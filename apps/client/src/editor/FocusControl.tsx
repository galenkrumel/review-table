// Dev affordance for M1: type focus anchors (and an optional focus hunk) and apply
// the highlight, exercising scroll-to-focus and clamp-to-hunk by hand. In M2 the
// server's `highlight` message drives the same highlight state, and this strip can
// be hidden. Routes through resolveHighlightAnchors so a bad id never throws.

import { useState } from "react";

export function FocusControl({
  onApply,
  onClear,
}: {
  onApply: (anchors: string[], focusHunk: string | null) => void;
  onClear: () => void;
}) {
  const [anchors, setAnchors] = useState("a049");
  const [hunk, setHunk] = useState("");

  return (
    <div className="focus-control">
      <span className="dev-tag">dev</span>
      <input
        className="focus-input"
        value={anchors}
        onChange={(e) => setAnchors(e.target.value)}
        placeholder="anchors e.g. a049, a047"
        spellCheck={false}
      />
      <input
        className="focus-input hunk"
        value={hunk}
        onChange={(e) => setHunk(e.target.value)}
        placeholder="focus hunk (e.g. h2)"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() =>
          onApply(
            anchors
              .split(/[,\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
            hunk.trim() || null,
          )
        }
      >
        Highlight
      </button>
      <button type="button" className="ghost" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
