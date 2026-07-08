# The Review Table — project guide for Claude Code

> Working title. Rename freely. Codename `review-table`.

## What this is

A web app that runs a **live, voiced, multi-party code review** staged as the
"dogs playing poker" painting. Three AI reviewers (each a distinct dog with its
own voice and personality) plus the human code author sit around a table. An
invisible **moderator** ("director") walks the group through a pull request:
deciding who speaks, opening and closing discussion threads, calling on the
author, and delivering a verdict at the end. Dogs speak aloud (text-to-speech)
with amplitude-driven mouth animation; the human participates by typing (for
precise, line-level points) and by push-to-talk speech (for discussion).

This is a working MVP — it runs end-to-end with or without API keys.

## Read these before working

- `docs/ARCHITECTURE.md` — components, the turn loop, the floor-control state
  machine, audio/lip-sync pipeline, latency, multi-model abstraction, diff
  anchoring.
- `packages/contracts/src` — the **authoritative** wire/format schemas and
  interfaces, expressed in code. When in doubt, the types here win.

## Commands

- `pnpm install` — bootstrap the workspace.
- `pnpm dev` — custom launcher (`scripts/dev.mjs`) that starts the server + Vite
  client on auto-picked free ports and prints the local URL. Not a plain `vite`.
- `pnpm typecheck` — `tsc --noEmit` across all packages. Run it before committing.
- `pnpm lint` — Biome lint + format check (`biome check .`); exits non-zero on
  errors. `noNonNullAssertion`/`noExplicitAny` are intentionally **warnings**, and
  `noAutofocus` is off — see `biome.json`. Don't "fix" warnings by rewriting `!`
  lookups or adapter-boundary `any`.
- `pnpm format` — Biome auto-fix + format (`biome check --write .`).
- `pnpm -r test` — all Vitest unit tests (there is no root `test` script). Tests
  live in `apps/server/test/` and `packages/anchoring/test/`. Scope with
  `pnpm --filter @review-table/server test`; a single test with
  `pnpm --filter @review-table/server test -- -t "name"`.
- `pnpm --filter @review-table/server smoke` — keyless end-to-end run of the full
  turn loop (`USE_FAKES=1`); verifies orchestration with no API keys or cost.
- `pnpm eval` — LLM-as-judge eval: drives the real review over the labeled diffs in
  `fixtures/eval/` and scores catch-rate (recall). A plain run re-scores from cached
  transcripts for **free**; `--fresh` re-runs live and **costs money** (real Anthropic
  calls, needs `ANTHROPIC_API_KEY`). Pass flags through `--`, e.g.
  `pnpm eval -- --fresh --label="…"`. `pnpm eval:check` validates the ground-truth
  files. Full flag list is the header comment in `apps/server/src/eval/run-eval.ts`;
  what it measures and why precision isn't scored is in `docs/EVAL.md`. Recall is the
  scored metric; extra findings are tracked descriptively, never graded.
- `pnpm build` — `tsc` build across packages.

Runs keyless by default: with `ANTHROPIC_API_KEY`/`ELEVENLABS_API_KEY` absent (or
`USE_FAKES=1`) the app uses deterministic fakes. Real keys go in `apps/server/.env`
(copy `.env.example`), loaded server-side only. Knobs: `DIRECTOR_MODEL`,
`VOICE_REX`/`VOICE_BELLA`/`VOICE_DUKE`.

## Load-bearing invariants (do not violate without flagging)

1. **The director emits *moves*, not dialogue.** A separate speaker call turns a
   move into in-character speech. If the director writes the dogs' lines, the
   per-model personas collapse into one voice. Two calls per turn, always.
2. **One coordinate system for code.** All references to code flow through opaque
   anchor ids resolved by a single resolver. Raw line numbers never appear in the
   director output, speaker prompts, dialogue, or editor highlight logic. See the
   anchoring scheme in `docs/ARCHITECTURE.md`.
3. **Providers live behind adapters.** `LlmAdapter`, `TtsAdapter`, `SttAdapter`.
   The orchestration core is provider-agnostic even while only one provider is
   wired. No provider-specific assumptions (system-prompt handling, tool-call
   format, streaming shape) leak into the core.
4. **Director output is structured output / tool-calling, never free-text parsed.**
   An unseated or malformed move is a bug, not a thing to regex around.
5. **Every emitted anchor is validated against the anchor table.** On a miss,
   clamp to the hunk or regenerate. The editor never scrolls to a nonexistent line.
6. **Provider API keys are server-side only.** The browser never holds a key. The
   server orchestrates LLM/TTS/STT and streams audio to the client.
7. **On push-to-talk, dog audio is hard-paused.** This is what avoids the
   full-duplex echo/barge-in problem. No dog audio plays while the mic is open.

## Stack (recommended, swappable)

TypeScript end to end — the contract-heavy design makes shared client/server types
a real win. React + Vite frontend; Node + WebSocket backend; Web Audio API for
lip-sync; in-memory session state (no DB for MVP).
If you build UI, consult the `frontend-design` skill if available in this
environment.

## Layout

pnpm workspace (`packages/*`, `apps/*`). Cross-package imports use `workspace:*`
and resolve straight to TypeScript source (`exports → ./src/index.ts`) — no build
step needed in dev.

- `packages/contracts` (`@review-table/contracts`) — shared wire/format types, the
  source of truth imported by both sides — the authoritative wire/format contract.
- `packages/anchoring` (`@review-table/anchoring`) — unified-diff parser + anchor
  resolver + validation (unit-tested).
- `apps/server` (`@review-table/server`) — Node + ws: director loop, speaker,
  ledger, gate/addressing, provider adapters, session state.
- `apps/client` (`@review-table/client`) — React + Vite: scene, diff pane,
  audio/lip-sync, human input.
