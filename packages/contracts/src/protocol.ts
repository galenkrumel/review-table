// WebSocket protocol.
// All messages are JSON envelopes { type, ... } except binary audio frames.

import type { AnchorTable, AnnotatedFile } from "./anchors";
import type { Move, ThreadStatus, Verdict } from "./moves";
import type { SeatId } from "./seats";

export type ClientMessage =
  | { type: "start_review"; diff: string } // pasted unified diff
  | { type: "human_text"; text: string } // typed human turn
  | { type: "ptt_start" } // hold begins; server mutes dogs
  | { type: "ptt_end" } // hold ends; client will send the clip
  | { type: "interject" } // raise paw during a dog turn
  | { type: "turn_played" } // a dog turn finished playing on the client (pacing ack)
  | { type: "abort" }; // end session
// PTT audio clip is sent as a binary message immediately after ptt_end,
// or streamed as binary frames between ptt_start and ptt_end (implementer's choice;
// batch STT on the assembled clip either way).

export type ServerMessage =
  | { type: "review_started"; anchorTable: AnchorTable; files: AnnotatedFile[] }
  | { type: "turn_start"; seat_id: SeatId; move: Move; focus_anchors: string[] }
  | { type: "text_delta"; seat_id: SeatId; delta: string } // streaming caption
  | { type: "highlight"; anchors: string[] } // editor highlight for current turn
  | { type: "awaiting_human"; prompt: string; addressed_by: SeatId }
  | { type: "dogs_muted"; muted: boolean } // ack PTT mute/unmute
  | { type: "turn_end"; seat_id: SeatId }
  | { type: "review_complete"; verdict: Verdict; issues: IssueSummary[] }
  | { type: "thinking" }; // director hop beat
// Audio is delivered as binary frames tagged to the current turn_start's seat;
// the client routes amplitude to that seat's mouth.

export interface IssueSummary {
  thread_id: string;
  status: ThreadStatus;
  focus_anchors: string[];
  gist: string;
}
