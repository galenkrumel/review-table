// B4 — name-tagged caption. For the active seat, a nameplate + the streaming spoken
// text, anchored near that seat over the painting. Solid background + shadow so it
// stays legible over the artwork, and it doubles as subtitles when audio is muted
// (e.g. in the demo recording).

import type { CSSProperties } from "react";
import type { CaptionAnchor } from "./seatRegions";

export function SpeakerCaption({
  name,
  text,
  anchor,
}: {
  name: string;
  text: string | null;
  anchor: CaptionAnchor;
}) {
  const translateX = anchor.align === "center" ? "-50%" : anchor.align === "right" ? "-100%" : "0";
  const style: CSSProperties = {
    left: `${anchor.xPct}%`,
    top: `${anchor.yPct}%`,
    transform: `translateX(${translateX})`,
  };
  return (
    <div className="speaker-caption" style={style}>
      <span className="speaker-name">{name}</span>
      {text ? <span className="speaker-text">{text}</span> : null}
    </div>
  );
}
