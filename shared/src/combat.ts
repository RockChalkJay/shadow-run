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
  professionalRating: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Makes this NPC a grunt, one of a group of nameless opposition: their Professional Rating from 0 to 10. Leave it out for a named character"),
  charisma: z.number().int().min(1).max(20).optional().describe("A grunt's Charisma, for their Composure test. Required with professionalRating"),
  lieutenant: z.boolean().optional().describe("True for the leader of a group of grunts, who has a longer condition track"),
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
  rollId: z.string().min(1).describe("The id of the healing roll, from its ROLL RESULT report in this turn's input"),
  type: HealType.describe("Which track to heal. When a healer treats someone, overflow must be cleared before any other track"),
  boxes: z.number().int().min(1).max(12).describe("How many boxes to heal. The roll's hits must cover them at the rate for this kind of healing"),
  reason: z.string().min(1).describe("What did the healing, e.g. 'Doc's First Aid on Kira'"),
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
  alongside: z
    .array(CharacterRef)
    .max(9)
    .optional()
    .describe(
      "Other grunts attacking the same target in the same way as part of one group attack, besides the attacker. Give the highest pool in the group as attackPool; the system adds the group's bonus dice. Only grunts, and by the rulebook no more than 5 in a group including the attacker",
    ),
  attackRating: z
    .number()
    .int()
    .min(0)
    .max(40)
    .describe("The attacker's Attack Rating with this weapon at this range. For a group, the highest among them; the system adds 1 for each member beyond the first"),
  defenseRating: z.number().int().min(0).max(40).describe("The defender's Defense Rating: their Body plus any armor and other bonuses"),
  stakes: z.string().min(1).describe("What this attack means in the scene, for the players to read"),
  edgeAdvice: z
    .string()
    .min(1)
    .optional()
    .describe("When a player character rolls: whether spending Edge is worth it here, and the real option and its cost, as for request_roll"),
});
export type AttackInput = z.infer<typeof AttackInput>;

const initiativeNumber = z.number().int().min(1).max(20);

/** Someone in a fight, for starting it or joining it. */
export const CombatParticipant = z.object({
  who: CharacterRef.describe("A player character by id, or a non-player character by id (with name, body and willpower the first time)"),
  initiative: z
    .object({
      reaction: initiativeNumber,
      intuition: initiativeNumber,
      dice: z.number().int().min(1).max(5).default(1).describe("Initiative dice, usually 1; at most 5"),
    })
    .optional()
    .describe("Required for a non-player character. Leave it out for a player character: their sheet gives it"),
  edge: z.number().int().min(0).max(7).optional().describe("A named non-player character's Edge, which breaks ties in the order. A grunt's Professional Rating is used instead"),
  group: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Grunts listed in the same call with the same group label roll initiative once and act together, with the numbers of the first one listed. Grunts who join later form a group of their own"),
});
export type CombatParticipant = z.infer<typeof CombatParticipant>;

export const StartCombatInput = z.object({
  participants: z.array(CombatParticipant).min(2).max(30).describe("Everyone taking part in the fight"),
});
export type StartCombatInput = z.infer<typeof StartCombatInput>;

export const JoinCombatInput = z.object({
  participants: z.array(CombatParticipant).min(1).max(10).describe("Those joining a fight already under way"),
});
export type JoinCombatInput = z.infer<typeof JoinCombatInput>;

/** One place in the initiative order: a character, or a group of grunts who act together. */
export const CombatEntry = z.object({
  members: z.array(z.object({ kind: z.enum(["pc", "npc"]), id: z.string(), name: z.string() })).min(1),
  /** Set for a group of grunts. */
  group: z.string().optional(),
  score: z.number().int(),
  reaction: z.number().int(),
  intuition: z.number().int(),
  dice: z.number().int().min(1),
  /** The initiative dice as rolled. */
  rolls: z.array(z.number().int().min(1).max(6)),
  /** Breaks ties: a character's Edge, or a grunt's Professional Rating. */
  edge: z.number().int().min(0),
  /** The coin that settles a tie nothing else does, fixed when the entry was made. */
  coin: z.number().min(0).max(1),
  major: z.number().int().min(1),
  minor: z.number().int().min(1),
});
export type CombatEntry = z.infer<typeof CombatEntry>;

/** A fight in progress. The order is rolled once and stands from round to round. */
export const CombatState = z.object({
  round: z.number().int().min(1),
  /** Highest initiative first. */
  order: z.array(CombatEntry),
});
export type CombatState = z.infer<typeof CombatState>;

/** The GM awards a player character one point of Edge for something that earned it in a confrontation. */
export const AwardEdgeInput = z.object({
  characterId: z.string().describe("The id of the player character who earned the Edge"),
  reason: z.string().min(5).max(300).describe("What earned it: a brilliant, funny or decisive move, or a clear advantage in the confrontation. The players read this"),
});
export type AwardEdgeInput = z.infer<typeof AwardEdgeInput>;
