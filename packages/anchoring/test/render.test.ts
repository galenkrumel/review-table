import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/parseDiff";
import { renderFileForModel } from "../src/render";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(resolve(here, "../../../fixtures/sample.diff"), "utf8");
const { files } = parseUnifiedDiff(sample);
const rendered = renderFileForModel(files[0]!);

describe("renderFileForModel", () => {
  it("puts the anchor id and new-file number in the gutter, marker as a flag", () => {
    expect(rendered).toContain("src/auth/session.ts");
    // a049 added line shows id, number 49, and the "+" marker.
    const line49 = rendered.split("\n").find((l) => l.includes("a049"));
    expect(line49).toBeDefined();
    expect(line49).toMatch(/a049\s+49 │\+/);
  });

  it("collapses the gap between hunks with a divider while preserving numbering", () => {
    expect(rendered).toContain("⋯");
    // numbering is not renumbered: 17 (end of h1) and 45 (start of h2) both appear.
    expect(rendered).toMatch(/ 17 │/);
    expect(rendered).toMatch(/ 45 │/);
  });

  it("renders a deleted line with a marker but no id/number", () => {
    const del = rendered.split("\n").find((l) => l.includes("decode(token);") && l.includes("│-"));
    expect(del).toBeDefined();
    expect(del).not.toMatch(/a\d{3}/); // no anchor id on the deleted line
  });
});
