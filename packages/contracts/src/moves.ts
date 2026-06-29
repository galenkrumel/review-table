// TurnMove (director output) + SpeakerTurn.
// TurnMove is emitted via structured output / tool-calling. Never free-text parsed.

import type { SeatId } from "./seats";

export type Move =
  | "raise_issue" // open a thread about a concern
  | "pushback" // disagree with a prior turn (required before a thread resolves)
  | "pile_on" // reinforce another dog's point
  | "ask_author" // direct a question at the human (addressed_to = "human")
  | "answer" // a seat answers a question (used for human turns too)
  | "nitpick" // terse, minor point
  | "resolve" // close a thread with an outcome
  | "move_on" // shift focus, no resolution
  | "banter" // pacing beat, non-substantive
  | "close"; // end the review; deliver verdict

export type ThreadStatus = "open" | "resolved" | "blocking" | "deferred";
export type Verdict = "approve" | "request_changes" | "comment";

export interface Focus {
  file: string;
  anchor: string; // a hunk id (coarse handle), e.g. "h3"
  anchors: string[]; // specific line anchor ids, e.g. ["a047","a049"]
}

export interface TurnMove {
  next_speaker: SeatId; // who holds the floor this turn (may be "human")
  move: Move;
  addressed_to: SeatId | "table" | null;
  focus: Focus | null; // null for banter / close
  thread_id: string | null;
  thread_status: ThreadStatus | null;
  brief: string; // DIRECTION for the speaker, not the line itself
  verdict: Verdict | null; // meaningful only on close (overall) or resolve(blocking)
  rationale?: string; // logged for you; never shown or voiced
}

// SpeakerTurn — the speaker call's output.
export interface SpeakerTurn {
  seat_id: SeatId;
  thread_id: string | null;
  text: string; // in-character dialogue; sent to TTS
  focus_anchors: string[]; // anchors this turn stands behind (subset of move.focus.anchors)
}
