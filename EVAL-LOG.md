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

<!-- Add Entry 1 below when the hard fixture set exists. Keep the shape above. -->
