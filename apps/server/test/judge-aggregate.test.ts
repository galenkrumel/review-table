import { describe, expect, it } from "vitest";
import {
  aggregateJudge,
  cohensKappa,
  type Finding,
  type JudgeResult,
  judgeFamily,
  kappaBand,
  priceFor,
  snapshotPath,
} from "../src/eval/run-eval";

// aggregateJudge collapses k judge samples (each a full JudgeResult) into one MODAL verdict
// plus a variance record. These tests pin the majority/plurality/tie-break rules and the
// stability flag — the whole reason EVAL_JUDGE_RUNS exists is to make judge noise visible
// and turn a set of noisy draws into a deterministic verdict, so that logic must be exact.

/** Minimal Finding — aggregateJudge only reads `finding_id`; the rest is shape-filling. */
function f(id: string): Finding {
  return { finding_id: id, opener_seat: "rex", seats: ["rex"], moves: [], lines: [], text: "" };
}

const matched = (gt_id: string, finding_id: string) => ({ gt_id, finding_id, rationale: "" });
const fp = (finding_id: string) => ({ finding_id, rationale: "" });
const bonus = (finding_id: string) => ({ finding_id, rationale: "" });
const sample = (
  m: JudgeResult["matched"],
  fps: JudgeResult["false_positives"],
  bs: JudgeResult["bonus"],
): JudgeResult => ({ matched: m, false_positives: fps, bonus: bs });

describe("aggregateJudge — recall (majority match)", () => {
  it("counts a bug as caught only when a majority of samples matched it", () => {
    const findings = [f("t1"), f("t2")];
    const samples = [
      sample([matched("bug", "t1")], [], []), // caught
      sample([matched("bug", "t1")], [], []), // caught
      sample([], [fp("t1")], []), // not caught this draw
    ];
    const { judge } = aggregateJudge(samples, findings);
    // 2/3 majority → caught, and the modal finding_id (t1) is the credited match.
    expect(judge.matched).toEqual([
      { gt_id: "bug", finding_id: "t1", rationale: "modal match in 2/3 samples" },
    ]);
  });

  it("drops a bug matched in only a minority of samples", () => {
    const findings = [f("t1")];
    const samples = [
      sample([matched("bug", "t1")], [], []), // caught 1/3
      sample([], [], [bonus("t1")]),
      sample([], [fp("t1")], []),
    ];
    const { judge } = aggregateJudge(samples, findings);
    expect(judge.matched).toEqual([]);
  });

  it("picks the modal finding_id when different samples match the same bug differently", () => {
    const findings = [f("t1"), f("t2")];
    const samples = [
      sample([matched("bug", "t1")], [], []),
      sample([matched("bug", "t1")], [], []),
      sample([matched("bug", "t2")], [], []),
    ];
    const { judge } = aggregateJudge(samples, findings);
    // bug caught 3/3; t1 (2) beats t2 (1) as the credited finding.
    expect(judge.matched).toEqual([
      { gt_id: "bug", finding_id: "t1", rationale: "modal match in 3/3 samples" },
    ]);
  });
});

describe("aggregateJudge — precision (plurality role)", () => {
  it("labels a finding by its plurality role across samples", () => {
    const findings = [f("t1")];
    const samples = [
      sample([], [fp("t1")], []),
      sample([], [fp("t1")], []),
      sample([], [], [bonus("t1")]),
    ];
    const { judge } = aggregateJudge(samples, findings);
    expect(judge.false_positives.map((x) => x.finding_id)).toEqual(["t1"]);
    expect(judge.bonus).toEqual([]);
  });

  it("breaks an fp/bonus tie toward false_positive (surface the precision hit)", () => {
    const findings = [f("t1")];
    const samples = [
      sample([], [fp("t1")], []), // fp
      sample([], [], [bonus("t1")]), // bonus  → 1-1 tie
    ];
    const { judge } = aggregateJudge(samples, findings);
    expect(judge.false_positives.map((x) => x.finding_id)).toEqual(["t1"]);
    expect(judge.bonus).toEqual([]);
  });

  it("omits a finding that is neither a confident catch nor a confident fp/bonus", () => {
    const findings = [f("t1")];
    // matched (sub-majority) twice, dropped once → plurality role is 'matched', not fp/bonus.
    const samples = [
      sample([matched("bug", "t1")], [], []),
      sample([matched("bug", "t1")], [], []),
      sample([], [], []),
    ];
    const { judge } = aggregateJudge(samples, findings);
    // bug reaches majority (2/3) so t1 is a match, not an fp/bonus.
    expect(judge.matched.map((m) => m.finding_id)).toEqual(["t1"]);
    expect(judge.false_positives).toEqual([]);
    expect(judge.bonus).toEqual([]);
  });

  it("never lists a majority-matched finding as fp or bonus", () => {
    const findings = [f("t1")];
    const samples = [
      sample([matched("bug", "t1")], [], []),
      sample([matched("bug", "t1")], [], []),
      sample([], [fp("t1")], []), // a stray fp draw must not leak through
    ];
    const { judge } = aggregateJudge(samples, findings);
    expect(judge.matched.map((m) => m.finding_id)).toEqual(["t1"]);
    expect(judge.false_positives).toEqual([]);
  });
});

describe("snapshot naming", () => {
  it("maps model ids to short families matching the existing .haiku/.opus/.sonnet convention", () => {
    expect(judgeFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(judgeFamily("claude-opus-4-8")).toBe("opus");
    expect(judgeFamily("claude-sonnet-5")).toBe("sonnet");
    expect(judgeFamily("claude-fable-5")).toBe("fable");
  });

  it("falls back to a sanitized id for an unknown family (no silent collision)", () => {
    expect(judgeFamily("some-other/model:v2")).toBe("some-other_model_v2");
  });

  it("names the snapshot by family, appending the sample count only when >1", () => {
    expect(snapshotPath("claude-haiku-4-5-20251001", 1)).toMatch(/EVAL-REPORT\.haiku\.md$/);
    expect(snapshotPath("claude-sonnet-5", 5)).toMatch(/EVAL-REPORT\.sonnet\.5x\.md$/);
    expect(snapshotPath("claude-opus-4-8", 3)).toMatch(/EVAL-REPORT\.opus\.3x\.md$/);
  });

  it("never collides the snapshot with the canonical EVAL-REPORT.md", () => {
    expect(snapshotPath("claude-opus-4-8", 1)).not.toMatch(/[/\\]EVAL-REPORT\.md$/);
  });
});

describe("priceFor — per-model cost rates", () => {
  it("prices each model at its OWN list rate (the judge is not billed at the dog rate)", () => {
    // The whole point of per-model tracking: a Sonnet judge must cost Sonnet money, not Opus money.
    expect(priceFor("claude-opus-4-8")).toEqual({ in: 5, out: 25 }); // dogs
    expect(priceFor("claude-sonnet-5")).toEqual({ in: 3, out: 15 }); // default judge — cheaper than dogs
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ in: 1, out: 5 });
    expect(priceFor("claude-fable-5")).toEqual({ in: 10, out: 50 }); // most expensive, not cheapest
  });

  it("falls back to Opus-tier for an unknown model so it over- rather than under-estimates", () => {
    expect(priceFor("some-future-model")).toEqual({ in: 5, out: 25 });
  });
});

describe("cohensKappa — human vs judge agreement", () => {
  const CATS = ["caught", "fp", "bonus", "ignore"];

  it("returns κ = 1 on perfect agreement", () => {
    const pairs: [string, string][] = [
      ["caught", "caught"],
      ["fp", "fp"],
      ["bonus", "bonus"],
      ["caught", "caught"],
    ];
    const { kappa, po } = cohensKappa(pairs, CATS);
    expect(po).toBe(1);
    expect(kappa).toBe(1);
  });

  it("corrects for chance: high raw agreement on a skewed mix yields a modest κ", () => {
    // 9/10 agree, but almost everything is 'caught', so a lot of that agreement is expected by chance.
    const pairs: [string, string][] = [
      ...Array.from({ length: 8 }, () => ["caught", "caught"] as [string, string]),
      ["fp", "caught"], // one disagreement
      ["fp", "fp"],
    ];
    const { po, kappa } = cohensKappa(pairs, CATS);
    expect(po).toBeCloseTo(0.9, 5);
    // chance agreement is high here, so κ sits well below the 0.9 raw number.
    expect(kappa).toBeLessThan(0.9);
    expect(kappa).toBeGreaterThan(0);
  });

  it("gives κ ≈ 0 when agreement is no better than chance", () => {
    // Judge always says 'caught'; human is split 50/50 — every agreement is pure chance.
    const pairs: [string, string][] = [
      ["caught", "caught"],
      ["fp", "caught"],
      ["caught", "caught"],
      ["fp", "caught"],
    ];
    const { kappa } = cohensKappa(pairs, CATS);
    expect(kappa).toBeCloseTo(0, 5);
  });

  it("skips pairs whose label is outside the category set, and handles the empty case", () => {
    expect(cohensKappa([], CATS)).toEqual({ n: 0, po: 0, pe: 0, kappa: 0 });
    const { n } = cohensKappa(
      [
        ["caught", "caught"],
        ["bogus", "fp"],
      ],
      CATS,
    );
    expect(n).toBe(1); // the bogus-label pair is dropped
  });

  it("maps κ to Landis & Koch bands", () => {
    expect(kappaBand(-0.1)).toMatch(/poor/);
    expect(kappaBand(0.1)).toBe("slight");
    expect(kappaBand(0.5)).toBe("moderate");
    expect(kappaBand(0.7)).toBe("substantial");
    expect(kappaBand(0.9)).toBe("almost perfect");
  });
});

describe("aggregateJudge — variance", () => {
  it("reports per-sample spreads and flags instability", () => {
    const findings = [f("t1"), f("t2")];
    const samples = [
      sample([matched("bug", "t1")], [fp("t2")], []), // caught 1, fp 1, bonus 0
      sample([matched("bug", "t1")], [], [bonus("t2")]), // caught 1, fp 0, bonus 1
    ];
    const { variance } = aggregateJudge(samples, findings);
    expect(variance.runs).toBe(2);
    expect(variance.caught).toEqual([1, 1]);
    expect(variance.fp).toEqual([1, 0]);
    expect(variance.bonus).toEqual([0, 1]);
    expect(variance.stable).toBe(false); // fp and bonus counts differ across samples
  });

  it("flags stability when every sample agrees on the totals", () => {
    const findings = [f("t1")];
    const samples = [
      sample([matched("bug", "t1")], [], []),
      sample([matched("bug", "t1")], [], []),
    ];
    const { variance } = aggregateJudge(samples, findings);
    expect(variance.stable).toBe(true);
    expect(variance.caught).toEqual([1, 1]);
    expect(variance.fp).toEqual([0, 0]);
  });
});
