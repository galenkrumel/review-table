// Anchor validation + clamp-to-hunk (ARCHITECTURE.md §7).
// Every emitted anchor is validated against the table; on a miss, clamp to the focus
// hunk so the editor never scrolls to a nonexistent line. Never throws.

import type { AnchorTable } from "@review-table/contracts";

export function anchorExists(id: string, table: AnchorTable): boolean {
  return id in table.anchors;
}

export interface ValidationResult {
  valid: string[];
  invalid: string[];
}

export function validateAnchors(ids: string[], table: AnchorTable): ValidationResult {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const id of ids) (anchorExists(id, table) ? valid : invalid).push(id);
  return { valid, invalid };
}

/** All anchor ids that belong to a given hunk, ordered by new-file line. */
export function anchorsInHunk(hunkId: string, table: AnchorTable): string[] {
  return Object.entries(table.anchors)
    .filter(([, e]) => e.hunk === hunkId)
    .sort((a, b) => a[1].new_line - b[1].new_line)
    .map(([id]) => id);
}

/**
 * Clamp an invalid anchor into its focus hunk: return the first anchor of that hunk
 * (the editor highlights within the hunk rather than nowhere). Returns null if the
 * hunk has no citable anchors — caller drops the id.
 */
export function clampAnchorToHunk(hunkId: string, table: AnchorTable): string | null {
  const inHunk = anchorsInHunk(hunkId, table);
  return inHunk[0] ?? null;
}

/**
 * Resolve a set of emitted anchors for the editor highlight: keep valid ids; clamp
 * invalid ones into the focus hunk when known; silently drop anything unresolvable.
 * This is the central, never-throwing path the highlight logic uses.
 */
export function resolveHighlightAnchors(
  ids: string[],
  table: AnchorTable,
  focusHunk?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    let resolved: string | null = null;
    if (anchorExists(id, table)) resolved = id;
    else if (focusHunk) resolved = clampAnchorToHunk(focusHunk, table);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}
