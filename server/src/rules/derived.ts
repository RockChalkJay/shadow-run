import type { CharacterSheet } from "@shadow-run/shared";
import { newMonitor } from "./damage.js";
import { defaultRuleset, type Ruleset } from "./ruleset.js";

/**
 * The boxes the record sheet works out from a character's numbers. They are not stored in a sheet, since they follow from it;
 * an export can print them for a reader, and an import ignores them.
 */
export interface DerivedValues {
  /** Reaction + Intuition; the character also rolls `dice` D6 and adds them. */
  initiative: { base: number; dice: number };
  /** Willpower + Charisma. */
  composure: number;
  /** Willpower + Intuition. */
  judgeIntentions: number;
  /** Logic + Intuition. */
  memory: number;
  /** Body + Willpower, the pool for a Lift/Carry test. */
  liftCarry: number;
  /** Body + the rating of the primary armor; Body alone when none is marked primary. */
  defenseRating: number;
  /** Reaction + Strength, at the Close range. */
  unarmedAttackRating: number;
  physicalBoxes: number;
  stunBoxes: number;
  overflowBoxes: number;
}

/**
 * The record sheet's worked-out boxes. Composure, Judge Intentions, Memory and Lift/Carry are the core rulebook's attribute-only
 * tests (printed pp. 67-68), Defense Rating is Body plus armor rating and unarmed Attack Rating is Reaction + Strength (p. 67), and the
 * condition monitor is the one the game already uses for damage. The sheet's Movement and its Matrix and astral initiatives are
 * not worked out here, because their formulas have not been checked against the book.
 */
export function derivedValues(sheet: CharacterSheet, rules: Ruleset = defaultRuleset): DerivedValues {
  const a = sheet.attributes;
  const armor = (sheet.armor ?? []).find((piece) => piece.primary)?.rating ?? 0;
  const monitor = newMonitor(a.body, a.willpower, rules);
  return {
    initiative: { base: a.reaction + a.intuition, dice: sheet.initiativeDice },
    composure: a.willpower + a.charisma,
    judgeIntentions: a.willpower + a.intuition,
    memory: a.logic + a.intuition,
    liftCarry: a.body + a.willpower,
    defenseRating: a.body + armor,
    unarmedAttackRating: a.reaction + a.strength,
    physicalBoxes: monitor.physicalBoxes,
    stunBoxes: monitor.stunBoxes,
    overflowBoxes: monitor.overflowBoxes,
  };
}
