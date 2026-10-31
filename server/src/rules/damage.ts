import { defaultRuleset, type Ruleset } from "./ruleset.js";

export type DamageType = "physical" | "stun";
export type HealType = DamageType | "overflow";
export type Status = "active" | "unconscious" | "dead";

export interface ConditionMonitor {
  physicalBoxes: number;
  stunBoxes: number;
  /** Physical damage past the last physical box; the character dies when all of these are filled. */
  overflowBoxes: number;
  physical: number;
  stun: number;
  overflow: number;
}

export function newMonitor(body: number, willpower: number, rules: Ruleset = defaultRuleset): ConditionMonitor {
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

/** Either monitor full knocks the character out; filling the overflow kills. */
export function statusOf(monitor: ConditionMonitor): Status {
  if (monitor.overflow >= monitor.overflowBoxes) return "dead";
  if (monitor.physical >= monitor.physicalBoxes || monitor.stun >= monitor.stunBoxes) return "unconscious";
  return "active";
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

/** Damage left after the resistance roll's hits, each of which removes one point. */
export function damageAfterResistance(damageValue: number, resistanceHits: number): number {
  return Math.max(0, damageValue - resistanceHits);
}

function addPhysical(monitor: ConditionMonitor, amount: number): ConditionMonitor {
  const taken = Math.min(amount, monitor.physicalBoxes - monitor.physical);
  return { ...monitor, physical: monitor.physical + taken, overflow: monitor.overflow + (amount - taken) };
}

/** Marks damage on the monitor; stun past the last stun box carries over as physical. */
export function applyDamage(
  monitor: ConditionMonitor,
  type: DamageType,
  amount: number,
  rules: Ruleset = defaultRuleset,
): ConditionMonitor {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`Damage must be a whole number, got ${amount}`);
  if (type === "physical") return addPhysical(monitor, amount);

  const taken = Math.min(amount, monitor.stunBoxes - monitor.stun);
  const filled = { ...monitor, stun: monitor.stun + taken };
  const carried = Math.floor((amount - taken) / rules.conditionMonitor.stunOverflowPerPhysical);
  return carried > 0 ? addPhysical(filled, carried) : filled;
}

/** Clears up to `boxes` of damage from one track, never below zero. */
export function healDamage(monitor: ConditionMonitor, type: HealType, boxes: number): ConditionMonitor {
  if (!Number.isInteger(boxes) || boxes < 0) throw new RangeError(`Boxes healed must be a whole number, got ${boxes}`);
  return { ...monitor, [type]: Math.max(0, monitor[type] - boxes) };
}
