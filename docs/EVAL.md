# The Review Table — Eval Harness Spec

_Authored 2026-06-29; revised 2026-07-07 after an inter-rater reliability study reshaped what we
measure. Additive; lives under `apps/server/src/eval/` + `fixtures/eval/`. No changes to the core
app. This is the credibility centerpiece: it measures whether the dogs actually catch the bugs we
plant (**recall** — the scored metric), and separately, descriptively, tracks the extra things they
flag (**additional findings** — reported, never scored)._

## 0. Goal

Run the review over a labeled set of diffs with known planted issues, then produce **one trustworthy
number and some honest color**:

- **Catch-rate (recall) — THE metric.** Of the planted must-catch issues, how many did the dogs
  surface? Ground-truth-anchored, reproducible, high inter-rater agreement. This is the headline and
  the number we try to move when we improve the dogs.
- **Per-persona breakdown.** Did Bella catch the security ones, Duke the perf ones, Rex the
  correctness ones? (Attributed to the thread *opener*, so it's opener-biased — read with the caveat.)
- **Additional findings — descriptive, NOT scored.** Substantive things the dogs raised that aren't
  in the ground truth. We count and attribute them; we do not grade them. See §3.1 for *why* — this
  is the most important design decision in the harness.

Output is a generated `EVAL-REPORT.md` (latest run) plus `EVAL-LOG.md` (the hand-written baseline →
change → result narrative) and `fixtures/eval/history.jsonl` (append-only machine record).

## 1. Dataset — `fixtures/eval/`

Hand-built cases. Each case is a diff plus a ground-truth file:

- `fixtures/eval/<case>/diff.patch` — a unified diff in the same format the app already parses (see
  `fixtures/sample.diff`). Keep each diff small and self-contained; the system is diff-only today, so
  do not author cases that require whole-tree context.
- `fixtures/eval/<case>/expected.json`:
  ```json
  {
    "clean": false,
    "issues": [
      {
        "id": "off-by-one-loop",
        "category": "correctness",        // correctness | security | performance
        "severity": "high",                // low | med | high
        "line_hint": "src/foo.ts:49",      // human-readable location for the judge
        "description": "Loop runs to <= len, reads one past the end of the array.",
        "must_catch": true
      }
    ]
  }
  ```

Authoring guidance:
- Plant realistic bugs: off-by-one, unchecked null/error, swallowed exception, missing `await`,
  race/double-write, resource leak, injection, `O(n^2)` in a hot path, etc.
- Spread across the three categories so the per-persona scores are meaningful (correctness → Rex,
  security/edge-cases → Bella, performance/over-engineering → Duke).
- Mix severities, and include **subtle** issues — the interesting signal is the subtle catches and
  misses, not the obvious ones.
- Include a few **clean control cases** (`"clean": true`). A clean control means *no planted bug* —
  it does **not** mean "nothing worth commenting on." Real diffs often contain latent, debatable
  concerns; the dogs will surface some on clean controls, and those land in **additional findings**,
  not in a penalty. Clean controls exist so recall isn't the only lens, not to punish extra findings.
- **Headroom matters more than volume.** A fixture set the dogs ace at 100% recall cannot demonstrate
  improvement — there's nowhere for the number to go. Deliberately include cases the current dogs
  *miss* so the baseline sits below 100% and a change can show a measurable gain.

## 2. Runner — `apps/server/src/eval/run-eval.ts`

For each case:
1. Run the orchestrator to completion on the diff with **real adapters** (real `LlmAdapter`). Fake
   adapters are scripted and measure nothing. TTS/STT are stubbed — the eval only needs the text
   transcript, not audio.
2. Collect the **raised findings** = transcript entries whose `move` is in `{raise_issue, pushback,
   pile_on, nitpick}`. Collapse a single `thread_id` into one finding (a thread is one issue discussed
   across several turns; do not double-count). Capture `seat_id`, `move`, `thread_id`,
   `focus_anchors`, `text`.
3. Resolve `focus_anchors` back to diff line numbers via the existing anchor table.

Cost & reproducibility:
- Real LLM runs cost money and vary run-to-run. Cache raw transcripts to `fixtures/eval/.runs/` so the
  **scoring step re-runs without re-calling the LLM** (`pnpm eval` reads cache by default; `--fresh`
  re-drives live). Every report is stamped with run date + model ids.

## 3. Judge — LLM-as-judge (semantic matching)

For each case, give a judge LLM the case's ground-truth `issues` and the dogs' raised findings, and
ask it to **match each finding to at most one ground-truth issue semantically** (not string- or
anchor-exact). Uses the app's structured-output adapter, so the judge returns validated JSON.

Classification per case:
- **Caught (true positive):** a ground-truth issue matched by ≥1 finding (record which seat opened it).
- **Miss (false negative):** a `must_catch` ground-truth issue with no matching finding.
- **Additional finding:** any substantive finding not matched to a planted issue. Reported and
  attributed (per dog, per case); **not scored**. (Internally the judge still splits these into
  "false_positive" and "bonus", but the report collapses them — see §3.1.)
- Purely cosmetic/stylistic nitpicks are ignored entirely.

### 3.1 Why precision is NOT scored (the load-bearing decision)

The original design scored a **false-positive rate**: an "additional" finding was either a
hallucination (bad) or a valid bonus (fine). We tried to measure that split and it failed an
inter-rater reliability test:

- We ran a two-stage IRR study — a human labeled findings first **blind** (ground truth + dialogue
  only, matching a diff-blind judge), then **informed** (with the diffs in view) — and compared
  against the LLM judge with **Cohen's κ**.
- **Recall was near-perfect agreement** (it's anchored to ground truth). But the false-positive /
  bonus / ignore split landed at **κ≈0.42 — even between two humans who both read the code.** Giving
  the judge the diff did **not** improve it (κ 0.428 → 0.416).
- Root cause: "spurious alarm vs. sharp unplanned catch" is a genuine value judgment, and several
  "clean" controls contain real latent issues, so the fp-vs-bonus line is ill-defined.

Conclusion, and the harness's core stance: **a metric two careful humans can't agree on is not a
metric.** We score only recall. Additional findings are surfaced descriptively so a human can eyeball
them — including, per the changelog, watching which extra items recur per dog — but they never move a
score. (Documenting this reasoning is itself an eval-maturity signal, so it's on-brand to keep.)

## 4. Scoring & report — `EVAL-REPORT.md`

- **Catch-rate (recall)** = caught / (caught + missed) over `must_catch` issues — aggregate, per
  category, and per persona (opener-attributed). The headline.
- **Additional findings** = count + per-dog attribution + the actual items (the judge's one-line
  rationale per finding), so you can read what the dogs surface off-ground-truth. Descriptive only.
- **History** = `fixtures/eval/history.jsonl` renders as an over-time table so a change's recall delta
  is visible run-to-run. Tag each run with `--label`.
- No false-positive rate, no precision score. Cost is estimated per model at its own list rate.

## 5. Reuse / acceptance

- Reuse the orchestrator-driving pattern; reuse the structured-output adapter for the judge. No
  core-app changes.
- `pnpm eval` runs all cases and writes `EVAL-REPORT.md` reproducibly from cached transcripts;
  `--fresh` re-drives live.
- **Acceptance:** `pnpm eval` produces a report with catch-rate + per-persona + a descriptive
  additional-findings breakdown, re-scorable from cache without new LLM calls, and a human reading one
  case's caught/missed list agrees with the judge's calls.
