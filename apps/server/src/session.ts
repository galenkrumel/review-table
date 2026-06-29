// Per-connection session. In-memory, single active session (NFR-5). Decodes
// ClientMessages, parses the diff into the anchor table (M1), runs the director loop
// (M3), and brokers human input — typed turns, push-to-talk, and interject — between
// the client and the running review via ReviewControls (M4).

import { parseUnifiedDiff } from "@review-table/anchoring";
import type { ClientMessage, ServerMessage } from "@review-table/contracts";
import type { WebSocket } from "ws";
import { getAdapters } from "./adapters";
import { ReviewControls } from "./control";
import { runReview, type TurnSink } from "./orchestrator";

export function sendJson(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

export class Session {
  private controls: ReviewControls | null = null;
  private pttActive = false; // a hold is in progress; the next binary frame is its clip

  constructor(private readonly ws: WebSocket) {}

  /** Handle a decoded JSON control message from the client. */
  handleMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "start_review": {
        const { anchorTable, files } = parseUnifiedDiff(msg.diff);
        const anchorCount = Object.keys(anchorTable.anchors).length;
        const hunkCount = Object.keys(anchorTable.hunks).length;
        console.log(
          `[session] start_review: ${msg.diff.length} chars → ${files.length} file(s), ` +
            `${hunkCount} hunk(s), ${anchorCount} anchor(s)`,
        );
        sendJson(this.ws, { type: "review_started", anchorTable, files });

        // Run the loop async so this handler stays responsive to human input + abort.
        this.controls?.cancel();
        this.pttActive = false;
        const controls = new ReviewControls();
        this.controls = controls;
        const sink: TurnSink = {
          send: (m) => sendJson(this.ws, m),
          sendBinary: (data) => this.ws.send(data),
        };
        void runReview(sink, anchorTable, files, controls).catch((err) =>
          console.error("[session] review error:", err),
        );
        break;
      }
      case "human_text": {
        console.log(`[session] human_text: ${msg.text.slice(0, 120)}`);
        this.controls?.submitHuman(msg.text);
        break;
      }
      case "ptt_start": {
        // Invariant 7: dog audio is hard-paused while the mic is open.
        console.log("[session] ptt_start — muting dogs");
        this.pttActive = true;
        sendJson(this.ws, { type: "dogs_muted", muted: true });
        break;
      }
      case "ptt_end": {
        // The client sends the recorded clip as the next binary frame.
        console.log("[session] ptt_end — awaiting clip");
        break;
      }
      case "interject": {
        console.log("[session] interject (raise paw)");
        this.controls?.interject();
        break;
      }
      case "turn_played": {
        this.controls?.turnPlayed();
        break;
      }
      case "abort": {
        console.log("[session] abort (stop review)");
        this.close();
        break;
      }
      default: {
        const _never: never = msg;
        console.warn("[session] unhandled message", _never);
      }
    }
  }

  /**
   * Stop the running review and release the loop: aborts the controls (which settles
   * any in-flight turn/human waiter so `runReview` falls out of its loop) and clears
   * session state. Driven by the client's `abort` message AND by the socket closing —
   * without the latter, a closed browser would leave the loop generating turns into a
   * dead socket until a `ws.send` throws.
   */
  close(): void {
    this.controls?.cancel();
    this.controls = null;
    this.pttActive = false;
  }

  /** Binary frames: the PTT audio clip. Batch-transcribe it and commit a human turn. */
  handleBinary(data: Buffer): void {
    if (!this.pttActive) {
      console.warn("[session] binary frame with no active PTT — ignoring");
      return;
    }
    this.pttActive = false;
    console.log(`[session] PTT clip received (${data.length} bytes) — transcribing`);
    const controls = this.controls;
    const { stt } = getAdapters();
    void stt
      .transcribe({ audio: new Uint8Array(data), mime: "audio/webm" })
      .then((text) => {
        console.log(`[session] STT → "${text.slice(0, 120)}"`);
        sendJson(this.ws, { type: "dogs_muted", muted: false });
        controls?.submitHuman(text);
      })
      .catch((err) => {
        console.error("[session] STT error:", (err as Error).message);
        sendJson(this.ws, { type: "dogs_muted", muted: false });
        controls?.submitHuman(""); // empty turn → director picks again
      });
  }
}
