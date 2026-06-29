// Paste-diff panel — accepts a unified diff and fires `start_review` over the socket
// (FR-1). Anchoring + the annotated file view land in M1; for M0 this just posts.

import { useState } from "react";

export function DiffInput({
  onStart,
  disabled,
}: {
  onStart: (diff: string) => void;
  disabled?: boolean;
}) {
  const [diff, setDiff] = useState("");

  return (
    <div className="diff-panel">
      <label className="diff-label" htmlFor="diff">
        Paste a unified diff
      </label>
      <textarea
        id="diff"
        className="diff-textarea"
        placeholder={"diff --git a/foo.ts b/foo.ts\n@@ -1,3 +1,4 @@\n..."}
        value={diff}
        onChange={(e) => setDiff(e.target.value)}
        spellCheck={false}
      />
      <button
        type="button"
        className="start-btn"
        disabled={disabled || diff.trim().length === 0}
        onClick={() => onStart(diff)}
      >
        Start review
      </button>
    </div>
  );
}
