// ReviewControls — the coordination surface between the per-connection Session
// (driven by client messages) and the running review loop (M4: human in the loop).
//
// The review loop is paced to the client: after a dog turn finishes streaming, the
// server waits for the client's `turn_played` ack before the next director hop, so the
// server's "now" matches what the human actually hears. That coherence is what makes
// the two human-input paths work:
//   - AWAITING_HUMAN: the director picks the human → the loop blocks on `awaitHuman()`.
//   - interject ("raise paw"): the human barges in during a dog turn → the in-flight
//     turn is aborted and the loop diverts to the human instead of committing it.
//
// The Session calls the "client side" methods; the orchestrator calls the "loop side"
// methods. A pending-flag on each await lets a signal that arrives *before* the loop is
// waiting still be delivered (no lost wakeups), which also keeps headless harnesses
// (no real client) from deadlocking — they ack each turn synchronously on turn_end.

export type TurnOutcome = "played" | "interject";

export class ReviewControls {
  private readonly aborter = new AbortController();

  // Per-dog-turn playback gate.
  private turnResolve: ((o: TurnOutcome) => void) | null = null;
  private pendingOutcome: TurnOutcome | null = null;
  private turnAbort: AbortController | null = null;

  // Human-turn gate.
  private humanResolve: ((text: string) => void) | null = null;
  private pendingHuman: string | null = null;

  get signal(): AbortSignal {
    return this.aborter.signal;
  }
  get aborted(): boolean {
    return this.aborter.signal.aborted;
  }

  // ── Loop side ──────────────────────────────────────────────────────────────

  /** Start a dog turn: fresh abort signal (interject cancels it), reset the gate. */
  beginTurn(): AbortSignal {
    this.turnAbort = new AbortController();
    this.turnResolve = null;
    this.pendingOutcome = null;
    return this.turnAbort.signal;
  }

  /** After turn_end: block until the client acks playback or the human interjects. */
  awaitTurnOutcome(): Promise<TurnOutcome> {
    if (this.aborted) return Promise.resolve("played");
    if (this.pendingOutcome) {
      const o = this.pendingOutcome;
      this.pendingOutcome = null;
      return Promise.resolve(o);
    }
    return new Promise((resolve) => {
      this.turnResolve = resolve;
    });
  }

  /** Block until the human submits a turn (typed, or PTT clip → STT). */
  awaitHuman(): Promise<string> {
    if (this.aborted) return Promise.resolve("");
    if (this.pendingHuman !== null) {
      const t = this.pendingHuman;
      this.pendingHuman = null;
      return Promise.resolve(t);
    }
    return new Promise((resolve) => {
      this.humanResolve = resolve;
    });
  }

  // ── Client side (driven by the Session from ClientMessages) ─────────────────

  /** Client finished playing the current dog turn (pacing ack). */
  turnPlayed(): void {
    this.settleTurn("played");
  }

  /** Human raised a paw during a dog turn: abort the turn, divert to human input. */
  interject(): void {
    this.turnAbort?.abort();
    this.settleTurn("interject");
  }

  /** Human submitted a turn (typed text or a finished transcription). */
  submitHuman(text: string): void {
    if (this.humanResolve) {
      const r = this.humanResolve;
      this.humanResolve = null;
      r(text);
    } else {
      this.pendingHuman = text;
    }
  }

  /** End the session: abort and release any waiters so the loop can exit. */
  cancel(): void {
    this.aborter.abort();
    this.turnAbort?.abort();
    this.settleTurn("played");
    if (this.humanResolve) {
      const r = this.humanResolve;
      this.humanResolve = null;
      r("");
    }
  }

  private settleTurn(o: TurnOutcome): void {
    if (this.turnResolve) {
      const r = this.turnResolve;
      this.turnResolve = null;
      r(o);
    } else {
      this.pendingOutcome = o;
    }
  }
}
