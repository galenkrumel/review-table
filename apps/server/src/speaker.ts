// The speaker call: a director move → in-character spoken dialogue (CLAUDE.md
// invariant 1, second call of the two). Streams text deltas for live captions, then
// streams TTS audio frames. Anchor ids never reach the dog's mouth as ids — they are
// rendered to spoken "line N" (invariant 2: one coordinate system).

import type {
  AiSeat,
  AnchorTable,
  AnnotatedFile,
  LlmAdapter,
  ServerMessage,
  TranscriptEntry,
  TtsAdapter,
  TurnMove,
} from "@review-table/contracts";
import { displayName, isDogSeat, isHuman } from "./config";

export interface TurnSink {
  send(msg: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

/** Map any anchor ids the speaker emitted (a049) to spoken "line 49" for TTS. */
export function speakAnchors(text: string, table: AnchorTable): string {
  return text.replace(/\ba(\d{3,})(?:-h\d+)?\b/g, (m) => {
    const entry = table.anchors[m] ?? table.anchors[m.replace(/-h\d+$/, "")];
    return entry ? `line ${entry.new_line}` : m;
  });
}

/** The focus lines, as plain text, to ground the speaker. */
export function focusSnippet(anchors: string[], files: AnnotatedFile[]): string {
  const out: string[] = [];
  for (const file of files) {
    for (const line of file.lines) {
      if (line.anchor && anchors.includes(line.anchor)) {
        out.push(`line ${line.new_line}: ${line.text.trim()}`);
      }
    }
  }
  return out.join("\n");
}

const MOVE_HINT: Record<string, string> = {
  raise_issue: "Open a new concern — name the problem and why it matters.",
  pushback: "Disagree with the prior point. Stress-test it; do not just agree.",
  pile_on: "Reinforce the prior point with one more angle.",
  ask_author: "Pose a pointed question about this code.",
  answer: "Answer the question on the table.",
  nitpick: "Make one terse, minor point.",
  resolve: "Close this thread with a clear outcome.",
  move_on: "Shift the focus; wrap this thread without full resolution.",
  banter: "A short, non-substantive beat for pacing.",
  close: "Deliver the closing verdict for the whole review. Sum up briefly.",
};

/**
 * Run one speaker turn: stream the in-character line (captions) then the audio.
 * Returns the final spoken text for the transcript.
 */
export async function runSpeaker(
  llm: LlmAdapter,
  tts: TtsAdapter,
  sink: TurnSink,
  seat: AiSeat,
  move: TurnMove,
  highlight: string[],
  files: AnnotatedFile[],
  table: AnchorTable,
  recentTurns: TranscriptEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const system =
    seat.persona_prompt +
    "\n\nYou are one of three dog reviewers arguing about this pull request WITH EACH OTHER, not " +
    "reporting to an audience. You are speaking aloud in a live, fast-moving review. Say ONE or two " +
    "short, punchy sentences of in-character dialogue, grounded in the direction and focus lines. Refer " +
    "to line numbers naturally. Engage the others by name when you are responding to them. Output ONLY " +
    "the spoken words — no stage directions, no narration, no reasoning, no quotes, no name prefix.";

  // Who this turn is aimed at. When it is a fellow dog, engage that dog by name; when it
  // is the author (the human just spoke), respond to them directly in the second person.
  const addressed = move.addressed_to && move.addressed_to !== "table" ? move.addressed_to : null;
  let addressedHint = "";
  if (addressed && isDogSeat(addressed)) {
    addressedHint =
      `You are responding to ${displayName(addressed)}. Address them by name and engage their ` +
      `specific point: build on it or push back. Do not re-explain to the author.\n\n`;
  } else if (addressed && isHuman(addressed)) {
    addressedHint =
      `You are responding to the author — the person at the table who wrote this change and just ` +
      `spoke. Address them DIRECTLY in the second person ("you"), and engage the specific point ` +
      `they just made: answer it or push back on it. Do not address the other dogs by name as if ` +
      `the author hadn't spoken.\n\n`;
  }

  // The real back-and-forth: a thread-scoped rolling window labeled by speaker name,
  // so the dog sees the actual exchange it is joining (not just one prior line).
  const exchange = recentTurns.map((e) => `${displayName(e.seat_id)}: "${e.text}"`).join("\n");
  const exchangeBlock = exchange ? `Recent exchange (most recent last):\n${exchange}\n\n` : "";

  const focusText = focusSnippet(highlight, files);
  const user =
    `Direction (do not read aloud): ${move.brief}\n` +
    `Your move is "${move.move}" — ${MOVE_HINT[move.move] ?? ""}\n\n` +
    addressedHint +
    exchangeBlock +
    (focusText ? `Focus lines:\n${focusText}\n\n` : "") +
    `Your line:`;

  let text = "";
  for await (const delta of llm.streamText({
    model_id: seat.model_id,
    system,
    messages: [{ seat_id: seat.id, role: "user", text: user }],
    cacheKey: `persona:${seat.id}`, // constant per dog; cached if above the model minimum
  })) {
    if (signal?.aborted) break; // interject: stop streaming the line to the client
    text += delta;
    sink.send({ type: "text_delta", seat_id: seat.id, delta });
  }
  text = text.trim() || "…";

  // On interject mid-line, skip TTS entirely — the partial turn is being discarded.
  if (signal?.aborted) return text;

  const spoken = speakAnchors(text, table);
  try {
    for await (const chunk of tts.streamSpeech({ voice_id: seat.voice_id, text: spoken })) {
      if (signal?.aborted) break; // interject: stop forwarding audio frames
      sink.sendBinary(chunk);
    }
  } catch (err) {
    console.error("[speaker] TTS error:", (err as Error).message);
  }

  return text;
}
