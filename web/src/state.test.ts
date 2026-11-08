import type { RollRequest, ServerEvent, TranscriptEntry } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { initialState, reduce, type TableState } from "./state";

const apply = (state: TableState, ...events: ServerEvent[]) => events.reduce((s, event) => reduce(s, { type: "server", event }), state);

const request = { id: "r1", characterId: "kira", label: "Sneak" } as RollRequest;
const gmEntry = (id: number, text: string): TranscriptEntry => ({ id, ts: "t", kind: "gm", text });
const rollEntry = (id: number): TranscriptEntry =>
  ({ id, ts: "t", kind: "roll", resolved: { request, source: "app", roll: { dice: [6], hits: 1, ones: 0, glitch: false, criticalGlitch: false }, outcome: { success: true, netHits: 0, glitch: false, criticalGlitch: false, consequence: "ok" } } }) as TranscriptEntry;

describe("the table's state", () => {
  it("takes a snapshot whole, replacing what it had", () => {
    const before = apply(initialState, { type: "roll.requested", request });
    const after = apply(before, { type: "snapshot", party: [], characters: [], pendingRolls: [], edge: [], combat: null, transcript: [gmEntry(1, "Hi")], gm: { phase: "idle" }, usage: null, rules: { hitMinimum: 4, stunOverflowPerPhysical: 2 } });
    expect(after.rules).toEqual({ hitMinimum: 4, stunOverflowPerPhysical: 2 });
    expect(after).toMatchObject({ ready: true, pending: [], transcript: [{ id: 1 }] });
  });

  it("assumes the book's rules until a snapshot says otherwise", () => {
    expect(initialState.rules).toEqual({ hitMinimum: 5, stunOverflowPerPhysical: 1 });
  });

  it("streams narration into blocks, and drops them when the finished entry arrives", () => {
    const streaming = apply(initialState, { type: "gm.block", turnId: 1 }, { type: "gm.text", turnId: 1, text: "Rain " }, { type: "gm.text", turnId: 1, text: "falls." }, { type: "gm.block", turnId: 1 }, { type: "gm.text", turnId: 1, text: "A door." });
    expect(streaming.streaming?.blocks).toEqual(["Rain falls.", "A door."]);
    const done = apply(streaming, { type: "entry", entry: gmEntry(1, "Rain falls.\n\nA door.") }, { type: "gm.turn_done", turnId: 1 });
    expect(done.streaming).toBeNull();
    expect(done.transcript).toHaveLength(1);
  });

  it("puts a roll on the screen, and takes it off when it is counted, which also shows the result open until the GM has narrated it", () => {
    const asked = apply(initialState, { type: "roll.requested", request });
    expect(asked.pending).toHaveLength(1);
    const counted = apply(asked, { type: "entry", entry: rollEntry(5) });
    expect(counted.pending).toHaveLength(0);
    expect(counted.fresh).toEqual([5]);
    expect(apply(counted, { type: "gm.block", turnId: 2 }, { type: "gm.text", turnId: 2, text: "You slip by." }).fresh).toEqual([5]);
    expect(apply(counted, { type: "entry", entry: gmEntry(6, "You slip by.") }).fresh).toEqual([]);
    expect(apply(counted, { type: "roll.requested", request: { ...request, id: "r2" } }).fresh).toEqual([]);
  });

  it("removes a skipped roll and replaces a roll that was updated", () => {
    const asked = apply(initialState, { type: "roll.requested", request });
    expect(apply(asked, { type: "roll.updated", request: { ...request, label: "Changed" } }).pending[0]?.label).toBe("Changed");
    expect(apply(asked, { type: "roll.cancelled", requestId: "r1" }).pending).toEqual([]);
  });

  it("does not show an entry twice", () => {
    const entry = gmEntry(1, "Hi");
    expect(apply(initialState, { type: "entry", entry }, { type: "entry", entry }).transcript).toHaveLength(1);
  });

  it("keeps the server's refusal until the player acts again", () => {
    const refused = apply(initialState, { type: "error", message: "This roll is 4 dice; you entered 3." });
    expect(refused.error).toBe("This roll is 4 dice; you entered 3.");
    expect(reduce(refused, { type: "acted" }).error).toBeNull();
  });

  it("tracks the connection", () => {
    expect(reduce(initialState, { type: "connection", connected: false, attempt: 2 })).toMatchObject({ connected: false, attempt: 2 });
  });
});
