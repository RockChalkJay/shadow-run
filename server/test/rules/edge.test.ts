import { describe, expect, it } from "vitest";
import { edgeFromRatings, gainEdge, spendEdge } from "../../src/rules/index.js";

describe("edgeFromRatings", () => {
  it("rewards whichever side leads by the gap or more", () => {
    expect(edgeFromRatings(10, 6)).toBe("attacker");
    expect(edgeFromRatings(6, 10)).toBe("defender");
  });

  it("rewards no one for a smaller lead", () => {
    expect(edgeFromRatings(10, 7)).toBeNull();
    expect(edgeFromRatings(7, 10)).toBeNull();
    expect(edgeFromRatings(8, 8)).toBeNull();
  });
});

describe("gainEdge", () => {
  it("adds what was asked when nothing caps it", () => {
    expect(gainEdge(3, 0, 1)).toEqual({ points: 4, gainedThisRound: 1, gained: 1 });
  });

  it("stops at the per-round cap", () => {
    expect(gainEdge(3, 2, 1)).toEqual({ points: 3, gainedThisRound: 2, gained: 0 });
    expect(gainEdge(3, 1, 5)).toEqual({ points: 4, gainedThisRound: 2, gained: 1 });
  });

  it("gains nothing for an amount of 0 and rejects one that is negative or fractional", () => {
    expect(gainEdge(3, 0, 0).gained).toBe(0);
    expect(() => gainEdge(3, 0, -1)).toThrow(RangeError);
    expect(() => gainEdge(3, 0, 0.5)).toThrow(RangeError);
  });

  it("stops at the overall maximum", () => {
    expect(gainEdge(7, 0, 1).gained).toBe(0);
    expect(gainEdge(6, 0, 2)).toEqual({ points: 7, gainedThisRound: 1, gained: 1 });
  });
});

describe("spendEdge", () => {
  it("takes the cost off the points", () => {
    expect(spendEdge(3, 2)).toBe(1);
  });

  it("refuses to overspend or spend nothing", () => {
    expect(() => spendEdge(3, 4)).toThrow("Not enough Edge");
    expect(() => spendEdge(3, 0)).toThrow(RangeError);
    expect(() => spendEdge(3, 1.5)).toThrow(RangeError);
  });
});
