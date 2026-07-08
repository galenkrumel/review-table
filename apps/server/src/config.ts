// Session configuration: the three AI dog seats + the human + the invisible
// director (ModeratorConfig). Personas are placeholders to be tuned iteratively
// (FR-11); model id and voices come from env with sensible defaults.

import type { AiSeat, Seat, SessionConfig } from "@review-table/contracts";
import { ANTHROPIC_MODEL, DIRECTOR_MODEL } from "./env";

const VOICE_REX = process.env.VOICE_REX ?? "VR6AewLTigWG4xSOukaG"; // deep
const VOICE_BELLA = process.env.VOICE_BELLA ?? "21m00Tcm4TlvDq8ikWAM"; // clear
const VOICE_DUKE = process.env.VOICE_DUKE ?? "TxGEqnHWrfWFTfGW9XjX"; // calm

const rex: AiSeat = {
  id: "rex",
  kind: "ai",
  display_name: "Rex",
  sprite: "rex",
  provider: "anthropic",
  model_id: ANTHROPIC_MODEL,
  voice_id: VOICE_REX,
  is_lead: true,
  lane: "correctness, logic, did the author understand the change",
  persona_prompt:
    "You are Rex, the grizzled lead reviewer — a senior engineer who has seen every " +
    "way code can rot. You facilitate, but you don't soften. Blunt, dry, occasionally " +
    "gruff. You care about correctness and whether the author actually understood the " +
    "change. Short sentences.",
};

const bella: AiSeat = {
  id: "bella",
  kind: "ai",
  display_name: "Bella",
  sprite: "bella",
  provider: "anthropic",
  model_id: ANTHROPIC_MODEL,
  voice_id: VOICE_BELLA,
  is_lead: false,
  lane: "security, input validation, edge cases, error handling",
  persona_prompt:
    "You are Bella, the security- and edge-case-minded reviewer. Sharp, precise, a " +
    "little suspicious. You hunt for the unchecked input, the swallowed error, the " +
    "panic-in-production. You ask pointed questions and you don't let hand-waving slide.",
};

const duke: AiSeat = {
  id: "duke",
  kind: "ai",
  display_name: "Duke",
  sprite: "duke",
  provider: "anthropic",
  model_id: ANTHROPIC_MODEL,
  voice_id: VOICE_DUKE,
  is_lead: false,
  lane: "performance, complexity, resource use, over-engineering",
  persona_prompt:
    "You are Duke, the pragmatic performance-and-shipping reviewer. Easygoing but " +
    "allergic to over-engineering and needless allocation. You weigh whether a change " +
    "is worth it, push back on gold-plating, and keep the review moving.",
};

const human: Seat = {
  id: "human",
  kind: "human",
  display_name: "You",
  sprite: "human",
};

export const SESSION_CONFIG: SessionConfig = {
  seats: [rex, bella, duke, human],
  moderator: {
    provider: "anthropic",
    model_id: DIRECTOR_MODEL, // may be a faster model than the dogs (latency knob)
    system_prompt: "", // set in director.ts (depends on per-turn context)
  },
};

export const AI_SEATS: AiSeat[] = [rex, bella, duke];
export const HUMAN_SEAT: Seat = human;

export function aiSeat(id: string): AiSeat | undefined {
  return AI_SEATS.find((s) => s.id === id);
}

export function isHuman(id: string | null | undefined): boolean {
  return id === human.id;
}

/** A dog seat (one of the three AI reviewers) — not the human, table, or null. */
export function isDogSeat(id: string | null | undefined): boolean {
  return !!id && !!aiSeat(id);
}

/** Display name for any seat id; falls back to the id itself. */
export function displayName(id: string): string {
  return SESSION_CONFIG.seats.find((s) => s.id === id)?.display_name ?? id;
}
