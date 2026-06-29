// B1 — the one new data structure for the scene. A map of seat → the region of the
// fixed reference image that seat occupies, plus where that seat's caption anchors.
// All values are PERCENTAGES of the rendered image, so the overlay (spotlight +
// captions) scales responsively with the <img> regardless of viewport size.
//
// Tuned by eye against apps/client/public/scene.png (2816×1536, ~16:9). Persona → dog
// is fixed:
//   director = bulldog (background, left)
//   bella    = terrier with green visor (left)
//   rex      = St. Bernard with glasses + pipe (center, lead)
//   human    = beagle reading the printout (center-right)
//   duke     = golden retriever (right)
//
// To re-tune: nudge these boxes until each spotlight lands cleanly on its dog. They are
// the only thing that needs eyeballing; everything else is driven by server events.

export interface Box {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface CaptionAnchor {
  xPct: number;
  yPct: number;
  align: "left" | "center" | "right";
}

export interface SeatRegion {
  box: Box;
  caption: CaptionAnchor;
}

export const SEAT_REGIONS: Record<string, SeatRegion> = {
  bella: {
    box: { xPct: 13, yPct: 37, wPct: 22, hPct: 55 },
    caption: { xPct: 24, yPct: 62, align: "center" },
  },
  rex: {
    box: { xPct: 29, yPct: 22, wPct: 24, hPct: 67 },
    caption: { xPct: 41, yPct: 60, align: "center" },
  },
  human: {
    box: { xPct: 55, yPct: 34, wPct: 18, hPct: 49 },
    caption: { xPct: 63, yPct: 58, align: "center" },
  },
  duke: {
    box: { xPct: 70, yPct: 32, wPct: 28, hPct: 64 },
    caption: { xPct: 82, yPct: 60, align: "right" },
  },
  director: {
    box: { xPct: 8, yPct: 10, wPct: 17, hPct: 34 },
    caption: { xPct: 15, yPct: 33, align: "center" },
  },
};

export function seatRegion(id: string | null | undefined): SeatRegion | null {
  return id ? (SEAT_REGIONS[id] ?? null) : null;
}
