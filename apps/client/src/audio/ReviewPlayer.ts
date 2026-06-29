// Sequential turn player. The server paces the review to the client (M4 lock-step):
// it streams one dog turn, then waits for this client's `turn_played` ack before the
// next director hop, so the server's state matches what the human hears. This player
// assembles each turn (caption + highlight + audio frames) as messages arrive, plays
// turns strictly in order with no audio overlap, and fires `onTurnEnd` when a turn
// finishes playing — the App turns that into the `turn_played` ack.
//
// `interruptCurrent()` is the interject path: it stops the in-flight audio and
// suppresses that turn's ack (the server is discarding the partial turn, not advancing).

import type { IssueSummary, Verdict } from "@review-table/contracts";
import { AudioEngine, type MouthState } from "./AudioEngine";

type Item =
  | { kind: "turn"; seat: string; caption: string; highlight: string[]; chunks: ArrayBuffer[] }
  | { kind: "complete"; verdict: Verdict; issues: IssueSummary[] };

export interface PlayerCallbacks {
  onThinking(): void;
  onTurnStart(seat: string, caption: string, highlight: string[]): void;
  onMouth(state: MouthState): void;
  onTurnEnd(seat: string): void;
  onComplete(verdict: Verdict, issues: IssueSummary[]): void;
  onIdle(): void;
}

export class ReviewPlayer {
  private engine: AudioEngine;
  private queue: Item[] = [];
  private wake: (() => void) | null = null;
  private assembling: {
    seat: string;
    caption: string;
    highlight: string[];
    chunks: ArrayBuffer[];
  } | null = null;
  private running = true;
  private generation = 0; // bumped on reset/interrupt to abandon in-flight items

  constructor(private readonly cb: PlayerCallbacks) {
    this.engine = new AudioEngine(
      (state) => this.cb.onMouth(state),
      () => {
        /* per-turn end is sequenced via the awaited engine.end() in the loop */
      },
    );
    void this.loop();
  }

  /** Unlock the AudioContext from within the Start click gesture. */
  unlock(): Promise<void> {
    return this.engine.unlock();
  }

  // ── Receive side (called directly from the socket message handlers) ─────────

  /** The director hop beat. In lock-step the client is idle, so show it at once. */
  beginThinking(): void {
    this.cb.onThinking();
  }

  beginTurn(seat: string, highlight: string[]): void {
    this.assembling = { seat, caption: "", highlight, chunks: [] };
  }

  appendCaption(delta: string): void {
    if (this.assembling) this.assembling.caption += delta;
  }

  updateHighlight(highlight: string[]): void {
    if (this.assembling) this.assembling.highlight = highlight;
  }

  appendAudio(buf: ArrayBuffer): void {
    if (this.assembling) this.assembling.chunks.push(buf);
  }

  endTurn(): void {
    if (!this.assembling) return;
    this.enqueue({ kind: "turn", ...this.assembling });
    this.assembling = null;
  }

  complete(verdict: Verdict, issues: IssueSummary[]): void {
    this.enqueue({ kind: "complete", verdict, issues });
  }

  /** New review starting — drop everything queued and stop any in-flight audio. */
  reset(): void {
    this.generation += 1;
    this.queue = [];
    this.assembling = null;
    this.engine.interrupt();
  }

  /**
   * Interject ("raise paw"): stop the dog mid-sentence and suppress its `turn_played`
   * ack (the server discards the partial turn rather than advancing past it).
   */
  interruptCurrent(): void {
    this.generation += 1; // the in-flight handle() sees this and skips its onTurnEnd
    this.assembling = null;
    this.engine.interrupt();
  }

  // ── Player loop ─────────────────────────────────────────────────────────────

  private enqueue(item: Item): void {
    this.queue.push(item);
    this.wake?.();
    this.wake = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const item = this.queue.shift();
      if (!item) {
        this.cb.onIdle();
        await new Promise<void>((r) => {
          this.wake = r;
        });
        continue;
      }
      await this.handle(item, this.generation);
    }
  }

  private async handle(item: Item, gen: number): Promise<void> {
    switch (item.kind) {
      case "turn": {
        this.cb.onTurnStart(item.seat, item.caption, item.highlight);
        if (item.chunks.length > 0) {
          this.engine.begin();
          for (const c of item.chunks) this.engine.push(c);
          await this.engine.end(); // resolves when this turn's audio finishes
        } else {
          // No audio (e.g. TTS failed) — hold the caption long enough to read.
          await delay(readingTime(item.caption));
        }
        if (gen !== this.generation) return; // interrupted mid-turn → no ack
        this.cb.onTurnEnd(item.seat);
        return;
      }
      case "complete":
        this.cb.onComplete(item.verdict, item.issues);
        return;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readingTime(caption: string): number {
  return Math.min(5000, Math.max(1400, caption.length * 45));
}
