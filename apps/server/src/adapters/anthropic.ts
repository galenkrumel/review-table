// Anthropic LlmAdapter. Director call → validated structured output (TurnMove via
// output_config.format); speaker call → streamed text. effort:"low" + no thinking
// for low time-to-first-audio (NFR-1); a final-answer-only instruction keeps any
// stray reasoning out of spoken dialogue. Keys are read from env, server-side only.

import Anthropic from "@anthropic-ai/sdk";
import type { InternalMessage, JsonSchema, LlmAdapter } from "@review-table/contracts";
import { ANTHROPIC_API_KEY } from "../env";

function toMessages(
  messages: InternalMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  // Internal "system"/"director"/seat roles collapse to user/assistant for the wire.
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    }));
}

// When a cacheKey is set, send the (large, constant) system prompt as a cached block so
// it is billed at ~0.1x on the repeat calls within a session — the director system and
// each persona are re-sent on every turn. Below the model's cache minimum the breakpoint
// is simply ignored, so this is safe to always apply when caching is requested. The diff
// context lives in the user message and would need a message split to cache; deferred.
function buildSystem(system: string, cacheKey?: string) {
  if (!cacheKey) return system;
  return [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }];
}

// The `effort` knob (NFR-1, low time-to-first-audio) is an Opus-class feature; cheaper
// models (e.g. a Haiku judge) reject it with a 400 "does not support the effort parameter".
// A rejected 4xx is not billed, so on that specific error we retry once without `effort`
// and remember the model so its later calls skip the param outright — no repeated round-trips.
function isEffortUnsupported(err: unknown): boolean {
  const msg =
    (err as { error?: { error?: { message?: string } } })?.error?.error?.message ??
    (err as { message?: string })?.message ??
    String(err);
  return typeof msg === "string" && msg.toLowerCase().includes("effort");
}

export class AnthropicLlmAdapter implements LlmAdapter {
  private client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  private noEffort = new Set<string>(); // model ids that rejected `effort` this session

  async completeStructured<T>(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string;
  }): Promise<T> {
    // output_config typing varies across SDK minors; cast the params bag.
    const build = (effort: boolean): any => {
      const output_config: any = { format: { type: "json_schema", schema: args.schema } };
      if (effort) output_config.effort = "low";
      return {
        model: args.model_id,
        max_tokens: 2048,
        system: buildSystem(args.system, args.cacheKey),
        messages: toMessages(args.messages),
        output_config,
      };
    };
    const resp: any = await this.create(args.model_id, build);
    const text = (resp.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    return JSON.parse(text) as T;
  }

  async *streamText(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    cacheKey?: string;
  }): AsyncIterable<string> {
    const build = (effort: boolean): any => {
      const params: any = {
        model: args.model_id,
        max_tokens: 1024,
        system: buildSystem(args.system, args.cacheKey),
        messages: toMessages(args.messages),
      };
      if (effort) params.output_config = { effort: "low" };
      return params;
    };
    // Try with effort, then without. An effort 400 surfaces at connect (before any delta),
    // so a fallback never double-yields; any other error propagates on the first attempt.
    const attempts = this.noEffort.has(args.model_id) ? [false] : [true, false];
    for (const effort of attempts) {
      try {
        const stream: any = this.client.messages.stream(build(effort));
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            yield ev.delta.text as string;
          }
        }
        return;
      } catch (err) {
        if (effort && isEffortUnsupported(err)) {
          this.noEffort.add(args.model_id);
          continue; // retry once without `effort`
        }
        throw err;
      }
    }
  }

  /** Run a structured create, dropping `effort` and retrying once if the model rejects it. */
  private async create(modelId: string, build: (effort: boolean) => any): Promise<any> {
    const useEffort = !this.noEffort.has(modelId);
    try {
      return await this.client.messages.create(build(useEffort));
    } catch (err) {
      if (!(useEffort && isEffortUnsupported(err))) throw err;
      this.noEffort.add(modelId);
      console.warn(
        `[anthropic] ${modelId} rejects 'effort'; retrying without it (skipped hereafter).`,
      );
      return await this.client.messages.create(build(false));
    }
  }
}
