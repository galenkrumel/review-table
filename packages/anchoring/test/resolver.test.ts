import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/parseDiff";
import { createResolver } from "../src/resolver";
import { clampAnchorToHunk, resolveHighlightAnchors, validateAnchors } from "../src/validate";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(resolve(here, "../../../fixtures/sample.diff"), "utf8");
const { anchorTable } = parseUnifiedDiff(sample);

describe("resolver (near-identity)", () => {
  const resolver = createResolver(anchorTable);

  it("resolves a049 to line 49", () => {
    expect(resolver.resolve("a049")).toEqual({ file: "src/auth/session.ts", line: 49 });
  });

  it("returns null for an unknown anchor (never throws)", () => {
    expect(resolver.resolve("a999")).toBeNull();
  });
});

describe("validation + clamp-to-hunk", () => {
  it("separates valid from invalid anchors", () => {
    const { valid, invalid } = validateAnchors(["a049", "a999"], anchorTable);
    expect(valid).toEqual(["a049"]);
    expect(invalid).toEqual(["a999"]);
  });

  it("clamps an out-of-range anchor to the first anchor of its focus hunk", () => {
    // h2 spans 45..53; its first anchor is line 45.
    const clamped = clampAnchorToHunk("h2", anchorTable);
    expect(clamped).toBe("a045");
  });

  it("resolveHighlightAnchors clamps invalid ids into the focus hunk instead of throwing", () => {
    const out = resolveHighlightAnchors(["a999"], anchorTable, "h2");
    expect(out).toEqual(["a045"]);
  });

  it("resolveHighlightAnchors keeps valid ids and drops unresolvable ones with no hunk hint", () => {
    expect(resolveHighlightAnchors(["a049", "a999"], anchorTable)).toEqual(["a049"]);
  });

  it("resolveHighlightAnchors dedupes", () => {
    expect(resolveHighlightAnchors(["a049", "a049"], anchorTable)).toEqual(["a049"]);
  });
});
