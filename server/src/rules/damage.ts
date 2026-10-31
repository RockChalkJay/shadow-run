import { defaultRuleset, type Ruleset } from "./ruleset.js";

export type DamageType = "physical" | "stun";
export type Status = "active" | "unconscious" | "dying" | "dead";

export interface ConditionMonitor {
  physicalBoxes: number;
  stunBoxes: number;
  physical: number;
  stun: number;
  /** Physical damage past the last box; death comes when it exceeds Body. */
  overflow: number;
  body: number;
}

export function newMonitor(body: number, willpower: number, rules: Ruleset = defaultRuleset): ConditionMonitor {
  const { baseBoxes } = rules.conditionMonitor;
  return {
    physicalBoxes: baseBoxes + Math.ceil(body / 2),
    stunBoxes: baseBoxes + Math.ceil(willpower / 2),
    physical: 0,
    stun: 0,
    overflow: 0,
    body,
  };
}

export function statusOf(monitor: ConditionMonitor): Status {
  if (monitor.overflow > monitor.body) return "dead";
  if (monitor.physical >= monitor.physicalBoxes) return "dying";
  if (monitor.stun >= monitor.stunBoxes) return "unconscious";
  return "active";
}

/** Dice lost on every test, from boxes filled on both tracks. Not applied to damage resistance. */
export function woundModifier(monitor: ConditionMonitor, rules: Ruleset = defaultRuleset): number {
  return Math.floor((monitor.physical + monitor.stun) / rules.woundModifier.boxesPerDie);
}

/** Dice for the roll that soaks damage. */
export function damageResistancePool(body: number, armor: number, rules: Ruleset = defaultRuleset): number {
  return rules.damageResistance.pool === "body_plus_armor" ? body + armor : body;
}

/** Damage left after the resistance roll's hits, each of which removes one point. */
export function damageAfterResistance(damageValue: number, resistanceHits: number): number {
  return Math.max(0, damageValue - resistanceHits);
}

/** Physical damage that does not beat the armor lands as stun. */
export function resolveDamageType(base: DamageType, damageValue: number, armor: number): DamageType {
  return base === "physical" && damageValue <= armor ? "stun" : base;
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
