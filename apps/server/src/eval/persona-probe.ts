// Persona-distinctiveness probe (blind attribution).
//
// Tests load-bearing invariant #1 — the three per-model personas must NOT collapse into one
// voice. Method: strip every dog line of its speaker label, move type, and conversational
// context; shuffle lines across all cases; ask the judge (JUDGE_MODEL) to attribute each blind
// line to Rex / Bella / Duke given only the three real persona prompts. Score attribution
// accuracy vs a 33% random floor and the majority-class floor.
//
//   High accuracy  → voices are distinct → invariant holds → little persona headroom.
//   ~majority-class → voices have collapsed → invariant at risk → real headroom.
//
// `close` moves are excluded (Rex closes 100% of threads — a ROLE tell, not a VOICE tell).
// Lines are shuffled globally so no two batched lines share a thread: this isolates VOICE
// from "this reply obviously answers Bella, so it's someone else" contextual reasoning.
//
// The baseline scores the MODAL attribution across EVAL_PERSONA_RUNS judge passes (default 3),
// over a single dog-model only (PERSONA_DOG_MODEL, default ANTHROPIC_MODEL) so the subject model's
// persona baseline isn't polluted by other-model transcripts. Predictions are cached per (judge,
// run, line-hash) in .runs/persona-probe.<judge>[.run<i>].json, so re-scoring is FREE.
//   npx tsx src/eval/persona-probe.ts                    # modal of 3, dogs=claude-opus-4-8
//   EVAL_PERSONA_RUNS=1 npx tsx src/eval/persona-probe.ts  # single pass (the original probe)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonSchema } from "@review-table/contracts";
import { AnthropicLlmAdapter } from "../adapters/anthropic";
import { ANTHROPIC_MODEL, JUDGE_MODEL } from "../env";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = resolve(here, "../../../../fixtures/eval/.runs");

const DOGS = ["rex", "bella", "duke"] as const;
type Dog = (typeof DOGS)[number];

// The real persona prompts (kept in sync with apps/server/src/config.ts) plus lanes, so the
// judge attributes against the ACTUAL intended personas — not a paraphrase.
const PERSONAS: Record<Dog, string> = {
  rex:
    "Rex — the grizzled lead reviewer. A senior engineer who has seen every way code can rot. " +
    "Facilitates but does not soften; blunt, dry, occasionally gruff. Cares about correctness and " +
    "whether the author actually understood the change. Short sentences. Lane: correctness, logic.",
  bella:
    "Bella — the security- and edge-case-minded reviewer. Sharp, precise, a little suspicious. Hunts " +
    "the unchecked input, the swallowed error, the panic-in-production. Asks pointed questions, does " +
    "not let hand-waving slide. Lane: security, input validation, edge cases, error handling.",
  duke:
    "Duke — the pragmatic performance-and-shipping reviewer. Easygoing but allergic to over-engineering " +
    "and needless allocation. Weighs whether a change is worth it, pushes back on gold-plating, keeps the " +
    "review moving. Lane: performance, complexity, resource use, over-engineering.",
};

// Deterministic FNV-1a hash → stable shuffle + stable per-line cache key (no Math.random).
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface Line {
  id: string; // stable hash key
  text: string;
  truth: Dog;
}

function collectLines(modelFilter?: string): Line[] {
  const lines: Line[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(RUNS_DIR).filter((n) => n.endsWith(".run.json"))) {
    const d = JSON.parse(readFileSync(resolve(RUNS_DIR, f), "utf8"));
    if (modelFilter && d.model !== modelFilter) continue; // clean single-model baseline
    for (const t of d.turns ?? []) {
      const seat = t.seat_id;
      if (!DOGS.includes(seat)) continue;
      if (t.move === "close") continue; // role tell, not voice tell
      const text: string = (t.text ?? "").trim();
      if (text.length < 25) continue; // too short to carry voice
      const id = fnv1a(text);
      if (seen.has(id)) continue; // dedup identical lines
      seen.add(id);
      lines.push({ id, text, truth: seat });
    }
  }
  // Deterministic shuffle: order by hash of the id (decouples from case/thread order).
  return lines.sort((a, b) => fnv1a(a.id).localeCompare(fnv1a(b.id)));
}

const ATTR_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    attributions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          line_id: { type: "string" },
          dog: { type: "string", enum: ["rex", "bella", "duke"] },
        },
        required: ["line_id", "dog"],
      },
    },
  },
  required: ["attributions"],
};

const SYSTEM =
  "You are attributing anonymous code-review remarks to one of three reviewers, by VOICE and STANCE " +
  "alone. Each remark was said by exactly one of them. You are given no speaker label and no " +
  "surrounding conversation — judge only from the words. The three reviewers:\n\n" +
  `REX:\n${PERSONAS.rex}\n\nBELLA:\n${PERSONAS.bella}\n\nDUKE:\n${PERSONAS.duke}\n\n` +
  "For EVERY line_id you are given, output exactly one attribution (rex | bella | duke). You must " +
  "choose one even when unsure — never skip a line. Attribute by whose personality, focus, and tone " +
  "the remark best fits.";

function buildUser(batch: Line[]): string {
  return [
    "Attribute each remark to rex, bella, or duke:",
    "",
    ...batch.map((l) => `[${l.id}] ${l.text}`),
  ].join("\n");
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set (expected in apps/server/.env).");
    process.exit(2);
  }
  const judge = JUDGE_MODEL;
  const dogModel = process.env.PERSONA_DOG_MODEL ?? ANTHROPIC_MODEL; // baseline = one dog-model
  const RUNS = Math.max(1, Math.floor(Number(process.env.EVAL_PERSONA_RUNS ?? 3)) || 1);
  const jslug = judge.replace(/[^a-z0-9]+/gi, "-");

  const lines = collectLines(dogModel);
  const truth = new Map(lines.map((l) => [l.id, l.truth]));
  console.log(
    `persona baseline · judge=${judge} · dogs=${dogModel} · ${RUNS} judge pass(es) · ` +
      `${lines.length} unique dog lines (close excluded)`,
  );

  // One cache per (judge, run). Run 0 keeps the legacy suffix-free name (seeded by the earlier
  // single-pass probe); extra runs get a `.run<i>` suffix, mirroring the harness's judge sampling.
  const runPreds: Record<string, Dog>[] = [];
  const llm = new AnthropicLlmAdapter();
  const BATCH = 25;
  for (let r = 0; r < RUNS; r++) {
    const cachePath = resolve(RUNS_DIR, `persona-probe.${jslug}${r === 0 ? "" : `.run${r}`}.json`);
    const cache: Record<string, Dog> = existsSync(cachePath)
      ? JSON.parse(readFileSync(cachePath, "utf8"))
      : {};
    const todo = lines.filter((l) => !(l.id in cache));
    process.stdout.write(`  run ${r}: ${lines.length - todo.length} cached, ${todo.length} to do`);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const res = await llm.completeStructured<{ attributions: { line_id: string; dog: Dog }[] }>({
        model_id: judge,
        system: SYSTEM,
        messages: [{ seat_id: "director", role: "user", text: buildUser(batch) }],
        schema: ATTR_SCHEMA,
        cacheKey: "persona-probe-rubric",
      });
      for (const a of res.attributions ?? []) {
        if (truth.has(a.line_id) && DOGS.includes(a.dog)) cache[a.line_id] = a.dog;
      }
      writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    }
    // keep only lines belonging to this dog-model (the legacy run-0 cache may hold other-model ids)
    const pred: Record<string, Dog> = {};
    for (const l of lines) if (cache[l.id]) pred[l.id] = cache[l.id] as Dog;
    runPreds.push(pred);
    process.stdout.write("\n");
  }

  // ---- modal collapse across runs (tie → DOGS order) ----
  const scored = lines.filter((l) => runPreds.every((p) => l.id in p));
  const modal = new Map<string, Dog>();
  let unanimous = 0;
  for (const l of scored) {
    const votes: Record<Dog, number> = { rex: 0, bella: 0, duke: 0 };
    for (const p of runPreds) votes[p[l.id] as Dog]++;
    let best: Dog = "rex";
    for (const d of DOGS) if (votes[d] > votes[best]) best = d;
    modal.set(l.id, best);
    if (DOGS.some((d) => votes[d] === RUNS)) unanimous++;
  }

  // per-run accuracy (the non-determinism we're taming)
  const perRunAcc = runPreds.map((p) => {
    let c = 0;
    for (const l of scored) if (p[l.id] === l.truth) c++;
    return c / scored.length;
  });

  // ---- score the modal ----
  const truthCount: Record<Dog, number> = { rex: 0, bella: 0, duke: 0 };
  const predCount: Record<Dog, number> = { rex: 0, bella: 0, duke: 0 };
  const confusion: Record<Dog, Record<Dog, number>> = {
    rex: { rex: 0, bella: 0, duke: 0 },
    bella: { rex: 0, bella: 0, duke: 0 },
    duke: { rex: 0, bella: 0, duke: 0 },
  };
  let correct = 0;
  for (const l of scored) {
    const pred = modal.get(l.id);
    if (!pred) continue;
    truthCount[l.truth]++;
    predCount[pred]++;
    confusion[l.truth][pred]++;
    if (pred === l.truth) correct++;
  }
  const n = scored.length;
  const acc = correct / n;
  const majorityClass = Math.max(...DOGS.map((d) => truthCount[d])) / n;
  const spread =
    RUNS > 1
      ? `  per-run: ${perRunAcc.map((a) => `${(a * 100).toFixed(1)}%`).join(" / ")}` +
        `  ·  unanimous on ${((unanimous / n) * 100).toFixed(0)}% of lines`
      : "";

  console.log("\n" + "=".repeat(64));
  console.log(`PERSONA-DISTINCTIVENESS BASELINE — modal of ${RUNS} · dogs=${dogModel}`);
  console.log("=".repeat(64));
  console.log(`lines scored:      ${n}`);
  console.log(`MODAL accuracy:    ${(acc * 100).toFixed(1)}%`);
  console.log(`  random floor:    33.3%`);
  console.log(`  majority-class:  ${(majorityClass * 100).toFixed(1)}%  (always-guess-most-frequent)`);
  if (spread) console.log(spread);
  console.log("");
  console.log("per-dog recall (of this dog's lines, how many attributed correctly):");
  for (const d of DOGS) {
    const rec = truthCount[d] ? confusion[d][d] / truthCount[d] : 0;
    const prec = predCount[d] ? confusion[d][d] / predCount[d] : 0;
    console.log(
      `  ${d.padEnd(6)} recall ${(rec * 100).toFixed(0).padStart(3)}%  precision ${(prec * 100)
        .toFixed(0)
        .padStart(3)}%   (${truthCount[d]} lines)`,
    );
  }
  console.log("");
  console.log("confusion (row = truth, col = predicted):");
  console.log(`         ${DOGS.map((d) => d.padStart(6)).join("")}`);
  for (const t of DOGS) {
    console.log(`  ${t.padEnd(6)} ${DOGS.map((p) => String(confusion[t][p]).padStart(6)).join("")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
