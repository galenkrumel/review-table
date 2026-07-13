// Ollama LlmAdapter — locally-served open-weight models for the dog seats' speaker
// calls (streamText only). The director and eval judge always run on Anthropic
// (CLAUDE.md invariant 4: director output must be reliable structured output), so
// completeStructured here is intentionally unimplemented rather than faked.

import type { InternalMessage, JsonSchema, LlmAdapter } from "@review-table/contracts";
import { OLLAMA_BASE_URL } from "../env";

function toOllamaMessages(
  system: string,
  messages: InternalMessage[],
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return [
    { role: "system" as const, content: system },
    ...messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        content: m.text,
      })),
  ];
}

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaLlmAdapter implements LlmAdapter {
  constructor(private baseUrl: string = OLLAMA_BASE_URL) {}

  async completeStructured<T>(_args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    schema: JsonSchema;
    cacheKey?: string;
  }): Promise<T> {
    throw new Error(
      "OllamaLlmAdapter.completeStructured is not implemented — Ollama-served dogs are " +
        "speaker-only (streamText). The director and eval judge always run on Anthropic.",
    );
  }

  async *streamText(args: {
    model_id: string;
    system: string;
    messages: InternalMessage[];
    cacheKey?: string;
  }): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model_id,
        messages: toOllamaMessages(args.system, args.messages),
        stream: true,
        think: false, // dialogue is one/two spoken sentences — no reasoning budget needed
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama ${args.model_id}: HTTP ${res.status} ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // last (possibly partial) line carries over
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new Error(`Ollama ${args.model_id}: ${chunk.error}`);
        const delta = chunk.message?.content;
        if (delta) yield delta;
      }
    }
  }
}
