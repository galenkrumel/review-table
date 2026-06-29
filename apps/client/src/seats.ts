// Static seat display config for the scene. The authoritative seat config is
// server-owned (SessionConfig); the client only needs each seat's id, name, kind, and
// lead flag for labels and routing. Per-seat geometry lives in scene/seatRegions.ts
// (percentages of the fixed reference image), not here.

import type { SeatId } from "@review-table/contracts";

export interface DisplaySeat {
  id: SeatId;
  display_name: string;
  kind: "ai" | "human";
  is_lead?: boolean;
}

export const SEATS: DisplaySeat[] = [
  { id: "rex", display_name: "Rex", kind: "ai", is_lead: true },
  { id: "bella", display_name: "Bella", kind: "ai" },
  { id: "duke", display_name: "Duke", kind: "ai" },
  { id: "human", display_name: "You", kind: "human" },
];
