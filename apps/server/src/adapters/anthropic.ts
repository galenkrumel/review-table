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

export class AnthropicLlmAdapter implements LlmAdapter {
  private client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  async completeStructured<T>(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string;
  }): Promise<T> {
    // output_config typing varies across SDK minors; cast the params bag.
    const params: any = {
      model: args.model_id,
      max_tokens: 2048,
      system: args.system,
      messages: toMessages(args.messages),
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: args.schema },
      },
    };
    const resp: any = await this.client.messages.create(params);
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
    const params: any = {
      model: args.model_id,
      max_tokens: 1024,
      system: args.system,
      messages: toMessages(args.messages),
      output_config: { effort: "low" },
    };
    const stream: any = this.client.messages.stream(params);
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        yield ev.delta.text as string;
      }
    }
  }
}
