// Adapter factory. Wires real providers when keys are present, deterministic fakes
// otherwise — so the orchestration core stays provider-agnostic (CLAUDE.md
// invariant 3) and the whole pipeline runs keyless during development.

import type {
  InternalMessage,
  JsonSchema,
  LlmAdapter,
  SttAdapter,
  TtsAdapter,
} from "@review-table/contracts";
import { OLLAMA_MODELS, USE_FAKES } from "../env";
import { AnthropicLlmAdapter } from "./anthropic";
import { ElevenLabsSttAdapter, ElevenLabsTtsAdapter } from "./elevenlabs";
import { FakeLlmAdapter, FakeSttAdapter, FakeTtsAdapter } from "./fakes";
import { OllamaLlmAdapter } from "./ollama";

export interface Adapters {
  llm: LlmAdapter;
  tts: TtsAdapter;
  stt: SttAdapter;
}

/**
 * Dispatches each call by model_id: a known local-model id (OLLAMA_MODELS) goes to
 * Ollama, everything else goes to Anthropic. This is enough to mix providers within
 * one review with no changes to director.ts/speaker.ts — they already pass a per-seat
 * model_id on every call. Unrecognized ids fall through to Anthropic, which errors
 * loudly on an unknown model rather than silently misrouting a typo to Ollama.
 */
export class RoutingLlmAdapter implements LlmAdapter {
  constructor(
    private anthropic: LlmAdapter,
    private ollama: LlmAdapter,
  ) {}

  private pick(modelId: string): LlmAdapter {
    return OLLAMA_MODELS.has(modelId) ? this.ollama : this.anthropic;
  }

  completeStructured<T>(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string;
  }): Promise<T> {
    return this.pick(args.model_id).completeStructured(args);
  }

  streamText(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    cacheKey?: string;
  }): AsyncIterable<string> {
    return this.pick(args.model_id).streamText(args);
  }
}

/** The real (non-fake) LlmAdapter: Anthropic + Ollama behind one router. Exposed
 *  separately from getAdapters() so the eval harness (which drives its own TTS/STT
 *  stubs) can reuse the exact same provider routing without going through fakes. */
export function createLiveLlmAdapter(): LlmAdapter {
  return new RoutingLlmAdapter(new AnthropicLlmAdapter(), new OllamaLlmAdapter());
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
        llm: createLiveLlmAdapter(),
        tts: new ElevenLabsTtsAdapter(),
        stt: new ElevenLabsSttAdapter(),
      };
  return cached;
}
