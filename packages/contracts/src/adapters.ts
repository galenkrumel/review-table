// Provider adapters.
// The only place provider-specific code lives. The core speaks this internal format;
// adapters translate at the boundary (CLAUDE.md invariant 3). Keys server-side only.

import type { SeatId } from "./seats";

// Loose JSON Schema handle for structured-output calls; the adapter validates the
// director's TurnMove against this before returning.
export type JsonSchema = Record<string, unknown>;

export interface InternalMessage {
  seat_id: SeatId | "system" | "director";
  role: "system" | "user" | "assistant";
  text: string;
}

export interface LlmAdapter {
  // Structured output for the director; plain streamed text for the speaker.
  completeStructured<T>(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string; // for prompt-caching the code-context block
  }): Promise<T>;
  streamText(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    cacheKey?: string;
  }): AsyncIterable<string>; // token/sentence stream
}

export interface TtsAdapter {
  streamSpeech(args: {
    voice_id: string;
    text: string; // may be called per-sentence
  }): AsyncIterable<Uint8Array>; // audio chunks
}

export interface SttAdapter {
  transcribe(args: { audio: Uint8Array; mime: string }): Promise<string>; // batch, whole clip
}
