// Unified-diff parser → AnchorTable + AnnotatedFile[] (ARCHITECTURE.md §7).
// Parse once; this is session source-of-truth.
//
// Anchoring rules:
//  - Added and context lines exist in the new file → they get a new_line and an
//    anchor id.
//  - Deleted lines do NOT exist in the new file → marker "-", no new_line, no id
//    (comment on removed code by anchoring to surrounding context).
//  - new_line advances only on added/context lines, never on deleted.
//
// Id scheme (MVP, near-identity per the spec): anchor id = "a" + zero-padded
// new_line. Clean and matches the resolver's near-identity contract. If two files
// share a new_line (a real cross-file collision), the later occurrence is
// disambiguated with a "-<hunk>" suffix so table keys stay unique; single-file
// diffs (the MVP/acceptance case) keep the clean "a049 → line 49" property.
// Hunk ids are global sequential "h1", "h2", … in diff order.

import type {
  AnchorEntry,
  AnchorTable,
  AnnotatedFile,
  ChangeKind,
  HunkEntry,
} from "@review-table/contracts";

export interface ParsedDiff {
  anchorTable: AnchorTable;
  files: AnnotatedFile[];
}

// Captures: 1=oldStart, 2=oldCount?, 3=newStart, 4=newCount?
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPathPrefix(p: string): string {
  // "b/src/x.ts" → "src/x.ts"; leave "/dev/null" and bare paths alone.
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");

  const anchors: Record<string, AnchorEntry> = {};
  const hunks: Record<string, HunkEntry> = {};
  const files: AnnotatedFile[] = [];

  // Decide padding width up front from the largest new_line in any hunk header so
  // ids are consistent across the whole table (e.g. width 3 → "a049").
  let maxLine = 0;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const start = Number(m[3]);
      const count = m[4] === undefined ? 1 : Number(m[4]);
      maxLine = Math.max(maxLine, start + Math.max(count, 1) - 1);
    }
  }
  const padWidth = Math.max(3, String(maxLine).length);
  const padLine = (n: number) => String(n).padStart(padWidth, "0");

  let currentFile: AnnotatedFile | null = null;
  let hunkCounter = 0;
  let currentHunk: string | null = null;
  let newLine = 0;
  // Lines still owed by the current hunk, from the @@ header counts. Used to know
  // when a hunk ends and to treat whitespace-stripped blank lines as blank context.
  let newRemaining = 0;
  let oldRemaining = 0;

  // Create, register, and return a file. Callers assign `currentFile` directly so
  // TS tracks the non-null type (closure mutation alone defeats narrowing).
  const startFile = (path: string): AnnotatedFile => {
    const f: AnnotatedFile = { file: path, lines: [] };
    files.push(f);
    return f;
  };

  const mkAnchorId = (n: number, hunk: string): string => {
    const base = `a${padLine(n)}`;
    if (!(base in anchors)) return base;
    return `${base}-${hunk}`; // cross-file collision fallback
  };

  for (const raw of lines) {
    // File headers.
    if (raw.startsWith("diff --git ")) {
      // Prefer the +++ path; seed from the git header in case +++ is /dev/null.
      const parts = raw.split(" ");
      const bPath = parts[parts.length - 1];
      currentFile = startFile(stripPathPrefix(bPath ?? "unknown"));
      currentHunk = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = stripPathPrefix(raw.slice(4).trim().replace(/\t.*$/, ""));
      if (path && path !== "/dev/null") {
        if (currentFile) currentFile.file = path;
        else {
          currentFile = startFile(path);
          currentHunk = null;
        }
      }
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ")
    ) {
      continue;
    }

    // Hunk header.
    const hm = HUNK_RE.exec(raw);
    if (hm) {
      if (!currentFile) currentFile = startFile("unknown");
      const file = currentFile;
      hunkCounter += 1;
      currentHunk = `h${hunkCounter}`;
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const start = Number(hm[3]);
      const count = hm[4] === undefined ? 1 : Number(hm[4]);
      newLine = start;
      oldRemaining = Math.max(oldCount, 0);
      newRemaining = Math.max(count, 0);
      hunks[currentHunk] = {
        file: file.file,
        start_line: start,
        end_line: start + Math.max(count, 1) - 1,
      };
      continue;
    }

    if (!currentFile || currentHunk === null) continue; // preamble / unknown line
    if (newRemaining <= 0 && oldRemaining <= 0) continue; // hunk already fully consumed

    // Capture non-null locals so the closure below narrows correctly.
    const file = currentFile;
    const hunk = currentHunk;

    // Content lines. A truly-empty line inside a hunk is a blank context line whose
    // leading space was stripped in transit — treat it as " " (robustness for pasted
    // diffs), but only while the hunk still owes lines.
    const marker = raw.length === 0 ? " " : raw[0];
    const text = raw.length === 0 ? "" : raw.slice(1);

    const addAnchored = (change: ChangeKind, m: "+" | " ") => {
      const id = mkAnchorId(newLine, hunk);
      anchors[id] = { file: file.file, new_line: newLine, change, hunk };
      file.lines.push({ anchor: id, new_line: newLine, marker: m, text });
      newLine += 1;
    };

    if (marker === "+") {
      addAnchored("added", "+");
      newRemaining -= 1;
    } else if (marker === " ") {
      addAnchored("context", " ");
      newRemaining -= 1;
      oldRemaining -= 1;
    } else if (marker === "-") {
      file.lines.push({ anchor: null, new_line: null, marker: "-", text });
      oldRemaining -= 1; // no new_line advance, no anchor entry
    }
    // "\ No newline at end of file" and the like: ignored, no budget change.
  }

  return { anchorTable: { anchors, hunks }, files };
}
