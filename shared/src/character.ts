import { z } from "zod";

export const DamageType = z.enum(["physical", "stun"]);
export type DamageType = z.infer<typeof DamageType>;

export const HealType = z.enum(["physical", "stun", "overflow"]);
export type HealType = z.infer<typeof HealType>;

export const Status = z.enum(["active", "unconscious", "dead"]);
export type Status = z.infer<typeof Status>;

const count = z.number().int().min(0);

/** A character's health: boxes filled on each track, and how many boxes each track has. */
export const ConditionMonitor = z.object({
  physicalBoxes: count.min(1),
  stunBoxes: count.min(1),
  /** Physical damage past the last physical box; the character dies when all of these are filled. */
  overflowBoxes: count.min(1),
  physical: count,
  stun: count,
  overflow: count,
});
export type ConditionMonitor = z.infer<typeof ConditionMonitor>;

/** A character as the table sees them: a player character or a non-player one the GM is tracking. */
export interface CharacterView {
  id: string;
  kind: "pc" | "npc";
  name: string;
  monitor: ConditionMonitor;
  status: Status;
  /** Dice lost on every test but damage resistance. */
  woundModifier: number;
}
