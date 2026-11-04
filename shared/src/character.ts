import { z } from "zod";

export const DamageType = z.enum(["physical", "stun"]);
export type DamageType = z.infer<typeof DamageType>;

export const HealType = z.enum(["physical", "stun", "overflow"]);
export type HealType = z.infer<typeof HealType>;

/** How a character is being healed. The first three can each be received once per set of injuries. */
export const HealMethod = z.enum(["first_aid", "medkit", "magic", "natural_stun", "natural_physical", "natural_overflow"]);
export type HealMethod = z.infer<typeof HealMethod>;

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

/** What marks a non-player character as a grunt: a nameless member of a group of opposition with one condition track. */
export interface GruntInfo {
  professionalRating: number;
  lieutenant: boolean;
  /** The damage that hit last; with a full track it decides whether the grunt is dead or unconscious. */
  lastDamage: DamageType | null;
}

/** A character as the table sees them: a player character or a non-player one the GM is tracking. */
export interface CharacterView {
  id: string;
  kind: "pc" | "npc";
  name: string;
  monitor: ConditionMonitor;
  status: Status;
  /** Dice lost on every test but damage resistance. */
  woundModifier: number;
  /** Set for a grunt. Its whole condition track is `monitor.physical` out of `monitor.physicalBoxes`; the stun and overflow tracks are unused. */
  grunt?: GruntInfo;
}

/** A player character's Edge points as the players see them. */
export interface EdgeView {
  id: string;
  /** Edge points on hand. */
  points: number;
  /** The Edge attribute, which a session starts with and which Edge above it falls back to. */
  rank: number;
  /** Whether this round's one expenditure of Edge is already used. */
  spentThisRound: boolean;
}
