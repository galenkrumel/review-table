// Ledger.
// Fed to the director every cycle. The runtime updates it from each committed move:
// increment turns_by_seat, advance the thread entry (set has_pushback when a pushback
// lands), and update hunk_coverage. Review is complete when every hunk is resolved,
// blocking, or deferred.

import type { ThreadStatus } from "./moves";
import type { SeatId } from "./seats";

export interface ThreadLedgerEntry {
  status: ThreadStatus;
  focus_anchors: string[];
  turn_count: number;
  opened_by: SeatId;
  has_pushback: boolean; // gate for allowing resolve
}

export type HunkCoverage = "uncovered" | "open" | "resolved" | "blocking" | "deferred";

export interface Ledger {
  turns_by_seat: Record<SeatId, number>;
  threads: Record<string, ThreadLedgerEntry>;
  hunk_coverage: Record<string, HunkCoverage>; // hunk_id -> coverage
  total_turns: number;
}
