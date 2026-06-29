// The review loop. Two LLM calls per turn (director move → speaker line), a
// floor-control state machine (DIRECTING → DOG_SPEAKING / AWAITING_HUMAN → … →
// REVIEW_COMPLETE), the ledger advancing from each committed move, and the
// anti-agreeableness gate enforced in code (a thread never resolves without prior
// pushback). Ends with a spoken verdict.
//
// M4 — human in the loop. The loop is paced to the client: the server presents one dog
// turn, then waits for the client's `turn_played` ack (via ReviewControls) before the
// next turn is presented, so the server's "now" matches what the human hears. That
// coherence powers two human paths:
//   - AWAITING_HUMAN: the director picks the human seat → the loop blocks on the human's
//     typed/spoken reply, then resumes.
//   - interject ("raise paw"): the human barges in during a dog turn → the in-flight
//     generation is aborted and the *partial turn is discarded* (never committed).
//
// Latency — 1-turn lookahead pipeline. GENERATION (director move → speaker text → TTS)
// is decoupled from PRESENTATION (streaming the turn to the client). While turn N is
// playing, the server generates turn N+1 into a buffer; when N is acked, N+1 is presented
// instantly — hiding the director+speaker latency that used to show as a gap between
// dogs. The prefetch runs against a SHADOW of the ledger/transcript (real state + N
// applied optimistically); the real state only advances on each ack, so an interject
// still discards both the playing turn and the prefetched one with no rollback. Prefetch
// stops at a human turn (we can't know the reply) and is aborted on interject.

import { anchorsInHunk, resolveHighlightAnchors } from "@review-table/anchoring";
import type {
  AiSeat,
  AnchorTable,
  AnnotatedFile,
  Ledger,
  ServerMessage,
  TranscriptEntry,
  TurnMove,
} from "@review-table/contracts";
import { getAdapters } from "./adapters";
import { AI_SEATS, aiSeat, HUMAN_SEAT, isHuman, SESSION_CONFIG } from "./config";
import type { ReviewControls } from "./control";
import { runDirector } from "./director";
import { coerce, correctAddressing, gateProblems } from "./gate";
import {
  applyMove,
  deriveIssues,
  deriveVerdict,
  initLedger,
  leastSpokenSeat,
  reviewComplete,
} from "./ledger";
import { runSpeaker, type TurnSink } from "./speaker";

export type { TurnSink } from "./speaker";

const MAX_TURNS = 24; // hard safety cap on a runaway review (cost + termination)
const MAX_GATE_RETRIES = 2; // director re-tries before we coerce a rejected move

/** The mutable state the loop and the director read from. The prefetch runs against a
 *  clone of this with the current turn applied (a "shadow"); the real one advances only
 *  as turns are acked/committed. */
interface GenState {
  ledger: Ledger;
  transcript: TranscriptEntry[];
  priorTurn: TranscriptEntry | null;
  turnNumber: number;
}

/** A planned turn — the output of generation, ready to present or act on. */
type Planned =
  | {
      kind: "dog";
      seat: AiSeat;
      move: TurnMove;
      highlight: string[];
      deltas: string[]; // buffered caption deltas, replayed on present
      audio: Uint8Array[]; // buffered TTS frames, replayed on present
      text: string; // committed transcript text
    }
  | { kind: "human"; move: TurnMove }
  | { kind: "close"; move: TurnMove }
  | { kind: "aborted" } // generation was cancelled (interject) — discard
  | { kind: "failed" }; // generation threw — terminate safely

/** A TurnSink that captures a turn's caption deltas + audio instead of sending them, so
 *  the turn can be generated ahead of time and presented later (the prefetch buffer). */
class BufferSink implements TurnSink {
  deltas: string[] = [];
  audio: Uint8Array[] = [];
  send(m: ServerMessage): void {
    if (m.type === "text_delta") this.deltas.push(m.delta);
  }
  sendBinary(d: Uint8Array): void {
    this.audio.push(d);
  }
}

export async function runReview(
  sink: TurnSink,
  anchorTable: AnchorTable,
  files: AnnotatedFile[],
  controls: ReviewControls,
): Promise<void> {
  const { llm, tts } = getAdapters();
  const aiIds = AI_SEATS.map((s) => s.id);
  const leadId = (AI_SEATS.find((s) => s.is_lead) ?? AI_SEATS[0]!).id;
  const directorModel = SESSION_CONFIG.moderator.model_id || AI_SEATS[0]!.model_id;

  const real: GenState = {
    ledger: initLedger(
      anchorTable,
      SESSION_CONFIG.seats.map((s) => s.id),
    ),
    transcript: [],
    priorTurn: null,
    turnNumber: 0,
  };

  // The prefetched next turn, generated while the current turn plays. `done` flips when
  // generation settles, so we only show a "thinking" beat if it isn't ready in time.
  let pending: { promise: Promise<Planned>; done: boolean } | null = null;

  console.log("[orchestrator] state → DIRECTING (review start)");

  while (!controls.aborted) {
    // ── Obtain the next planned turn: the prefetched one, or generate now ──────
    let planned: Planned;
    if (pending) {
      if (!pending.done) sink.send({ type: "thinking" });
      planned = await pending.promise;
      pending = null;
      // A consumed prefetch should be a real turn; if it didn't survive, regenerate.
      if (planned.kind === "aborted") {
        sink.send({ type: "thinking" });
        planned = await plan(real, undefined);
      }
    } else {
      sink.send({ type: "thinking" });
      planned = await plan(real, undefined);
    }
    if (controls.aborted) break;

    // ── Dispatch by kind ──────────────────────────────────────────────────────
    if (planned.kind === "failed") {
      console.error("[orchestrator] generation failed — closing the review");
      await deliverClose(synthClose());
      return;
    }
    if (planned.kind === "close") {
      await deliverClose(planned.move);
      return;
    }
    if (planned.kind === "human") {
      await humanTurn(planned.move, true);
      if (controls.aborted) break;
      continue;
    }
    if (planned.kind === "aborted") continue; // defensive; shouldn't reach here

    // ── DOG_SPEAKING: present the turn, prefetch the next, await the ack ───────
    const dog = planned;
    const sig = controls.beginTurn(); // reset the pacing gate; this signal guards the prefetch
    presentDog(dog);

    // Prefetch the next turn against a shadow (real + this turn applied), concurrently
    // with the playback we're about to wait on. Aborted by interject via `sig`.
    const shadow = shadowAfter(real, dog);
    const p = { promise: plan(shadow, sig), done: false };
    p.promise.then(
      () => (p.done = true),
      () => (p.done = true),
    );
    pending = p;

    const outcome = await controls.awaitTurnOutcome();
    if (controls.aborted) break;

    if (outcome === "interject") {
      // Discard the playing turn (never committed) AND the prefetch (never presented).
      console.log(`[orchestrator] interject — discarding ${dog.seat.id}'s turn + prefetch`);
      pending = null;
      p.promise.catch(() => {}); // swallow the abandoned prefetch
      await humanTurn(dog.move, false);
      if (controls.aborted) break;
      continue;
    }

    // played → commit the turn; the prefetch (pending) carries into the next iteration.
    commitDog(dog);
  }

  console.log("[orchestrator] loop ended (aborted)");

  // ── Generation (no side effects on `real`) ──────────────────────────────────

  /**
   * Generate the next turn for the given state: run the director (with the gate), then —
   * for a dog turn — generate the spoken line + TTS into a buffer. Pure w.r.t. `real`;
   * the prefetch passes a shadow state. Never throws (errors → {failed}); honors `signal`
   * (interject) by bailing to {aborted}.
   */
  async function plan(state: GenState, signal: AbortSignal | undefined): Promise<Planned> {
    if (signal?.aborted) return { kind: "aborted" };
    try {
      const complete = reviewComplete(state.ledger);
      const capped = state.turnNumber >= MAX_TURNS;
      if (capped && !complete) {
        console.warn(`[orchestrator] turn cap (${MAX_TURNS}) reached — forcing close`);
      }
      const wantClose = complete || capped;

      const move = await directNext(state, wantClose);
      if (signal?.aborted) return { kind: "aborted" };

      if (move.move === "close" || wantClose) {
        return { kind: "close", move: move.move === "close" ? move : synthClose() };
      }
      if (isHuman(move.next_speaker)) return { kind: "human", move };

      // Dog turn.
      const seat =
        aiSeat(move.next_speaker) ?? aiSeat(leastSpokenSeat(state.ledger, aiIds, leadId))!;

      // When the author has just spoken, the responding dog addresses the AUTHOR (second
      // person), not whoever spoke before the author.
      const { move: addressed, redirected } = correctAddressing(state, move);
      if (redirected)
        console.log(`[orchestrator] author just spoke → ${seat.id} addresses the author`);

      const highlight = resolveFocus(addressed);
      const buf = new BufferSink();
      const text = await runSpeaker(
        llm,
        tts,
        buf,
        seat,
        addressed,
        highlight,
        files,
        anchorTable,
        recentWindow(state.transcript, addressed.thread_id),
        signal,
      );
      if (signal?.aborted) return { kind: "aborted" };
      return {
        kind: "dog",
        seat,
        move: addressed,
        highlight,
        deltas: buf.deltas,
        audio: buf.audio,
        text,
      };
    } catch (err) {
      console.error("[orchestrator] generation error:", (err as Error).message);
      return { kind: "failed" };
    }
  }

  /** Director call with the anti-agreeableness gate: reject, feed back, then coerce. */
  async function directNext(state: GenState, wantClose: boolean): Promise<TurnMove> {
    let corrections: string[] | undefined;
    let last: TurnMove | null = null;
    for (let attempt = 0; attempt <= MAX_GATE_RETRIES; attempt++) {
      const move = await runDirector(llm, directorModel, {
        files,
        ledger: state.ledger,
        transcript: state.transcript,
        turnNumber: state.turnNumber,
        complete: wantClose,
        corrections,
      });
      last = move;
      const problems = gateProblems(state, move, wantClose);
      if (problems.length === 0) return move;
      console.warn(`[orchestrator] move rejected (attempt ${attempt + 1}): ${problems.join("; ")}`);
      corrections = problems;
    }
    const coerced = coerce(state, last!);
    console.warn(
      `[orchestrator] coercing rejected move: ${last!.move} → ${coerced.move} ` +
        `(addressed_to=${coerced.addressed_to})`,
    );
    return coerced;
  }

  /**
   * The thread-scoped rolling window the speaker sees (A1): the actual back-and-forth it
   * is joining. Prefer turns on the current thread; fall back to the most recent turns
   * overall (opening moves, banter) when the thread is short or absent.
   */
  function recentWindow(
    transcript: TranscriptEntry[],
    threadId: string | null,
    n = 4,
  ): TranscriptEntry[] {
    if (threadId) {
      const scoped = transcript.filter((e) => e.thread_id === threadId);
      if (scoped.length >= 2) return scoped.slice(-n);
    }
    return transcript.slice(-n);
  }

  /** Resolve/validate focus anchors; clamp to the hunk, never highlight nothing. */
  function resolveFocus(move: TurnMove): string[] {
    const hunk = move.focus?.anchor ?? null;
    let h = resolveHighlightAnchors(move.focus?.anchors ?? [], anchorTable, hunk);
    if (h.length === 0 && hunk) h = anchorsInHunk(hunk, anchorTable);
    if (h.length === 0) {
      const firstHunk = Object.keys(anchorTable.hunks)[0];
      if (firstHunk) h = anchorsInHunk(firstHunk, anchorTable);
    }
    if (h.length === 0) h = Object.keys(anchorTable.anchors).slice(0, 3);
    return h;
  }

  // ── Presentation + commit (the only side effects on `real` + the wire) ──────

  /** Stream a buffered dog turn to the client, in the same shape as live generation. */
  function presentDog(dog: Extract<Planned, { kind: "dog" }>): void {
    console.log(
      `[orchestrator] state → DOG_SPEAKING (${dog.seat.id} / ${dog.move.move}` +
        `${dog.move.thread_id ? " " + dog.move.thread_id : ""})`,
    );
    sink.send({
      type: "turn_start",
      seat_id: dog.seat.id,
      move: dog.move.move,
      focus_anchors: dog.highlight,
    });
    sink.send({ type: "highlight", anchors: dog.highlight });
    for (const delta of dog.deltas) sink.send({ type: "text_delta", seat_id: dog.seat.id, delta });
    for (const frame of dog.audio) sink.sendBinary(frame);
    sink.send({ type: "turn_end", seat_id: dog.seat.id });
  }

  /** Commit a played dog turn to the real ledger + transcript. */
  function commitDog(dog: Extract<Planned, { kind: "dog" }>): void {
    real.transcript.push(dogEntry(dog, real.transcript.length));
    real.priorTurn = real.transcript[real.transcript.length - 1]!;
    applyMove(real.ledger, dog.move, dog.seat.id);
    real.turnNumber += 1;
    console.log(
      `[orchestrator] committed turn ${real.turnNumber} (${dog.seat.id}/${dog.move.move}` +
        `${dog.move.addressed_to && dog.move.addressed_to !== "table" ? `→${dog.move.addressed_to}` : ""}); ` +
        `coverage=${JSON.stringify(real.ledger.hunk_coverage)}`,
    );
  }

  function dogEntry(dog: Extract<Planned, { kind: "dog" }>, index: number): TranscriptEntry {
    return {
      seat_id: dog.seat.id,
      move: dog.move.move,
      thread_id: dog.move.thread_id,
      text: dog.text,
      focus_anchors: dog.highlight,
      ts: Date.now(),
      addressed_to: dog.move.addressed_to,
      in_reply_to: index > 0 ? index - 1 : null,
    };
  }

  /** A shadow of `state` with `dog` applied — what the prefetch generates against. */
  function shadowAfter(state: GenState, dog: Extract<Planned, { kind: "dog" }>): GenState {
    const ledger = structuredClone(state.ledger);
    applyMove(ledger, dog.move, dog.seat.id);
    const entry = dogEntry(dog, state.transcript.length);
    return {
      ledger,
      transcript: [...state.transcript, entry],
      priorTurn: entry,
      turnNumber: state.turnNumber + 1,
    };
  }

  /**
   * Give the human the floor and block until they reply (typed, or PTT → STT).
   * `solicited` distinguishes a director invitation from a self-initiated interject;
   * both converge on the same commit. Returns false if the human gave nothing.
   */
  async function humanTurn(move: TurnMove | null, solicited: boolean): Promise<boolean> {
    const asker =
      real.priorTurn && !isHuman(real.priorTurn.seat_id) ? real.priorTurn.seat_id : leadId;
    const prompt = solicited
      ? real.priorTurn && !isHuman(real.priorTurn.seat_id)
        ? real.priorTurn.text
        : "The table wants your take — go ahead."
      : "You have the floor — go ahead.";
    console.log(
      `[orchestrator] state → AWAITING_HUMAN (addressed_by=${asker}, solicited=${solicited})`,
    );
    sink.send({ type: "awaiting_human", prompt, addressed_by: asker });

    const text = (await controls.awaitHuman()).trim();
    if (controls.aborted || !text) {
      console.log("[orchestrator] human turn empty/abandoned");
      return false;
    }

    const thread_id = move?.thread_id ?? real.priorTurn?.thread_id ?? null;
    const entry: TranscriptEntry = {
      seat_id: HUMAN_SEAT.id,
      move: "answer",
      thread_id,
      text,
      focus_anchors: [],
      ts: Date.now(),
      addressed_to: "table",
      in_reply_to: real.transcript.length ? real.transcript.length - 1 : null,
    };
    real.transcript.push(entry);
    real.priorTurn = entry;
    applyMove(
      real.ledger,
      {
        next_speaker: HUMAN_SEAT.id,
        move: "answer",
        addressed_to: "table",
        focus: null,
        thread_id,
        thread_status: null,
        brief: "",
        verdict: null,
      },
      HUMAN_SEAT.id,
    );
    real.turnNumber += 1;
    console.log(
      `[orchestrator] human turn committed (${text.length} chars, thread=${thread_id ?? "none"})`,
    );
    return true;
  }

  function synthClose(): TurnMove {
    return {
      next_speaker: leadId,
      move: "close",
      addressed_to: "table",
      focus: null,
      thread_id: null,
      thread_status: null,
      brief: "Wrap up the review and deliver the verdict.",
      verdict: deriveVerdict(real.ledger),
      rationale: "synthesized close (cap reached or director declined to close)",
    };
  }

  async function deliverClose(move: TurnMove): Promise<void> {
    const seat = aiSeat(move.next_speaker) ?? aiSeat(leadId)!;
    const verdict = move.verdict ?? deriveVerdict(real.ledger);
    console.log(`[orchestrator] state → REVIEW_COMPLETE (verdict=${verdict})`);

    const turnSignal = controls.beginTurn();
    sink.send({ type: "turn_start", seat_id: seat.id, move: "close", focus_anchors: [] });
    sink.send({ type: "highlight", anchors: [] });

    const closeMove: TurnMove = {
      ...move,
      move: "close",
      brief:
        `${move.brief}\nThis is the closing word for the whole review. Deliver the verdict ` +
        `(${verdict.replace("_", " ")}) in one or two sentences.`,
    };
    const text = await runSpeaker(
      llm,
      tts,
      sink,
      seat,
      closeMove,
      [],
      files,
      anchorTable,
      recentWindow(real.transcript, null),
      turnSignal,
    );
    real.transcript.push({
      seat_id: seat.id,
      move: "close",
      thread_id: null,
      text,
      focus_anchors: [],
      ts: Date.now(),
      addressed_to: "table",
    });
    sink.send({ type: "turn_end", seat_id: seat.id });
    await controls.awaitTurnOutcome(); // let the closing line finish playing before the panel

    const issues = deriveIssues(real.ledger, real.transcript);
    sink.send({ type: "review_complete", verdict, issues });
    console.log(`[orchestrator] review_complete sent (${issues.length} issue(s))`);
  }
}
