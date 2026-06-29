# Architecture

## 1. System overview

Three layers:

- **Client (browser)** — renders the table scene and editor pane, plays streamed
  audio, drives mouth animation from audio amplitude, captures human input (text +
  push-to-talk), sends control events.
- **Server (Node)** — owns provider keys and all orchestration: runs the director
  loop, makes LLM calls (director + speaker), runs TTS and STT through adapters,
  streams audio and turn events to the client, holds session state (anchor table,
  ledger, transcript) in memory.
- **Adapters** — `LlmAdapter`, `TtsAdapter`, `SttAdapter`. The only place
  provider-specific code lives. The core speaks an internal format; adapters
  translate at the boundary.

The client/server link is a WebSocket carrying control events and audio chunks (see
the protocol types in `packages/contracts/src/protocol.ts`).

```
 Browser                              Server                         Providers
 ┌───────────────┐   WebSocket   ┌────────────────────────┐
 │ Table scene   │◀────events────│ Orchestrator (loop)    │
 │ + mouth anim  │◀────audio─────│  ├─ Director call ─────┼──▶ LlmAdapter ──▶ …
 │ Editor pane   │               │  ├─ Speaker call ──────┼──▶ LlmAdapter ──▶ …
 │ Input (text/  │────events────▶│  ├─ TTS stream ────────┼──▶ TtsAdapter ──▶ …
 │  push-to-talk)│               │  ├─ STT (PTT clip) ────┼──▶ SttAdapter ──▶ …
 └───────────────┘               │  └─ Session state      │
                                 │     (anchors, ledger,  │
                                 │      transcript)       │
                                 └────────────────────────┘
```

## 2. The turn loop (two calls per turn)

Every turn is two LLM calls. This separation is non-negotiable (see CLAUDE.md
invariant 1).

1. **Director call.** Input: the code context (anchor-annotated file, cached), the
   ledger, and the recent transcript. Output: a single structured `TurnMove`
   (`next_speaker`, `move`, `addressed_to`, `focus`, `thread_id`, `thread_status`,
   `brief`, `verdict`). Structured output / tool-calling only.
2. **Speaker call** (skipped when `next_speaker = "human"`). Input: the chosen
   seat's persona prompt, the move's `brief` and `focus`, the focus lines, and the
   relevant transcript. Output: a `SpeakerTurn` — the in-character dialogue text
   plus the focus anchors it stands behind.

Then the runtime:
- commits the move to the transcript and updates the ledger,
- highlights `focus` anchors in the editor for the turn's duration,
- streams the dialogue text to TTS and the resulting audio to the client,
- the client animates the speaking dog's mouth from that audio.

When `next_speaker = "human"`, the loop enters `AWAITING_HUMAN` instead of making a
speaker call, and resumes the director loop once the human submits.

The `brief` is *direction*, never the line itself: "push back on Rex — you think
that mutex guards the cache rebuild," not Bella's actual sentence. Writing the
sentence in the brief is the failure mode that flattens the personas.

## 3. Floor-control state machine

Exactly one seat holds the floor at any instant. The director grants it; turns
hand it back. This single constraint is what makes turn-taking tractable without
full-duplex voice machinery.

States:

- `DIRECTING` — director call in flight (the "thinking beat").
- `DOG_SPEAKING(seat)` — a dog's audio is playing; mouth animating; interject armed.
- `AWAITING_HUMAN` — director granted the human the floor; input open; dogs idle.
- `HUMAN_PTT` — push-to-talk active; mic capturing; **all dog audio muted**.
- `TRANSCRIBING` — PTT clip sent to batch STT.
- `REVIEW_COMPLETE` — `close` delivered; session ends.

Transitions:

- `DIRECTING` → `DOG_SPEAKING(seat)` when move targets an AI seat.
- `DIRECTING` → `AWAITING_HUMAN` when `next_speaker = "human"`.
- `DIRECTING` → `REVIEW_COMPLETE` on `close`.
- `DOG_SPEAKING` → `DIRECTING` when the turn's audio finishes (normal return).
- `DOG_SPEAKING` → `HUMAN_PTT` / `AWAITING_HUMAN` on **interject** (raise paw):
  hard-pause + cancel in-flight TTS and generation; discard the partial turn.
- `AWAITING_HUMAN` → `HUMAN_PTT` on press-and-hold; → `DIRECTING` on text submit.
- `HUMAN_PTT` → `TRANSCRIBING` on release.
- `TRANSCRIBING` → `DIRECTING` once the transcript is appended as the human turn.

The interject path is the only "barge-in," and it is a button press, not audio
detection — which is why PTT with dog-muting avoids echo cancellation, VAD, and
end-of-utterance detection entirely.

## 4. Real-time audio and lip-sync

- **Synthesis is server-side.** The server calls the TTS adapter (streaming) and
  forwards audio chunks to the client over the WebSocket. Keys never reach the
  browser.
- **Playback + lip-sync is client-side.** The client plays the streamed audio
  through Web Audio, taps an `AnalyserNode` for short-window RMS amplitude, and maps
  amplitude to the speaking dog's mouth state (closed / mid / open). No server
  round-trip for mouth data; the client already knows which seat is speaking from
  the `turn_start` event.
- **Mouth states**: 2–3 sprites per dog is enough for the cartoon register. Do not
  build viseme-accurate sync for MVP — it's more work and less funny here.
- **Scene**: one static background plate + four dog layers, each dog with a small
  mouth sprite sheet swapped on an amplitude threshold/timer. CSS-layered images are
  sufficient for MVP; canvas/Rive is a later upgrade.

## 5. Latency strategy

- **Sentence-level streaming.** Stream the speaker call's tokens; as the first
  sentence completes, fire streaming TTS for that sentence and begin playback while
  the rest generates. Perceived latency ≈ one short sentence, not the whole turn.
- **The director hop** between turns is unavoidable (a call must pick the next
  speaker before it can start). Present it as a deliberate beat — a dog sips its
  coffee. Optional later optimization: speculatively prefetch the likely next turn
  and discard on disagreement. Start with the honest beat.
- **Prompt-cache the code context.** The annotated file is resent every turn to
  every agent; caching that block cuts both cost and first-token latency and is the
  biggest single lever on a long review.

## 6. Multi-model abstraction

Model a reviewer as a config: `{ provider, model_id, persona_prompt, voice_id }`.
The director is its own config of the same shape (minus voice). One-provider start
= one provider behind every seat with different persona prompts and voices.

To keep a later provider swap to a one-field change:
- Keep a **single internal transcript/message format**; translate to each provider's
  API shape only inside the adapter.
- Never let provider quirks (system-prompt handling, tool-call format, streaming
  token shape) leak into the orchestrator.

Consequences to expect when providers are mixed: turn pacing varies seat to seat
(fine, even characterful — but director timing logic must not assume uniform
turns), and the shared transcript grows every turn for every agent (window or
summarize old turns on long reviews).

## 7. Diff anchoring scheme

A PR carries several coordinate systems at once (old-file lines, new-file lines,
diff-relative position, editor position). A model handed a raw diff cites them
interchangeably and sometimes invents numbers. The scheme imposes **one** address
space and removes the model's need to count.

Principle (same discipline as the adapter boundary): **every consumer references
opaque anchor ids; a single resolver maps ids to current editor positions. Raw line
numbers never flow through the director, speaker prompts, dialogue, or highlight
logic.**

- **Parse once** into an anchor table: `anchor_id → { file, new_line, change, hunk }`,
  plus a hunk index `hunk_id → { file, start_line, end_line }`. This is session
  source-of-truth alongside the ledger. (See the types in `packages/contracts/src`.)
- **Render the full new file** to the model (full file — hunks alone yield shallow
  critiques), every line prefixed with its anchor id in the gutter and a one-char
  change marker. The id sits in front of the line so the model copies it instead of
  inferring a number.
- **One number column only** (new-file line); the `+`/`-`/space is a *status flag*,
  not a second coordinate. Deleted lines get a marker but **no citable id**; comment
  on removed code by anchoring to surrounding context lines.
- For large files, collapse the *view* of distant unchanged regions but keep their
  numbering intact (collapse the view, not the line numbers) so nothing renumbers.
- **The resolver is the seam.** In MVP it is near-identity (anchor id ≈ a frozen
  new-file line). It exists now so that the v2 live-edit feature — where the human
  edits code mid-review and raw numbers shift — only requires swapping the resolver,
  not reworking the three consumers.
- **Validate every emitted anchor** against the table. On a miss, clamp to the hunk
  or regenerate; the editor never tries to scroll to a nonexistent line.

## 8. Editor highlight strategy

Do not parse dialogue prose to decide highlights — fragile, and a dog may phrase a
reference many ways. The director already committed `focus` for the turn, so the
editor highlights `focus`'s anchors for the whole turn duration, full stop. The
speaker is merely instructed to keep prose consistent with the focus and to speak
line references naturally (the runtime renders `a049` → "line 49" for TTS). The
optional polish — lighting the exact line at the exact spoken word — is feasible via
TTS word-level timestamps but is post-MVP.

## 9. Data flow summary (one cycle)

```
director call (code+ledger+transcript) ─▶ TurnMove
        │
        ├─ next_speaker = AI ─▶ speaker call (persona+brief+focus) ─▶ SpeakerTurn
        │                         │
        │                         ├─▶ commit transcript, update ledger
        │                         ├─▶ editor.highlight(focus.anchors)
        │                         └─▶ TTS stream ─▶ client audio ─▶ mouth anim
        │
        ├─ next_speaker = human ─▶ AWAITING_HUMAN ─▶ (text | PTT→STT) ─▶ append turn
        │
        └─ close ─▶ verdict spoken ─▶ REVIEW_COMPLETE
```
