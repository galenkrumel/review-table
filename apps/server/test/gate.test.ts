import type { Ledger, ThreadLedgerEntry, TranscriptEntry, TurnMove } from "@review-table/contracts";
import { describe, expect, it } from "vitest";
import { coerce, correctAddressing, gateProblems, pickDogTarget } from "../src/gate";

function ledger(over: Partial<Ledger> = {}): Ledger {
  return { turns_by_seat: {}, threads: {}, hunk_coverage: {}, total_turns: 0, ...over };
}
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
function entry(p: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    seat_id: "rex",
    move: "raise_issue",
    thread_id: null,
    text: "",
    focus_anchors: [],
    ts: 0,
    addressed_to: "table",
    ...p,
  };
}
const thread = (over: Partial<ThreadLedgerEntry> = {}): ThreadLedgerEntry => ({
  status: "open",
  focus_anchors: [],
  turn_count: 1,
  opened_by: "rex",
  has_pushback: false,
  ...over,
});

describe("gateProblems — anti-agreeableness (resolve needs prior pushback)", () => {
  it("rejects resolve on a thread that has taken no pushback", () => {
    const st = { ledger: ledger({ threads: { t1: thread() } }), priorTurn: null };
    const problems = gateProblems(st, move({ move: "resolve", thread_id: "t1" }), false);
    expect(problems.some((p) => /pushback/.test(p))).toBe(true);
  });

  it("allows resolve once the thread has taken pushback", () => {
    const st = {
      ledger: ledger({ threads: { t1: thread({ has_pushback: true }) } }),
      priorTurn: null,
    };
    expect(gateProblems(st, move({ move: "resolve", thread_id: "t1" }), false)).toEqual([]);
  });
});

describe("gateProblems — close rules", () => {
  it("rejects close while work remains (wantClose=false)", () => {
    const st = { ledger: ledger(), priorTurn: null };
    expect(gateProblems(st, move({ move: "close" }), false).length).toBeGreaterThan(0);
  });

  it("allows close when the review is complete (wantClose=true)", () => {
    const st = { ledger: ledger(), priorTurn: null };
    expect(gateProblems(st, move({ move: "close", next_speaker: "rex" }), true)).toEqual([]);
  });

  it("rejects the human delivering the verdict", () => {
    const st = { ledger: ledger(), priorTurn: null };
    expect(
      gateProblems(st, move({ move: "close", next_speaker: "human" }), true).length,
    ).toBeGreaterThan(0);
  });
});

describe("gateProblems — reactive moves must name a participant", () => {
  const st = { ledger: ledger(), priorTurn: null };

  it("rejects a pushback addressed to the table", () => {
    expect(
      gateProblems(st, move({ move: "pushback", addressed_to: "table" }), false).length,
    ).toBeGreaterThan(0);
  });
  it("rejects a pile_on addressed to nobody (null)", () => {
    expect(
      gateProblems(st, move({ move: "pile_on", addressed_to: null }), false).length,
    ).toBeGreaterThan(0);
  });
  it("accepts a pushback addressed to a fellow dog", () => {
    expect(
      gateProblems(
        st,
        move({ move: "pushback", next_speaker: "bella", addressed_to: "rex" }),
        false,
      ),
    ).toEqual([]);
  });
  it("accepts a pushback addressed to the author", () => {
    expect(
      gateProblems(
        st,
        move({ move: "pushback", next_speaker: "bella", addressed_to: "human" }),
        false,
      ),
    ).toEqual([]);
  });
});

describe("coerce", () => {
  it("turns an illegal resolve into a pushback that names a dog", () => {
    const st = { ledger: ledger({ threads: { t1: thread() } }), priorTurn: null };
    const out = coerce(st, move({ move: "resolve", thread_id: "t1", next_speaker: "bella" }));
    expect(out.move).toBe("pushback");
    expect(["rex", "duke"]).toContain(out.addressed_to); // a dog other than the speaker
  });

  it("turns a premature close into move_on", () => {
    const st = { ledger: ledger(), priorTurn: null };
    expect(coerce(st, move({ move: "close" })).move).toBe("move_on");
  });

  it("gives a target-less pushback the prior dog speaker", () => {
    const st = { ledger: ledger(), priorTurn: entry({ seat_id: "duke" }) };
    const out = coerce(
      st,
      move({ move: "pushback", next_speaker: "bella", addressed_to: "table" }),
    );
    expect(out.addressed_to).toBe("duke");
  });

  it("aims a target-less pushback at the author when the author just spoke", () => {
    const st = { ledger: ledger(), priorTurn: entry({ seat_id: "human" }) };
    const out = coerce(
      st,
      move({ move: "pushback", next_speaker: "bella", addressed_to: "table" }),
    );
    expect(out.addressed_to).toBe("human");
  });

  it("leaves a legal move untouched", () => {
    const st = { ledger: ledger(), priorTurn: null };
    const m = move({ move: "raise_issue", thread_id: "t1" });
    expect(coerce(st, m)).toBe(m);
  });
});

describe("pickDogTarget", () => {
  it("prefers the thread opener when it's a different dog", () => {
    const st = {
      ledger: ledger({ threads: { t1: thread({ opened_by: "duke" }) } }),
      priorTurn: null,
    };
    expect(pickDogTarget(st, "bella", "t1")).toBe("duke");
  });

  it("falls back to the prior dog speaker, then any other dog", () => {
    expect(
      pickDogTarget({ ledger: ledger(), priorTurn: entry({ seat_id: "rex" }) }, "bella", null),
    ).toBe("rex");
    const other = pickDogTarget({ ledger: ledger(), priorTurn: null }, "rex", null);
    expect(["bella", "duke"]).toContain(other);
  });
});

describe("correctAddressing — post-human responses aim at the author", () => {
  it("redirects a responding move to the author when the author just spoke", () => {
    const st = { ledger: ledger(), priorTurn: entry({ seat_id: "human" }) };
    const { move: out, redirected } = correctAddressing(
      st,
      move({ move: "pushback", addressed_to: "rex" }),
    );
    expect(redirected).toBe(true);
    expect(out.addressed_to).toBe("human");
  });

  it("leaves a new-topic move (raise_issue) after the human untouched", () => {
    const st = { ledger: ledger(), priorTurn: entry({ seat_id: "human" }) };
    const { move: out, redirected } = correctAddressing(
      st,
      move({ move: "raise_issue", addressed_to: "table" }),
    );
    expect(redirected).toBe(false);
    expect(out.addressed_to).toBe("table");
  });

  it("leaves moves untouched when the prior turn was a dog", () => {
    const st = { ledger: ledger(), priorTurn: entry({ seat_id: "rex" }) };
    const { redirected } = correctAddressing(st, move({ move: "pile_on", addressed_to: "rex" }));
    expect(redirected).toBe(false);
  });
});
