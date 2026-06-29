// The anti-agreeableness gate + addressing rules. Pure functions over the slice of loop
// state they read (`ledger` + `priorTurn`) and a candidate director move — extracted from
// the orchestrator so they can be unit-tested in isolation.
//
//   - gateProblems()    → the reasons a move is illegal (empty = legal). Each string is fed
//                          back to the director as a correction for a retry.
//   - coerce()          → last-resort fix when the director keeps emitting an illegal move.
//   - correctAddressing()→ aim a post-human response at the AUTHOR, not the prior dog.
//   - pickDogTarget()   → choose which dog a reactive move should address.

import type { Ledger, SeatId, TranscriptEntry, TurnMove } from "@review-table/contracts";
import { AI_SEATS, HUMAN_SEAT, isDogSeat, isHuman } from "./config";
import { canResolve } from "./ledger";

const AI_IDS = AI_SEATS.map((s) => s.id);

/** Moves that respond to the immediately-prior turn (vs. open a new topic). After a human
 *  turn, these must address the author, not the dog who spoke before the author. */
export const RESPONDS_TO_PRIOR: ReadonlySet<string> = new Set([
  "answer",
  "pushback",
  "pile_on",
  "nitpick",
]);

/** The slice of loop state the gate reads. (GenState is structurally compatible.) */
export interface GateState {
  ledger: Ledger;
  priorTurn: TranscriptEntry | null;
}

/** Reasons the move is illegal; empty array means it passes the gate. */
export function gateProblems(state: GateState, move: TurnMove, wantClose: boolean): string[] {
  const problems: string[] = [];

  // Anti-agreeableness: a thread may only resolve after it has taken genuine pushback.
  if (move.move === "resolve" && !canResolve(state.ledger, move.thread_id)) {
    problems.push(
      `move=resolve on thread ${move.thread_id ?? "(none)"} but it has taken no pushback. ` +
        `A thread must be challenged (a "pushback") before it can resolve. Pick "pushback" or another move.`,
    );
  }
  // Don't end the review while work remains; a dog (not the author) delivers the verdict.
  if (move.move === "close" && !wantClose) {
    problems.push(`move=close but hunks remain uncovered/open. Keep the review going.`);
  }
  if (isHuman(move.next_speaker) && move.move === "close") {
    problems.push(`next_speaker=human on a close — a dog delivers the verdict, not the author.`);
  }
  // Reactive moves must name whose point they engage — a fellow dog (the usual case, so
  // dogs argue with each other) OR the author when responding to the human's point.
  if (
    (move.move === "pushback" || move.move === "pile_on") &&
    !isDogSeat(move.addressed_to) &&
    !isHuman(move.addressed_to)
  ) {
    problems.push(
      `a ${move.move} must name whose point you are challenging — a dog seat ` +
        `(one of ${AI_IDS.join("/")}) or the author (${HUMAN_SEAT.id}) when responding to the ` +
        `author — not "table" or null.`,
    );
  }
  return problems;
}

/** Last-resort fix for a move the director kept emitting illegally (after retries). */
export function coerce(state: GateState, move: TurnMove): TurnMove {
  if (move.move === "resolve" && !canResolve(state.ledger, move.thread_id)) {
    // A coerced pushback still owes a participant target.
    return {
      ...move,
      move: "pushback",
      thread_status: "open",
      verdict: null,
      addressed_to: pickDogTarget(state, move.next_speaker, move.thread_id),
    };
  }
  if (move.move === "close") {
    return { ...move, move: "move_on", verdict: null };
  }
  if (
    (move.move === "pushback" || move.move === "pile_on") &&
    !isDogSeat(move.addressed_to) &&
    !isHuman(move.addressed_to)
  ) {
    // If the author just spoke, the response is aimed at them; otherwise pick a dog.
    const target =
      state.priorTurn && isHuman(state.priorTurn.seat_id)
        ? HUMAN_SEAT.id
        : pickDogTarget(state, move.next_speaker, move.thread_id);
    return { ...move, addressed_to: target };
  }
  return move;
}

/** Pick a dog (not `nextSpeaker`) for a reactive move to address: the thread's opener, the
 *  prior dog speaker, or any other dog. */
export function pickDogTarget(
  state: GateState,
  nextSpeaker: string,
  threadId: string | null,
): SeatId {
  const opener = threadId ? state.ledger.threads[threadId]?.opened_by : undefined;
  if (isDogSeat(opener) && opener !== nextSpeaker) return opener!;
  if (
    state.priorTurn &&
    isDogSeat(state.priorTurn.seat_id) &&
    state.priorTurn.seat_id !== nextSpeaker
  ) {
    return state.priorTurn.seat_id;
  }
  return AI_SEATS.find((s) => s.id !== nextSpeaker)!.id;
}

/** When the author has just spoken, a responding dog must address the AUTHOR (second
 *  person), not whoever spoke before the author. Returns the move with addressed_to fixed
 *  (or unchanged); `redirected` reports whether it changed (for logging). */
export function correctAddressing(
  state: GateState,
  move: TurnMove,
): { move: TurnMove; redirected: boolean } {
  if (
    state.priorTurn &&
    isHuman(state.priorTurn.seat_id) &&
    RESPONDS_TO_PRIOR.has(move.move) &&
    !isHuman(move.addressed_to)
  ) {
    return { move: { ...move, addressed_to: HUMAN_SEAT.id }, redirected: true };
  }
  return { move, redirected: false };
}
