// Keyless M4 smoke: drives the paced loop + the interject→human path on fakes.
// Run with: USE_FAKES=1 npx tsx src/smoke-m4.ts   (from apps/server)
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "@review-table/anchoring";
import type { ServerMessage } from "@review-table/contracts";
import { ReviewControls } from "./control";
import { runReview, type TurnSink } from "./orchestrator";

const here = dirname(fileURLToPath(import.meta.url));
const diff = readFileSync(resolve(here, "../../../fixtures/sample.diff"), "utf8");
const { anchorTable, files } = parseUnifiedDiff(diff);

type Mode = "paced" | "interject";

async function run(mode: Mode) {
  const controls = new ReviewControls();
  const log: ServerMessage[] = [];
  let audioFrames = 0;
  let turnEnds = 0;
  const interjectAt = 2; // raise a paw on the 2nd dog turn

  const sink: TurnSink = {
    send: (m) => {
      log.push(m);
      if (m.type === "turn_end") {
        turnEnds += 1;
        // Ack playback so the next director hop runs — except where we interject.
        if (mode === "interject" && turnEnds === interjectAt) {
          controls.interject();
          controls.submitHuman("That null path is actually guarded upstream — here's why.");
        } else {
          controls.turnPlayed();
        }
      }
    },
    sendBinary: () => {
      audioFrames += 1;
    },
  };

  await runReview(sink, anchorTable, files, controls);

  const turnStarts = log.filter((m) => m.type === "turn_start").length;
  const awaiting = log.filter((m) => m.type === "awaiting_human").length;
  // Reactive (dog-to-dog) moves: with the A2 gate active, these only get committed if
  // their addressed_to named a dog seat — so their presence proves dog-to-dog addressing.
  const reactive = log.filter(
    (m) => m.type === "turn_start" && (m.move === "pushback" || m.move === "pile_on"),
  ).length;
  const complete = log.find((m) => m.type === "review_complete");
  console.log(`\n── mode=${mode} ──`);
  console.log(
    `turn_start=${turnStarts}, turn_end=${turnEnds}, awaiting_human=${awaiting}, reactive=${reactive}, audioFrames=${audioFrames}`,
  );
  if (complete && complete.type === "review_complete") {
    console.log(`review_complete: verdict=${complete.verdict}, issues=${complete.issues.length}`);
  } else {
    console.log("!! no review_complete emitted");
  }
  return { turnStarts, awaiting, reactive, complete: !!complete };
}

const paced = await run("paced");
const inter = await run("interject");

const ok =
  paced.complete &&
  inter.complete &&
  paced.reactive >= 1 && // dogs engaged each other's points (A2 gate passed)
  inter.awaiting >= 1; // the interject opened the floor for the human
console.log(
  `\n${ok ? "PASS" : "FAIL"} — paced.complete=${paced.complete}, paced.reactive=${paced.reactive}, ` +
    `interject.complete=${inter.complete}, interject.awaiting=${inter.awaiting}`,
);
process.exit(ok ? 0 : 1);
