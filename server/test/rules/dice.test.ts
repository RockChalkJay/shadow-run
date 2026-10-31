import { describe, expect, it } from "vitest";
import {
  addDice,
  defaultRuleset,
  evaluate,
  nonHitIndexes,
  parseDice,
  rerollDice,
  rollPool,
  scriptedD6,
  seededD6,
  type Ruleset,
} from "../../src/rules/index.js";

const strictGlitch: Ruleset = { ...defaultRuleset, glitch: { rule: "more_than_half" } };

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

  it("calls it a glitch when half the dice are ones, with hits still counted", () => {
    const roll = evaluate([1, 1, 1, 6, 6, 6]);
    expect(roll).toMatchObject({ hits: 3, ones: 3, glitch: true, criticalGlitch: false });
  });

  it("needs more than half under the stricter reading of the rule", () => {
    expect(evaluate([1, 1, 1, 6, 6, 6], strictGlitch).glitch).toBe(false);
    expect(evaluate([1, 1, 1, 1, 6, 6], strictGlitch).glitch).toBe(true);
  });

  it("makes a glitch with no hits critical", () => {
    expect(evaluate([1, 1, 1, 2])).toMatchObject({ hits: 0, glitch: true, criticalGlitch: true });
  });

  it("does not glitch on an empty pool", () => {
    expect(evaluate([])).toMatchObject({ hits: 0, glitch: false, criticalGlitch: false });
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

  it("hits about a third of the time, with every face turning up", () => {
    const roll = rollPool(60000, seededD6(42));
    expect(roll.hits / 60000).toBeGreaterThan(0.32);
    expect(roll.hits / 60000).toBeLessThan(0.347);
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const count = roll.dice.filter((d) => d === face).length;
      expect(count).toBeGreaterThan(9000);
      expect(count).toBeLessThan(11000);
    }
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

describe("rerolling and adding dice", () => {
  const start = evaluate([6, 2, 5, 1]);

  it("finds the dice that did not hit", () => {
    expect(nonHitIndexes(start)).toEqual([1, 3]);
  });

  it("rerolls the chosen dice and recounts, leaving the original roll alone", () => {
    const after = rerollDice(start, nonHitIndexes(start), scriptedD6([5, 6]));
    expect(after.dice).toEqual([6, 5, 5, 6]);
    expect(after.hits).toBe(4);
    expect(start.dice).toEqual([6, 2, 5, 1]);
  });

  it("rejects a repeated or missing die", () => {
    expect(() => rerollDice(start, [1, 1], seededD6(1))).toThrow(RangeError);
    expect(() => rerollDice(start, [4], seededD6(1))).toThrow(RangeError);
    expect(() => rerollDice(start, [-1], seededD6(1))).toThrow(RangeError);
  });

  it("adds dice and recounts glitches over the larger pool", () => {
    const after = addDice(evaluate([6, 1]), 2, scriptedD6([1, 1]));
    expect(after).toMatchObject({ dice: [6, 1, 1, 1], hits: 1, ones: 3, glitch: true, criticalGlitch: false });
  });

  it("rejects a negative or fractional number of extra dice", () => {
    expect(() => addDice(start, -1, seededD6(1))).toThrow(RangeError);
    expect(() => addDice(start, 1.5, seededD6(1))).toThrow(RangeError);
  });
});
