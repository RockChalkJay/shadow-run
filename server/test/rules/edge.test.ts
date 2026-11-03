import { describe, expect, it } from "vitest";
import {
  burnEdge,
  edgeFromRatings,
  endConfrontation,
  gainEdge,
  loseEdge,
  spendEdge,
  startRound,
  startSession,
} from "../../src/rules/index.js";

describe("edgeFromRatings", () => {
  it("rewards whichever side leads by the gap or more", () => {
    expect(edgeFromRatings(10, 6)).toBe("attacker");
    expect(edgeFromRatings(6, 10)).toBe("defender");
    expect(edgeFromRatings(8, 4)).toBe("attacker");
  });

  it("rewards no one for a smaller lead", () => {
    expect(edgeFromRatings(10, 7)).toBeNull();
    expect(edgeFromRatings(7, 10)).toBeNull();
    expect(edgeFromRatings(8, 8)).toBeNull();
  });
});

describe("a session of Edge", () => {
  it("starts with as many points as the Edge rank", () => {
    expect(startSession(4)).toEqual({ rank: 4, points: 4, gainedThisRound: 0, spentThisRound: false });
    expect(() => startSession(-1)).toThrow(RangeError);
  });
});

describe("gainEdge", () => {
  it("adds what was asked when nothing caps it", () => {
    const { state, gained } = gainEdge(startSession(3), 1);
    expect(gained).toBe(1);
    expect(state).toMatchObject({ points: 4, gainedThisRound: 1 });
  });

  it("stops at two bonus points in a round, and starts over the next round", () => {
    let state = startSession(3);
    state = gainEdge(state, 1).state;
    const second = gainEdge(state, 5);
    expect(second.gained).toBe(1);
    expect(gainEdge(second.state, 1).gained).toBe(0);
    expect(gainEdge(startRound(second.state), 1).gained).toBe(1);
  });

  it("stops at the overall maximum of 7, which includes the Edge attribute", () => {
    expect(gainEdge(startSession(7), 1).gained).toBe(0);
    expect(gainEdge(startSession(6), 2)).toMatchObject({ gained: 1, state: { points: 7 } });
  });

  it("gains nothing for an amount of 0 and rejects one that is negative or fractional", () => {
    expect(gainEdge(startSession(3), 0).gained).toBe(0);
    expect(() => gainEdge(startSession(3), -1)).toThrow(RangeError);
    expect(() => gainEdge(startSession(3), 0.5)).toThrow(RangeError);
  });
});

describe("spendEdge", () => {
  it("takes the cost off the points", () => {
    expect(spendEdge(startSession(3), 2)).toMatchObject({ points: 1, spentThisRound: true });
  });

  it("allows only one expenditure a round, even a small one", () => {
    const spent = spendEdge(startSession(5), 1);
    expect(() => spendEdge(spent, 1)).toThrow("already spent");
    expect(spendEdge(startRound(spent), 1).points).toBe(3);
  });

  it("refuses to overspend or spend nothing", () => {
    expect(() => spendEdge(startSession(3), 4)).toThrow("Not enough Edge");
    expect(() => spendEdge(startSession(3), 0)).toThrow(RangeError);
    expect(() => spendEdge(startSession(3), 1.5)).toThrow(RangeError);
  });

  it("does not change the state it was given", () => {
    const before = startSession(3);
    spendEdge(before, 2);
    expect(before.points).toBe(3);
  });
});

describe("losing, ending and burning Edge", () => {
  it("loses Edge to a foe, never below zero", () => {
    expect(loseEdge(startSession(3), 1).points).toBe(2);
    expect(loseEdge(startSession(1), 5).points).toBe(0);
    expect(() => loseEdge(startSession(3), -1)).toThrow(RangeError);
  });

  it("drops Edge above the attribute when a confrontation ends, but keeps lower Edge", () => {
    const high = { ...startSession(3), points: 5 };
    expect(endConfrontation(high).points).toBe(3);
    const low = { ...startSession(3), points: 1 };
    expect(endConfrontation(low).points).toBe(1);
  });

  it("burns a rank for good and every point on hand, even in a round Edge was spent", () => {
    const spent = spendEdge(startSession(5), 2);
    expect(burnEdge(spent)).toMatchObject({ rank: 4, points: 0 });
    expect(burnEdge(startSession(0)).rank).toBe(0);
  });
});
