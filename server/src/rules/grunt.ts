import type { DamageType, Status } from "@shadow-run/shared";
import { defaultRuleset, type Ruleset } from "./ruleset.js";

/** What a grunt is: the Professional Rating that says how well trained they are, and whether they lead their group. */
export interface GruntProfile {
  professionalRating: number;
  lieutenant: boolean;
}

/**
 * Hits a grunt's Composure test needs. The book leaves the threshold to the GM, so this is the system's own
 * ruling (listed under `unverified` in ruleset.json), not a setting from the book.
 */
export const COMPOSURE_THRESHOLD = 2;

/** A grunt's one condition track: 8 plus half the higher of Body and Willpower, rounded up, plus their rating if they lead. */
export function gruntBoxes(body: number, willpower: number, profile: GruntProfile, rules: Ruleset = defaultRuleset): number {
  const base = rules.conditionMonitor.baseBoxes + Math.ceil(Math.max(body, willpower) / 2);
  return base + (profile.lieutenant ? profile.professionalRating : 0);
}

/** Dice a grunt loses on every test: one per complete pair of boxes filled. */
export function gruntWoundModifier(damage: number, rules: Ruleset = defaultRuleset): number {
  return Math.floor(damage / rules.grunt.woundBoxesPerRow);
}

/** With one track, the damage that hit last decides it: physical leaves them dead, stun just unconscious. */
export function gruntStatus(damage: number, boxes: number, last: DamageType | null): Status {
  if (damage < boxes) return "active";
  return last === "stun" ? "unconscious" : "dead";
}

/** Whether this damage took a grunt, still on their feet, past their Professional Rating for the first time. */
export function passedRating(before: number, after: number, professionalRating: number, standing: boolean): boolean {
  return standing && before <= professionalRating && after > professionalRating;
}

/** Dice a group attack adds to the highest member's pool: one for every odd-numbered member beyond the first. */
export function groupBonusDice(size: number): number {
  return Math.floor((size - 1) / 2);
}
