// Adapter factory. Wires real providers when keys are present, deterministic fakes
// otherwise — so the orchestration core stays provider-agnostic (CLAUDE.md
// invariant 3) and the whole pipeline runs keyless during development.

import type { LlmAdapter, SttAdapter, TtsAdapter } from "@review-table/contracts";
import { USE_FAKES } from "../env";
import { AnthropicLlmAdapter } from "./anthropic";
import { ElevenLabsSttAdapter, ElevenLabsTtsAdapter } from "./elevenlabs";
import { FakeLlmAdapter, FakeSttAdapter, FakeTtsAdapter } from "./fakes";

export interface Adapters {
  llm: LlmAdapter;
  tts: TtsAdapter;
  stt: SttAdapter;
}

let cached: Adapters | null = null;

/**
 * Override the cached adapter set. Additive injection seam used by the eval
 * harness to run the REAL LlmAdapter while stubbing TTS/STT (so no ElevenLabs
 * key is needed). Not used by the normal server or the keyless smoke.
 */
export function setAdapters(a: Adapters): void {
  cached = a;
}

export function getAdapters(): Adapters {
  if (cached) return cached;
  cached = USE_FAKES
    ? { llm: new FakeLlmAdapter(), tts: new FakeTtsAdapter(), stt: new FakeSttAdapter() }
    : {
        llm: new AnthropicLlmAdapter(),
        tts: new ElevenLabsTtsAdapter(),
        stt: new ElevenLabsSttAdapter(),
      };
  return cached;
}
