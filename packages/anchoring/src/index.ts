// @review-table/anchoring — the single coordinate system for code (CLAUDE.md
// invariant 2). Parse a diff once into an AnchorTable; every consumer references
// opaque anchor ids; one resolver maps ids → editor positions. Used by the server
// (parse, model-render) and the client (resolver, highlight validation).

export { type ParsedDiff, parseUnifiedDiff } from "./parseDiff";
export { renderFileForModel, renderFilesForModel } from "./render";
export { createResolver } from "./resolver";
export {
  anchorExists,
  anchorsInHunk,
  clampAnchorToHunk,
  resolveHighlightAnchors,
  type ValidationResult,
  validateAnchors,
} from "./validate";
