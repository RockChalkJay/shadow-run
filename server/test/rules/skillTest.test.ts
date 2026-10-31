import { describe, expect, it } from "vitest";
import { evaluate, opposedTest, simpleTest } from "../../src/rules/index.js";

const withHits = (n: number) => evaluate([...Array(n).fill(6), ...Array(4).fill(3)]);

describe("simpleTest", () => {
  it("succeeds at the threshold and counts hits beyond it", () => {
    expect(simpleTest(withHits(3), 2)).toEqual({ success: true, netHits: 1 });
    expect(simpleTest(withHits(2), 2)).toEqual({ success: true, netHits: 0 });
  });

  it("fails below the threshold with no net hits", () => {
    expect(simpleTest(withHits(1), 2)).toEqual({ success: false, netHits: 0 });
  });
});

describe("opposedTest", () => {
  it("goes to the roller who has more hits, by the difference", () => {
    expect(opposedTest(withHits(4), withHits(2))).toEqual({ winner: "attacker", netHits: 2 });
    expect(opposedTest(withHits(1), withHits(4))).toEqual({ winner: "defender", netHits: 3 });
  });

  it("goes to the defender on a tie", () => {
    expect(opposedTest(withHits(3), withHits(3))).toEqual({ winner: "defender", netHits: 0 });
  });
});
