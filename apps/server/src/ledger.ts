// The review Ledger + the rules that read and advance it.
// The runtime feeds the ledger to the director every cycle and updates it from each
// committed move: turns_by_seat for balance, thread entries (status + has_pushback)
// for the anti-agreeableness gate, hunk_coverage for the termination condition.
//
// Review is complete when every hunk is resolved, blocking, or deferred — never while
// a hunk is still uncovered or open. The verdict and the closing IssueSummary[] are
// derived purely from these structured statuses, never from dialogue.

import type {
  AnchorTable,
  IssueSummary,
  Ledger,
  ThreadLedgerEntry,
  TranscriptEntry,
  TurnMove,
  Verdict,
} from "@review-table/contracts";

const COVERED: ReadonlySet<string> = new Set(["resolved", "blocking", "deferred"]);

export function initLedger(anchorTable: AnchorTable, seatIds: string[]): Ledger {
  const turns_by_seat: Record<string, number> = {};
  for (const id of seatIds) turns_by_seat[id] = 0;

  const hunk_coverage: Record<string, "uncovered"> = {};
  for (const hunkId of Object.keys(anchorTable.hunks)) hunk_coverage[hunkId] = "uncovered";

  return { turns_by_seat, threads: {}, hunk_coverage, total_turns: 0 };
}

/** Advance the ledger from one committed move. Mutates in place. */
export function applyMove(ledger: Ledger, move: TurnMove, seatId: string): void {
  ledger.turns_by_seat[seatId] = (ledger.turns_by_seat[seatId] ?? 0) + 1;
  ledger.total_turns += 1;

  const tid = move.thread_id;
  const hunk = move.focus?.anchor ?? null;
  const focusAnchors = move.focus?.anchors ?? [];

  // Touching an uncovered hunk with any substantive move opens it.
  if (hunk && ledger.hunk_coverage[hunk] === "uncovered" && move.move !== "banter") {
    ledger.hunk_coverage[hunk] = "open";
  }

  switch (move.move) {
    case "raise_issue": {
      if (tid && !ledger.threads[tid]) {
        ledger.threads[tid] = {
          status: "open",
          focus_anchors: focusAnchors,
          turn_count: 1,
          opened_by: seatId,
          has_pushback: false,
        };
      } else if (tid) {
        ledger.threads[tid]!.turn_count += 1;
      }
      break;
    }
    case "pushback": {
      // The gate-opening event: a thread cannot resolve until it has taken pushback.
      const t = ensureThread(ledger, tid, seatId, focusAnchors);
      if (t) {
        t.has_pushback = true;
        t.turn_count += 1;
      }
      break;
    }
    case "pile_on":
    case "ask_author":
    case "answer":
    case "nitpick":
    case "move_on": {
      const t = tid ? ledger.threads[tid] : undefined;
      if (t) t.turn_count += 1;
      break;
    }
    case "resolve": {
      const t = tid ? ledger.threads[tid] : undefined;
      const status =
        move.thread_status && COVERED.has(move.thread_status) ? move.thread_status : "resolved";
      if (t) {
        t.status = status;
        t.turn_count += 1;
      }
      if (hunk) ledger.hunk_coverage[hunk] = status as Ledger["hunk_coverage"][string];
      break;
    }
    case "banter":
    case "close":
      break;
  }
}

function ensureThread(
  ledger: Ledger,
  tid: string | null,
  seatId: string,
  focusAnchors: string[],
): ThreadLedgerEntry | null {
  if (!tid) return null;
  if (!ledger.threads[tid]) {
    ledger.threads[tid] = {
      status: "open",
      focus_anchors: focusAnchors,
      turn_count: 0,
      opened_by: seatId,
      has_pushback: false,
    };
  }
  return ledger.threads[tid]!;
}

/** Can this thread legally resolve? The anti-agreeableness gate (CLAUDE.md). */
export function canResolve(ledger: Ledger, threadId: string | null): boolean {
  if (!threadId) return false;
  const t = ledger.threads[threadId];
  return !!t && t.has_pushback;
}

/** Review ends only when every hunk reached a terminal coverage state. */
export function reviewComplete(ledger: Ledger): boolean {
  const hunks = Object.values(ledger.hunk_coverage);
  if (hunks.length === 0) return ledger.total_turns >= 1; // no hunks: one beat, done
  return hunks.every((c) => COVERED.has(c));
}

/** Pick an AI seat to favor for balance: fewest turns first, lead breaks ties. */
export function leastSpokenSeat(ledger: Ledger, aiSeatIds: string[], leadId: string): string {
  let best = aiSeatIds[0]!;
  let bestCount = Infinity;
  for (const id of aiSeatIds) {
    const c = ledger.turns_by_seat[id] ?? 0;
    if (c < bestCount || (c === bestCount && id === leadId)) {
      best = id;
      bestCount = c;
    }
  }
  return best;
}

/** Overall verdict, derived from coverage/thread statuses (never from dialogue). */
export function deriveVerdict(ledger: Ledger): Verdict {
  const coverage = Object.values(ledger.hunk_coverage);
  const threadStatuses = Object.values(ledger.threads).map((t) => t.status);
  if (coverage.includes("blocking") || threadStatuses.includes("blocking")) {
    return "request_changes";
  }
  const hasOpenWork =
    coverage.some((c) => c === "open" || c === "uncovered") || threadStatuses.includes("open");
  if (hasOpenWork) return "comment";
  // Everything resolved/deferred and at least one real thread → approve with notes.
  return Object.keys(ledger.threads).length > 0 ? "approve" : "comment";
}

/** Closing issue list, one per thread, gist drawn from the thread's opening turn. */
export function deriveIssues(ledger: Ledger, transcript: TranscriptEntry[]): IssueSummary[] {
  return Object.entries(ledger.threads).map(([thread_id, t]) => {
    const opening = transcript.find((e) => e.thread_id === thread_id);
    const gist = opening
      ? truncate(opening.text, 160)
      : `Discussion on ${t.focus_anchors.join(", ")}`;
    return { thread_id, status: t.status, focus_anchors: t.focus_anchors, gist };
  });
}

/** A compact, model-facing snapshot of the ledger for the director's prompt. */
export function ledgerSummary(ledger: Ledger, aiSeatIds: string[]): string {
  const turns = aiSeatIds.map((id) => `${id}=${ledger.turns_by_seat[id] ?? 0}`).join(", ");
  const coverage =
    Object.entries(ledger.hunk_coverage)
      .map(([h, c]) => `${h}=${c}`)
      .join(", ") || "(no hunks)";

  const threadLines = Object.entries(ledger.threads).map(([id, t]) => {
    const gate =
      t.status === "open" && !t.has_pushback ? " — NOT yet eligible to resolve (no pushback)" : "";
    const eligible = t.status === "open" && t.has_pushback ? " — eligible to resolve" : "";
    return `  - ${id}: status=${t.status}, opened_by=${t.opened_by}, has_pushback=${t.has_pushback}, focus=[${t.focus_anchors.join(", ")}]${gate}${eligible}`;
  });
  const threads = threadLines.length ? threadLines.join("\n") : "  (none yet)";

  return [
    `Turns so far (balance — prefer dogs with FEWER turns): ${turns}.`,
    `Hunk coverage: ${coverage}. The review ends only when every hunk is resolved, blocking, or deferred.`,
    `Threads:`,
    threads,
  ].join("\n");
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
}
