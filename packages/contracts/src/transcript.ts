// Transcript.
// The internal transcript is provider-agnostic; adapters translate it to each
// provider's message shape at the boundary.

import type { Move } from "./moves";
import type { SeatId } from "./seats";

export interface TranscriptEntry {
  seat_id: SeatId;
  move: Move; // for human turns: typically "answer"
  thread_id: string | null;
  text: string;
  focus_anchors: string[];
  ts: number; // epoch ms
  // Response lineage — who this turn was directed at (a dog seat, the table, the
  // human, or nobody). Persisted so the director can re-read who has been arguing
  // with whom and sustain threads of disagreement. `null` for unaddressed turns.
  addressed_to: SeatId | "table" | null;
  // Optional: index into the transcript of the turn this one is replying to.
  in_reply_to?: number | null;
}
