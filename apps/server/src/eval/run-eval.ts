// Eval harness: run the real multi-dog review over a labeled set of diffs and
// measure catch-rate (recall) and false positives (precision), with a per-persona
// breakdown. Drives the SAME orchestrator the app uses (apps/server/src/orchestrator.ts)
// headless — real Anthropic LlmAdapter, stubbed TTS/STT (no ElevenLabs needed). An
// LLM-as-judge semantically matches the dogs' raised findings to the planted ground
// truth. Raw transcripts + judge verdicts are cached under fixtures/eval/.runs/ so the
// report re-generates without new LLM calls.
//
// Usage (from apps/server):
//   npx tsx src/eval/run-eval.ts            # run (uses caches where present)
//   npx tsx src/eval/run-eval.ts --fresh    # ignore caches, re-run everything
//   npx tsx src/eval/run-eval.ts --cases=security-sql-injection,clean-rename
//   npx tsx src/eval/run-eval.ts --fresh --label="pre-routing baseline"  # records the
//                                           # experiment in the history row (or EVAL_LABEL=)
//   npx tsx src/eval/run-eval.ts --diff-judges=claude-haiku-4-5-20251001,claude-opus-4-8
//                                           # re-judge cached transcripts with two models;
//                                           # writes the disagreement reading-list (bare = defaults)
//   EVAL_JUDGE_RUNS=5 npx tsx src/eval/run-eval.ts  # judge each case 5× and report the MODAL
//                                           # verdict + per-case variance — tames judge non-determinism
//                                           # (works with any JUDGE_MODEL: haiku, sonnet, opus)
//   Every run writes EVAL-REPORT.md (canonical latest) AND an auto-snapshot named by judge +
//   sample count, e.g. JUDGE_MODEL=claude-sonnet-5 EVAL_JUDGE_RUNS=5 → EVAL-REPORT.sonnet.5x.md.
//   Same config overwrites its own snapshot; no more manual `cp`.
//   npx tsx src/eval/run-eval.ts --check    # validate every expected.json, exit non-zero on error
//   npx tsx src/eval/run-eval.ts --mark=<case> --category=<c> --line=<path:line> --desc="…" [--must-catch]
//                                           # append a ground-truth issue to a case (promote a finding)

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@review-table/anchoring";
import type {
  AnchorTable,
  IssueSummary,
  JsonSchema,
  LlmAdapter,
  Move,
  ServerMessage,
  SttAdapter,
  TtsAdapter,
  Verdict,
} from "@review-table/contracts";
import { setAdapters } from "../adapters";
import { AnthropicLlmAdapter } from "../adapters/anthropic";
import { AI_SEATS, displayName } from "../config";
import { ReviewControls } from "../control";
import { ANTHROPIC_MODEL, JUDGE_MODEL } from "../env";
import { runReview, type TurnSink } from "../orchestrator";

const here = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(here, "../../../../fixtures/eval");
const RUNS_DIR = resolve(EVAL_DIR, ".runs");
const REPORT_PATH = resolve(here, "../../../../EVAL-REPORT.md");
// Committed, append-only ledger of past runs so the report can show results over time.
const HISTORY_PATH = resolve(EVAL_DIR, "history.jsonl");

// Short, stable label for a judge model — matches the hand-rolled EVAL-REPORT.haiku.md /
// .opus.md snapshot names so auto-snapshots slot into the existing convention (and overwrite
// those files rather than sit beside them). Unknown families fall back to the sanitized id so
// two distinct models never silently share one snapshot.
export function judgeFamily(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  if (m.includes("fable")) return "fable";
  return sanitizeModel(modelId);
}

// Where to also write a per-(judge model, sample count) snapshot alongside the canonical
// EVAL-REPORT.md — so switching judges no longer needs a manual `cp`. Re-running the same
// config overwrites its own snapshot (idempotent): one file per config, no proliferation.
// e.g. judge=claude-sonnet-5, EVAL_JUDGE_RUNS=5 → EVAL-REPORT.sonnet.5x.md.
export function snapshotPath(modelId: string, runs: number): string {
  const suffix = runs > 1 ? `.${runs}x` : "";
  return REPORT_PATH.replace(/\.md$/, `.${judgeFamily(modelId)}${suffix}.md`);
}

// Moves that constitute a "raised finding" (a substantive concern about the code).
const RAISE_MOVES: ReadonlySet<Move> = new Set(["raise_issue", "pushback", "pile_on", "nitpick"]);

// Each dog seat's specialty, for the per-persona "does it earn its keep" view.
const SPECIALTY: Record<string, "correctness" | "security" | "performance"> = {
  rex: "correctness",
  bella: "security",
  duke: "performance",
};

// A neutral, non-committal author reply for when the director gives the human the
// floor. Deliberately does not confirm or deny any concern, so it neither suppresses
// real catches nor manufactures issues.
const AUTHOR_REPLY =
  "I'd have to double-check that path — assume nothing upstream guarantees it. Carry on.";

const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4);

// How many times to judge each case. >1 samples the judge's non-determinism (the API runs at
// default temperature, so repeat judgements genuinely differ) and reports a MODAL verdict plus
// the per-case spread, instead of trusting one noisy draw. A single re-judge cannot tell a real
// rubric change from run-to-run wobble; N samples turn that wobble into a visible error bar.
const JUDGE_RUNS = Math.max(1, Math.floor(Number(process.env.EVAL_JUDGE_RUNS ?? 1)) || 1);

// ── Types ─────────────────────────────────────────────────────────────────────

type Category = "correctness" | "security" | "performance";
type Severity = "low" | "med" | "high";

interface GtIssue {
  id: string;
  category: Category;
  severity: Severity;
  line_hint: string;
  description: string;
  must_catch: boolean;
}
interface Expected {
  clean: boolean;
  issues: GtIssue[];
}

interface CapturedTurn {
  seat_id: string;
  move: Move;
  thread_id: string | null;
  focus_anchors: string[];
  text: string;
}

interface RunCache {
  case: string;
  clean: boolean;
  model: string;
  run_at: string;
  turns: CapturedTurn[];
  verdict: Verdict | null;
  issues: IssueSummary[];
  error?: string;
}

// One raised finding = one thread (collapsed across its turns).
export interface Finding {
  finding_id: string; // thread_id, or a synthetic id for thread-less turns
  opener_seat: string; // the seat that surfaced it (raise_issue, else first speaker)
  seats: string[];
  moves: Move[];
  lines: number[]; // diff line numbers the finding's anchors resolve to
  text: string; // the dogs' dialogue across the thread
}

export interface JudgeResult {
  matched: { gt_id: string; finding_id: string; rationale: string }[];
  false_positives: { finding_id: string; rationale: string }[];
  bonus: { finding_id: string; rationale: string }[];
}

// The spread of a case's judge samples when EVAL_JUDGE_RUNS>1. `judge` above is the collapsed
// MODAL verdict; this records the raw per-sample counts so the report can show how much the
// judge disagreed with itself (the whole point of sampling — noise you can see, not hide).
export interface JudgeVariance {
  runs: number; // how many judge samples were taken
  fp: number[]; // false-positive count per sample
  bonus: number[]; // bonus count per sample
  caught: number[]; // # distinct ground-truth bugs matched per sample
  stable: boolean; // did every sample agree on fp/bonus/caught totals?
}

interface CaseResult {
  name: string;
  clean: boolean;
  expected: Expected;
  findings: Finding[];
  judge: JudgeResult; // when sampled >1×, this is the collapsed modal verdict
  variance?: JudgeVariance; // present only when EVAL_JUDGE_RUNS>1
  ranFresh: boolean; // did this invocation drive the transcript live (vs. load from cache)?
  error?: string;
}

// ── Usage tracking ──────────────────────────────────────────────────────────

interface ModelUsage {
  inChars: number;
  outChars: number;
  calls: number;
}

/**
 * Char tally kept PER model_id. The dogs run on ANTHROPIC_MODEL and the judge on JUDGE_MODEL, which
 * are usually different models at different prices; blending them into one bucket and pricing it all
 * at the dog rate (as this used to) makes cross-judge cost comparison meaningless. Keying by model lets
 * `score` price each model's tokens at its OWN rate and split the dog vs judge spend.
 */
class Usage {
  readonly byModel = new Map<string, ModelUsage>();
  private bucket(model: string): ModelUsage {
    let u = this.byModel.get(model);
    if (!u) {
      u = { inChars: 0, outChars: 0, calls: 0 };
      this.byModel.set(model, u);
    }
    return u;
  }
  /** One call's input; also ticks the call count. */
  addIn(model: string, chars: number): void {
    const b = this.bucket(model);
    b.inChars += chars;
    b.calls += 1;
  }
  addOut(model: string, chars: number): void {
    this.bucket(model).outChars += chars;
  }
  get calls(): number {
    let n = 0;
    for (const u of this.byModel.values()) n += u.calls;
    return n;
  }
}

/** Wraps the real LlmAdapter to keep a rough per-model token/cost tally (chars/4 estimate). */
class TrackingLlmAdapter implements LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly usage: Usage,
  ) {}
  async completeStructured<T>(args: Parameters<LlmAdapter["completeStructured"]>[0]): Promise<T> {
    const inChars = args.system.length + args.messages.reduce((a, m) => a + m.text.length, 0);
    this.usage.addIn(args.model_id, inChars);
    const r = await this.inner.completeStructured<T>(args);
    this.usage.addOut(args.model_id, JSON.stringify(r).length);
    return r;
  }
  async *streamText(args: Parameters<LlmAdapter["streamText"]>[0]): AsyncIterable<string> {
    const inChars = args.system.length + args.messages.reduce((a, m) => a + m.text.length, 0);
    this.usage.addIn(args.model_id, inChars);
    for await (const d of this.inner.streamText(args)) {
      this.usage.addOut(args.model_id, d.length);
      yield d;
    }
  }
}

/**
 * List price per MTok (USD) as input/output. Source: the claude-api skill pricing table (cached
 * 2026-06). Sonnet 5 also has intro pricing ($2/$10) through 2026-08-31 — we use standard list so the
 * number isn't date-dependent, which keeps this a conservative upper bound. An unknown model id falls
 * back to Opus-tier so an unpriced model over-estimates rather than silently reads as free.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
export function priceFor(modelId: string): { in: number; out: number } {
  return PRICING[modelId] ?? { in: 5, out: 25 };
}

/** TTS/STT stubs — the eval only needs the text transcript, never audio. */
class NoopTtsAdapter implements TtsAdapter {
  async *streamSpeech(): AsyncIterable<Uint8Array> {
    // yield nothing
  }
}
class NoopSttAdapter implements SttAdapter {
  async transcribe(): Promise<string> {
    return "";
  }
}

// ── Orchestrator driving ──────────────────────────────────────────────────────

/** Run the real review loop on one diff, capturing the transcript from the wire. */
async function runOrchestrator(
  llm: LlmAdapter,
  diff: string,
): Promise<{ turns: CapturedTurn[]; verdict: Verdict | null; issues: IssueSummary[] }> {
  setAdapters({ llm, tts: new NoopTtsAdapter(), stt: new NoopSttAdapter() });
  const { anchorTable, files } = parseUnifiedDiff(diff);
  const controls = new ReviewControls();

  const turns: CapturedTurn[] = [];
  let cur: CapturedTurn | null = null;
  let verdict: Verdict | null = null;
  let issues: IssueSummary[] = [];

  const sink: TurnSink = {
    send(m: ServerMessage) {
      switch (m.type) {
        case "turn_start":
          cur = {
            seat_id: m.seat_id,
            move: m.move,
            thread_id: m.thread_id ?? null,
            focus_anchors: m.focus_anchors,
            text: "",
          };
          break;
        case "text_delta":
          if (cur && m.seat_id === cur.seat_id) cur.text += m.delta;
          break;
        case "turn_end":
          if (cur) {
            cur.text = cur.text.trim();
            turns.push(cur);
            cur = null;
          }
          controls.turnPlayed(); // ack pacing so the next turn proceeds
          break;
        case "awaiting_human":
          controls.submitHuman(AUTHOR_REPLY);
          break;
        case "review_complete":
          verdict = m.verdict;
          issues = m.issues;
          break;
      }
    },
    sendBinary() {
      // audio frames ignored
    },
  };

  await runReview(sink, anchorTable, files, controls);
  return { turns, verdict, issues };
}

// ── Findings ──────────────────────────────────────────────────────────────────

function resolveLine(anchorTable: AnchorTable, anchorId: string): number | null {
  const entry =
    anchorTable.anchors[anchorId] ?? anchorTable.anchors[anchorId.replace(/-h\d+$/, "")];
  return entry ? entry.new_line : null;
}

/** Collapse raised turns into per-thread findings. */
function buildFindings(turns: CapturedTurn[], anchorTable: AnchorTable): Finding[] {
  const raised = turns.filter((t) => RAISE_MOVES.has(t.move));
  const groups = new Map<string, CapturedTurn[]>();
  let synthetic = 0;
  for (const t of raised) {
    const key = t.thread_id ?? `__loose_${synthetic++}`;
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  const findings: Finding[] = [];
  for (const [finding_id, grp] of groups) {
    const opener = grp.find((t) => t.move === "raise_issue") ?? grp[0]!;
    const seats = [...new Set(grp.map((t) => t.seat_id))];
    const anchors = [...new Set(grp.flatMap((t) => t.focus_anchors))];
    const lines = [
      ...new Set(
        anchors.map((a) => resolveLine(anchorTable, a)).filter((n): n is number => n != null),
      ),
    ].sort((a, b) => a - b);
    const text = grp.map((t) => `[${displayName(t.seat_id)}/${t.move}] ${t.text}`).join("\n");
    findings.push({
      finding_id,
      opener_seat: opener.seat_id,
      seats,
      moves: grp.map((t) => t.move),
      lines,
      text,
    });
  }
  return findings;
}

// ── Judge ─────────────────────────────────────────────────────────────────────

const JUDGE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    matched: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          gt_id: { type: "string" },
          finding_id: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["gt_id", "finding_id", "rationale"],
      },
    },
    false_positives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          finding_id: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["finding_id", "rationale"],
      },
    },
    bonus: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          finding_id: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["finding_id", "rationale"],
      },
    },
  },
  required: ["matched", "false_positives", "bonus"],
};

const JUDGE_SYSTEM = `You are a rigorous, impartial judge scoring an AI code review. You are given the
GROUND TRUTH list of bugs planted in a unified DIFF, the DIFF itself, and the FINDINGS the reviewers
raised. Decide, semantically (NOT by string or line-number exact match), which findings correspond to
which planted bugs — and, for the rest, use the DIFF to tell a valid concern from a hallucination.

The GROUND TRUTH is authoritative for what was PLANTED: do not invent new planted bugs from the diff,
and do not un-match a finding because your own reading of the code disagrees with the ground truth. Use
the DIFF only to VERIFY unmatched findings (is this real code behaviour or a mistaken claim?), never to
override the matched/ground-truth relationship.

Rules:
- Match a finding to a ground-truth bug when it describes the SAME underlying defect, even if worded
  differently or pointing at a nearby line. A finding may reference the right code but explain it loosely;
  still match it if a competent engineer would agree it is the same bug.
- Each ground-truth bug may be matched by AT MOST ONE finding. If several findings describe the SAME
  bug, match the single best one; every other finding that restates or piles onto that already-matched
  bug is ALREADY COVERED — DROP it entirely (omit it from matched, false_positives, AND bonus). A
  redundant re-mention of a bug that is already caught is NEVER a false positive and NEVER a bonus.
- A single finding MAY match MULTIPLE ground-truth bugs when it genuinely describes more than one
  DISTINCT planted defect (e.g. one review thread that raises two separate bugs in the same code).
  Emit one matched pair per bug, all sharing that finding_id. Do NOT stretch a finding to cover bugs
  it does not actually address — only match defects the finding really discusses.
- After matching, classify every REMAINING substantive finding (one that is neither matched above nor
  already-covered by a matched finding) as exactly one of:
    * false_positive: read against the DIFF, the finding is wrong — it claims a defect the code does not
      actually have, misreads what the code does, or is otherwise factually mistaken.
    * bonus: read against the DIFF, the finding is a genuine, valid concern about the real code that is
      absent from the ground truth and not already raised by another finding. This applies EVEN ON A
      CLEAN CONTROL (no planted bug): a real, valid concern the reviewers happened to surface is a bonus,
      NOT a false positive. The clean/buggy status of the diff does NOT decide this — the diff does. If a
      finding merely echoes a concern already matched or already counted, it is NOT a bonus — drop it.
  The fp-vs-bonus call is a judgement about the code, made from the DIFF: a valid observation about the
  actual code is a bonus; a claim the code contradicts is a false positive.
- Ignore purely cosmetic / stylistic nitpicks (naming, formatting, a missing comment) — do NOT classify
  them as false positives or bonus. Only substantive findings (real behavioral, security, or performance
  concerns) count.
Return strict JSON matching the schema.`;

function buildJudgeUser(
  name: string,
  clean: boolean,
  gt: GtIssue[],
  findings: Finding[],
  diff: string,
): string {
  const gtBlock = clean
    ? "NONE. This is a CLEAN control diff: there is no planted bug. Any substantive finding is a false positive."
    : gt
        .map(
          (g) =>
            `  - gt_id="${g.id}" [${g.category}/${g.severity}] near ${g.line_hint}\n    ${g.description}`,
        )
        .join("\n");
  const fBlock =
    findings.length === 0
      ? "  (the reviewers raised nothing)"
      : findings
          .map(
            (f) =>
              `  - finding_id="${f.finding_id}" raised_by=${f.seats
                .map(displayName)
                .join(
                  ", ",
                )} diff_lines=[${f.lines.join(", ")}]\n    dialogue: ${f.text.replace(/\n/g, "\n      ")}`,
          )
          .join("\n");
  return [
    `Case: ${name}${clean ? " (CLEAN CONTROL)" : ""}.`,
    ``,
    `DIFF under review (verify unmatched findings against this — is the concern real code behaviour or a misread?):`,
    "```diff",
    diff.trim(),
    "```",
    ``,
    `GROUND TRUTH planted bugs:`,
    gtBlock,
    ``,
    `FINDINGS the reviewers raised:`,
    fBlock,
    ``,
    `Produce the matched pairs, false positives, and bonus findings.`,
  ].join("\n");
}

async function judgeCase(
  llm: LlmAdapter,
  name: string,
  clean: boolean,
  gt: GtIssue[],
  findings: Finding[],
  diff: string,
  modelId: string = JUDGE_MODEL,
): Promise<JudgeResult> {
  if (findings.length === 0) return { matched: [], false_positives: [], bonus: [] };
  return llm.completeStructured<JudgeResult>({
    model_id: modelId,
    system: JUDGE_SYSTEM,
    messages: [
      { seat_id: "director", role: "user", text: buildJudgeUser(name, clean, gt, findings, diff) },
    ],
    schema: JUDGE_SCHEMA,
    cacheKey: "judge-rubric", // JUDGE_SYSTEM is constant across all cases
  });
}

/**
 * Judge one case `runs` times with `modelId`, caching each sample per (case, model, sample).
 * Sample 0 shares the single-run file `<case>.judge.<model>.json` used by --diff-judges, so a
 * prior judge-diff makes the main report's first sample free — and, crucially, the cache is now
 * keyed BY MODEL: switching JUDGE_MODEL (haiku→sonnet→opus) never silently reuses another model's
 * verdicts. Extra samples get a `.run<i>` suffix; all match the `*.judge*.json` reset glob.
 */
async function judgeSamples(
  llm: LlmAdapter,
  name: string,
  expected: Expected,
  findings: Finding[],
  diff: string,
  modelId: string,
  runs: number,
  fresh: boolean,
): Promise<JudgeResult[]> {
  const samples: JudgeResult[] = [];
  for (let i = 0; i < runs; i++) {
    const suffix = i === 0 ? "" : `.run${i}`;
    const path = resolve(RUNS_DIR, `${name}.judge.${sanitizeModel(modelId)}${suffix}.json`);
    let j = fresh ? null : loadJson<JudgeResult>(path);
    if (!j) {
      j = await judgeCase(llm, name, expected.clean, expected.issues, findings, diff, modelId);
      writeFileSync(path, JSON.stringify(j, null, 2));
    }
    samples.push(j);
  }
  return samples;
}

/**
 * Collapse k judge samples into one MODAL verdict + a variance record. Sampling exists because a
 * single re-judge cannot separate a real rubric effect from run-to-run noise; the modal rule makes
 * the reported verdict the one the judge lands on most often, and `variance` exposes the spread.
 *  - a ground-truth bug is "caught" iff a MAJORITY of samples matched it (modal finding_id wins);
 *  - each remaining finding takes its PLURALITY role across samples (fp / bonus / matched-but-not-
 *    majority / dropped). Ties break fp > bonus > matched > drop — deterministic, and biased toward
 *    surfacing a precision hit rather than letting noise bury it.
 */
export function aggregateJudge(
  samples: JudgeResult[],
  findings: Finding[],
): { judge: JudgeResult; variance: JudgeVariance } {
  const k = samples.length;
  const majority = Math.floor(k / 2) + 1;

  // ── recall track: per gt_id, which finding matched it and how often ──
  const gtHits = new Map<string, Map<string, number>>();
  for (const s of samples) {
    const seen = new Set<string>(); // guard a sample that lists the same (gt,finding) twice
    for (const m of s.matched) {
      const key = `${m.gt_id} ${m.finding_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inner = gtHits.get(m.gt_id) ?? new Map<string, number>();
      inner.set(m.finding_id, (inner.get(m.finding_id) ?? 0) + 1);
      gtHits.set(m.gt_id, inner);
    }
  }
  const matched: JudgeResult["matched"] = [];
  for (const [gt_id, inner] of gtHits) {
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    if (total < majority) continue; // matched only in a minority of samples → not confidently caught
    const [finding_id] = [...inner.entries()].sort((a, b) => b[1] - a[1])[0]!;
    matched.push({ gt_id, finding_id, rationale: `modal match in ${total}/${k} samples` });
  }
  const matchedFindingIds = new Set(matched.map((m) => m.finding_id));

  // ── precision track: per finding, its role distribution across samples ──
  const roles = new Map<string, Record<"fp" | "bonus" | "matched" | "drop", number>>();
  for (const s of samples) {
    const cls = classifyFindings(s); // finding_id -> bucket (caught / false positive / bonus)
    for (const f of findings) {
      const r = roles.get(f.finding_id) ?? { fp: 0, bonus: 0, matched: 0, drop: 0 };
      const b = cls.get(f.finding_id)?.bucket;
      if (b === "caught") r.matched++;
      else if (b === "false positive") r.fp++;
      else if (b === "bonus") r.bonus++;
      else r.drop++;
      roles.set(f.finding_id, r);
    }
  }
  const false_positives: JudgeResult["false_positives"] = [];
  const bonus: JudgeResult["bonus"] = [];
  for (const [fid, r] of roles) {
    if (matchedFindingIds.has(fid)) continue; // it landed a majority match; not fp/bonus
    // Array.sort is stable in V8, so equal counts keep this fp>bonus>matched>drop priority order.
    const winner = (["fp", "bonus", "matched", "drop"] as const)
      .map((role) => ({ role, n: r[role] }))
      .sort((a, b) => b.n - a.n)[0]!.role;
    if (winner === "fp") false_positives.push({ finding_id: fid, rationale: `FP in ${r.fp}/${k}` });
    else if (winner === "bonus")
      bonus.push({ finding_id: fid, rationale: `bonus in ${r.bonus}/${k}` });
    // matched-but-not-majority or drop → omit (neither a confident catch nor a confident miss)
  }

  const fp = samples.map((s) => s.false_positives.length);
  const bonusCounts = samples.map((s) => s.bonus.length);
  const caught = samples.map((s) => new Set(s.matched.map((m) => m.gt_id)).size);
  const stable =
    new Set(fp).size === 1 && new Set(bonusCounts).size === 1 && new Set(caught).size === 1;

  return {
    judge: { matched, false_positives, bonus },
    variance: { runs: k, fp, bonus: bonusCounts, caught, stable },
  };
}

// ── Per-case pipeline (with caching) ──────────────────────────────────────────

function loadJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

async function processCase(llm: LlmAdapter, name: string, fresh: boolean): Promise<CaseResult> {
  const diff = readFileSync(resolve(EVAL_DIR, name, "diff.patch"), "utf8");
  const expected = JSON.parse(
    readFileSync(resolve(EVAL_DIR, name, "expected.json"), "utf8"),
  ) as Expected;
  const { anchorTable } = parseUnifiedDiff(diff);
  const runPath = resolve(RUNS_DIR, `${name}.run.json`);

  // 1. Transcript (expensive multi-turn LLM run) — cache it.
  let ranFresh = false;
  let run = fresh ? null : loadJson<RunCache>(runPath);
  if (!run) {
    ranFresh = true;
    try {
      console.log(`[run]   ${name}: driving the review…`);
      const { turns, verdict, issues } = await runOrchestrator(llm, diff);
      run = {
        case: name,
        clean: expected.clean,
        model: ANTHROPIC_MODEL,
        run_at: new Date().toISOString(),
        turns,
        verdict,
        issues,
      };
      writeFileSync(runPath, JSON.stringify(run, null, 2));
      console.log(`[run]   ${name}: ${turns.length} turns, verdict=${verdict}`);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[run]   ${name}: ERROR ${msg}`);
      return {
        name,
        clean: expected.clean,
        expected,
        findings: [],
        judge: { matched: [], false_positives: [], bonus: [] },
        ranFresh,
        error: msg,
      };
    }
  } else {
    console.log(`[cache] ${name}: transcript (${run.turns.length} turns)`);
  }

  const findings = buildFindings(run.turns, anchorTable);

  // 2. Judge (LLM) — sample JUDGE_RUNS times with JUDGE_MODEL, cache each sample, collapse to the
  //    modal verdict. Cache is keyed by model, so JUDGE_MODEL swaps never reuse another model's verdicts.
  let judge: JudgeResult;
  let variance: JudgeVariance | undefined;
  if (findings.length === 0) {
    judge = { matched: [], false_positives: [], bonus: [] };
  } else {
    try {
      const tag = `${sanitizeModel(JUDGE_MODEL)}${JUDGE_RUNS > 1 ? ` ×${JUDGE_RUNS}` : ""}`;
      console.log(`[judge] ${name}: scoring ${findings.length} finding(s) with ${tag}…`);
      const samples = await judgeSamples(
        llm,
        name,
        expected,
        findings,
        diff,
        JUDGE_MODEL,
        JUDGE_RUNS,
        fresh,
      );
      if (JUDGE_RUNS === 1) {
        judge = samples[0]!;
      } else {
        const agg = aggregateJudge(samples, findings);
        judge = agg.judge;
        variance = agg.variance;
        if (!variance.stable)
          console.log(
            `[judge] ${name}: UNSTABLE across ${JUDGE_RUNS} samples — fp=[${variance.fp.join(",")}] bonus=[${variance.bonus.join(",")}] caught=[${variance.caught.join(",")}]`,
          );
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[judge] ${name}: ERROR ${msg}`);
      return {
        name,
        clean: expected.clean,
        expected,
        findings,
        judge: { matched: [], false_positives: [], bonus: [] },
        ranFresh,
        error: msg,
      };
    }
  }

  return { name, clean: expected.clean, expected, findings, judge, variance, ranFresh };
}

// ── Scoring + report ──────────────────────────────────────────────────────────

const CATS: Category[] = ["correctness", "security", "performance"];
const SEATS = ["rex", "bella", "duke"];

interface PerCaseRow {
  name: string;
  clean: boolean;
  caught: string[];
  missed: string[];
  // Every substantive finding the judge did NOT match to a planted bug — false_positives and bonus
  // collapsed into ONE descriptive bucket. We deliberately do not surface the fp-vs-bonus split: our
  // IRR study found it too subjective to score (see docs/EVAL.md). These are counted, never graded.
  additional: { finding_id: string; opener: string; rationale: string }[];
  error?: string;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}

// ── History ledger ─────────────────────────────────────────────────────────────
// An append-only, committed log (fixtures/eval/history.jsonl) of past runs so the
// report can show catch-rate / precision *over time* — the before/after delta is the
// whole point of an eval. Raw transcripts stay out of git (.runs/ is ignored); only the
// compact scored numbers are versioned here. A row is added on each genuine new
// measurement (≥1 case run live); the first generation also seeds one baseline row from
// the existing cache so the table is never empty.

interface HistoryRow {
  ts: string;
  git_sha: string;
  dirty: boolean; // uncommitted working tree at run time → result isn't reproducible
  model: string;
  cases: number;
  live: number; // cases driven live this run (0 = scored from cache)
  catch_rate: number;
  caught: number;
  planted: number;
  fp: number;
  fp_clean: number;
  bonus: number;
  persona: Record<string, number>;
  // Provider + model that actually reviewed, per dog seat. The product is heterogeneous
  // (each dog may be a different lab); this keeps the ledger comparable once seats stop
  // being all-Anthropic. Optional so rows written before this field still parse.
  lineup?: Record<string, { provider: string; model: string }>;
  judge?: string; // judge model id — pin it across runs so cross-lineup rows stay comparable
  judge_runs?: number; // samples per case behind the modal verdict (EVAL_JUDGE_RUNS); absent/1 = single draw
  // What this run was testing (the experiment/condition), from --label / EVAL_LABEL. Not
  // reconstructable from code or git later, so capture it here or the table is context-free.
  note?: string;
}

function gitMeta(): { sha: string; dirty: boolean } {
  // Hardcoded git argv (no shell, no interpolation) — argument-array form avoids any
  // command-injection surface.
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: EVAL_DIR, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  try {
    return {
      sha: git(["rev-parse", "--short", "HEAD"]) || "unknown",
      dirty: git(["status", "--porcelain"]).length > 0,
    };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

function readHistory(): HistoryRow[] {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryRow);
}

/**
 * Record this run when it's a genuine new measurement (≥1 case ran live), or to seed the
 * first baseline row from cache. Returns the full history (incl. any new row) to render.
 */
function recordHistory(row: HistoryRow, liveCases: number): HistoryRow[] {
  const rows = readHistory();
  if (liveCases > 0 || rows.length === 0) {
    appendFileSync(HISTORY_PATH, `${JSON.stringify(row)}\n`);
    rows.push(row);
  }
  return rows;
}

/**
 * Compact label for the dog lineup that reviewed in a run. Collapses to a single
 * `provider/model` when the whole table is homogeneous (today's case), otherwise lists
 * each seat. Rows written before the `lineup` field fall back to the bare model id.
 */
function lineupLabel(r: HistoryRow): string {
  const lu = r.lineup;
  if (!lu || Object.keys(lu).length === 0) return r.model;
  const entries = Object.entries(lu);
  const tags = entries.map(([, v]) => `${v.provider}/${v.model}`);
  if (new Set(tags).size === 1) return tags[0]!;
  return `mixed — ${entries.map(([s, v]) => `${s}=${v.provider}/${v.model}`).join(", ")}`;
}

function historySection(rows: HistoryRow[]): string[] {
  const L: string[] = [];
  L.push(`## History (over time)`);
  L.push(``);
  L.push(
    `One row per recorded run (oldest first), from \`fixtures/eval/history.jsonl\`. \`Note\` is what that run was testing (pass \`--label\`); without it a row is just numbers with no context. \`Lineup\` is the provider/model each dog ran on (one label when the whole table matches; per-seat when it's mixed). \`Catch-rate\` (recall) is the metric to watch across rows — that delta is the point of the eval. \`Additional\` is the count of extra, non-ground-truth findings raised that run (descriptive only, never scored). \`Live\` is how many cases were driven live that run (\`0\` = scored from cache; the metrics are still real, only cost isn't measured). A \`*\` on the commit means the working tree was dirty. The judge model is recorded per row in the JSONL (kept off this table for width) — pin it across runs so lineups stay comparable.`,
  );
  L.push(``);
  L.push(`| Date (UTC) | Note | Commit | Lineup | Catch-rate | Additional | Live |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const when = r.ts.slice(0, 16).replace("T", " ");
    const commit = `${r.git_sha}${r.dirty ? "*" : ""}`;
    const rate = `${r.caught}/${r.planted} (${pct(r.caught, r.planted)})`;
    const additional = (r.fp ?? 0) + (r.bonus ?? 0);
    L.push(
      `| ${when} | ${r.note?.trim() || "—"} | \`${commit}\` | \`${lineupLabel(r)}\` | ${rate} | ${additional} | ${r.live}/${r.cases} |`,
    );
  }
  L.push(``);
  return L;
}

function score(results: CaseResult[], usage: Usage, note: string): string {
  // Aggregate counters.
  let tp = 0;
  let fn = 0;
  const catTotal: Record<Category, number> = { correctness: 0, security: 0, performance: 0 };
  const catTp: Record<Category, number> = { correctness: 0, security: 0, performance: 0 };
  // caughtBySeat[seat][category] = # must_catch caught & attributed to that seat
  const caughtBySeat: Record<string, Record<Category, number>> = {};
  for (const s of SEATS) caughtBySeat[s] = { correctness: 0, security: 0, performance: 0 };
  let fpTotal = 0;
  let fpClean = 0;
  let bonusTotal = 0;
  // Descriptive tally of additional (non-ground-truth) findings, attributed to the dog that OPENED
  // the thread. Not a precision score — just "which dog surfaced the most extra observations".
  const additionalBySeat: Record<string, number> = {};
  for (const s of SEATS) additionalBySeat[s] = 0;
  const rows: PerCaseRow[] = [];

  for (const r of results) {
    const matchedGt = new Map(r.judge.matched.map((m) => [m.gt_id, m.finding_id]));
    const findingById = new Map(r.findings.map((f) => [f.finding_id, f]));
    const caught: string[] = [];
    const missed: string[] = [];

    for (const issue of r.expected.issues) {
      const fid = matchedGt.get(issue.id);
      const isCaught = fid != null;
      if (issue.must_catch) {
        catTotal[issue.category] += 1;
        if (isCaught) {
          tp += 1;
          catTp[issue.category] += 1;
          const seat = findingById.get(fid!)?.opener_seat;
          if (seat && caughtBySeat[seat]) caughtBySeat[seat][issue.category] += 1;
          caught.push(issue.id);
        } else {
          fn += 1;
          missed.push(issue.id);
        }
      } else if (isCaught) {
        caught.push(`${issue.id} (not-required)`);
      }
    }

    fpTotal += r.judge.false_positives.length;
    if (r.clean) fpClean += r.judge.false_positives.length;
    bonusTotal += r.judge.bonus.length;

    // Collapse fp + bonus into one descriptive "additional findings" list, attributed to the opener.
    const additional = [...r.judge.false_positives, ...r.judge.bonus].map((af) => {
      const opener = findingById.get(af.finding_id)?.opener_seat ?? "?";
      if (additionalBySeat[opener] != null) additionalBySeat[opener] += 1;
      return { finding_id: af.finding_id, opener, rationale: af.rationale };
    });

    rows.push({
      name: r.name,
      clean: r.clean,
      caught,
      missed,
      additional,
      error: r.error,
    });
  }
  const additionalTotal = fpTotal + bonusTotal;

  // Per-model cost: each model's tokens priced at its own rate, dogs and judge kept separate. When
  // JUDGE_MODEL === ANTHROPIC_MODEL both roles share one bucket (can't split by role on one id).
  const perModel = [...usage.byModel.entries()]
    .map(([m, u]) => {
      const inTok = Math.round(u.inChars / 4);
      const outTok = Math.round(u.outChars / 4);
      const rate = priceFor(m);
      const cost = (inTok / 1e6) * rate.in + (outTok / 1e6) * rate.out;
      const role =
        m === JUDGE_MODEL && m === ANTHROPIC_MODEL
          ? "dogs + judge"
          : m === JUDGE_MODEL
            ? "judge"
            : "dogs";
      return { model: m, role, calls: u.calls, inTok, outTok, rate, cost };
    })
    .sort((a, b) => b.cost - a.cost);
  const totalCost = perModel.reduce((a, x) => a + x.cost, 0);
  const model = ANTHROPIC_MODEL;
  const ran = results.filter((r) => !r.error).length;
  const errored = results.filter((r) => r.error);
  // Usage is only accrued for cases driven live this invocation; cache hits make no calls.
  const liveCases = results.filter((r) => r.ranFresh).length;

  const L: string[] = [];
  L.push(`# The Review Table — Eval Report`);
  L.push(``);
  L.push(
    `_Generated ${new Date().toISOString()} · dogs \`${model}\` · judge \`${JUDGE_MODEL}\`${JUDGE_RUNS > 1 ? ` ×${JUDGE_RUNS}` : ""} · ${results.length} cases (${ran} ran clean)._`,
  );
  L.push(``);
  L.push(`## Headline`);
  L.push(``);
  L.push(
    `**Caught ${tp} / ${tp + fn} must-catch bugs (${pct(tp, tp + fn)} catch-rate) across ${results.length} diffs.**`,
  );
  L.push(``);
  L.push(
    `Catch-rate (recall) is the scored metric — it is ground-truth-anchored and reproducible. The dogs also raised **${additionalTotal}** additional finding${additionalTotal === 1 ? "" : "s"} beyond the planted ground truth; these are tracked descriptively (per dog, per case) below and **not scored**. Whether an extra finding is noise or a sharp unplanned catch is a judgement call our inter-rater study found too subjective to measure reliably (κ≈0.42) — so we count them, we don't grade them. See \`docs/EVAL.md\`.`,
  );
  if (JUDGE_RUNS > 1) {
    const unstable = results.filter((r) => r.variance && !r.variance.stable).length;
    L.push(``);
    L.push(
      `_Judge \`${JUDGE_MODEL}\` was sampled **${JUDGE_RUNS}× per case**; the figures above are the **modal** verdict (a bug counts as caught on a majority of samples; each finding takes its plurality role). The judge disagreed with itself on **${unstable} of ${results.length}** case(s) — see the Judge stability section below for the spread._`,
    );
  }
  L.push(``);

  // Record this run in the committed ledger and render the over-time table.
  const persona: Record<string, number> = {};
  for (const s of SEATS) {
    const c = caughtBySeat[s]!;
    persona[s] = c.correctness + c.security + c.performance;
  }
  // The configured dog lineup that reviewed (provider + model per seat). Today every seat
  // is Anthropic; recording it now keeps the ledger comparable once seats go multi-lab.
  const lineup: Record<string, { provider: string; model: string }> = {};
  for (const s of AI_SEATS) lineup[s.id] = { provider: s.provider, model: s.model_id };
  const { sha, dirty } = gitMeta();
  const history = recordHistory(
    {
      ts: new Date().toISOString(),
      git_sha: sha,
      dirty,
      model,
      cases: results.length,
      live: liveCases,
      catch_rate: tp + fn === 0 ? 0 : tp / (tp + fn),
      caught: tp,
      planted: tp + fn,
      fp: fpTotal,
      fp_clean: fpClean,
      bonus: bonusTotal,
      persona,
      lineup,
      judge: JUDGE_MODEL,
      judge_runs: JUDGE_RUNS > 1 ? JUDGE_RUNS : undefined,
      note: note.trim() || undefined,
    },
    liveCases,
  );
  for (const line of historySection(history)) L.push(line);

  L.push(`## Catch-rate (recall) by category`);
  L.push(``);
  L.push(`| Category | Caught | Planted (must-catch) | Catch-rate |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const c of CATS)
    L.push(`| ${c} | ${catTp[c]} | ${catTotal[c]} | ${pct(catTp[c], catTotal[c])} |`);
  L.push(`| **all** | **${tp}** | **${tp + fn}** | **${pct(tp, tp + fn)}** |`);
  L.push(``);
  L.push(`## Per-persona (who surfaced the catch)`);
  L.push(``);
  L.push(
    `Each must-catch bug is attributed to the dog that *opened* the thread on it (the \`raise_issue\`). Read this together with the caveat below: the director sends most opening moves to the lead (Rex), so this table measures floor-control, not which dog is individually best in a lane — the other dogs engage heavily via \`pushback\`/\`pile_on\` without opening.`,
  );
  L.push(``);
  L.push(`| Dog (specialty) | correctness | security | performance | total catches |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const s of SEATS) {
    const row = caughtBySeat[s]!;
    const tot = row.correctness + row.security + row.performance;
    L.push(
      `| ${displayName(s)} (${SPECIALTY[s]}) | ${row.correctness} | ${row.security} | ${row.performance} | ${tot} |`,
    );
  }
  L.push(``);
  L.push(`Specialty catch-rate (bugs in a dog's own lane that the dog personally caught):`);
  L.push(``);
  L.push(`| Dog | Lane | Caught in lane | Catch-rate in lane |`);
  L.push(`| --- | --- | --- | --- |`);
  for (const s of SEATS) {
    const lane = SPECIALTY[s]!;
    L.push(
      `| ${displayName(s)} | ${lane} | ${caughtBySeat[s]![lane]} / ${catTotal[lane]} | ${pct(caughtBySeat[s]![lane], catTotal[lane])} |`,
    );
  }
  L.push(``);
  L.push(`## Additional findings (descriptive — not scored)`);
  L.push(``);
  L.push(
    `Beyond the ${tp + fn} planted must-catch bugs, the dogs raised **${additionalTotal}** additional substantive finding(s): observations not in the ground truth. We deliberately do **not** grade these as "false positive" vs "sharp extra catch" — our inter-rater study found that split too subjective to score reliably (κ≈0.42 even between two humans who both read the diff; see \`docs/EVAL.md\`). So this is descriptive color, not a metric. When you improve the dogs, watch whether the *catch-rate* moves; treat this section as texture, not a target.`,
  );
  L.push(``);
  L.push(`Additional findings by dog (attributed to the thread opener):`);
  L.push(``);
  L.push(`| Dog (specialty) | Additional findings opened |`);
  L.push(`| --- | --- |`);
  for (const s of SEATS)
    L.push(`| ${displayName(s)} (${SPECIALTY[s]}) | ${additionalBySeat[s]} |`);
  L.push(``);
  const withAdditional = rows.filter((r) => !r.error && r.additional.length > 0);
  if (withAdditional.length > 0) {
    L.push(`The items themselves (per case), so you can eyeball what the dogs surface off-ground-truth:`);
    L.push(``);
    for (const row of withAdditional) {
      L.push(`- **${row.name}**${row.clean ? " (clean control)" : ""}:`);
      for (const a of row.additional)
        L.push(`  - _${displayName(a.opener)}_ — ${a.rationale} \`(${a.finding_id})\``);
    }
    L.push(``);
  }
  L.push(`## Per-case`);
  L.push(``);
  L.push(`\`Additional\` = extra findings beyond ground truth (descriptive; see the section above).`);
  L.push(``);
  L.push(`| Case | Clean? | Caught | Missed | Additional |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const row of rows) {
    if (row.error) {
      L.push(`| ${row.name} | ${row.clean ? "yes" : "no"} | — | — | — (ERROR: ${row.error}) |`);
      continue;
    }
    L.push(
      `| ${row.name} | ${row.clean ? "yes" : "no"} | ${row.caught.join(", ") || "—"} | ${row.missed.join(", ") || "—"} | ${row.additional.length} |`,
    );
  }
  L.push(``);
  if (JUDGE_RUNS > 1) {
    const judged = results.filter((r) => r.variance);
    const unstable = judged.filter((r) => r.variance && !r.variance.stable);
    L.push(`## Judge stability (${JUDGE_RUNS}× sampling)`);
    L.push(``);
    L.push(
      `Each case was judged ${JUDGE_RUNS}× with \`${JUDGE_MODEL}\`. A single re-judge can't tell a real change from run-to-run wobble, so these are the raw per-sample counts behind the modal verdict. \`fp\`/\`bonus\`/\`caught\` list one number per sample; a spread means the judge disagreed with itself. **${unstable.length} of ${judged.length}** judged case(s) were unstable.`,
    );
    L.push(``);
    if (unstable.length === 0) {
      L.push(`_Every judged case was stable across all ${JUDGE_RUNS} samples._`);
    } else {
      L.push(`| Case | FP / sample | Bonus / sample | Caught / sample |`);
      L.push(`| --- | --- | --- | --- |`);
      for (const r of unstable) {
        const v = r.variance!;
        L.push(
          `| ${r.name} | ${v.fp.join(", ")} | ${v.bonus.join(", ")} | ${v.caught.join(", ")} |`,
        );
      }
    }
    L.push(``);
  }
  L.push(`## Cost (approximate)`);
  L.push(``);
  if (usage.calls === 0) {
    L.push(
      `Not measured this run — every case was scored from the cached transcripts in \`fixtures/eval/.runs/\`, so no LLM calls were made. Run \`pnpm eval --fresh\` (or clear the cache) to measure cost against live calls.`,
    );
  } else {
    const scope =
      liveCases < results.length
        ? `the ${liveCases} of ${results.length} case(s) executed live this run (the rest were scored from cache, so their calls are not included)`
        : `all ${results.length} cases, executed live this run`;
    L.push(
      `Estimated from character counts (≈chars/4 tokens), priced **per model at its own list rate** for ${scope} — a rough figure, not metered billing.`,
    );
    L.push(``);
    L.push(`| Model | Role | Calls | Input tok | Output tok | $/MTok (in/out) | Est. cost |`);
    L.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    for (const p of perModel) {
      L.push(
        `| \`${p.model}\` | ${p.role} | ${p.calls} | ${p.inTok.toLocaleString()} | ${p.outTok.toLocaleString()} | $${p.rate.in}/$${p.rate.out} | ~$${p.cost.toFixed(2)} |`,
      );
    }
    L.push(`| **total** | | **${usage.calls}** | | | | **~$${totalCost.toFixed(2)}** |`);
    L.push(``);
    L.push(
      `- Each model's tokens are priced at its **own** rate — dogs on \`${ANTHROPIC_MODEL}\`, judge on \`${JUDGE_MODEL}\` — so the dog/judge split is real, not everything blended at the dog rate (the old bug).`,
    );
    L.push(
      `- Still a conservative **upper bound**: it ignores prompt-cache discounts (the constant system prompts are cached) and Sonnet's intro pricing, so the actual bill is lower.`,
    );
  }
  L.push(``);
  if (errored.length) {
    L.push(`## Run errors`);
    L.push(``);
    for (const e of errored) L.push(`- ${e.name}: ${e.error}`);
    L.push(``);
  }
  L.push(`## Caveats (honest)`);
  L.push(``);
  L.push(
    `- **Recall is the metric; additional findings are not.** We score catch-rate against a hand-built ground truth because that is the reliable, reproducible signal. We deliberately do **not** score precision (false-positive rate): an inter-rater study (\`docs/EVAL.md\`) found the "spurious vs valid extra catch" call too subjective to measure (κ≈0.42 between two humans who both saw the code). Additional findings are reported descriptively so you can watch them, not to penalize the dogs for surfacing more.`,
  );
  L.push(
    `- **Diff-only review.** The dogs see only the unified diff, not the surrounding file or repo. Some planted bugs (e.g. missing \`await\`, a removed guard) are genuinely ambiguous from a diff alone; misses there reflect the product's current scope, not just model skill.`,
  );
  L.push(
    `- **Fixture authorship.** The ground truth is hand-built (${results.length} cases: ${CATS.map((c) => `${results.filter((r) => !r.clean && r.expected.issues.some((i) => i.category === c)).length} ${c}`).join(", ")}, ${results.filter((r) => r.clean).length} clean). Small N: each case moves the headline by a few points. Treat as a directional signal, not a benchmark.`,
  );
  L.push(
    `- **LLM-as-judge.** Matching is semantic and itself model-generated (judge model: \`${JUDGE_MODEL}\`); spot-check the per-case caught/missed lists against the cached transcripts in \`fixtures/eval/.runs/\`.`,
  );
  L.push(
    `- **Non-determinism.** Real LLM runs vary; re-running \`--fresh\` will shift numbers slightly. The cached transcripts make the *scoring* reproducible. The **judge itself** is also non-deterministic (the same transcript can score differently run-to-run) — set \`EVAL_JUDGE_RUNS=5\` (or more) to sample the judge N× and report the modal verdict plus the per-case spread, so a rubric change can be told apart from judge wobble.`,
  );
  L.push(
    `- **Per-persona attribution is opener-biased.** A catch is credited to the dog that opened the thread, and the director routes most opening moves to the lead (Rex). So Rex's count is inflated and Bella/Duke's "specialty catch-rate" understates them — they pile on and push back on most threads, they just rarely open. The table reflects orchestration (who gets the floor first), not latent per-dog bug-finding skill. A fairer per-dog metric would require crediting every dog that engaged a matched thread.`,
  );
  L.push(
    `- **Author turns stubbed.** When the dogs ask the author, a fixed neutral reply is injected; it neither confirms nor denies a concern.`,
  );
  L.push(``);
  return L.join("\n");
}

function consoleSummary(report: string): void {
  // Print the headline + the two key tables to the console.
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Headline"));
  const end = lines.findIndex((l) => l.startsWith("## Per-case"));
  console.log(`\n${lines.slice(start, end >= 0 ? end : undefined).join("\n")}`);
}

// ── pool ──────────────────────────────────────────────────────────────────────

async function pool<T>(items: string[], n: number, fn: (x: string) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Validate every request shape the run will use with one tiny call each, BEFORE spending
 * on the 30-case batch. A systematic shape error (unsupported param, bad model id, auth)
 * fails the same way on every case, so catching it here aborts for ~a cent instead of the
 * full run. Rejected 4xx requests are not billed. Skips paths the run won't exercise (a
 * cache re-score only judges, so it only preflights the judge model).
 */
async function preflight(llm: LlmAdapter, opts: { dogs: boolean; judge: boolean }): Promise<void> {
  const messages = [{ seat_id: "preflight", role: "user" as const, text: `Reply {"ok":true}.` }];
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const checks: Array<[string, () => Promise<unknown>]> = [];
  if (opts.dogs) {
    checks.push([
      `director ${ANTHROPIC_MODEL} (structured)`,
      () =>
        llm.completeStructured({
          model_id: ANTHROPIC_MODEL,
          system: "Reply JSON.",
          messages,
          schema,
        }),
    ]);
    checks.push([
      `speaker ${ANTHROPIC_MODEL} (stream)`,
      async () => {
        for await (const _ of llm.streamText({
          model_id: ANTHROPIC_MODEL,
          system: "Reply ok.",
          messages,
        }))
          break;
      },
    ]);
  }
  if (opts.judge) {
    checks.push([
      `judge ${JUDGE_MODEL} (structured)`,
      () =>
        llm.completeStructured({ model_id: JUDGE_MODEL, system: "Reply JSON.", messages, schema }),
    ]);
  }
  for (const [label, run] of checks) {
    try {
      await run();
    } catch (e) {
      console.error(
        `\nPREFLIGHT FAILED — ${label}:\n  ${(e as Error).message}\n\n` +
          "This request shape is rejected by the model, so every case would fail identically.\n" +
          "Aborting before spending on the full run. Fix the adapter/model config and retry.\n",
      );
      process.exit(3);
    }
  }
  console.log(`Preflight OK — ${checks.length} request shape(s) validated.\n`);
}

// ── Judge disagreement diff ─────────────────────────────────────────────────
// Re-judge the SAME cached transcripts with two judge models and print only the
// findings they classify differently — the human reading-list for "which judge is
// right?". Model-vs-model comparison has no ground truth; this surfaces the exact
// items a person needs to adjudicate. Per-model verdicts are cached so re-runs are free.

const DEFAULT_DIFF_JUDGES = ["claude-haiku-4-5-20251001", "claude-opus-4-8"];
const DIFF_PATH = resolve(RUNS_DIR, "judge-diff.md");

function sanitizeModel(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Which bucket a judge put each finding in: caught / false positive / bonus / ignored. */
function classifyFindings(j: JudgeResult): Map<string, { bucket: string; why: string }> {
  const m = new Map<string, { bucket: string; why: string }>();
  for (const x of j.matched) m.set(x.finding_id, { bucket: "caught", why: x.rationale });
  for (const x of j.false_positives)
    m.set(x.finding_id, { bucket: "false positive", why: x.rationale });
  for (const x of j.bonus) m.set(x.finding_id, { bucket: "bonus", why: x.rationale });
  return m;
}

// ── Inter-rater reliability: human vs the LLM judge ───────────────────────────
// How much do YOU (a human) agree with the LLM judge's per-finding calls? LLM-as-judge is circular —
// a model grading a model — so its verdicts are only as trustworthy as a human's would be on the same
// items. This measures that. `--irr-worksheet` reconstructs the EXACT findings the judge scored
// (buildFindings on the cached transcript → the same t1/t2 ids the judge saw), hides the judge's
// labels in a key under .runs/, and emits a blank worksheet. You label each finding blind; then
// `--irr-score` computes Cohen's κ (agreement corrected for chance). High κ ⇒ trust the judge; low κ,
// especially on the known-unstable cases, ⇒ the ground truth there is genuinely debatable, not flaky.

type IrrLabel = "caught" | "fp" | "bonus" | "ignore";
const IRR_LABELS: IrrLabel[] = ["caught", "fp", "bonus", "ignore"];
const IRR_WORKSHEET = resolve(here, "../../../../EVAL-IRR-WORKSHEET.md");
const IRR_ANSWERS = resolve(here, "../../../../EVAL-IRR-ANSWERS.tsv"); // the sheet you edit each pass
const IRR_REPORT = resolve(here, "../../../../EVAL-IRR-REPORT.md"); // informed-pass report
const IRR_REPORT_BLIND = resolve(here, "../../../../EVAL-IRR-REPORT.blind.md");
// Per-pass snapshots of your filled answers, so the informed pass can diff against the blind one.
const IRR_ANSWERS_BLIND = resolve(here, "../../../../EVAL-IRR-ANSWERS.blind.tsv");
const IRR_ANSWERS_INFORMED = resolve(here, "../../../../EVAL-IRR-ANSWERS.informed.tsv");
const IRR_KEY = resolve(RUNS_DIR, "irr-key.json"); // hidden with the cache — it IS the answer key

/** The judge's bucket for one finding → an IrrLabel. A finding in none of matched/fp/bonus means the
 *  judge saw it but deemed it non-substantive: "ignore". */
function judgeLabelOf(cls: Map<string, { bucket: string }>, fid: string): IrrLabel {
  const b = cls.get(fid)?.bucket;
  if (b === "caught") return "caught";
  if (b === "false positive") return "fp";
  if (b === "bonus") return "bonus";
  return "ignore";
}

interface IrrCase {
  name: string;
  clean: boolean;
  diff: string;
  gt: GtIssue[];
  findings: Finding[];
  judgeLabels: Map<string, IrrLabel>;
}

/** Reconstruct one case's findings + the judge's cached (JUDGE_MODEL sample-0) label per finding.
 *  Returns null if either the transcript or the JUDGE_MODEL verdict isn't cached (run `pnpm eval`). */
function irrReconstruct(name: string): IrrCase | null {
  const dir = resolve(EVAL_DIR, name);
  const run = loadJson<RunCache>(resolve(RUNS_DIR, `${name}.run.json`));
  const judge = loadJson<JudgeResult>(
    resolve(RUNS_DIR, `${name}.judge.${sanitizeModel(JUDGE_MODEL)}.json`),
  );
  if (!run || !judge) return null;
  const diff = readFileSync(resolve(dir, "diff.patch"), "utf8");
  const expected = JSON.parse(readFileSync(resolve(dir, "expected.json"), "utf8")) as Expected;
  const { anchorTable } = parseUnifiedDiff(diff);
  const findings = buildFindings(run.turns, anchorTable);
  const cls = classifyFindings(judge);
  const judgeLabels = new Map<string, IrrLabel>(
    findings.map((f) => [f.finding_id, judgeLabelOf(cls, f.finding_id)]),
  );
  return { name, clean: expected.clean, diff, gt: expected.issues, findings, judgeLabels };
}

/** "Findings-heavy" selection: cases whose JUDGE_MODEL verdict has ≥1 fp or ≥1 bonus — the only
 *  places human and judge can disagree (a lone obvious catch is unanimous, so it teaches κ nothing). */
function irrSelect(): IrrCase[] {
  const names = readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  const out: IrrCase[] = [];
  for (const n of names) {
    const c = irrReconstruct(n);
    if (c && [...c.judgeLabels.values()].some((l) => l === "fp" || l === "bonus")) out.push(c);
  }
  return out;
}

function snippet(text: string, n = 240): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** Read a filled/blank answers TSV → `${case}\t${fid}` → your_label (lowercased; "" if unfilled). */
function irrReadAnswers(path: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(path)) return m;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length);
  lines.shift(); // header
  for (const line of lines) {
    const c = line.split("\t");
    if (c[0] && c[1]) m.set(`${c[0]}\t${c[1]}`, (c[4] ?? "").trim().toLowerCase());
  }
  return m;
}

/**
 * Emit the worksheet (human context), the fill-in TSV, and the hidden answer key.
 *  - blind=true  → OMIT the diffs, so you label from the finding dialogue + ground truth ALONE — the
 *    exact inputs the judge had. This is the clean judge-agreement pass.
 *  - blind=false → INCLUDE the diffs (informed pass) and pre-seed each your_label from your blind
 *    answers (EVAL-IRR-ANSWERS.blind.tsv) if present, so you only revisit calls the code changes.
 */
function irrWorksheet(blind: boolean): void {
  const cases = irrSelect();
  if (!cases.length) {
    console.error(
      "No findings-heavy cases found. Run `pnpm eval` first so JUDGE_MODEL verdicts are cached.",
    );
    process.exit(2);
  }
  // Informed pass seeds from the blind answers so you edit, not restart.
  const seed = blind ? new Map<string, string>() : irrReadAnswers(IRR_ANSWERS_BLIND);
  const seeded = !blind && seed.size > 0;

  const W: string[] = [
    `# Eval — inter-rater reliability worksheet (${blind ? "BLIND — no diffs" : "INFORMED — with diffs"})`,
    ``,
    `_${cases.length} findings-heavy case(s); judge = \`${JUDGE_MODEL}\`. Put ONE label per finding in the \`your_label\` column of \`EVAL-IRR-ANSWERS.tsv\`:_`,
    ``,
    `- \`caught\` — this finding matches a planted ground-truth bug`,
    `- \`fp\` — substantive but wrong/hallucinated (or ANY substantive claim on a clean control)`,
    `- \`bonus\` — a valid concern that isn't in the ground truth`,
    `- \`ignore\` — not a substantive review point (chatter, a question, a trivial nit)`,
    ``,
    blind
      ? `_**Blind pass:** you get the ground truth + the reviewers' dialogue ONLY — the same evidence the judge had (it never saw the diff either). Judge from that, don't infer the judge's calls, then run \`pnpm eval --irr-score --blind\`._`
      : `_**Informed pass:** the diffs are shown now. ${seeded ? "Your blind answers are pre-filled in the TSV — change only the ones the code makes you reconsider." : "(No blind answers found to pre-fill — run the blind pass first for the full comparison.)"} Then run \`pnpm eval --irr-score\` for the informed κ plus a blind→informed flip analysis._`,
    ``,
  ];
  const key: Record<string, Record<string, IrrLabel>> = {};
  const rows: string[] = [`case\tfinding_id\tseats\tsnippet\tyour_label`];
  for (const c of cases) {
    const caseKey: Record<string, IrrLabel> = {};
    key[c.name] = caseKey;
    W.push(`## ${c.name}${c.clean ? " (CLEAN CONTROL)" : ""}`, ``);
    if (!blind) W.push("```diff", c.diff.trim(), "```", ``);
    if (c.gt.length) {
      W.push(`**Ground-truth bug(s):**`);
      for (const g of c.gt)
        W.push(`- \`${g.id}\` [${g.category}/${g.severity}] — ${g.description}`);
    } else {
      W.push(
        `**Ground truth:** clean — no planted bug. Any substantive finding here is a false positive.`,
      );
    }
    W.push(``, `**Findings the judge scored:**`);
    for (const f of c.findings) {
      W.push(
        `- \`${f.finding_id}\` — opened by ${displayName(f.opener_seat)}, engaged [${f.seats
          .map(displayName)
          .join(", ")}], diff lines [${f.lines.join(", ")}]`,
        // FULL dialogue, exactly as the judge received it (buildJudgeUser sends f.text untruncated).
        // The blind pass is only honest if you see the same evidence — never a snippet of it.
        ...f.text.split("\n").map((l) => `  > ${l}`),
      );
      caseKey[f.finding_id] = c.judgeLabels.get(f.finding_id) ?? "ignore";
      const pre = seed.get(`${c.name}\t${f.finding_id}`) ?? "";
      rows.push(
        `${c.name}\t${f.finding_id}\t${f.seats.map(displayName).join("|")}\t${snippet(f.text, 160).replace(/\t/g, " ")}\t${pre}`,
      );
    }
    W.push(``);
  }
  writeFileSync(IRR_WORKSHEET, `${W.join("\n")}\n`);
  writeFileSync(IRR_ANSWERS, `${rows.join("\n")}\n`);
  writeFileSync(IRR_KEY, JSON.stringify(key, null, 2));
  console.log(
    `IRR worksheet (${blind ? "blind" : "informed"}): ${cases.length} case(s), ${rows.length - 1} finding(s).`,
  );
  console.log(`  Read for context : ${IRR_WORKSHEET}`);
  console.log(
    `  Fill your_label  : ${IRR_ANSWERS}  (caught | fp | bonus | ignore)${seeded ? " — pre-filled from your blind pass" : ""}`,
  );
  console.log(`  Then score        : pnpm eval --irr-score${blind ? " --blind" : ""}`);
}

/** Cohen's κ over paired categorical labels: κ = (po − pe)/(1 − pe) — observed agreement corrected
 *  for the agreement you'd expect by chance. 1 perfect, 0 chance-level, <0 worse than chance. Pure +
 *  exported for unit tests. Pairs whose label isn't in `categories` are skipped. */
export function cohensKappa(
  pairs: [string, string][],
  categories: string[],
): { n: number; po: number; pe: number; kappa: number } {
  const idx = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const rowM = new Array(k).fill(0);
  const colM = new Array(k).fill(0);
  let n = 0;
  let agree = 0;
  for (const [a, b] of pairs) {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i == null || j == null) continue;
    rowM[i] += 1;
    colM[j] += 1;
    if (i === j) agree += 1;
    n += 1;
  }
  if (n === 0) return { n: 0, po: 0, pe: 0, kappa: 0 };
  const po = agree / n;
  let pe = 0;
  for (let i = 0; i < k; i++) pe += (rowM[i] / n) * (colM[i] / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { n, po, pe, kappa };
}

/** Landis & Koch interpretation bands for κ. */
export function kappaBand(k: number): string {
  if (k < 0) return "poor (worse than chance)";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

interface IrrScored {
  pairs: [IrrLabel, IrrLabel][];
  disagreements: { case: string; fid: string; human: IrrLabel; judge: IrrLabel }[];
  unfilled: string[];
  invalid: string[];
}

/** Pair each human label against the judge's, over exactly the findings in the key. */
function irrScorePairs(
  human: Map<string, string>,
  key: Record<string, Record<string, IrrLabel>>,
): IrrScored {
  const out: IrrScored = { pairs: [], disagreements: [], unfilled: [], invalid: [] };
  for (const [cname, fids] of Object.entries(key)) {
    for (const [fid, judge] of Object.entries(fids)) {
      const h = human.get(`${cname}\t${fid}`) ?? "";
      if (!h) {
        out.unfilled.push(`${cname}/${fid}`);
        continue;
      }
      if (!(IRR_LABELS as string[]).includes(h)) {
        out.invalid.push(`${cname}/${fid} = "${h}"`);
        continue;
      }
      out.pairs.push([h as IrrLabel, judge]);
      if (h !== judge) out.disagreements.push({ case: cname, fid, human: h as IrrLabel, judge });
    }
  }
  return out;
}

/**
 * Score the filled TSV against the hidden key → κ + report. Cache-only, no LLM.
 *  - blind=true  → clean judge-agreement pass; snapshots answers to EVAL-IRR-ANSWERS.blind.tsv.
 *  - blind=false → informed pass; snapshots to .informed.tsv and, if a blind snapshot exists, adds a
 *    blind→informed FLIP analysis and both κ's side by side — the measure of what the judge loses by
 *    not seeing the diff.
 */
function irrScore(blind: boolean): void {
  // Recompute the judge's labels LIVE from the current cached verdicts rather than trusting the key
  // irrWorksheet froze at generation time. A re-judge between worksheet and score (e.g. after a rubric
  // change) leaves that frozen key stale, silently scoring the human against a judge that no longer
  // exists. irrSelect() re-reads the verdict JSON, so κ always reflects the judge on disk right now.
  // (Still hidden from the human: the worksheet MD never shows judge labels, only the verdict cache does.)
  const cases = irrSelect();
  if (!cases.length) {
    console.error(
      `No findings-heavy cases found. Run \`pnpm eval\` first so ${JUDGE_MODEL} verdicts are cached.`,
    );
    process.exit(2);
  }
  const key: Record<string, Record<string, IrrLabel>> = {};
  for (const c of cases) {
    const m: Record<string, IrrLabel> = {};
    for (const [fid, label] of c.judgeLabels) m[fid] = label;
    key[c.name] = m;
  }
  if (!existsSync(IRR_ANSWERS)) {
    console.error(`No answers at ${IRR_ANSWERS}. Fill the your_label column first.`);
    process.exit(2);
  }
  const human = irrReadAnswers(IRR_ANSWERS);
  const { pairs, disagreements, unfilled, invalid } = irrScorePairs(human, key);
  const { n, po, pe, kappa } = cohensKappa(pairs as [string, string][], IRR_LABELS);

  // Snapshot this pass's answers so the informed pass can diff against the blind one.
  writeFileSync(
    blind ? IRR_ANSWERS_BLIND : IRR_ANSWERS_INFORMED,
    readFileSync(IRR_ANSWERS, "utf8"),
  );
  const stage = blind ? "blind" : "informed";
  const reportPath = blind ? IRR_REPORT_BLIND : IRR_REPORT;

  const L: string[] = [
    `# Eval — inter-rater reliability (human vs \`${JUDGE_MODEL}\` judge) — ${stage.toUpperCase()} pass`,
    ``,
    `_Generated ${new Date().toISOString()}. ${n} finding(s) labelled by both a human (${blind ? "ground truth + dialogue only, matching the judge's inputs" : "with the diffs in view"}) and the LLM judge._`,
    ``,
    `## Headline`,
    ``,
    `**Cohen's κ = ${kappa.toFixed(3)} (${kappaBand(kappa)})** · raw agreement ${(100 * po).toFixed(0)}% (${Math.round(po * n)}/${n}) · chance agreement ${(100 * pe).toFixed(0)}%.`,
    ``,
    `κ corrects raw agreement for chance: with skewed label mixes (most findings are one label), a high raw % can still be unimpressive. κ is the honest number to quote when defending the LLM-as-judge.`,
    ``,
  ];

  // Blind vs informed κ side by side (informed pass only).
  const flips: { case: string; fid: string; blind: IrrLabel; informed: IrrLabel }[] = [];
  if (!blind && existsSync(IRR_ANSWERS_BLIND)) {
    const blindHuman = irrReadAnswers(IRR_ANSWERS_BLIND);
    const b = cohensKappa(irrScorePairs(blindHuman, key).pairs as [string, string][], IRR_LABELS);
    L.push(
      `## Blind vs informed`,
      ``,
      `| Pass | κ | raw | n |`,
      `| --- | --- | --- | --- |`,
      `| blind (judge's inputs) | ${b.kappa.toFixed(3)} (${kappaBand(b.kappa)}) | ${(100 * b.po).toFixed(0)}% | ${b.n} |`,
      `| informed (you saw the code) | ${kappa.toFixed(3)} (${kappaBand(kappa)}) | ${(100 * po).toFixed(0)}% | ${n} |`,
      ``,
      `If κ **drops** from blind to informed, the judge agrees more with a human who had its same (diff-blind) evidence than with one who read the code — i.e. the judge isn't unreliable so much as under-informed, and feeding it the diff would likely help. If κ is unchanged, the diff didn't matter to the calls.`,
      ``,
    );
    for (const [cname, fids] of Object.entries(key)) {
      for (const fid of Object.keys(fids)) {
        const bl = blindHuman.get(`${cname}\t${fid}`) ?? "";
        const inf = human.get(`${cname}\t${fid}`) ?? "";
        if (
          bl &&
          inf &&
          (IRR_LABELS as string[]).includes(bl) &&
          (IRR_LABELS as string[]).includes(inf) &&
          bl !== inf
        )
          flips.push({ case: cname, fid, blind: bl as IrrLabel, informed: inf as IrrLabel });
      }
    }
    L.push(`## Label flips once you saw the code (${flips.length})`, ``);
    if (flips.length === 0) {
      L.push(
        `None — reading the diffs changed none of your labels. The dialogue carried the code.`,
      );
    } else {
      L.push(`| Case | finding | blind | → informed |`, `| --- | --- | --- | --- |`);
      for (const f of flips) L.push(`| ${f.case} | \`${f.fid}\` | ${f.blind} | ${f.informed} |`);
      L.push(
        ``,
        `Each flip is a call the code changed your mind on — and a spot where the judge, which also never saw the diff, is at risk of the same mistake. This is the direct, honest measurement of the judge's diff blind-spot.`,
      );
    }
    L.push(``);
  }

  // Contingency: human rows × judge cols.
  const counts = new Map<string, number>();
  for (const [h, j] of pairs) counts.set(`${h}|${j}`, (counts.get(`${h}|${j}`) ?? 0) + 1);
  L.push(`## Contingency (human ↓ vs judge →)`, ``);
  L.push(`| human \\ judge | ${IRR_LABELS.join(" | ")} | total |`);
  L.push(`| --- | ${IRR_LABELS.map(() => "---").join(" | ")} | --- |`);
  for (const h of IRR_LABELS) {
    const cells = IRR_LABELS.map((j) => counts.get(`${h}|${j}`) ?? 0);
    const tot = cells.reduce((a, b) => a + b, 0);
    L.push(`| **${h}** | ${cells.join(" | ")} | ${tot} |`);
  }
  L.push(``, `Diagonal = agreement; off-diagonal = where you and the judge parted.`, ``);

  L.push(`## Disagreements with the judge (${disagreements.length})`, ``);
  if (disagreements.length === 0) {
    L.push(`None — you and the judge labelled every scored finding identically.`);
  } else {
    L.push(`| Case | finding | human | judge |`);
    L.push(`| --- | --- | --- | --- |`);
    for (const d of disagreements) L.push(`| ${d.case} | \`${d.fid}\` | ${d.human} | ${d.judge} |`);
    L.push(
      ``,
      `Each row is a finding where a human and the LLM judge genuinely disagree — the material for a rubric fix or a ground-truth correction. Disagreements clustered on the known-unstable cases (\`security-timing-compare\`, \`security-missing-authz\`) point at debatable ground truth, not judge error.`,
    );
  }
  if (unfilled.length || invalid.length) {
    L.push(``, `## Coverage warnings`, ``);
    if (unfilled.length)
      L.push(
        `- **${unfilled.length} finding(s) left blank** (excluded from κ): ${unfilled.join(", ")}`,
      );
    if (invalid.length)
      L.push(
        `- **${invalid.length} invalid label(s)** (must be ${IRR_LABELS.join("/")}): ${invalid.join(", ")}`,
      );
  }
  L.push(``);
  writeFileSync(reportPath, `${L.join("\n")}\n`);
  console.log(
    `IRR (${stage}): κ=${kappa.toFixed(3)} (${kappaBand(kappa)}), raw ${(100 * po).toFixed(0)}%, n=${n}. Report → ${reportPath}`,
  );
  if (!blind && flips.length)
    console.log(`  ${flips.length} label(s) flipped once the diffs were visible.`);
  if (blind)
    console.log(
      `  Next: pnpm eval --irr-worksheet   (informed pass — diffs shown, blind answers pre-filled)`,
    );
  if (unfilled.length)
    console.log(
      `  (${unfilled.length} unlabelled finding(s) excluded — fill them for a complete κ.)`,
    );
}

/** Judge one case with a specific model, cached per-model so repeat diffs cost nothing. Shares
 *  the sample-0 cache file with the main report path (judgeSamples), so the two never diverge. */
async function judgeWithModel(
  llm: LlmAdapter,
  name: string,
  expected: Expected,
  findings: Finding[],
  diff: string,
  modelId: string,
): Promise<JudgeResult> {
  return (await judgeSamples(llm, name, expected, findings, diff, modelId, 1, false))[0]!;
}

async function validateJudgeModel(llm: LlmAdapter, modelId: string): Promise<void> {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  try {
    await llm.completeStructured({
      model_id: modelId,
      system: "Reply JSON.",
      messages: [{ seat_id: "preflight", role: "user", text: `Reply {"ok":true}.` }],
      schema,
    });
  } catch (e) {
    console.error(`\nPREFLIGHT FAILED — judge ${modelId}:\n  ${(e as Error).message}\nAborting.\n`);
    process.exit(3);
  }
}

async function diffJudges(llm: LlmAdapter, cases: string[], a: string, b: string): Promise<void> {
  console.log(`Judge diff: \`${a}\` vs \`${b}\` over ${cases.length} cached transcript(s).`);
  console.log(`Per-model verdicts cached under \`.runs/\`; re-runs are free.\n`);
  await validateJudgeModel(llm, a);
  await validateJudgeModel(llm, b);

  const tally: Record<string, Record<string, number>> = {
    [a]: { caught: 0, "false positive": 0, bonus: 0, ignored: 0 },
    [b]: { caught: 0, "false positive": 0, bonus: 0, ignored: 0 },
  };
  const disagreements: Array<{
    name: string;
    clean: boolean;
    finding: Finding;
    aBucket: string;
    aWhy: string;
    bBucket: string;
    bWhy: string;
  }> = [];
  let totalFindings = 0;
  let missing = 0;

  for (const name of cases) {
    const run = loadJson<RunCache>(resolve(RUNS_DIR, `${name}.run.json`));
    if (!run) {
      missing++;
      console.warn(`[skip]  ${name}: no cached transcript (run \`pnpm eval --fresh\` first)`);
      continue;
    }
    const diff = readFileSync(resolve(EVAL_DIR, name, "diff.patch"), "utf8");
    const expected = JSON.parse(
      readFileSync(resolve(EVAL_DIR, name, "expected.json"), "utf8"),
    ) as Expected;
    const { anchorTable } = parseUnifiedDiff(diff);
    const findings = buildFindings(run.turns, anchorTable);
    if (findings.length === 0) continue;

    console.log(`[judge] ${name}: ${findings.length} finding(s) × 2 judges`);
    const jA = await judgeWithModel(llm, name, expected, findings, diff, a);
    const jB = await judgeWithModel(llm, name, expected, findings, diff, b);
    const cA = classifyFindings(jA);
    const cB = classifyFindings(jB);

    for (const f of findings) {
      totalFindings++;
      const aInfo = cA.get(f.finding_id) ?? { bucket: "ignored", why: "" };
      const bInfo = cB.get(f.finding_id) ?? { bucket: "ignored", why: "" };
      tally[a]![aInfo.bucket]!++;
      tally[b]![bInfo.bucket]!++;
      if (aInfo.bucket === bInfo.bucket) continue;
      disagreements.push({
        name,
        clean: expected.clean,
        finding: f,
        aBucket: aInfo.bucket,
        aWhy: aInfo.why,
        bBucket: bInfo.bucket,
        bWhy: bInfo.why,
      });
    }
  }

  const onClean = disagreements.filter((d) => d.clean).length;
  const onBuggy = disagreements.length - onClean;
  const L: string[] = [];
  L.push(`# Judge disagreements — \`${a}\` vs \`${b}\``);
  L.push(``);
  L.push(
    `Same cached transcripts, two judges. Only findings they bucketed **differently** are listed — this is the reading list to adjudicate yourself (their agreement carries no ground truth; your call does).`,
  );
  L.push(``);
  L.push(
    `**${disagreements.length} disagreement(s)** out of ${totalFindings} findings — ${onClean} on clean controls, ${onBuggy} on buggy diffs.` +
      (missing ? ` (${missing} case(s) skipped: no transcript.)` : ""),
  );
  L.push(``);
  L.push(`| Judge | caught | false positive | bonus | ignored |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const m of [a, b]) {
    const t = tally[m]!;
    L.push(`| \`${m}\` | ${t.caught} | ${t["false positive"]} | ${t.bonus} | ${t.ignored} |`);
  }
  L.push(``);
  L.push(
    `> Counts are finding-level (a bug can draw several findings), not the report's bug-level recall.`,
  );
  L.push(``);

  for (const group of [
    { title: "Clean controls", rows: disagreements.filter((d) => d.clean) },
    { title: "Buggy diffs", rows: disagreements.filter((d) => !d.clean) },
  ]) {
    if (group.rows.length === 0) continue;
    L.push(`## ${group.title} (${group.rows.length})`);
    L.push(``);
    for (const d of group.rows) {
      const where = d.finding.lines.length ? `lines ${d.finding.lines.join(", ")}` : "no anchor";
      L.push(`### ${d.name} — ${where}, opened by ${displayName(d.finding.opener_seat)}`);
      L.push(`- \`${a}\` → **${d.aBucket}**${d.aWhy ? ` — ${d.aWhy}` : ""}`);
      L.push(`- \`${b}\` → **${d.bBucket}**${d.bWhy ? ` — ${d.bWhy}` : ""}`);
      L.push(``);
      L.push(`Full thread (verbatim):`);
      L.push("```");
      L.push(d.finding.text);
      L.push("```");
      L.push(``);
      L.push(`Diff under review:`);
      L.push("```diff");
      L.push(readFileSync(resolve(EVAL_DIR, d.name, "diff.patch"), "utf8").trim());
      L.push("```");
      L.push(``);
    }
  }

  writeFileSync(DIFF_PATH, L.join("\n"));
  console.log(
    `\n${disagreements.length} disagreement(s) of ${totalFindings} findings — ${onClean} clean, ${onBuggy} buggy.`,
  );
  console.log(`Reading list written to ${DIFF_PATH}`);
}

// ── Ground truth: validation + marking ──────────────────────────────────────
// The planted issues in each case's expected.json ARE the ground truth. They're keyed
// to the CODE (line_hint), not to any dog finding, so they survive re-running reviews.
// Validate on every run so a bad hand-edit fails loudly instead of silently mis-scoring;
// `--mark` appends an issue without hand-editing JSON.

const GT_CATEGORIES = ["correctness", "security", "performance"];
const GT_SEVERITIES = ["low", "med", "high"];
const LINE_HINT_RE = /^.+:\d+$/; // path:line, e.g. src/foo.ts:11

function validateExpected(name: string): string[] {
  const path = resolve(EVAL_DIR, name, "expected.json");
  if (!existsSync(path)) return [`${name}: missing expected.json`];
  let data: { clean?: unknown; issues?: unknown };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [`${name}: expected.json is not valid JSON — ${(e as Error).message}`];
  }
  const errs: string[] = [];
  if (typeof data.clean !== "boolean") errs.push(`${name}: "clean" must be a boolean`);
  if (!Array.isArray(data.issues)) return [...errs, `${name}: "issues" must be an array`];
  const issues = data.issues as Array<Record<string, unknown>>;
  if (data.clean === true && issues.length > 0)
    errs.push(
      `${name}: clean control has ${issues.length} issue(s) — a clean case needs "issues": []`,
    );
  if (data.clean === false && issues.length === 0)
    errs.push(`${name}: non-clean case has no planted issues (expected at least one)`);
  const ids = new Set<string>();
  issues.forEach((it, i) => {
    const at = `${name} issue[${i}]`;
    if (typeof it.id !== "string" || !it.id) errs.push(`${at}: "id" must be a non-empty string`);
    else if (ids.has(it.id)) errs.push(`${at}: duplicate id "${it.id}"`);
    else ids.add(it.id);
    if (!GT_CATEGORIES.includes(it.category as string))
      errs.push(`${at}: "category" must be ${GT_CATEGORIES.join("|")} (got "${it.category}")`);
    if (!GT_SEVERITIES.includes(it.severity as string))
      errs.push(`${at}: "severity" must be ${GT_SEVERITIES.join("|")} (got "${it.severity}")`);
    if (typeof it.line_hint !== "string" || !LINE_HINT_RE.test(it.line_hint))
      errs.push(`${at}: "line_hint" must look like path:line (got "${it.line_hint}")`);
    if (typeof it.description !== "string" || !it.description)
      errs.push(`${at}: "description" must be a non-empty string`);
    if (typeof it.must_catch !== "boolean") errs.push(`${at}: "must_catch" must be a boolean`);
  });
  return errs;
}

function validateGroundTruth(cases: string[]): string[] {
  return cases.flatMap(validateExpected);
}

function flagValue(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

/** Append a ground-truth issue to a case's expected.json (promote a finding). */
function markCase(caseName: string): void {
  const path = resolve(EVAL_DIR, caseName, "expected.json");
  if (!existsSync(path)) {
    console.error(`No such case: ${caseName} (missing ${path})`);
    process.exit(2);
  }
  const category = flagValue("category");
  const line = flagValue("line");
  const desc = flagValue("desc");
  const severity = flagValue("severity") ?? "med";
  const mustCatch = process.argv.includes("--must-catch");
  const usage = `Usage: pnpm eval --mark=<case> --category=<${GT_CATEGORIES.join("|")}> --line=<path:line> --desc="<text>" [--severity=<${GT_SEVERITIES.join("|")}>] [--must-catch] [--id=<id>]`;
  const problems: string[] = [];
  if (!category || !GT_CATEGORIES.includes(category))
    problems.push(`--category must be one of ${GT_CATEGORIES.join("|")}`);
  if (!line || !LINE_HINT_RE.test(line)) problems.push(`--line must look like path:line`);
  if (!desc) problems.push(`--desc="…" is required`);
  if (!GT_SEVERITIES.includes(severity))
    problems.push(`--severity must be one of ${GT_SEVERITIES.join("|")}`);
  if (problems.length) {
    console.error(`\nCannot mark:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n${usage}\n`);
    process.exit(2);
  }

  const data = JSON.parse(readFileSync(path, "utf8")) as {
    clean: boolean;
    issues: Array<Record<string, unknown>>;
  };
  if (data.clean === true) {
    console.error(
      `\n${caseName} is a clean control (clean:true) — adding a planted issue contradicts that.\n` +
        `If this control genuinely has a bug it's no longer a control: flip "clean" to false deliberately, then mark.\n`,
    );
    process.exit(2);
  }
  const existing = new Set((data.issues ?? []).map((i) => i.id as string));
  const id = flagValue("id") ?? `${category}-${(data.issues?.length ?? 0) + 1}`;
  if (existing.has(id)) {
    console.error(`id "${id}" already exists in ${caseName}; pass a unique --id=`);
    process.exit(2);
  }
  data.issues = [
    ...(data.issues ?? []),
    { id, category, severity, line_hint: line, description: desc, must_catch: mustCatch },
  ];
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

  const errs = validateExpected(caseName);
  if (errs.length) {
    console.error(`\nWrote, but the result is invalid:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Marked ${caseName}: +${id} (${category}/${severity}, ${mustCatch ? "MUST-catch" : "optional"}) @ ${line}\n  "${desc}"`,
  );
  console.log(
    `\nGround truth changed → cached judge verdicts are now stale. Re-judge (transcripts stay cached):\n  rm -f fixtures/eval/.runs/*.judge*.json && pnpm eval\n`,
  );
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  const casesArg = process.argv.find((a) => a.startsWith("--cases="));
  const only = casesArg ? new Set(casesArg.slice("--cases=".length).split(",")) : null;
  const labelArg = process.argv.find((a) => a.startsWith("--label="));
  const note = (
    labelArg ? labelArg.slice("--label=".length) : (process.env.EVAL_LABEL ?? "")
  ).trim();

  mkdirSync(RUNS_DIR, { recursive: true });
  let cases = readdirSync(EVAL_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  if (only) cases = cases.filter((c) => only.has(c));

  // --mark=<case>: append a ground-truth issue, then stop (no run).
  const markArg = process.argv.find((x) => x.startsWith("--mark="));
  if (markArg) {
    markCase(markArg.slice("--mark=".length));
    return;
  }

  // Validate ground truth on every invocation — a bad expected.json silently mis-scores,
  // so fail loudly and cheaply before any LLM work. `--check` validates and exits.
  const gtErrors = validateGroundTruth(cases);
  if (process.argv.includes("--check")) {
    if (gtErrors.length) {
      console.error(`\nGround truth INVALID:\n${gtErrors.map((e) => `  - ${e}`).join("\n")}\n`);
      process.exit(1);
    }
    console.log(`Ground truth OK — ${cases.length} case(s) valid.`);
    return;
  }
  if (gtErrors.length) {
    console.error(
      `\nGround truth INVALID (aborting before any run):\n${gtErrors.map((e) => `  - ${e}`).join("\n")}\n\n` +
        `Fix the expected.json file(s), or run \`pnpm eval --check\` to re-validate.\n`,
    );
    process.exit(1);
  }

  // --irr-worksheet / --irr-score: inter-rater reliability against a human. Cache-only (no LLM):
  // reconstruct the judged findings, let a human label them blind, then score Cohen's κ vs the judge.
  if (process.argv.includes("--irr-worksheet")) {
    irrWorksheet(process.argv.includes("--blind"));
    return;
  }
  if (process.argv.includes("--irr-score")) {
    irrScore(process.argv.includes("--blind"));
    return;
  }

  // --diff-judges[=A,B]: re-judge cached transcripts with two models, print divergences.
  const diffArg = process.argv.find((x) => x === "--diff-judges" || x.startsWith("--diff-judges="));
  if (diffArg) {
    const [a, b] = diffArg.includes("=")
      ? diffArg
          .slice("--diff-judges=".length)
          .split(",")
          .map((s) => s.trim())
      : DEFAULT_DIFF_JUDGES;
    if (!a || !b) {
      console.error("Usage: --diff-judges=<modelA>,<modelB>  (or bare for the defaults)\n");
      process.exit(2);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "\nERROR: ANTHROPIC_API_KEY not set (expected in apps/server/.env). Aborting.\n",
      );
      process.exit(2);
    }
    const usage = new Usage();
    const llm = new TrackingLlmAdapter(new AnthropicLlmAdapter(), usage);
    await diffJudges(llm, cases, a, b);
    return;
  }

  // The real Anthropic adapter is only needed when a case must actually be run or judged
  // live. A fully-cached re-score (the reproducible scoring path) makes no LLM calls, so
  // don't demand a key for it — that lets the report regenerate for free from the cache.
  const needsLive =
    fresh ||
    cases.some(
      (c) =>
        !existsSync(resolve(RUNS_DIR, `${c}.run.json`)) ||
        !existsSync(resolve(RUNS_DIR, `${c}.judge.json`)),
    );
  if (needsLive && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\nERROR: ANTHROPIC_API_KEY is not set (expected in apps/server/.env). A fresh run — or any\n" +
        "uncached case — needs the real Anthropic adapter; the fakes are scripted and measure nothing.\n" +
        "(A fully-cached re-score needs no key, but this invocation has at least one case to run live.)\n" +
        "Aborting.\n",
    );
    process.exit(2);
  }

  console.log(
    `Eval: ${cases.length} cases · model=${ANTHROPIC_MODEL} · concurrency=${CONCURRENCY} · ${fresh ? "FRESH (ignoring caches)" : "using caches where present"}` +
      (note ? ` · label="${note}"` : "") +
      `\n`,
  );
  // A live run appends a history row; without a label that row is context-free later.
  if (fresh && !note) {
    console.warn(
      'Tip: pass --label="what you are testing" (e.g. --label="pre-routing baseline") so the\n' +
        "history row records the experiment, not just the numbers.\n",
    );
  }

  const usage = new Usage();
  const llm = new TrackingLlmAdapter(new AnthropicLlmAdapter(), usage);

  if (needsLive) {
    // Only preflight the paths this invocation will actually drive: the orchestrator runs
    // when a transcript is missing or --fresh; the judge runs when a verdict is missing.
    const willDriveDogs = cases.some(
      (c) => fresh || !existsSync(resolve(RUNS_DIR, `${c}.run.json`)),
    );
    const willJudge = cases.some((c) => fresh || !existsSync(resolve(RUNS_DIR, `${c}.judge.json`)));
    await preflight(llm, { dogs: willDriveDogs, judge: willJudge });
  }

  const results = await pool(cases, CONCURRENCY, (c) => processCase(llm, c, fresh));

  const report = score(results, usage, note);
  writeFileSync(REPORT_PATH, report);
  // Also drop a per-(judge model, sample count) snapshot so switching judges never needs a
  // manual `cp`. EVAL-REPORT.md stays the canonical "latest run"; the snapshot is the durable,
  // per-config copy you compare across judges.
  const snap = snapshotPath(JUDGE_MODEL, JUDGE_RUNS);
  writeFileSync(snap, report);
  consoleSummary(report);
  console.log(`\nReport written to ${REPORT_PATH}`);
  console.log(
    `Snapshot (judge ${judgeFamily(JUDGE_MODEL)}${JUDGE_RUNS > 1 ? ` ×${JUDGE_RUNS}` : ""}) written to ${snap}`,
  );
  console.log(`Cached transcripts + judge verdicts under ${RUNS_DIR}`);
}

// Only drive the eval when run as the entry script (npx tsx …). Guarding this lets unit tests
// import the pure helpers (aggregateJudge) without kicking off a full live run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
