// The director call: code context + ledger + transcript → one structured TurnMove
// (CLAUDE.md invariants 1 & 4). Structured output only; never free-text parsed. The
// brief is DIRECTION for the speaker, never the dog's actual line. The director runs
// once per turn; a separate speaker call turns the move into in-character dialogue.

import { renderFilesForModel } from "@review-table/anchoring";
import type {
  AnnotatedFile,
  JsonSchema,
  Ledger,
  LlmAdapter,
  TranscriptEntry,
  TurnMove,
} from "@review-table/contracts";
import { AI_SEATS, HUMAN_SEAT } from "./config";
import { ledgerSummary } from "./ledger";

const MOVE_VALUES = [
  "raise_issue",
  "pushback",
  "pile_on",
  "ask_author",
  "answer",
  "nitpick",
  "resolve",
  "move_on",
  "banter",
  "close",
];
const THREAD_STATUS = ["open", "resolved", "blocking", "deferred"];
const VERDICTS = ["approve", "request_changes", "comment"];

// JSON schema for structured outputs. All properties required; optionals nullable.
export const TURN_MOVE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    next_speaker: { type: "string", enum: [...AI_SEATS.map((s) => s.id), HUMAN_SEAT.id] },
    move: { type: "string", enum: MOVE_VALUES },
    addressed_to: { type: ["string", "null"] },
    focus: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            file: { type: "string" },
            anchor: { type: "string" },
            anchors: { type: "array", items: { type: "string" } },
          },
          required: ["file", "anchor", "anchors"],
        },
        { type: "null" },
      ],
    },
    thread_id: { type: ["string", "null"] },
    thread_status: { anyOf: [{ type: "string", enum: THREAD_STATUS }, { type: "null" }] },
    brief: { type: "string" },
    verdict: { anyOf: [{ type: "string", enum: VERDICTS }, { type: "null" }] },
    rationale: { type: ["string", "null"] },
  },
  required: [
    "next_speaker",
    "move",
    "addressed_to",
    "focus",
    "thread_id",
    "thread_status",
    "brief",
    "verdict",
    "rationale",
  ],
};

const DIRECTOR_SYSTEM = `You are the invisible director of a live, voiced code review staged as three dogs
arguing about a pull request around a table. The dogs are COLLEAGUES debating the code WITH EACH OTHER —
not coordinators taking turns to report to the author. You never speak; you decide who speaks next and
what they should do, as a single structured move. A separate step turns your move into the dog's words.

Core rules:
- Emit EXACTLY ONE move. next_speaker is a dog seat (the author is pulled in only as described below). The
  "brief" is DIRECTION for that dog — what to do and why — NEVER their line and NEVER dialogue. Do not
  write quotes or sentences to be read aloud.
- Ground every substantive move in the diff. Set focus.anchor to a real hunk id and focus.anchors to the
  specific line anchor ids it concerns (from the gutter of the annotated file). Use ids exactly as shown.
  Use focus=null only for banter and close.
- Keep a thread_id stable across a discussion. raise_issue opens a new thread; pushback/pile_on/answer/
  nitpick/resolve refer to an existing thread_id.

Choreograph a debate (this is the point):
- The default texture is dog-to-dog: one dog raises a point, then you direct a DIFFERENT dog to challenge
  it (pushback) or reinforce it (pile_on), and so on — raise → challenge → pile on or defer.
- addressed_to is load-bearing. For pushback and pile_on you MUST set addressed_to to the dog whose point
  is being engaged (one of the dog seats), NEVER "table", "human", or null. For raise_issue it is usually
  "table"; for ask_author it is the human seat. A pushback/pile_on without a dog in addressed_to will be
  rejected.
- Bias next_speaker AWAY from the dog who just spoke while a point is live, so one dog never monologues —
  the dog being challenged or built on should usually be someone other than the previous speaker.
- A substantive raise_issue should draw at least one cross-dog response (pushback or pile_on) before you
  move_on or resolve it. In-character banter between dogs is welcome for pacing.

Pace and balance:
- Spread the floor across all three dogs. Prefer a dog with FEWER turns so far; never let one dominate.
- Open threads on hunks that are still uncovered. Move the review forward.
- When you OPEN a thread (raise_issue), set next_speaker to the dog whose lane the concern falls in:
  security/input/edge-cases → Bella, performance/complexity/resource → Duke, correctness and cross-cutting
  → Rex. The lead opens what doesn't clearly belong to a specialist. After the open, keep choreographing
  cross-dog debate as before.

The anti-agreeableness gate (hard rule):
- A thread may only be resolved AFTER it has taken genuine pushback. Never emit "resolve" for a thread
  whose has_pushback is false. If an issue looks fine, still direct a dog to "pushback" (stress-test it)
  before any "resolve". Disagreement is mandatory before consensus.

Bringing in the author (the human):
- The author is a real participant at the table, not a bystander. When a thread genuinely turns on intent
  — why a choice was made, whether a risk is known, what the plan is for an edge case — call on them:
  set next_speaker to the human seat with move="answer" (you are giving them the floor to respond). A dog
  can also tee this up first with move="ask_author" (the dog asks; addressed_to = the human seat).
- Do this when it actually moves a thread forward, not on every turn. The author has no line generated for
  them — picking them simply opens the floor for their typed or spoken reply, then the review resumes.
- RIGHT AFTER the author speaks, the next dog should respond TO the author: pick a dog as next_speaker, set
  addressed_to to the human seat, and use move="answer" (or "pushback" if you disagree with the author's
  point). Do not have that dog address another dog by name as if the author hadn't just spoken.

Ending the review:
- The review ends only when EVERY hunk is resolved, blocking, or deferred. When the ledger shows that,
  emit move="close" with an overall "verdict" (approve / request_changes / comment) and a brief telling
  the lead dog how to wrap up. Do not close while any hunk is still uncovered or open. Do not pick the
  human for the closing move — a dog delivers the verdict.`;

export interface DirectorContext {
  files: AnnotatedFile[];
  ledger: Ledger;
  transcript: TranscriptEntry[];
  turnNumber: number;
  complete: boolean;
  corrections?: string[]; // gate violations from a rejected attempt, fed back in
}

function recentTranscript(transcript: TranscriptEntry[], n = 6): string {
  if (transcript.length === 0) return "(nothing said yet — this is the opening move)";
  return transcript
    .slice(-n)
    .map((e) => {
      const thread = e.thread_id ? ` ${e.thread_id}` : "";
      const to = e.addressed_to && e.addressed_to !== "table" ? ` →${e.addressed_to}` : "";
      return `  [${e.seat_id}/${e.move}${thread}${to}] ${e.text}`;
    })
    .join("\n");
}

function buildDirectorUser(ctx: DirectorContext): string {
  const seatList =
    AI_SEATS.map((s) => `${s.id} (${s.display_name}${s.is_lead ? ", lead" : ""} — ${s.lane})`).join(
      ", ",
    ) + `, ${HUMAN_SEAT.id} (${HUMAN_SEAT.display_name}: the code author — answers when called on)`;
  const rendered = renderFilesForModel(ctx.files);
  const state = ledgerSummary(
    ctx.ledger,
    AI_SEATS.map((s) => s.id),
  );

  const parts = [
    `Seats: ${seatList}.`,
    ``,
    `Turn number: ${ctx.turnNumber}.`,
    ``,
    `The annotated pull request (each line: anchor id, new-file line number, +/- marker):`,
    rendered,
    ``,
    `Ledger:`,
    state,
    ``,
    `Recent discussion (oldest first):`,
    recentTranscript(ctx.transcript),
    ``,
    ctx.complete
      ? `Every hunk is now covered. Emit move="close" with the overall verdict and a wrap-up brief for the lead.`
      : ctx.turnNumber === 0
        ? `Emit the OPENING move: have the right specialist raise the most interesting real concern in the diff.`
        : `Emit the next move that best advances the review.`,
  ];

  if (ctx.corrections?.length) {
    parts.push(
      ``,
      `Your previous move was rejected. Fix it and re-emit:`,
      ...ctx.corrections.map((c) => `  - ${c}`),
    );
  }

  return parts.join("\n");
}

export async function runDirector(
  llm: LlmAdapter,
  modelId: string,
  ctx: DirectorContext,
): Promise<TurnMove> {
  return llm.completeStructured<TurnMove>({
    model_id: modelId,
    system: DIRECTOR_SYSTEM,
    messages: [{ seat_id: "director", role: "user", text: buildDirectorUser(ctx) }],
    schema: TURN_MOVE_SCHEMA,
    cacheKey: "code-context",
  });
}
