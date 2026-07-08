// Seats and configuration.
// Ids (seat ids, anchor ids) are opaque strings; never parse meaning out of them.

export type SeatId = string; // stable per session, e.g. "rex" | "bella" | "duke" | "human"
export type SeatKind = "ai" | "human";

export interface Seat {
  id: SeatId;
  kind: SeatKind;
  display_name: string; // "Rex"
  sprite: string; // asset key for the dog layer
}

export interface AiSeat extends Seat {
  kind: "ai";
  provider: string; // adapter key: "anthropic" | "openai" | "google" | ...
  model_id: string;
  voice_id: string; // TTS voice id (provider-specific, used via TtsAdapter)
  persona_prompt: string; // personality + review stance; tuned iteratively
  is_lead: boolean; // facilitator flavor; voices facilitation moves
  lane: string; // terse specialty the director routes opening concerns by (FR-11)
}

export interface ModeratorConfig {
  // the director; invisible, never a seat
  provider: string;
  model_id: string;
  system_prompt: string;
}

export interface SessionConfig {
  seats: Seat[]; // exactly one kind:"human"; the rest AiSeat
  moderator: ModeratorConfig;
}
