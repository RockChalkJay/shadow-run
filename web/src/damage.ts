import { DEFAULT_SCREEN_RULES, type ConditionMonitor, type DamageType, type ScreenRules } from "@shadow-run/shared";

/** Damage left after the resistance roll's hits, each of which removes one point. */
export const damageAfterResistance = (damageValue: number, hits: number) => Math.max(0, damageValue - hits);

/**
 * Whether this much damage, already resisted, would fill a character's overflow and kill them. It follows the server's
 * rules: physical past the last box goes to overflow, and stun past the last stun box carries over as physical at the
 * ruleset's rate. The server decides; this is so the screen offers Not Dead Yet only for a blow that would kill.
 */
export function wouldKill(monitor: ConditionMonitor, type: DamageType, amount: number, rules: ScreenRules = DEFAULT_SCREEN_RULES): boolean {
  const toPhysical = type === "physical" ? amount : Math.floor(Math.max(0, amount - (monitor.stunBoxes - monitor.stun)) / rules.stunOverflowPerPhysical);
  const overflow = monitor.overflow + Math.max(0, toPhysical - (monitor.physicalBoxes - monitor.physical));
  return overflow >= monitor.overflowBoxes;
}
