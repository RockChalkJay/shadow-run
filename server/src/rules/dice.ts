import type { RollResult } from "@shadow-run/shared";
import type { D6 } from "./rng.js";
import { defaultRuleset, type Ruleset } from "./ruleset.js";

/** Most dice one roll may have. Real pools stay far below it; it stops a mistaken size from exhausting memory. */
export const MAX_POOL = 100;

/** Counts hits and glitches for dice that were already rolled, by app or by hand. */
export function evaluate(dice: readonly number[], rules: Ruleset = defaultRuleset): RollResult {
  const bad = dice.find((d) => !Number.isInteger(d) || d < 1 || d > 6);
  if (bad !== undefined) throw new RangeError(`A die shows 1 to 6, got ${bad}`);
  const hits = dice.filter((d) => d >= rules.hitMinimum).length;
  const ones = dice.filter((d) => d === 1).length;
  const halfOnes =
    rules.glitch.rule === "half_or_more" ? ones * 2 >= dice.length : ones * 2 > dice.length;
  // An empty pool has nothing to glitch.
  const glitch = dice.length > 0 && halfOnes;
  return { dice: [...dice], hits, ones, glitch, criticalGlitch: glitch && hits === 0 };
}

export function rollPool(size: number, d6: D6, rules: Ruleset = defaultRuleset): RollResult {
  if (!Number.isInteger(size) || size < 0 || size > MAX_POOL) {
    throw new RangeError(`Dice pool must be a whole number from 0 to ${MAX_POOL}, got ${size}`);
  }
  return evaluate(Array.from({ length: size }, d6), rules);
}

/** Reads dice a player rolled at the table: "6 5 3 1", "6,5,3,1" or "6531". */
export function parseDice(text: string): number[] {
  const compact = text.replace(/[\s,]+/g, "");
  if (compact === "") throw new RangeError("No dice entered");
  if (!/^[1-6]+$/.test(compact)) throw new RangeError(`Dice must be digits 1 to 6, got "${text.trim()}"`);
  return [...compact].map(Number);
}

/** Indexes of the dice that are not hits, e.g. the ones a Second Chance would reroll. */
export function nonHitIndexes(roll: RollResult, rules: Ruleset = defaultRuleset): number[] {
  return roll.dice.flatMap((d, i) => (d < rules.hitMinimum ? [i] : []));
}

/**
 * Rerolls the dice at `indexes` and recounts. Each index may appear once. Any die may be
 * named, hits included; rules that limit which dice an Edge action rerolls belong to the caller.
 */
export function rerollDice(
  roll: RollResult,
  indexes: readonly number[],
  d6: D6,
  rules: Ruleset = defaultRuleset,
): RollResult {
  if (new Set(indexes).size !== indexes.length) throw new RangeError("A die can be rerolled only once per call");
  const dice = [...roll.dice];
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= dice.length) throw new RangeError(`No die at position ${i}`);
    dice[i] = d6();
  }
  return evaluate(dice, rules);
}

/** Adds `count` freshly rolled dice to a roll and recounts. */
export function addDice(roll: RollResult, count: number, d6: D6, rules: Ruleset = defaultRuleset): RollResult {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`Extra dice must be a whole number, got ${count}`);
  return evaluate([...roll.dice, ...Array.from({ length: count }, d6)], rules);
}
