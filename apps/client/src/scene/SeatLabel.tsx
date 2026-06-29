// Persistent name label for a seat, anchored to that seat's region over the painting.
// Identifies who is who (the art alone doesn't), shown for every seat except the one
// currently speaking — whose streaming SpeakerCaption already carries its name.

import type { CSSProperties } from "react";
import type { CaptionAnchor } from "./seatRegions";

export function SeatLabel({ name, anchor }: { name: string; anchor: CaptionAnchor }) {
  const translateX = anchor.align === "center" ? "-50%" : anchor.align === "right" ? "-100%" : "0";
  const style: CSSProperties = {
    left: `${anchor.xPct}%`,
    top: `${anchor.yPct}%`,
    transform: `translateX(${translateX})`,
  };
  return (
    <div className="seat-label" style={style}>
      {name}
    </div>
  );
}
