// The author's input affordance (M4). Appears when the director gives the human the
// floor (AWAITING_HUMAN) or after the human interjects. Two ways to answer: type a
// precise, line-level point, or hold to talk (push-to-talk). While the talk button is
// held, the server mutes all dog audio (invariant 7) — surfaced here as a live state.

import { useState } from "react";

export function HumanInput({
  prompt,
  addressedBy,
  recording,
  dogsMuted,
  onSubmitText,
  onPttDown,
  onPttUp,
}: {
  prompt: string;
  addressedBy: string;
  recording: boolean;
  dogsMuted: boolean;
  onSubmitText: (text: string) => void;
  onPttDown: () => void;
  onPttUp: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmitText(t);
    setText("");
  };

  return (
    <div className="human-input">
      <div className="human-input-prompt">
        <span className="human-input-by">{addressedBy} → you</span>
        <span className="human-input-q">{prompt}</span>
      </div>
      <div className="human-input-row">
        <textarea
          className="human-input-text"
          placeholder="Type your reply… (Enter to send, Shift+Enter for a newline)"
          value={text}
          autoFocus
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="human-input-actions">
          <button
            type="button"
            className="send-btn"
            onClick={submit}
            disabled={text.trim().length === 0}
          >
            Send
          </button>
          <button
            type="button"
            className={`ptt-btn${recording ? " recording" : ""}`}
            onPointerDown={(e) => {
              e.preventDefault();
              onPttDown();
            }}
            onPointerUp={onPttUp}
            onPointerLeave={() => recording && onPttUp()}
          >
            {recording ? "● recording — release to send" : "🎤 hold to talk"}
          </button>
        </div>
      </div>
      {dogsMuted ? <div className="human-input-muted">dogs muted while you speak</div> : null}
    </div>
  );
}
