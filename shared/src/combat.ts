import { z } from "zod";
import { DamageType, HealType } from "./character.js";
import { MAX_POOL, Weapon } from "./roll.js";

const id = z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/, "ids are lowercase letters, digits, - or _");

/** Who is being hurt or healed: a player character, or a non-player character the GM names. */
export const CharacterRef = z.object({
  kind: z.enum(["pc", "npc"]).describe("'pc' for a player character, 'npc' for anyone else"),
  id: id.describe("A player character's id, or a short id you choose for an NPC, e.g. 'ganger-1'"),
  name: z.string().min(1).max(60).optional().describe("An NPC's name. Required the first time you mention an NPC"),
  body: z.number().int().min(1).max(20).optional().describe("An NPC's Body. Required the first time you mention an NPC"),
  willpower: z.number().int().min(1).max(20).optional().describe("An NPC's Willpower. Required the first time you mention an NPC"),
});
export type CharacterRef = z.infer<typeof CharacterRef>;

export const DealDamageInput = z.object({
  label: z.string().min(1).describe("What does the harm, e.g. 'Falls two floors onto the loading dock'"),
  target: CharacterRef,
  damageValue: z.number().int().min(1).max(40).describe("The Damage Value before the target resists"),
  damageType: DamageType.describe("'physical' or 'stun'"),
});
export type DealDamageInput = z.infer<typeof DealDamageInput>;

export const HealInput = z.object({
  target: CharacterRef,
  type: HealType.describe("Which track to heal; overflow is healed first and brings a character back from the brink"),
  boxes: z.number().int().min(1).max(12).describe("How many boxes to heal, no more than the hits that earned it"),
  reason: z.string().min(1).describe("What did the healing, e.g. 'Doc's First Aid, 3 net hits'"),
});
export type HealInput = z.infer<typeof HealInput>;

const AttackPool = z.object({
  total: z.number().int().min(1).max(MAX_POOL).describe("Number of d6"),
  breakdown: z.string().describe("How the pool was built, e.g. 'Agility 5 + Firearms 6 + 1 smartlink'"),
});

/** One attack between two characters, at least one of them a non-player character. */
export const AttackInput = z.object({
  label: z.string().min(1).describe("What happens, e.g. 'Kira shoots the ganger on the stairs'"),
  attacker: CharacterRef,
  defender: CharacterRef,
  weapon: Weapon,
  attackPool: AttackPool.describe("The attacker's pool: the weapon skill plus Agility, adjusted for gear and conditions"),
  defensePool: AttackPool.describe("The defender's pool: Reaction plus Intuition, adjusted for cover, surprise and conditions"),
  stakes: z.string().min(1).describe("What this attack means in the scene, for the players to read"),
});
export type AttackInput = z.infer<typeof AttackInput>;
