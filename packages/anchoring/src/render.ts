// Model-facing annotated rendering. The id sits in front of
// each line so the model copies it instead of inferring a number; one number column
// (new-file line) only; the marker is a status flag, not a second coordinate.
// Deleted lines carry a marker but no id/number. Distant unchanged regions between
// hunks are collapsed in the VIEW (a "⋯" divider) while numbering is preserved.
//
//   src/auth/session.ts
//     a047  47 │   const token = …
//     a049  49 │+      s.expiresAt = …
//           ⋯
//     a060  60 │   return s;

import type { AnnotatedFile } from "@review-table/contracts";

export function renderFileForModel(file: AnnotatedFile): string {
  const idWidth = Math.max(4, ...file.lines.map((l) => (l.anchor ? l.anchor.length : 0)));
  const numWidth = Math.max(
    2,
    ...file.lines.map((l) => (l.new_line != null ? String(l.new_line).length : 0)),
  );

  const out: string[] = [file.file];
  let prevNum: number | null = null;

  for (const line of file.lines) {
    // Collapse the view across a gap in new-file numbering (between hunks).
    if (line.new_line != null && prevNum != null && line.new_line > prevNum + 1) {
      out.push(`  ${" ".repeat(idWidth)}  ${" ".repeat(numWidth)} ⋯`);
    }
    const id = (line.anchor ?? "").padStart(idWidth, " ");
    const num = (line.new_line != null ? String(line.new_line) : "").padStart(numWidth, " ");
    out.push(`  ${id}  ${num} │${line.marker}${line.text}`);
    if (line.new_line != null) prevNum = line.new_line;
  }

  return out.join("\n");
}

export function renderFilesForModel(files: AnnotatedFile[]): string {
  return files.map(renderFileForModel).join("\n\n");
}
