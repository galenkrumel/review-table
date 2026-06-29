// Read-only editor pane (FR-19, FR-20). Renders AnnotatedFile[] with the anchor
// gutter (anchor id · new-file number · change marker), highlights the focus
// anchors for the whole turn, and scrolls to keep the first focused line visible.
// Highlight is driven by committed anchors, never by parsing dialogue text.

import type { AnnotatedFile } from "@review-table/contracts";
import { useEffect, useMemo, useRef } from "react";

export function EditorPane({
  files,
  highlighted,
}: {
  files: AnnotatedFile[];
  highlighted: string[];
}) {
  const highlightSet = useMemo(() => new Set(highlighted), [highlighted]);
  const scrollHost = useRef<HTMLDivElement | null>(null);
  const firstHit = useRef<HTMLDivElement | null>(null);

  // Scroll the first highlighted line into view whenever the focus changes.
  useEffect(() => {
    if (highlighted.length > 0 && firstHit.current) {
      firstHit.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlighted]);

  if (files.length === 0) {
    return (
      <div className="editor empty">
        <p className="editor-empty-msg">paste a diff to see the annotated code</p>
      </div>
    );
  }

  let seenFirstHit = false;

  return (
    <div className="editor" ref={scrollHost}>
      {files.map((file) => {
        let prevNum: number | null = null;
        return (
          <div className="file" key={file.file}>
            <div className="file-header">{file.file}</div>
            <div className="code">
              {file.lines.map((line, i) => {
                const gap = line.new_line != null && prevNum != null && line.new_line > prevNum + 1;
                if (line.new_line != null) prevNum = line.new_line;
                const isHit = line.anchor != null && highlightSet.has(line.anchor);
                const attachRef = isHit && !seenFirstHit;
                if (attachRef) seenFirstHit = true;
                return (
                  <div key={line.anchor ?? `ctx${i}`}>
                    {gap ? <div className="gap">⋯</div> : null}
                    <div
                      ref={attachRef ? firstHit : undefined}
                      className={
                        "row" +
                        (isHit ? " hit" : "") +
                        (line.marker === "+" ? " added" : line.marker === "-" ? " removed" : "")
                      }
                    >
                      <span className="g-anchor">{line.anchor ?? ""}</span>
                      <span className="g-num">{line.new_line ?? ""}</span>
                      <span className="g-mark">{line.marker === " " ? "" : line.marker}</span>
                      <span className="g-text">{line.text}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
