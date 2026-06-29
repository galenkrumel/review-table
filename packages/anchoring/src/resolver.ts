// The resolver — the single seam between opaque anchor ids and editor positions
// (ARCHITECTURE.md §7, CLAUDE.md invariant 2). MVP is near-identity: look the id up
// in the table and return its frozen new-file line. v2 (live edit) swaps only this.

import type { AnchorTable, Resolver } from "@review-table/contracts";

export function createResolver(table: AnchorTable): Resolver {
  return {
    resolve(anchorId: string) {
      const entry = table.anchors[anchorId];
      return entry ? { file: entry.file, line: entry.new_line } : null;
    },
  };
}
