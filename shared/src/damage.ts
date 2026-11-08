import type { ConditionMonitor, DamageType, Status } from "./character.js";
import type { ScreenRules } from "./protocol.js";

/** What the damage arithmetic needs of the ruleset: just this one number, so the browser need not load the whole thing. */
export type DamageRules = Pick<ScreenRules, "stunOverflowPerPhysical">;

/** Either monitor full knocks the character out; filling the overflow kills. */
export function statusOf(monitor: ConditionMonitor): Status {
  if (monitor.overflow >= monitor.overflowBoxes) return "dead";
  if (monitor.physical >= monitor.physicalBoxes || monitor.stun >= monitor.stunBoxes) return "unconscious";
  return "active";
}

/** Damage left after the resistance roll's hits, each of which removes one point. */
export function damageAfterResistance(damageValue: number, resistanceHits: number): number {
  return Math.max(0, damageValue - resistanceHits);
}

function addPhysical(monitor: ConditionMonitor, amount: number): ConditionMonitor {
  const taken = Math.min(amount, monitor.physicalBoxes - monitor.physical);
  return { ...monitor, physical: monitor.physical + taken, overflow: monitor.overflow + (amount - taken) };
}

function markDamage(monitor: ConditionMonitor, type: DamageType, amount: number, rules: DamageRules): ConditionMonitor {
  if (type === "physical") return addPhysical(monitor, amount);
  const taken = Math.min(amount, monitor.stunBoxes - monitor.stun);
  const filled = { ...monitor, stun: monitor.stun + taken };
  const carried = Math.floor((amount - taken) / rules.stunOverflowPerPhysical);
  return carried > 0 ? addPhysical(filled, carried) : filled;
}

/**
 * Marks damage on the monitor; stun past the last stun box carries over as physical at the ruleset's rate. With
 * `surviveDeath`, damage that would fill the overflow stops one box short of it, so the character is left dying instead
 * of dead. The server applies damage with this, and the screen asks `wouldKill`, so the two cannot disagree.
 */
export function applyDamage(monitor: ConditionMonitor, type: DamageType, amount: number, rules: DamageRules, options: { surviveDeath?: boolean } = {}): ConditionMonitor {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`Damage must be a whole number, got ${amount}`);
  const marked = markDamage(monitor, type, amount, rules);
  if (!options.surviveDeath || marked.overflow < marked.overflowBoxes) return marked;
  return { ...marked, overflow: marked.overflowBoxes - 1 };
}

/** Whether this much damage, already resisted, would kill a character as they stand. */
export function wouldKill(monitor: ConditionMonitor, type: DamageType, amount: number, rules: DamageRules): boolean {
  return statusOf(applyDamage(monitor, type, amount, rules)) === "dead";
}
