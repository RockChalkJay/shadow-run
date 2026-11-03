import { randomInt } from "node:crypto";
import { defaultRuleset, type Ruleset } from "./ruleset.js";
import type { D6 } from "./rng.js";

export interface InitiativeRoll {
  score: number;
  rolls: number[];
}

/** Reaction + Intuition + the initiative dice, rolled once at the start of an encounter. */
export function rollInitiative(
  attrs: { reaction: number; intuition: number; dice: number },
  d6: D6,
  rules: Ruleset = defaultRuleset,
): InitiativeRoll {
  const { dice } = attrs;
  if (!Number.isInteger(dice) || dice < 1 || dice > rules.initiative.maxDice) {
    throw new RangeError(`Initiative dice must be 1 to ${rules.initiative.maxDice}, got ${dice}`);
  }
  const rolls = Array.from({ length: dice }, d6);
  return { score: attrs.reaction + attrs.intuition + rolls.reduce((a, b) => a + b, 0), rolls };
}

/** Major actions, and minor actions: a base amount plus one for each initiative die. */
export function actionsFor(dice: number, rules: Ruleset = defaultRuleset): { major: number; minor: number } {
  const { majorActions, baseMinorActions, minorActionsPerDie } = rules.initiative;
  return { major: majorActions, minor: baseMinorActions + minorActionsPerDie * dice };
}

export interface TurnEntry {
  score: number;
  /** The Edge attribute, not the points on hand. */
  edge: number;
  reaction: number;
  intuition: number;
}

/** A number in [0, 1) used to break a tie that no attribute settles. */
export type Flip = () => number;

export const cryptoFlip: Flip = () => randomInt(0, 2 ** 30) / 2 ** 30;

/**
 * Highest score first. Equal scores go to the higher Edge, then Reaction, then Intuition;
 * entries still equal after that are put in a random order.
 */
export function turnOrder<T extends TurnEntry>(entries: readonly T[], flip: Flip = cryptoFlip): T[] {
  return entries
    .map((entry) => ({ entry, coin: flip() }))
    .sort(
      (a, b) =>
        b.entry.score - a.entry.score ||
        b.entry.edge - a.entry.edge ||
        b.entry.reaction - a.entry.reaction ||
        b.entry.intuition - a.entry.intuition ||
        a.coin - b.coin,
    )
    .map(({ entry }) => entry);
}
