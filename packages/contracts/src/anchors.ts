// Anchor table, hunk index, resolver, and model-facing rendering.
// One coordinate system: opaque anchor ids resolve to editor
// positions through a single Resolver. Raw line numbers never flow through the
// director, speaker prompts, dialogue, or highlight logic (CLAUDE.md invariant 2).

export type ChangeKind = "added" | "context"; // deleted lines are not citable (no id)

export interface AnchorEntry {
  file: string;
  new_line: number; // canonical address space (new-file line)
  change: ChangeKind;
  hunk: string; // hunk id this line belongs to
}

export interface HunkEntry {
  file: string;
  start_line: number; // inclusive, new-file coordinates
  end_line: number; // inclusive
}

export interface AnchorTable {
  anchors: Record<string, AnchorEntry>; // anchor_id -> entry
  hunks: Record<string, HunkEntry>; // hunk_id -> entry
}

export interface Resolver {
  // MVP: near-identity (anchor.new_line). v2: map through the editor's live position table.
  resolve(anchorId: string): { file: string; line: number } | null;
}

// Model-facing / client-facing annotated rendering.
export interface AnnotatedFile {
  file: string;
  lines: AnnotatedLine[];
}

export interface AnnotatedLine {
  anchor: string | null;
  new_line: number | null;
  marker: "+" | "-" | " ";
  text: string;
}
