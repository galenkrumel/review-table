# The Review Table — Eval Log

Append-only record of how well the dogs review code, and how that changes as we work on
them. **Entry 0 is the baseline; every entry after it is one change we made and what it did
to the numbers.** Read top-to-bottom and you get the whole story: baseline → intervention →
measured result, repeated. This is the human narrative; the machine records live in
`EVAL-REPORT.md` (regenerated every run) and `fixtures/eval/history.jsonl` (append-only).

## How to read this

- **Catch-rate (recall) is the metric.** Of the bugs we deliberately planted, how many did the
  dogs surface? It is ground-truth-anchored and reproducible, so a change to it is real signal.
  This is the number to move.
- **Additional findings are descriptive, never scored.** These are substantive things the dogs
  flagged that aren't in the planted ground truth. We *count and attribute* them (per dog, per
  case) but we do **not** grade them "false positive" vs "sharp extra catch" — an inter-rater
  study (`docs/EVAL.md`) found that call too subjective to measure (κ≈0.42 between two humans who
  both read the code). Watch them for texture; don't optimize against them.
- **Each entry follows one shape:** _Change · Hypothesis · Result (recall table) · Per-persona ·
  Additional (descriptive) · Cost · Takeaway._ Copy the headline numbers from that run's
  `EVAL-REPORT.md` into a new entry; keep the prose to a paragraph.
- Tag each run with `pnpm eval --label "what I changed"` so the run's `history.jsonl` row and the
  in-report History table carry the same label as the entry here.

---

## Entry 0 — Baseline (easy set) — 2026-07-07

**Config:** dogs `claude-opus-4-8` · judge `claude-sonnet-5` · 36 cases (28 must-catch bugs across
correctness/security/performance + 8 clean controls). Scored from cached transcripts.

**Change:** None — this is the starting line. First honest measurement after settling the metric
philosophy (recall scored, precision demoted to descriptive; see `docs/EVAL.md`).

**Result — catch-rate (recall):**

| Category    | Caught | Planted | Catch-rate |
| ----------- | ------ | ------- | ---------- |
| correctness | 11     | 11      | 100%       |
| security    | 9      | 9       | 100%       |
| performance | 8      | 8       | 100%       |
| **overall** | **28** | **28**  | **100%**   |

**Per-persona** (attributed to the dog that *opened* the thread; opener-biased toward the lead — see
report caveat): Rex 9 · Bella 12 · Duke 7. In-lane specialty catch-rate: Rex 9/11 (82%),
Bella 9/9 (100%), Duke 6/8 (75%).

**Additional findings (descriptive, not scored):** 17 total — Rex 5, Bella 9, Duke 3. Several land
on clean controls (e.g. Bella flags an unescaped `%`/`_` in a `LIKE` term; Rex flags a missing
null-guard in a rename). Whether these are noise or sharpness is a judgment call we chose not to
automate.

**Cost:** $0 this run (scored from cache; no live LLM calls).

**Takeaway — and the one real problem this exposes:** recall is **saturated at 100%** on the current
fixtures. That is a good sales number but a *useless* starting line for demonstrating improvement —
you cannot show a metric rise from 100%. So the very next experiment (Entry 1) is **not** a change to
the dogs; it is **building a harder fixture set** that the dogs currently *miss*, deliberately
dropping baseline recall below 100% to create headroom. Only then can a change to the dogs show a
measurable gain. Framing: Entry 0 is "saturated baseline on the easy set"; Entry 1 introduces the
hard set and re-baselines.

---

## Entry 1 — Calibration: recall has no headroom → recall becomes a guardrail — 2026-07-07

**Config:** dogs `claude-opus-4-8` (with a `claude-sonnet-5` cross-check) · judge `claude-sonnet-5` ·
12 hard cases authored across two batches.

**Intent.** Entry 0 predicted the next move was a hard fixture set to drop recall below 100% and
create headroom. Authored two batches to do exactly that:
- `hard-*` (6) — subtle *single-bug* diffs: allSettled-swallow, splice-in-loop, open-redirect
  prefix-match, prototype pollution, memo-key timestamp, Set-rebuilt-in-loop.
- `hard2-*` (6) — realistic 25–45 line diffs that *bury* the real bug under a plausible "feature"
  (rate-limit sleep, RBAC, filtering, retry/backoff, helper extraction) plus decoys: stale-cache-on
  -update, dropped partial batch, dropped token-expiry, IDOR in a filtered branch, serial-await
  buried in retry, per-item re-sort.

**Result — the hypothesis failed:**

| Batch | Dogs | Recall | Additional |
| --- | --- | --- | --- |
| `hard` (6)  | `opus-4-8`  | 6/6 (100%) | 0  |
| `hard` (6)  | `sonnet-5`  | 6/6 (100%) | 12 |
| `hard2` (6) | `opus-4-8`  | 6/6 (100%) | 8  |

Opus caught **18/18** across both batches — including the buried-bug diffs — with perfect in-lane
specialty catch-rate. Sonnet also went 6/6.

**Cost:** ~$4.4 calibration (opus hard $0.92, sonnet hard $1.49, opus hard2 $2.00).

**Takeaway — the real finding.** Recall on planted bugs is **saturated for a capable panel, and it's
structural.** This isn't one model reading a diff — it's a **3-dog panel debating over many turns**
(ensemble recall). Every dog gets a shot at every bug, so ensemble recall on any *catchable* bug
saturates. Hand-authoring a diff-only, unambiguous bug that a frontier panel misses isn't achievable
at sane effort, and weakening the panel to Sonnet buys nothing here (Sonnet is also 6/6 — and
*chattier/pricier*, not weaker at catching these).

**Decision.**
- **Demote recall to a guardrail** — a regression check ("an improvement didn't make the dogs start
  *missing* planted bugs"), not the improvement axis. Recognizing a saturated metric and repurposing
  it is the eval judgment, not a dead end.
- **Keep the 12 hard fixtures** — valid, and they double as review-drivers for the new axes (any diff
  drives a full review).
- **Pivot the improvement work** to axes with real headroom, all computable from the transcripts the
  harness already captures:
  - *Orchestration / floor control* — turn balance across dogs, lane-routing accuracy (security→Bella,
    perf→Duke, correctness→Rex), hunk coverage, anti-agreeableness (pushback before resolve).
    _Hypothesis: an opener-bias toward Rex and lane mis-routing leave headroom here — **tested and
    largely falsified in Entry 2**, which measured the opposite (Bella opens most; Rex leads only by
    closing) and effectively clean routing._
  - *Persona distinctiveness* — blind attribution of unlabeled lines to the right dog (tests the
    "personas must not collapse into one voice" invariant).

**Next:** a free structural readout of the orchestration metrics over the cached transcripts, to
confirm the headroom is real before spending on a live baseline.

---

## Entry 2 — Where's the real headroom? Free structural readout + persona probe — 2026-07-07

**Config:** measured over the 48 cached transcripts (42 `claude-opus-4-8`, 6 `claude-sonnet-5`) from
Entries 0–1. Structural readout is deterministic and **free** (`$0`); the persona probe is one
`claude-sonnet-5` judge pass (~$0.12). No fresh dog runs.

**Intent.** Entry 1 pivoted from recall to orchestration + persona but assumed the orchestration
headroom without measuring it. Before spending on a live baseline, measure the cheap proxies first —
same discipline as Entry 1 (probe before you build).

**Result A — orchestration structural metrics are saturated/confounded (the pivot's own premise
fails).** All computed for free from the transcripts:

| Metric | Value | Read |
| --- | --- | --- |
| Floor balance (turn share) | Rex 37.6% · Duke 32.9% · Bella 29.5% | healthy — **0 cases** where any dog stayed silent |
| Thread openers (`raise_issue`) | **Bella 47 · Rex 34 · Duke 21** | Entry 1's "opener-bias toward Rex" is **backwards** — Bella opens most |
| Thread closers (`close`) | **Rex 48 / 48 (100%)** | Rex's higher turn-share is his *lead/closer role by design*, not floor-hogging |
| Lane-opening routing | 41/47 in-lane (87%) | all **6** "misses" are genuinely cross-lane (error-handling/edge-case issues that fall in Bella's lane, or multi-issue fixtures) → effective director-error rate ≈ 0 |
| Anti-agreeableness | 101/101 threads had pushback | saturated — the turn-loop always scripts a pushback beat; too coarse to grade |

So the cheaply-measurable orchestration axes are as flat as recall was. **The correction matters:** the
data falsifies my own Entry-1 premise. Rex dominates *closing*, not *opening* — and the director routes
the right lane essentially every time once you account for issues that legitimately straddle two lanes.

**Result B — persona distinctiveness is the axis with real headroom.** Blind attribution: strip 524
dog lines of speaker/move/context (drop `close` — a role tell, not a voice tell), shuffle across cases,
ask the judge to attribute each to Rex/Bella/Duke from the three real persona prompts alone.

| | Accuracy |
| --- | --- |
| **Overall** | **54.4%** |
| Random floor | 33.3% |
| Majority-class floor | 35.9% |

Per-dog recall: **Bella 71%** · Rex 48% · Duke 45%. Confusion is structured, not uniform: **Rex and Duke
blur into each other** (74 cross-confusions) and both bleed into Bella (the judge over-predicts Bella —
precision 51%). Read: the invariant **holds** (voices are well above the collapse floor — not one voice),
but only Bella is *sharply* distinct; Rex (gruff-correctness) and Duke (pragmatic-performance) sound too
alike. That is a concrete, gradeable weak spot a persona-prompt change can move.

**Cost:** ~$0.12 (structural readout $0; one Sonnet persona-attribution pass). Cached per line, so
re-scoring is free.

**Caveats (kept honest).** 100% attribution isn't the ceiling — some lines are genuinely generic
("Bella's right, and it's worse"). One judge, one pass (non-determinism not yet sampled). Part of the
54% is lane *content* leaking into attribution, not pure style — but the Rex↔Duke blur shows their
styles are close even when content differs. The transcript lineup is mixed-model (42 Opus / 6 Sonnet);
a clean persona baseline should freeze to one model.

**Decision.** Make **persona distinctiveness** the improvement axis; **orchestration joins recall as a
guardrail** (both measured, both flat — regressions still visible, but not where the gain is).

**Next:** freeze a single-model persona baseline (modal of a few judge passes to tame non-determinism),
then sharpen the Rex/Duke persona prompts to separate their voices and re-measure the attribution
accuracy — the first real intervention with a number to move.

---

<!-- Add Entry 3 below (first persona intervention). Keep the shape above. -->

