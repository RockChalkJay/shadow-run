import type { RollResult } from "@shadow-run/shared";
import type { D6 } from "./rng.js";
import { defaultRuleset, type Ruleset } from "./ruleset.js";

/** Most dice one roll may have. Real pools stay far below it; it stops a mistaken size from exhausting memory. */
export const MAX_POOL = 100;

/** Most extra dice exploding 6s may add to one roll, so a die that keeps showing 6 cannot loop forever. */
export const MAX_EXPLOSIONS = 1000;

type Extras = Pick<RollResult, "explosions" | "bonusHits" | "glitchFaces">;

export interface RollOptions {
  /** Roll an extra die for every 6, and again for each 6 that follows. */
  explode?: boolean;
  /** Count 2s toward glitches as well as 1s. */
  glitchFaces?: 1 | 2;
}

const isFace = (d: number) => Number.isInteger(d) && d >= 1 && d <= 6;

const extrasOf = (roll: RollResult): Extras => ({
  explosions: roll.explosions,
  bonusHits: roll.bonusHits,
  glitchFaces: roll.glitchFaces,
});

/** Counts hits and glitches for dice that were already rolled, by app or by hand. */
export function evaluate(dice: readonly number[], rules: Ruleset = defaultRuleset, extras: Extras = {}): RollResult {
  const { explosions = [], bonusHits = 0, glitchFaces = 1 } = extras;
  const bad = [...dice, ...explosions].find((d) => !isFace(d));
  if (bad !== undefined) throw new RangeError(`A die shows 1 to 6, got ${bad}`);
  if (!Number.isInteger(bonusHits) || bonusHits < 0) throw new RangeError(`Bought hits must be a whole number, got ${bonusHits}`);
  if (glitchFaces !== 1 && glitchFaces !== 2) throw new RangeError(`Glitch faces must be 1 or 2, got ${glitchFaces}`);

  const hits = [...dice, ...explosions].filter((d) => d >= rules.hitMinimum).length + bonusHits;
  const glitchDice = dice.filter((d) => d <= glitchFaces).length;
  const overHalf =
    rules.glitch.rule === "half_or_more" ? glitchDice * 2 >= dice.length : glitchDice * 2 > dice.length;
  // An empty pool has nothing to glitch.
  const glitch = dice.length > 0 && overHalf;
  return {
    dice: [...dice],
    hits,
    ones: dice.filter((d) => d === 1).length,
    glitch,
    criticalGlitch: glitch && hits === 0,
    ...(explosions.length > 0 && { explosions: [...explosions] }),
    ...(bonusHits > 0 && { bonusHits }),
    ...(glitchFaces === 2 && { glitchFaces }),
  };
}

function explode(dice: readonly number[], d6: D6): number[] {
  const extra: number[] = [];
  for (const first of dice) {
    for (let face = first; face === 6; ) {
      if (extra.length >= MAX_EXPLOSIONS) throw new RangeError("Too many exploding dice");
      face = d6();
      extra.push(face);
    }
  }
  return extra;
}

export function rollPool(
  size: number,
  d6: D6,
  rules: Ruleset = defaultRuleset,
  options: RollOptions = {},
): RollResult {
  if (!Number.isInteger(size) || size < 0 || size > MAX_POOL) {
    throw new RangeError(`Dice pool must be a whole number from 0 to ${MAX_POOL}, got ${size}`);
  }
  const dice = Array.from({ length: size }, d6);
  const explosions = options.explode ? explode(dice, d6) : [];
  return evaluate(dice, rules, { explosions, glitchFaces: options.glitchFaces });
}

/** The 4-Edge boost that adds the Edge attribute to the pool and makes 6s explode. */
export function rollWithEdgeDice(
  pool: number,
  edgeRank: number,
  d6: D6,
  rules: Ruleset = defaultRuleset,
  options: Omit<RollOptions, "explode"> = {},
): RollResult {
  if (!Number.isInteger(edgeRank) || edgeRank < 0) throw new RangeError(`Edge must be a whole number, got ${edgeRank}`);
  if (!Number.isInteger(pool) || pool < 0) throw new RangeError(`Dice pool must be a whole number, got ${pool}`);
  return rollPool(pool + edgeRank, d6, rules, { ...options, explode: true });
}

/** Reads dice a player rolled at the table: "6 5 3 1", "6,5,3,1" or "6531". */
export function parseDice(text: string): number[] {
  const compact = text.replace(/[\s,]+/g, "");
  if (compact === "") throw new RangeError("No dice entered");
  if (!/^[1-6]+$/.test(compact)) throw new RangeError(`Dice must be digits 1 to 6, got "${text.trim()}"`);
  return [...compact].map(Number);
}

/** Indexes of the dice in the pool that are not hits. */
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
  return evaluate(dice, rules, extrasOf(roll));
}

/** The 4-Edge boost: rerolls every die that is not a hit. Not allowed after a glitch or critical glitch. */
export function rerollFailed(roll: RollResult, d6: D6, rules: Ruleset = defaultRuleset): RollResult {
  if (roll.glitch) throw new RangeError("Failed dice cannot be rerolled after a glitch");
  return rerollDice(roll, nonHitIndexes(roll, rules), d6, rules);
}

/** The 2-Edge boost: adds 1 to a single die. A 6 cannot go higher, so it is refused. */
export function bumpDie(roll: RollResult, index: number, rules: Ruleset = defaultRuleset): RollResult {
  const face = roll.dice[index];
  if (face === undefined) throw new RangeError(`No die at position ${index}`);
  if (face === 6) throw new RangeError("A 6 cannot be raised");
  const dice = [...roll.dice];
  dice[index] = face + 1;
  return evaluate(dice, rules, extrasOf(roll));
}

/** The 3-Edge boost: one extra hit that is not tied to a die. */
export function buyHit(roll: RollResult, rules: Ruleset = defaultRuleset): RollResult {
  return evaluate(roll.dice, rules, { ...extrasOf(roll), bonusHits: (roll.bonusHits ?? 0) + 1 });
}

/** The 5-Edge boost, played on a foe's roll: 2s count toward its glitch as well as 1s. */
export function widenGlitch(roll: RollResult, rules: Ruleset = defaultRuleset): RollResult {
  return evaluate(roll.dice, rules, { ...extrasOf(roll), glitchFaces: 2 });
}
