// Top-level app. WebSocket + session view-state: anchor table + annotated files (M1),
// the table scene with audio-driven mouth animation (M2), the full multi-turn review
// playing in order to a spoken verdict (M3), and the author in the loop (M4): typed and
// push-to-talk turns, plus interject ("raise paw") to interrupt a speaking dog. A
// ReviewPlayer serializes the turns the server streams and acks each one (`turn_played`)
// so the server's state stays in step with what the human hears.

import { createResolver, resolveHighlightAnchors } from "@review-table/anchoring";
import type {
  AnchorTable,
  AnnotatedFile,
  ClientMessage,
  IssueSummary,
  SeatId,
  ServerMessage,
  Verdict,
} from "@review-table/contracts";
import { useMemo, useRef, useState } from "react";
import type { MouthState } from "./audio/AudioEngine";
import { ReviewPlayer } from "./audio/ReviewPlayer";
import { DiffInput } from "./DiffInput";
import { EditorPane } from "./editor/EditorPane";
import { FocusControl } from "./editor/FocusControl";
import { PttRecorder } from "./lib/ptt";
import { useReviewSocket } from "./lib/ws";
import { type AwaitingState, TableScene } from "./scene/TableScene";
import { SEATS } from "./seats";

interface VerdictState {
  verdict: Verdict;
  issues: IssueSummary[];
}

const AI_SEAT_IDS = new Set(SEATS.filter((s) => s.kind === "ai").map((s) => s.id));
const displayName = (id: SeatId): string => SEATS.find((s) => s.id === id)?.display_name ?? id;

export function App() {
  const [thinking, setThinking] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);
  const [speakingSeat, setSpeakingSeat] = useState<string | null>(null);
  const [mouth, setMouth] = useState<MouthState>("closed");
  const [anchorTable, setAnchorTable] = useState<AnchorTable | null>(null);
  const [files, setFiles] = useState<AnnotatedFile[]>([]);
  const [highlighted, setHighlighted] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<VerdictState | null>(null);
  const [awaiting, setAwaiting] = useState<AwaitingState | null>(null);
  const [dogsMuted, setDogsMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [running, setRunning] = useState(false); // a review loop is live on the server
  const [dockOpen, setDockOpen] = useState(true); // collapse the diff dock for a full-bleed scene

  const resolver = useMemo(() => (anchorTable ? createResolver(anchorTable) : null), [anchorTable]);

  const recorderRef = useRef<PttRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new PttRecorder();

  // Player callbacks fire async (after audio), so they reach `send` through a ref kept
  // current below — the useRef object is stable across renders.
  const sendRef = useRef<((m: ClientMessage) => void) | null>(null);

  // One ReviewPlayer for the session; it owns the AudioEngine and the turn queue.
  const playerRef = useRef<ReviewPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new ReviewPlayer({
      onThinking: () => {
        setThinking(true);
        setSpeakingSeat(null);
        setMouth("closed");
      },
      onTurnStart: (seat, cap, highlight) => {
        setThinking(false);
        setAwaiting(null); // a dog has the floor again
        setSpeakingSeat(seat);
        setCaption(cap);
        setHighlighted(highlight);
      },
      onMouth: (state) => setMouth(state),
      onTurnEnd: (seat) => {
        setSpeakingSeat(null);
        setMouth("closed");
        // Pacing ack: tell the server this turn finished playing (AI turns only —
        // the human's own turns never round-trip through the player).
        if (AI_SEAT_IDS.has(seat)) sendRef.current?.({ type: "turn_played" });
      },
      onComplete: (v, issues) => {
        setThinking(false);
        setSpeakingSeat(null);
        setMouth("closed");
        setAwaiting(null);
        setRunning(false);
        setVerdict({ verdict: v, issues });
      },
      onIdle: () => {
        // Intentionally quiet: the thinking beat is cleared by the next turn/await,
        // so it persists across the real director hop rather than flickering.
      },
    });
  }
  const player = playerRef.current;

  const { status, send, sendBinary } = useReviewSocket(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "review_started":
          setAnchorTable(msg.anchorTable);
          setFiles(msg.files);
          setHighlighted([]);
          setThinking(false);
          setAwaiting(null);
          setDogsMuted(false);
          break;
        case "thinking":
          player.beginThinking();
          break;
        case "turn_start":
          player.beginTurn(msg.seat_id, msg.focus_anchors);
          break;
        case "highlight":
          player.updateHighlight(msg.anchors);
          break;
        case "text_delta":
          player.appendCaption(msg.delta);
          break;
        case "turn_end":
          player.endTurn();
          break;
        case "awaiting_human":
          setThinking(false);
          setSpeakingSeat(null);
          setMouth("closed");
          setAwaiting({ prompt: msg.prompt, addressedBy: displayName(msg.addressed_by) });
          break;
        case "dogs_muted":
          setDogsMuted(msg.muted);
          break;
        case "review_complete":
          player.complete(msg.verdict, msg.issues);
          break;
        default:
          break;
      }
    },
    (buf: ArrayBuffer) => player.appendAudio(buf),
  );

  sendRef.current = send;

  const applyHighlight = (anchors: string[], focusHunk: string | null) => {
    if (!anchorTable) return;
    const resolved = resolveHighlightAnchors(anchors, anchorTable, focusHunk);
    setHighlighted(resolved);
    if (resolver && resolved[0]) {
      const pos = resolver.resolve(resolved[0]);
      if (pos) console.log(`[highlight] ${resolved.join(", ")} → ${pos.file}:${pos.line}`);
    }
  };

  // ── Human input handlers (M4) ──────────────────────────────────────────────

  const submitText = (text: string) => {
    send({ type: "human_text", text });
    setAwaiting(null);
    setCaption(`You: ${text}`);
  };

  const pttDown = async () => {
    try {
      await recorderRef.current!.start();
      setRecording(true);
      send({ type: "ptt_start" });
    } catch (err) {
      console.error("[ptt] mic unavailable:", err);
      setRecording(false);
    }
  };

  const pttUp = async () => {
    if (!recording) return;
    setRecording(false);
    send({ type: "ptt_end" });
    try {
      const clip = await recorderRef.current!.stop();
      if (clip.size > 0) sendBinary(clip);
    } catch (err) {
      console.error("[ptt] capture failed:", err);
    }
    setAwaiting(null);
    setCaption("You: 🎤 …");
  };

  const interject = () => {
    player.interruptCurrent(); // stop the dog mid-sentence on the client at once
    setSpeakingSeat(null);
    setMouth("closed");
    send({ type: "interject" }); // server discards the partial turn, opens the floor
  };

  // Stop the whole review: tell the server to abort the loop, drop any queued/in-flight
  // audio, and return the scene to idle. The pasted diff + annotated editor stay so the
  // review can be re-run; the spotlight, captions, and any pending human turn clear.
  const stopReview = () => {
    send({ type: "abort" });
    player.reset(); // stop audio + clear the turn queue (suppresses stray acks)
    setRunning(false);
    setThinking(false);
    setSpeakingSeat(null);
    setMouth("closed");
    setCaption(null);
    setAwaiting(null);
    setHighlighted([]);
    setDogsMuted(false);
    setRecording(false);
  };

  const reviewActive = anchorTable != null;
  const canInterject = reviewActive && !!speakingSeat && AI_SEAT_IDS.has(speakingSeat) && !verdict;

  return (
    <div className="app">
      <header className="topbar">
        <h1>The Review Table</h1>
        <div className="topbar-right">
          {running ? (
            <button type="button" className="stop-btn" onClick={stopReview} title="Stop the review">
              ⏹ Stop review
            </button>
          ) : null}
          <span className={`conn conn-${status}`}>{status}</span>
        </div>
      </header>

      <main className="layout">
        <TableScene
          speakingSeat={speakingSeat}
          mouth={mouth}
          caption={caption}
          thinking={thinking}
          verdict={verdict}
          awaiting={awaiting}
          recording={recording}
          dogsMuted={dogsMuted}
          canInterject={canInterject}
          onSubmitText={submitText}
          onPttDown={pttDown}
          onPttUp={pttUp}
          onInterject={interject}
        />

        {/* Collapsible diff dock (B2): docks right; collapse it for a full-bleed scene. */}
        <aside className={`right-dock${dockOpen ? "" : " collapsed"}`}>
          <button
            type="button"
            className="dock-toggle"
            onClick={() => setDockOpen((o) => !o)}
            title={dockOpen ? "Collapse the diff pane" : "Show the diff pane"}
          >
            {dockOpen ? "›" : "‹"}
          </button>
          <div className="dock-content">
            <DiffInput
              disabled={status !== "open"}
              onStart={(diff) => {
                setCaption(null);
                setVerdict(null);
                setAwaiting(null);
                setDogsMuted(false);
                setRunning(true);
                player.reset();
                // Unlock audio from within the click gesture, then start the review.
                void player.unlock();
                send({ type: "start_review", diff });
              }}
            />
            {reviewActive ? (
              <FocusControl onApply={applyHighlight} onClear={() => setHighlighted([])} />
            ) : null}
            <EditorPane files={files} highlighted={highlighted} />
          </div>
        </aside>
      </main>
    </div>
  );
}
