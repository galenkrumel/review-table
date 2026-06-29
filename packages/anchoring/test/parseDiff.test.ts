import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/parseDiff";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(resolve(here, "../../../fixtures/sample.diff"), "utf8");

describe("parseUnifiedDiff (standing sample.diff)", () => {
  const { anchorTable, files } = parseUnifiedDiff(sample);

  it("parses one file with its path from the +++ header", () => {
    expect(files).toHaveLength(1);
    expect(files[0]!.file).toBe("src/auth/session.ts");
  });

  it("creates two hunks with correct new-file ranges", () => {
    expect(Object.keys(anchorTable.hunks).sort()).toEqual(["h1", "h2"]);
    expect(anchorTable.hunks.h1).toMatchObject({
      file: "src/auth/session.ts",
      start_line: 10,
      end_line: 17,
    });
    expect(anchorTable.hunks.h2).toMatchObject({
      file: "src/auth/session.ts",
      start_line: 45,
      end_line: 53,
    });
  });

  it("anchors a049 to new-file line 49 as an added line in hunk h2", () => {
    expect(anchorTable.anchors.a049).toEqual({
      file: "src/auth/session.ts",
      new_line: 49,
      change: "added",
      hunk: "h2",
    });
  });

  it("marks context lines as context", () => {
    expect(anchorTable.anchors.a047).toMatchObject({ new_line: 47, change: "context" });
  });

  it("gives deleted lines a marker but no anchor and no new_line", () => {
    const deleted = files[0]!.lines.filter((l) => l.marker === "-");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.text).toContain("const claims = decode(token);");
    expect(deleted[0]!.anchor).toBeNull();
    expect(deleted[0]!.new_line).toBeNull();
  });

  it("does not advance new_line across a deleted line", () => {
    // The added line right after the deletion is line 13 (10 blank, 11 fn, 12 token, 13 +claims!).
    const added13 = files[0]!.lines.find((l) => l.new_line === 13);
    expect(added13!.marker).toBe("+");
    expect(added13!.text).toContain("decode(token)!");
  });

  it("keeps new_line numbering monotonic and gapped between hunks", () => {
    const nums = files[0]!.lines.map((l) => l.new_line).filter((n): n is number => n != null);
    // strictly increasing
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
    // there is a gap between hunk 1 (…17) and hunk 2 (45…)
    expect(nums).toContain(17);
    expect(nums).toContain(45);
    expect(nums).not.toContain(30);
  });

  it("every anchor id maps back to an existing line entry", () => {
    for (const [id, entry] of Object.entries(anchorTable.anchors)) {
      const line = files[0]!.lines.find((l) => l.anchor === id);
      expect(line, `annotated line for ${id}`).toBeDefined();
      expect(line!.new_line).toBe(entry.new_line);
    }
  });
});
