// The table scene. A single fixed reference image is the hero stage
// (apps/client/public/scene.png — used exactly as provided, never recreated/restyled).
// An absolutely-positioned overlay of identical dimensions indicates WHO is talking:
//   - a spotlight (dark wash over the whole image + a soft lighter radial over the
//     active seat's region, with a brightness bump) that swings between dogs (B3), and
//   - a name-tagged caption streaming the spoken text near the active seat (B4).
// Everything is driven by the existing server events via App's state (B5): the speaking
// dog, the director "thinking" beat, AWAITING_HUMAN (the beagle lights up + the input
// affordance appears), and interject ("raise paw"). At the end, a verdict panel overlays.

import type { IssueSummary, Verdict } from "@review-table/contracts";
import type { CSSProperties } from "react";
import type { MouthState } from "../audio/AudioEngine";
import { SEATS } from "../seats";
import { Captions } from "./Captions";
import { HumanInput } from "./HumanInput";
import { SeatLabel } from "./SeatLabel";
import { SpeakerCaption } from "./SpeakerCaption";
import { type Box, SEAT_REGIONS, seatRegion } from "./seatRegions";

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  comment: "Commented",
};

const STATUS_LABEL: Record<string, string> = {
  open: "open",
  resolved: "resolved",
  blocking: "blocking",
  deferred: "deferred",
};

const displayName = (id: string): string => SEATS.find((s) => s.id === id)?.display_name ?? id;

/** A region box → absolute overlay style, padded outward into a soft halo. */
function regionStyle(box: Box, padX = 4, padY = 3): CSSProperties {
  return {
    left: `${box.xPct - padX}%`,
    top: `${box.yPct - padY}%`,
    width: `${box.wPct + padX * 2}%`,
    height: `${box.hPct + padY * 2}%`,
  };
}

export interface AwaitingState {
  prompt: string;
  addressedBy: string; // display name of the dog who gave the floor
}

export function TableScene({
  speakingSeat,
  mouth,
  caption,
  thinking,
  verdict,
  awaiting,
  recording,
  dogsMuted,
  canInterject,
  onSubmitText,
  onPttDown,
  onPttUp,
  onInterject,
}: {
  speakingSeat?: string | null;
  mouth?: MouthState;
  caption?: string | null;
  thinking?: boolean;
  verdict?: { verdict: Verdict; issues: IssueSummary[] } | null;
  awaiting?: AwaitingState | null;
  recording?: boolean;
  dogsMuted?: boolean;
  canInterject?: boolean;
  onSubmitText?: (text: string) => void;
  onPttDown?: () => void;
  onPttUp?: () => void;
  onInterject?: () => void;
}) {
  // The human's seat lights up when it's their turn, just like a speaking dog.
  const activeSeat = awaiting ? "human" : (speakingSeat ?? null);
  const activeRegion = seatRegion(activeSeat);

  // Caption: a name-tagged caption anchored to a speaking dog; a plain bottom caption
  // for the human's own echoed reply (no active region when the dogs aren't speaking).
  const showSpeakerCaption = !!caption && !!activeRegion && !!speakingSeat && !awaiting && !verdict;
  const showFallbackCaption = !!caption && !showSpeakerCaption && !awaiting && !verdict;

  return (
    <div className="stage">
      <div className="scene-frame">
        <img
          className="scene-img"
          src="/scene.png"
          alt="Three dog reviewers and the author at the table"
        />

        {/* B3 — spotlight: dim the whole painting, then lift the active seat's region. */}
        <div className="scene-wash" />
        <div
          className="spotlight"
          data-mouth={speakingSeat ? (mouth ?? "closed") : "closed"}
          style={{
            ...(activeRegion ? regionStyle(activeRegion.box) : {}),
            opacity: activeRegion ? 1 : 0,
          }}
        />

        {/* While the director decides, a faint glow + "…" over the bulldog (B5). */}
        {thinking && !activeSeat ? (
          <div className="director-glow" style={regionStyle(SEAT_REGIONS.director!.box, 2, 2)} />
        ) : null}

        {/* Persistent name labels so each participant is identifiable. The active speaker's
            name is carried by its streaming caption instead; labels yield to the verdict
            panel. The director (background bulldog) isn't a participant, so it gets no label. */}
        {!verdict
          ? Object.entries(SEAT_REGIONS).map(([id, region]) =>
              id === activeSeat || id === "director" ? null : (
                <SeatLabel key={id} name={displayName(id)} anchor={region.caption} />
              ),
            )
          : null}

        {/* B4 — name-tagged caption near the active dog; plain caption for human echo. */}
        {showSpeakerCaption && activeSeat ? (
          <SpeakerCaption
            name={displayName(activeSeat)}
            text={caption ?? null}
            anchor={seatRegion(activeSeat)!.caption}
          />
        ) : null}
        {showFallbackCaption ? <Captions text={caption} /> : null}

        {thinking && !awaiting ? (
          <div className="thinking-beat">the director is thinking…</div>
        ) : null}

        {canInterject && !awaiting && !verdict ? (
          <button type="button" className="raise-paw" onClick={onInterject}>
            ✋ raise paw
          </button>
        ) : null}

        {awaiting ? (
          <HumanInput
            prompt={awaiting.prompt}
            addressedBy={awaiting.addressedBy}
            recording={!!recording}
            dogsMuted={!!dogsMuted}
            onSubmitText={onSubmitText ?? (() => {})}
            onPttDown={onPttDown ?? (() => {})}
            onPttUp={onPttUp ?? (() => {})}
          />
        ) : null}

        {verdict ? <VerdictPanel verdict={verdict.verdict} issues={verdict.issues} /> : null}
      </div>
    </div>
  );
}

function VerdictPanel({ verdict, issues }: { verdict: Verdict; issues: IssueSummary[] }) {
  return (
    <div className={`verdict-panel verdict-${verdict}`}>
      <div className="verdict-headline">{VERDICT_LABEL[verdict]}</div>
      {issues.length > 0 ? (
        <ul className="verdict-issues">
          {issues.map((issue) => (
            <li key={issue.thread_id} className={`issue issue-${issue.status}`}>
              <span className="issue-status">{STATUS_LABEL[issue.status] ?? issue.status}</span>
              <span className="issue-gist">{issue.gist}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="verdict-empty">No threads opened.</div>
      )}
    </div>
  );
}
