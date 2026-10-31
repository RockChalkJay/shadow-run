import { defaultRuleset, type Ruleset } from "./ruleset.js";
import type { D6 } from "./rng.js";

export interface InitiativeRoll {
  score: number;
  rolls: number[];
}

/** Reaction + Intuition + the initiative dice. */
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

export function actionsFor(dice: number, rules: Ruleset = defaultRuleset): { major: number; minor: number } {
  const { majorActions, baseMinorActions, minorActionsPerDie } = rules.initiative;
  return { major: majorActions, minor: baseMinorActions + minorActionsPerDie * dice };
}

/** Highest score first; entries with equal scores keep the order they came in. */
export function turnOrder<T extends { score: number }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.score - a.score);
}
