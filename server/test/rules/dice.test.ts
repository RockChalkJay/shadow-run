import { describe, expect, it } from "vitest";
import {
  bumpDie,
  buyHit,
  defaultRuleset,
  evaluate,
  MAX_EXPLOSIONS,
  MAX_POOL,
  nonHitIndexes,
  parseDice,
  rerollDice,
  rerollFailed,
  rollPool,
  rollWithEdgeDice,
  scriptedD6,
  seededD6,
  widenGlitch,
  type Ruleset,
} from "../../src/rules/index.js";

const halfOrMore: Ruleset = { ...defaultRuleset, glitch: { rule: "half_or_more" } };

describe("evaluate", () => {
  it("counts 5s and 6s as hits and 1s as ones", () => {
    expect(evaluate([6, 5, 3, 1, 1, 2])).toEqual({
      dice: [6, 5, 3, 1, 1, 2],
      hits: 2,
      ones: 2,
      glitch: false,
      criticalGlitch: false,
    });
  });

  it("calls it a glitch only when more than half the dice are ones, with hits still counted", () => {
    expect(evaluate([1, 1, 1, 6, 6, 6]).glitch).toBe(false);
    const roll = evaluate([1, 1, 1, 1, 6, 6]);
    expect(roll).toMatchObject({ hits: 2, ones: 4, glitch: true, criticalGlitch: false });
  });

  it("can be switched to half or more", () => {
    expect(evaluate([1, 1, 1, 6, 6, 6], halfOrMore).glitch).toBe(true);
  });

  it("makes a glitch with no hits critical", () => {
    expect(evaluate([1, 1, 1, 2])).toMatchObject({ hits: 0, glitch: true, criticalGlitch: true });
  });

  it("does not glitch on an empty pool", () => {
    expect(evaluate([])).toMatchObject({ hits: 0, glitch: false, criticalGlitch: false });
  });

  it.each([[[9]], [[0]], [[2.5]], [[NaN]], [[6, 7, 1]]])("rejects dice that are not 1 to 6: %j", (dice) => {
    expect(() => evaluate(dice)).toThrow(RangeError);
  });

  it("does not change the array it was given", () => {
    const dice = [6, 1];
    evaluate(dice).dice.push(3);
    expect(dice).toEqual([6, 1]);
  });
});

describe("rollPool", () => {
  it("rolls the pool in order from the dice source", () => {
    expect(rollPool(3, scriptedD6([6, 1, 5])).dice).toEqual([6, 1, 5]);
  });

  it("rejects a pool that is not a whole, non-negative number", () => {
    expect(() => rollPool(-1, seededD6(1))).toThrow(RangeError);
    expect(() => rollPool(2.5, seededD6(1))).toThrow(RangeError);
  });

  it("allows the largest pool and refuses a bigger one", () => {
    expect(rollPool(MAX_POOL, seededD6(1)).dice).toHaveLength(MAX_POOL);
    expect(() => rollPool(MAX_POOL + 1, seededD6(1))).toThrow(RangeError);
    expect(() => rollPool(1_000_000_000, seededD6(1))).toThrow(RangeError);
  });

  it("refuses a dice source that returns a face off the die", () => {
    expect(() => rollPool(2, () => 7)).toThrow(RangeError);
  });

  it("hits about a third of the time, with every face turning up", () => {
    const roll = evaluate(Array.from({ length: 60000 }, seededD6(42)));
    expect(roll.hits / 60000).toBeGreaterThan(0.32);
    expect(roll.hits / 60000).toBeLessThan(0.347);
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const count = roll.dice.filter((d) => d === face).length;
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }
  });
});

describe("exploding 6s", () => {
  it("rolls another die for each 6, and again for each new 6, and counts every 5 or 6 among them as a hit", () => {
    // Pool 6,2,6: the first 6 explodes into 6 then 3; the second 6 explodes into 5.
    const roll = rollPool(3, scriptedD6([6, 2, 6, 6, 3, 5]), defaultRuleset, { explode: true });
    expect(roll.dice).toEqual([6, 2, 6]);
    expect(roll.explosions).toEqual([6, 3, 5]);
    expect(roll.hits).toBe(2 + 2);
  });

  it("does not count a 1 on an exploded die toward a glitch, or the exploded dice in the pool", () => {
    // Four pool dice with two 1s is not more than half; counting the two exploded 1s would make it a glitch.
    const roll = rollPool(4, scriptedD6([1, 1, 6, 6, 1, 1]), defaultRuleset, { explode: true });
    expect(roll.explosions).toEqual([1, 1]);
    expect(roll).toMatchObject({ ones: 2, hits: 2, glitch: false });
  });

  it("adds the Edge attribute to the pool and explodes", () => {
    // A pool of 9 with Edge 5 is 14 dice.
    const faces = [6, 6, 5, 2, 3, 1, 4, 2, 3, 4, 2, 3, 1, 4, /* explosions */ 6, 3, 5];
    const roll = rollWithEdgeDice(9, 5, scriptedD6(faces));
    expect(roll.dice).toHaveLength(14);
    expect(roll.explosions).toEqual([6, 3, 5]);
    expect(roll.hits).toBe(3 + 2);
  });

  it("stops a die that keeps showing 6 from looping forever", () => {
    expect(() => rollPool(1, () => 6, defaultRuleset, { explode: true })).toThrow("Too many exploding dice");
    expect(MAX_EXPLOSIONS).toBeGreaterThan(100);
  });

  it("rejects a negative or fractional Edge or pool", () => {
    expect(() => rollWithEdgeDice(5, -1, seededD6(1))).toThrow(RangeError);
    expect(() => rollWithEdgeDice(5.5, 2, seededD6(1))).toThrow(RangeError);
  });
});

describe("dice sources", () => {
  it("seededD6 repeats for the same seed and stays on the die", () => {
    const a = Array.from({ length: 50 }, seededD6(7));
    const b = Array.from({ length: 50 }, seededD6(7));
    expect(a).toEqual(b);
    expect(a.every((d) => d >= 1 && d <= 6 && Number.isInteger(d))).toBe(true);
  });

  it("scriptedD6 refuses to invent a face", () => {
    const d6 = scriptedD6([3]);
    expect(d6()).toBe(3);
    expect(() => d6()).toThrow("ran out");
  });
});

describe("parseDice", () => {
  it.each(["6 5 3 1", "6,5,3,1", "6, 5, 3, 1", "6531", " 6  5 3\t1 "])("reads %j", (text) => {
    expect(parseDice(text)).toEqual([6, 5, 3, 1]);
  });

  it.each(["", "   ", "7", "0", "10", "6 5 x", "1.5"])("rejects %j", (text) => {
    expect(() => parseDice(text)).toThrow(RangeError);
  });
});

describe("rerolling", () => {
  const start = evaluate([6, 2, 5, 1]);

  it("finds the dice that did not hit", () => {
    expect(nonHitIndexes(start)).toEqual([1, 3]);
  });

  it("rerolls the chosen dice and recounts, leaving the original roll alone", () => {
    const after = rerollDice(start, [1, 3], scriptedD6([5, 6]));
    expect(after.dice).toEqual([6, 5, 5, 6]);
    expect(after.hits).toBe(4);
    expect(start.dice).toEqual([6, 2, 5, 1]);
  });

  it("rejects a repeated or missing die", () => {
    expect(() => rerollDice(start, [1, 1], seededD6(1))).toThrow(RangeError);
    expect(() => rerollDice(start, [4], seededD6(1))).toThrow(RangeError);
    expect(() => rerollDice(start, [-1], seededD6(1))).toThrow(RangeError);
  });

  it("rerolls every failed die", () => {
    const after = rerollFailed(start, scriptedD6([5, 6]));
    expect(after.dice).toEqual([6, 5, 5, 6]);
  });

  it("refuses to reroll failed dice after a glitch or critical glitch", () => {
    expect(() => rerollFailed(evaluate([1, 1, 1, 6]), seededD6(1))).toThrow("glitch");
    expect(() => rerollFailed(evaluate([1, 1, 1, 2]), seededD6(1))).toThrow("glitch");
  });

  it("keeps explosions and bought hits when dice are rerolled", () => {
    const roll = buyHit(rollPool(2, scriptedD6([6, 2, 5]), defaultRuleset, { explode: true }));
    const after = rerollDice(roll, [1], scriptedD6([4]));
    expect(after).toMatchObject({ explosions: [5], bonusHits: 1 });
  });
});

describe("other Edge boosts on a roll", () => {
  it("raises one die by 1 so a 4 becomes a hit", () => {
    const after = bumpDie(evaluate([4, 2]), 0);
    expect(after.dice).toEqual([5, 2]);
    expect(after.hits).toBe(1);
  });

  it("raises a 1 to a 2 to avoid a glitch", () => {
    expect(evaluate([1, 1, 1, 3]).glitch).toBe(true);
    expect(bumpDie(evaluate([1, 1, 1, 3]), 0).glitch).toBe(false);
  });

  it("will not raise a 6 or a die that is not there", () => {
    expect(() => bumpDie(evaluate([6]), 0)).toThrow("cannot be raised");
    expect(() => bumpDie(evaluate([3]), 5)).toThrow(RangeError);
  });

  it("buys a hit that counts in the total and turns a critical glitch into a plain glitch", () => {
    const crit = evaluate([1, 1, 1, 2]);
    expect(crit.criticalGlitch).toBe(true);
    const bought = buyHit(crit);
    expect(bought).toMatchObject({ hits: 1, bonusHits: 1, glitch: true, criticalGlitch: false });
    expect(buyHit(bought).hits).toBe(2);
  });

  it("counts 2s toward a foe's glitch as well as 1s", () => {
    const foe = evaluate([1, 2, 2, 6]);
    expect(foe.glitch).toBe(false);
    const widened = widenGlitch(foe);
    expect(widened).toMatchObject({ glitch: true, criticalGlitch: false, glitchFaces: 2, ones: 1 });
    expect(widenGlitch(evaluate([1, 2, 2, 3])).criticalGlitch).toBe(true);
  });
});
