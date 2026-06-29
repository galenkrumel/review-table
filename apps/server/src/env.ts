// Server-side env. Loads apps/server/.env (Node ≥21.7 process.loadEnvFile) so keys
// live in a gitignored file, never in the browser (NFR-3). The dev launcher's PORT
// is passed via the process environment, not .env.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../.env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envPath);
}

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
// The director only emits a structured move (no dialogue), so it can run on a faster,
// cheaper model than the dogs to shrink the between-turns "thinking" gap. Defaults to the
// dog model (no change) — set DIRECTOR_MODEL, e.g. claude-haiku-4-5-20251001, to speed it up.
export const DIRECTOR_MODEL = process.env.DIRECTOR_MODEL ?? ANTHROPIC_MODEL;
export const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_turbo_v2_5";
export const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v1";

// Use deterministic fakes when keys are missing or USE_FAKES=1 — the full turn loop,
// audio pipeline, and lip-sync run with zero network/cost.
export const USE_FAKES = process.env.USE_FAKES === "1" || !ANTHROPIC_API_KEY || !ELEVENLABS_API_KEY;

export function providerStatus(): string {
  if (process.env.USE_FAKES === "1") return "fakes (forced via USE_FAKES=1)";
  const missing: string[] = [];
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
  return missing.length
    ? `fakes (missing ${missing.join(", ")} — add them to apps/server/.env for real providers)`
    : "real (Anthropic + ElevenLabs)";
}
