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

## Backlog (living — candidate next measurements, not history)

Unlike the entries below, this section is mutable: edited in place as priorities change, not
appended to. Each entry's own "Next" paragraph is a proposal made in the moment, not a commitment —
when more than one becomes plausible, they land here instead of fighting over which one is "the"
next entry. When an item is picked up, promote it into a new entry and delete it from this list.

- **qwen3.6:35b pilot** — Entry 5 only piloted `gemma4:31b`; a smoke test of `qwen3.6:35b` on the
  exact same Rex prompt produced degenerate staccato output ("Off. Bound. Wrong. Needs. Less.
  Equal. Not. Equal.") instead of coherent terse dialogue. Worth a real harness pilot (not just one
  sample) before writing it off — could be a prompt-fit issue, not a capability gap.
- **Persona-probe on local-model transcripts** — Entry 5 measured recall on `gemma4:31b`, not voice
  distinctiveness. Small live-judge cost (~$0.20–0.30) to see whether Rex/Bella/Duke stay
  attributable on a weaker local model, comparable to the Entry 3/4 Opus baseline.
- **Bella recovery** — Entry 4's Rex/Duke sharpening cost Bella 8pt of recall (78%→70%) even though
  her prompt didn't change, because Rex's new "pointed, no hand-waving" framing now overlaps Bella's
  own "asks pointed questions." Try dialing that back in Rex to see if Bella's number recovers
  without giving back Rex's gain. Lower priority — not a regression against any guardrail, just
  unclaimed headroom.

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

## Entry 3 — Frozen persona baseline (the reference interventions compare against) — 2026-07-07

**Config:** dogs `claude-opus-4-8` (the 42 Opus transcripts; the 6 Sonnet `hard-*` excluded) · judge
`claude-sonnet-5` · **modal of 3 judge passes** · 403 dog lines (`close` excluded).

**Why this, not Entry 2's number.** Entry 2's 54.4% was an *exploratory* single pass over a mixed-model
(42 Opus / 6 Sonnet) transcript set. A reference line that later interventions can be compared against
has to lock the protocol: **one dog-model** (the subject under test, not a blend) and the **modal of 3
judge passes** to tame the judge's own non-determinism. This is that frozen line.

**Result — the baseline to beat:**

| Metric | Value |
| --- | --- |
| **MODAL attribution accuracy** | **57.6%** |
| Random floor | 33.3% |
| Majority-class floor | 36.0% |
| Per-run accuracy | 55.8% / 58.6% / 55.8% (≈2.8pt spread) |
| Judge self-agreement | unanimous on **74%** of lines |

Per-dog recall: **Bella 78%** · Rex 50% · **Duke 46%**. Confusion is lopsided: Bella barely leaks (only
30/134 of her lines misattributed), while **Duke scatters almost evenly to Bella (46) and Rex (33)** and
Rex bleeds mostly to Bella (45). The modal changes the headline by ≤2pt vs any single run but removes the
coin-flip on the ~26% of lines the judge wavered on — which is the point of sampling.

**Reading.** The invariant holds — 57.6% is ~22pt over the majority-class floor, so the three are
demonstrably *not* one voice. But **the distinctiveness is carried almost entirely by Bella.** Rex
(gruff-correctness lead) and Duke (pragmatic-performance) are the collapsed pair.

**Cost:** ~$0.20 (judge runs 1–2; run 0 was free from Entry 2's cache). Re-scoring is free.

**Guardrails unchanged:** recall (Entry 1) and orchestration (Entry 2) remain flat — regressions would
still show, but the movement to chase is here.

**Next — the first real intervention.** Sharpen the Rex and Duke persona prompts (`apps/server/src/
config.ts`) to separate their voices — Rex terse/correctness-first, Duke performance/tradeoff-first —
without touching Bella, then re-run this exact protocol (`EVAL_PERSONA_RUNS=3`, Opus-only) and read the
modal + per-dog recall. Target: lift Duke and Rex recall without collapsing Bella.

---

## Entry 4 — First persona intervention: sharpen Rex/Duke voices — 2026-07-13

**Config:** dogs `claude-opus-4-8` (all 42 transcripts regenerated fresh, `--fresh`, same case set
as Entry 3) · judge `claude-sonnet-5` · modal of 3 judge passes · same blind-attribution protocol.

**Change:** Rewrote the Rex and Duke `persona_prompt`s in `apps/server/src/config.ts` (and the
judge's mirrored copy in `persona-probe.ts`), leaving Bella untouched. Entry 3 found Rex and Duke
collapsing into each other despite occupying different lanes — both read as "short, blunt, opinionated"
in isolation, once stripped of speaker label and lane content. The fix targets *register*, not lane:

- **Rex** — pushed further into clipped, fragment-heavy terseness ("clipped fragments, not full
  sentences") and an experience-tell ("has seen this exact mistake bite someone before").
- **Duke** — pulled the other direction, into a conversational, tradeoff-reasoning register ("talks
  like someone leaning back in a chair," reasons out loud about cost/benefit) instead of Rex-style
  flat verdicts.

**Hypothesis:** if the collapse was a voice problem (register/rhythm) rather than a content problem
(both dogs *sound* similar even when talking about different things), separating Rex and Duke's
registers should lift both dogs' recall without touching Bella, who was already distinct.

**Result — before vs. after:**

| Metric | Entry 3 (baseline) | Entry 4 (after) | Δ |
| --- | --- | --- | --- |
| MODAL attribution accuracy | 57.6% | **63.5%** | **+5.9pt** |
| Majority-class floor | 36.0% | 34.8% | — |
| Lift over majority-class floor | 21.6pt | **28.7pt** | **+7.1pt** |
| Per-run accuracy | 55.8 / 58.6 / 55.8% | 61.8 / 64.1 / 61.0% | +6.0pt avg |
| Judge self-agreement (unanimous) | 74% | 79% | +5pt |

Per-dog recall:

| Dog | Entry 3 | Entry 4 | Δ |
| --- | --- | --- | --- |
| Rex | 50% | **59%** | +9pt |
| Bella | 78% | 70% | **−8pt** |
| Duke | 46% | **61%** | +15pt |

**Reading.** The hypothesis mostly held: Duke moved the most (+15pt — the conversational/tradeoff
rewrite did the most work), Rex improved more modestly (+9pt — clipped fragments help but Rex was
already fairly distinct), and overall lift-over-floor rose 7.1pt. The confusion matrix shows the
Rex↔Duke cross-confusion specifically eased. The one side effect: **Bella dropped 8pt** even though
her prompt didn't change — the new Rex, sharpened into "pointed, no hand-waving" terseness, now bleeds
into some of Bella's own pointed/suspicious lines (25 of Bella's 118 lines were misattributed to Rex).
Net positive — total accuracy and floor-lift both up — but the fix wasn't free; sharpening one voice
narrowed the gap to an adjacent one. Recall (Entry 1) held at 34/34 (100%) on the full regen — no
orchestration or catch-rate regression from the persona change.

**Cost:** ~$7.38 for the 42-case live regen (dogs `$7.15` + eval-judge `$0.24`, from `EVAL-REPORT.md`'s
usage table) + ~$0.25 (estimated; the probe script doesn't track cost itself) for the fully-live
modal-of-3 persona pass (351 lines × 3 passes, no cache reuse since the new voice produces new line
text). Total ≈ **$7.63**, in line with the priced estimate before running it.

**Next.** This run surfaced more than one plausible follow-up (a Bella-recovery tweak, and — independent
of this result — a local free-model lineup to try now that hardware allows it). Rather than pick one
as *the* next entry, both are tracked in the Backlog section above; whichever gets picked up first
becomes Entry 5. Re-running this same protocol is also the standing regression check whenever
`config.ts` personas change again.

---

## Entry 5 — Local free-model pilot: gemma4:31b dogs, Opus director — 2026-07-13

**Config:** dogs `gemma4:31b` (locally-served via Ollama) · director `claude-opus-4-8` · judge
`claude-sonnet-5` · the 36 non-`hard2` cases (Entry 0's original case set).

**Change:** Built `apps/server/src/adapters/ollama.ts` (`streamText`-only — `completeStructured`
intentionally throws; the director and judge always stay on Anthropic for structured-output
reliability) plus `RoutingLlmAdapter` in `adapters/index.ts`, which dispatches every call by
`model_id` so a review can mix providers with zero changes to `director.ts`/`speaker.ts` — they
already pass a per-seat `model_id` on every call. Two real bugs surfaced and fixed while wiring
this up, both latent because `ANTHROPIC_MODEL` and `DIRECTOR_MODEL` had never diverged before:

- `run-eval.ts`'s preflight checked the director's structured-output path against
  `ANTHROPIC_MODEL` instead of `DIRECTOR_MODEL` — would have failed preflight and aborted the run
  the moment the two pointed at different models (exactly this config).
- `config.ts` hardcoded every seat's `provider: "anthropic"`, so `history.jsonl`'s lineup column
  would have read `anthropic/gemma4:31b` — wrong, it ran on Ollama. Now derived from
  `OLLAMA_MODELS` membership.

**Hypothesis:** does recall hold when the dogs' voice-generation model swaps from Opus to a free,
~31B locally-served model, with the director kept on Anthropic for move reliability?

**Result:**

| Metric | Value |
| --- | --- |
| Recall | **28/28 (100%)** — matches Opus on this same case set |
| Rex specialty catch-rate | 73% (8/11) |
| Bella specialty catch-rate | 100% (9/9) |
| Duke specialty catch-rate | 75% (6/8) |
| Additional findings | 11 (descriptive only) |

Recall held completely — no degradation from swapping the dogs' voice model, and the per-dog
specialty profile lands in the same range as the Opus lineups (Entries 0 and 4).

**Cost — the "free" framing needs a correction.** Total cost was **~$4.43, not $0**:

| Model | Role | Calls | Cost |
| --- | --- | --- | --- |
| `claude-opus-4-8` | director (labeled "dogs" in the report — see caveat below) | 378 | ~$4.25 |
| `claude-sonnet-5` | judge | 37 | ~$0.18 |
| `gemma4:31b` | dogs | 320 | **~$0.00** |

The dogs' own speech generation really was free — that part of the idea worked. But the director
runs every turn regardless of which model voices the dogs, and it stayed on paid Opus by design
(structured-move reliability, invariant 4). So "free models" only ever eliminates the dog-voice
cost, not the review's total cost — savings are real but partial. (Report caveat: the cost table's
"Role" column infers "dogs" vs "judge" from a two-way check against `JUDGE_MODEL`/`ANTHROPIC_MODEL`
and doesn't know about `DIRECTOR_MODEL` as a third possibility, so it mislabels the director's Opus
calls as "dogs" here. The dollar amounts are correct; only the row label is wrong. Not fixed this
entry — cosmetic, and the fix touches `Usage`'s role-inference logic more broadly than this pilot
needed.)

**Wall-clock:** ~45 minutes for 36 cases at concurrency 4 (Ollama's `think: false` cut per-turn
latency roughly 4×, from ~4.6s to ~1–5s per line depending on prompt length, but that is still an
order of magnitude slower than the API). A qualitative smoke test of `qwen3.6:35b` on the identical
Rex prompt (outside this harness run) produced degenerate staccato output — "Off. Bound. Wrong.
Needs. Less. Equal. Not. Equal." — instead of coherent dialogue, unlike `gemma4:31b`'s solid,
on-persona result. Not yet run through the real harness; tracked in the backlog.

**Takeaway.** The core finding holds up: swapping the dogs' voice model to a free, local ~31B
model cost nothing in recall. But this is genuinely a cost-*shape* change, not a cost-*elimination*
one — the director's Anthropic spend is structurally fixed by the two-call design (invariant 1),
so the real number to quote is "dog-voice generation is free," not "this review is free." Latency
is also a real, separate constraint from dollar cost: local hardware here is roughly 10x slower
per turn than the API.

**Guardrails unchanged:** recall held; this pilot didn't touch personas, so Entry 3/4's
persona-distinctiveness numbers aren't affected (and weren't re-measured against gemma's voice —
see backlog).

**Next.** See the Backlog section above — a `qwen3.6:35b` harness pilot and a persona-probe pass
over these `gemma4:31b` transcripts are both queued; neither is picked as canonically next.

---

<!-- Add Entry 6 below. Keep the shape above. -->

