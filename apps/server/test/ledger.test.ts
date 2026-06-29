import type { AnchorTable, TranscriptEntry, TurnMove } from "@review-table/contracts";
import { describe, expect, it } from "vitest";
import {
  applyMove,
  canResolve,
  deriveIssues,
  deriveVerdict,
  initLedger,
  leastSpokenSeat,
  reviewComplete,
} from "../src/ledger";

const TABLE: AnchorTable = {
  anchors: {},
  hunks: {
    h1: { file: "f.ts", start_line: 1, end_line: 5 },
    h2: { file: "f.ts", start_line: 40, end_line: 48 },
  },
};

function move(p: Partial<TurnMove>): TurnMove {
  return {
    next_speaker: "rex",
    move: "raise_issue",
    addressed_to: "table",
    focus: null,
    thread_id: null,
    thread_status: null,
    brief: "",
    verdict: null,
    ...p,
  };
}
const focus = (hunk: string, anchors: string[] = []) => ({ file: "f.ts", anchor: hunk, anchors });

describe("initLedger", () => {
  it("zeroes turns per seat and marks every hunk uncovered", () => {
    const l = initLedger(TABLE, ["rex", "bella", "human"]);
    expect(l.turns_by_seat).toEqual({ rex: 0, bella: 0, human: 0 });
    expect(l.hunk_coverage).toEqual({ h1: "uncovered", h2: "uncovered" });
    expect(l.threads).toEqual({});
    expect(l.total_turns).toBe(0);
  });
});

describe("applyMove", () => {
  it("raise_issue opens a thread and its hunk, and counts the turn", () => {
    const l = initLedger(TABLE, ["rex", "bella"]);
    applyMove(l, move({ move: "raise_issue", thread_id: "t1", focus: focus("h1", ["a3"]) }), "rex");
    expect(l.threads.t1).toMatchObject({ status: "open", has_pushback: false, opened_by: "rex" });
    expect(l.hunk_coverage.h1).toBe("open");
    expect(l.turns_by_seat.rex).toBe(1);
    expect(l.total_turns).toBe(1);
  });

  it("pushback sets has_pushback (the resolve gate) on a thread", () => {
    const l = initLedger(TABLE, ["rex", "bella"]);
    applyMove(l, move({ move: "raise_issue", thread_id: "t1", focus: focus("h1") }), "rex");
    expect(canResolve(l, "t1")).toBe(false);
    applyMove(
      l,
      move({ move: "pushback", thread_id: "t1", addressed_to: "rex", focus: focus("h1") }),
      "bella",
    );
    expect(l.threads.t1.has_pushback).toBe(true);
    expect(canResolve(l, "t1")).toBe(true);
  });

  it("resolve sets the thread + hunk to the given status", () => {
    const l = initLedger(TABLE, ["rex"]);
    applyMove(l, move({ move: "raise_issue", thread_id: "t1", focus: focus("h1") }), "rex");
    applyMove(
      l,
      move({ move: "pushback", thread_id: "t1", addressed_to: "rex", focus: focus("h1") }),
      "rex",
    );
    applyMove(
      l,
      move({ move: "resolve", thread_id: "t1", thread_status: "blocking", focus: focus("h1") }),
      "rex",
    );
    expect(l.threads.t1.status).toBe("blocking");
    expect(l.hunk_coverage.h1).toBe("blocking");
  });

  it("resolve without a thread_status defaults to resolved", () => {
    const l = initLedger(TABLE, ["rex"]);
    applyMove(l, move({ move: "raise_issue", thread_id: "t1", focus: focus("h1") }), "rex");
    applyMove(l, move({ move: "resolve", thread_id: "t1", focus: focus("h1") }), "rex");
    expect(l.threads.t1.status).toBe("resolved");
    expect(l.hunk_coverage.h1).toBe("resolved");
  });

  it("banter does not open an uncovered hunk", () => {
    const l = initLedger(TABLE, ["rex"]);
    applyMove(l, move({ move: "banter", focus: focus("h1") }), "rex");
    expect(l.hunk_coverage.h1).toBe("uncovered");
  });
});

describe("canResolve", () => {
  it("is false for a null or unknown thread", () => {
    const l = initLedger(TABLE, ["rex"]);
    expect(canResolve(l, null)).toBe(false);
    expect(canResolve(l, "nope")).toBe(false);
  });
});

describe("reviewComplete", () => {
  it("is false while any hunk is uncovered or open", () => {
    const l = initLedger(TABLE, ["rex"]);
    expect(reviewComplete(l)).toBe(false);
    l.hunk_coverage.h1 = "resolved";
    expect(reviewComplete(l)).toBe(false); // h2 still uncovered
  });

  it("is true once every hunk reached a terminal state", () => {
    const l = initLedger(TABLE, ["rex"]);
    l.hunk_coverage.h1 = "resolved";
    l.hunk_coverage.h2 = "blocking";
    expect(reviewComplete(l)).toBe(true);
  });
});

describe("leastSpokenSeat", () => {
  it("prefers the fewest-spoken seat; the lead breaks ties", () => {
    const l = initLedger(TABLE, ["rex", "bella", "duke"]);
    l.turns_by_seat = { rex: 2, bella: 1, duke: 3 };
    expect(leastSpokenSeat(l, ["rex", "bella", "duke"], "rex")).toBe("bella");
    l.turns_by_seat = { rex: 1, bella: 1, duke: 3 };
    expect(leastSpokenSeat(l, ["rex", "bella", "duke"], "rex")).toBe("rex"); // tie → lead
  });
});

describe("deriveVerdict", () => {
  it("request_changes when anything is blocking", () => {
    const l = initLedger(TABLE, ["rex"]);
    l.hunk_coverage = { h1: "blocking", h2: "resolved" };
    expect(deriveVerdict(l)).toBe("request_changes");
  });

  it("comment when work is still open/uncovered", () => {
    const l = initLedger(TABLE, ["rex"]);
    l.hunk_coverage = { h1: "open", h2: "resolved" };
    expect(deriveVerdict(l)).toBe("comment");
  });

  it("approve when all resolved/deferred with at least one real thread", () => {
    const l = initLedger(TABLE, ["rex"]);
    l.hunk_coverage = { h1: "resolved", h2: "deferred" };
    l.threads = {
      t1: {
        status: "resolved",
        focus_anchors: [],
        turn_count: 2,
        opened_by: "rex",
        has_pushback: true,
      },
    };
    expect(deriveVerdict(l)).toBe("approve");
  });
});

describe("deriveIssues", () => {
  it("emits one issue per thread, gist drawn from its opening turn", () => {
    const l = initLedger(TABLE, ["rex"]);
    l.threads = {
      t1: {
        status: "blocking",
        focus_anchors: ["a3"],
        turn_count: 3,
        opened_by: "rex",
        has_pushback: true,
      },
    };
    const transcript: TranscriptEntry[] = [
      {
        seat_id: "rex",
        move: "raise_issue",
        thread_id: "t1",
        text: "The null path is unguarded.",
        focus_anchors: ["a3"],
        ts: 0,
        addressed_to: "table",
      },
    ];
    const issues = deriveIssues(l, transcript);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      thread_id: "t1",
      status: "blocking",
      gist: "The null path is unguarded.",
    });
  });
});
