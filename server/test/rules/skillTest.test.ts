import { describe, expect, it } from "vitest";
import { attackDamage, damageAfterResistance, evaluate, opposedTest, simpleTest } from "../../src/rules/index.js";

const withHits = (n: number) => evaluate([...Array(n).fill(6), ...Array(4).fill(3)]);

describe("simpleTest", () => {
  it("succeeds at the threshold and counts hits beyond it", () => {
    expect(simpleTest(withHits(3), 2)).toEqual({ success: true, netHits: 1 });
    expect(simpleTest(withHits(2), 2)).toEqual({ success: true, netHits: 0 });
  });

  it("fails below the threshold with no net hits", () => {
    expect(simpleTest(withHits(1), 2)).toEqual({ success: false, netHits: 0 });
  });

  it("never lets a roll with no hits succeed, even against a threshold of 0", () => {
    expect(simpleTest(withHits(0), 0)).toEqual({ success: false, netHits: 0 });
    expect(simpleTest(evaluate([1, 1, 1, 2]), 0).success).toBe(false);
    expect(simpleTest(withHits(1), 0)).toEqual({ success: true, netHits: 0 });
  });
});

describe("opposedTest", () => {
  it("goes to the roller who has more hits, by the difference", () => {
    expect(opposedTest(withHits(4), withHits(2))).toEqual({ winner: "attacker", netHits: 2 });
    expect(opposedTest(withHits(1), withHits(4))).toEqual({ winner: "defender", netHits: 3 });
  });

  it("goes to the attacker on a tie", () => {
    expect(opposedTest(withHits(3), withHits(3))).toEqual({ winner: "attacker", netHits: 0 });
  });
});

describe("attackDamage", () => {
  it("adds the attacker's net hits to the weapon's Damage Value", () => {
    expect(attackDamage(withHits(7), withHits(2), 3)).toEqual({ hit: true, damageValue: 8 });
  });

  it("hits for the base Damage Value on a tie", () => {
    expect(attackDamage(withHits(3), withHits(3), 4)).toEqual({ hit: true, damageValue: 4 });
  });

  it("misses when the defender has more hits", () => {
    expect(attackDamage(withHits(2), withHits(3), 4)).toEqual({ hit: false, damageValue: 0 });
  });

  it("follows the rulebook's firearms example: 3P with 5 net hits is 8, a Body 3 soak with 1 hit leaves 7", () => {
    const { damageValue } = attackDamage(withHits(7), withHits(2), 3);
    expect(damageValue).toBe(8);
    expect(damageAfterResistance(damageValue, 1)).toBe(7);
  });
});
