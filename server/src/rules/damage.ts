import { applyDamage as applyDamageWith, damageAfterResistance, statusOf, type ConditionMonitor, type DamageType, type HealType, type Status } from "@shadow-run/shared";
import { defaultRuleset, type Ruleset } from "./ruleset.js";

export type { ConditionMonitor, DamageType, HealType, Status };
export { damageAfterResistance, statusOf };

export function newMonitor(body: number, willpower: number, rules: Ruleset = defaultRuleset): ConditionMonitor {
  for (const [name, value] of [["Body", body], ["Willpower", willpower]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of 1 or more, got ${value}`);
  }
  const { baseBoxes, overflowMultiplier } = rules.conditionMonitor;
  return {
    physicalBoxes: baseBoxes + Math.ceil(body / 2),
    stunBoxes: baseBoxes + Math.ceil(willpower / 2),
    overflowBoxes: body * overflowMultiplier,
    physical: 0,
    stun: 0,
    overflow: 0,
  };
}

/** Dice lost on every test but damage resistance: one per complete row of boxes filled on either monitor. */
export function woundModifier(monitor: ConditionMonitor, rules: Ruleset = defaultRuleset): number {
  const row = rules.woundModifier.boxesPerRow;
  return Math.floor(monitor.physical / row) + Math.floor(monitor.stun / row);
}

/** Dice for the roll that soaks damage: Body alone, since armor is already in the Defense Rating. */
export function damageResistancePool(body: number): number {
  return body;
}

/** Clears up to `boxes` of damage from one track, never below zero. */
export function healDamage(monitor: ConditionMonitor, type: HealType, boxes: number): ConditionMonitor {
  if (!Number.isInteger(boxes) || boxes < 0) throw new RangeError(`Boxes healed must be a whole number, got ${boxes}`);
  return { ...monitor, [type]: Math.max(0, monitor[type] - boxes) };
}

/** Marks damage on the monitor with the ruleset's carry-over rate; see `applyDamage` in the shared code, which the screen uses too. */
export function applyDamage(monitor: ConditionMonitor, type: DamageType, amount: number, rules: Ruleset = defaultRuleset, options: { surviveDeath?: boolean } = {}): ConditionMonitor {
  return applyDamageWith(monitor, type, amount, { stunOverflowPerPhysical: rules.conditionMonitor.stunOverflowPerPhysical }, options);
}
