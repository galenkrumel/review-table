// Deterministic fake adapters. They let the full turn loop, audio
// streaming, and amplitude lip-sync run with zero network, zero cost, and no keys.
// The fake TTS emits a REAL WAV with a speech-like amplitude envelope so the client's
// decodeAudioData + AnalyserNode mouth animation work exactly as with real audio.

import type {
  InternalMessage,
  JsonSchema,
  LlmAdapter,
  SttAdapter,
  TtsAdapter,
} from "@review-table/contracts";

// A scripted, stateless fake director: it reads the turn number + available hunks
// from the director prompt and walks each hunk through a 4-beat thread
// (raise → pushback → pile_on → resolve), then closes when the runtime signals every
// hunk is covered. This drives a FULL multi-dog review to a verdict with zero keys,
// and it honors the anti-agreeableness gate (resolve always follows a pushback).
const PER_THREAD = 4;
const OPENERS = [
  ["rex", "bella", "duke", "rex"],
  ["bella", "duke", "rex", "bella"],
  ["duke", "rex", "bella", "duke"],
];

const FAKE_BY_MOVE: Record<string, string[]> = {
  raise_issue: [
    "Hold on — {L}. This turns a recoverable bad-token case into a hard failure.",
    "{L} bothers me. We are trusting input we never actually validated.",
    "Stop right there — {L} assumes the happy path and nothing else.",
  ],
  pushback: [
    "I am not sold. {L} still blows up the moment the claims come back null.",
    "Disagree. That path {L} swallows the error instead of handling it.",
    "No — {L} just moves the bug, it does not fix it.",
  ],
  pile_on: [
    "Right, and it compounds — nothing downstream checks the result either.",
    "Same read here. This is the kind of thing that pages someone at 3am.",
    "Agreed, and the test that should catch it does not exist.",
  ],
  resolve: [
    "Fine. Guard {L}, add the null check, and I will sign off.",
    "Good enough. Gate that input and this thread is closed.",
    "Okay — with the fix noted, I am satisfied. Mark it.",
  ],
  move_on: ["Let us not rathole. Park it and keep moving.", "Noted. Moving on."],
  nitpick: ["Tiny thing — the name around {L} could be clearer.", "Nit: tighten {L}."],
  ask_author: ["Quick one — was {L} intentional?", "What is the plan for the null case at {L}?"],
  answer: ["It is intentional, but it needs the guard.", "Fair — I will add the check."],
  banter: ["We have all shipped worse on a Friday.", "Coffee is cold. Let us wrap."],
  close: [
    "Net-net: fix the unchecked path and this is good to go. Solid work otherwise.",
    "That is the review. Address the blocking thread and we are done here.",
  ],
};

export class FakeLlmAdapter implements LlmAdapter {
  private variant = 0;

  async completeStructured<T>(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string;
  }): Promise<T> {
    const prompt = args.messages.map((m) => m.text).join("\n");

    // The runtime tells us when every hunk is covered — close the review.
    if (/Every hunk is now covered/i.test(prompt)) {
      return {
        next_speaker: "rex",
        move: "close",
        addressed_to: "table",
        focus: null,
        thread_id: null,
        thread_status: null,
        brief: "Wrap up: summarize the threads and give the verdict.",
        verdict: null, // let the runtime derive it from the real ledger state
        rationale: "fake director: close on completion",
      } as unknown as T;
    }

    const turn = Number(/Turn number:\s*(\d+)/.exec(prompt)?.[1] ?? 0);
    // Pull the REAL hunk ids from the ledger's coverage line (avoids false positives
    // from `h\d+` substrings in the rendered code or `-h` anchor suffixes).
    const covLine = /Hunk coverage:\s*([^\n.]*)/.exec(prompt)?.[1] ?? "";
    const hunks = uniq(covLine.match(/h\d+/g) ?? ["h1"]);
    const hunkIdx = Math.floor(turn / PER_THREAD);
    const beat = turn % PER_THREAD;
    const hunk = hunks[Math.min(hunkIdx, hunks.length - 1)] ?? "h1";
    const tid = `t${hunkIdx + 1}`;
    const speakers = OPENERS[hunkIdx % OPENERS.length]!;

    const beatSpec = [
      { move: "raise_issue", status: "open" },
      { move: "pushback", status: "open" },
      { move: "pile_on", status: "open" },
      { move: "resolve", status: hunkIdx % 2 === 1 ? "blocking" : "resolved" },
    ][beat]!;

    // Reactive moves address the dog who spoke the prior beat, so the keyless smoke
    // exercises dog-to-dog addressing and the A2 gate (pushback/pile_on must name a dog).
    const addressed_to =
      beatSpec.move === "pushback" || beatSpec.move === "pile_on" ? speakers[beat - 1]! : "table";

    const move = {
      next_speaker: speakers[beat]!,
      move: beatSpec.move,
      addressed_to,
      focus: { file: "", anchor: hunk, anchors: [] }, // runtime clamps to the hunk
      thread_id: tid,
      thread_status: beatSpec.status,
      brief: BRIEFS[beatSpec.move] ?? "Advance the discussion on this hunk.",
      verdict: null,
      rationale: `fake director: turn ${turn}, ${hunk}, beat ${beat}`,
    };
    return move as unknown as T;
  }

  async *streamText(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    cacheKey?: string;
  }): AsyncIterable<string> {
    const prompt = args.messages.map((m) => m.text).join("\n");
    const move = /Your move is "(\w+)"/.exec(prompt)?.[1] ?? "raise_issue";
    const lineNo = /line (\d+):/.exec(prompt)?.[1] ?? null;
    const pool = FAKE_BY_MOVE[move] ?? FAKE_BY_MOVE.raise_issue!;
    const raw = pool[this.variant % pool.length]!;
    this.variant += 1;
    const line = raw.replace(/\{L\}/g, lineNo ? `line ${lineNo}` : "this");

    for (const word of line.split(" ")) {
      yield word + " ";
      await delay(16);
    }
  }
}

const BRIEFS: Record<string, string> = {
  raise_issue: "Open a thread: flag the unchecked failure path on this hunk.",
  pushback: "Stress-test the concern — argue it would actually break.",
  pile_on: "Reinforce the point with one more angle.",
  resolve: "Close the thread with the fix as a condition.",
};

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export class FakeTtsAdapter implements TtsAdapter {
  async *streamSpeech(args: { voice_id: string; text: string }): AsyncIterable<Uint8Array> {
    const wav = synthesizeWav(args.text);
    // Emit in chunks to mimic a streaming response.
    const CHUNK = 16384;
    for (let off = 0; off < wav.length; off += CHUNK) {
      yield wav.subarray(off, Math.min(off + CHUNK, wav.length));
      await delay(12);
    }
  }
}

export class FakeSttAdapter implements SttAdapter {
  async transcribe(_args: { audio: Uint8Array; mime: string }): Promise<string> {
    return "(transcribed speech — fake STT)";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A mono 16-bit PCM WAV with a speech-like amplitude envelope (bursts ≈ syllables). */
function synthesizeWav(text: string): Uint8Array {
  const sampleRate = 22050;
  const seconds = Math.min(7, Math.max(1.2, text.length / 14));
  const n = Math.floor(sampleRate * seconds);

  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  // RIFF/WAVE header.
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const carrier = Math.sin(2 * Math.PI * 140 * t); // low buzz
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 5.5 * t)); // ~5.5 bursts/sec
    const phrase = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.6 * t); // slow swell
    const env = syllable * phrase;
    const s = carrier * env * 0.5;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }

  return new Uint8Array(buf);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
