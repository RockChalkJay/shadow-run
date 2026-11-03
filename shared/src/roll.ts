import { z } from "zod";
import { DamageType, HealMethod } from "./character.js";

/** Most dice one roll may have. Real pools stay far below it; it stops a mistaken size from exhausting memory. */
export const MAX_POOL = 100;

/** What the GM supplies when it asks a player to roll. The server adds the id. */
export const RollRequestInput = z.object({
  characterId: z.string().describe("Id of the character who rolls"),
  label: z.string().describe("The action being attempted, e.g. 'Sneak past the guard'"),
  pool: z.object({
    total: z.number().int().min(1).max(MAX_POOL).describe("Number of d6 to roll"),
    breakdown: z.string().describe("How the pool was built, e.g. 'Agility 5 + Sneaking 4 + 1 gear'"),
  }),
  threshold: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Hits needed on a simple test (1 or more). Leave out for an opposed test"),
  opposed: z
    .object({
      by: z.string().describe("Who or what opposes the roll"),
      pool: z.number().int().min(0).max(MAX_POOL).describe("Opponent's dice pool, rolled by the system"),
      role: z
        .enum(["acting", "defending"])
        .default("acting")
        .describe("'acting' if the roller takes the action, 'defending' if the opponent does and the roller resists"),
    })
    .optional(),
  stakes: z.string().describe("What is on the line for this roll"),
  goodRoll: z.string().describe("What counts as a good roll here"),
  badRoll: z.string().describe("What counts as a bad roll here"),
  consequences: z.object({
    success: z.string(),
    failure: z.string(),
    glitch: z.string(),
    criticalGlitch: z.string(),
  }),
  edgeAdvice: z.string().describe("Whether and how to spend Edge on this roll"),
  healing: z
    .object({
      method: HealMethod.describe(
        "'first_aid', 'medkit' or 'magic' (a healing spell) for a healer treating a patient, or 'natural_stun', 'natural_physical' or 'natural_overflow' for the patient's own recovery",
      ),
      patient: z.object({ kind: z.enum(["pc", "npc"]), id: z.string() }).describe("Who is being healed"),
      essence: z
        .number()
        .min(0)
        .max(6)
        .default(6)
        .describe("The patient's Essence: 6 with no cyberware or bioware, less with it. Sets the difficulty; ignored for natural recovery"),
    })
    .optional()
    .describe("Set only when this roll is an attempt to heal. The system sets the threshold, so leave it out; after the roll, spend the result with the heal tool"),
});
export type RollRequestInput = z.infer<typeof RollRequestInput>;

/** What the GM supplies when a non-player character rolls. The system rolls the dice. */
export const NpcRollInput = z.object({
  label: z.string().min(1).describe("Who is rolling and why, e.g. 'Ganger sprays the doorway'"),
  pool: z.number().int().min(0).max(MAX_POOL).describe("Number of d6"),
  threshold: z.number().int().min(1).optional().describe("Hits needed, if the roll is against a fixed threshold"),
});
export type NpcRollInput = z.infer<typeof NpcRollInput>;

/** A weapon as the GM describes it for one attack. */
export const Weapon = z.object({
  name: z.string().min(1).max(60).describe("The weapon, e.g. 'Ares Predator VI' or 'combat knife'"),
  damageValue: z.number().int().min(1).max(40).describe("The weapon's base Damage Value, e.g. 3 for a 3P heavy pistol"),
  damageType: DamageType.describe("'physical' or 'stun'"),
});
export type Weapon = z.infer<typeof Weapon>;

export const RollRequest = RollRequestInput.extend({
  id: z.string(),
  /** Set when the pool was cut by this many dice for wounds. */
  woundPenalty: z.number().int().min(1).optional(),
  /** Set when this roll is an attempt to heal; the system worked out the difficulty from the patient's Essence. */
  healing: z
    .object({
      method: HealMethod,
      patient: z.object({ kind: z.enum(["pc", "npc"]), id: z.string(), name: z.string() }),
      essence: z.number().min(0).max(6),
      /** Hits the roll needs before any count toward healing; 0 for natural recovery. */
      threshold: z.number().int().min(0),
      /** A free hit added to the roll, for a fully natural patient. */
      autoHit: z.boolean(),
    })
    .optional(),
  /**
   * Set when this roll is one side of an attack: the player's attack roll or their defense roll. The system
   * rolls the other side when the player answers, then works out the damage.
   */
  attack: z
    .object({
      /** Which side the player is on. */
      role: z.enum(["attacker", "defender"]),
      weapon: Weapon,
      /** The other side, whom the system rolls for. */
      other: z.object({ kind: z.literal("npc"), id: z.string(), name: z.string() }),
    })
    .optional(),
  /** Set when this roll is a character resisting damage: each hit removes one point of it. */
  soak: z
    .object({
      damageValue: z.number().int().min(1),
      damageType: DamageType,
      /** What caused the damage, for the report. */
      source: z.string(),
    })
    .optional(),
});
export type RollRequest = z.infer<typeof RollRequest>;

/** The dice of one roll, in the order rolled, and what they add up to. */
export interface RollResult {
  /** The dice pool, in the order rolled. */
  dice: number[];
  /** Hits on the pool, plus hits on `explosions`, plus `bonusHits`. */
  hits: number;
  /** Dice in the pool showing 1. */
  ones: number;
  glitch: boolean;
  /** A glitch with no hits. */
  criticalGlitch: boolean;
  /** Extra dice rolled for exploding 6s. They can hit but never count toward a glitch. */
  explosions?: number[];
  /** Hits bought with Edge. */
  bonusHits?: number;
  /** Highest face that counts toward a glitch; 2 when a foe spent Edge to widen it. */
  glitchFaces?: 1 | 2;
}

const face = z.number().int().min(1).max(6);

export const RollResultSchema = z.object({
  dice: z.array(face),
  hits: z.number().int().min(0),
  ones: z.number().int().min(0),
  glitch: z.boolean(),
  criticalGlitch: z.boolean(),
  explosions: z.array(face).optional(),
  bonusHits: z.number().int().min(0).optional(),
  glitchFaces: z.union([z.literal(1), z.literal(2)]).optional(),
}) satisfies z.ZodType<RollResult>;

export const RollOutcome = z.object({
  success: z.boolean(),
  /** Hits beyond the threshold, or over the opponent's hits. */
  netHits: z.number().int().min(0),
  glitch: z.boolean(),
  criticalGlitch: z.boolean(),
  /** The consequence the GM declared in advance for this result. */
  consequence: z.string(),
  /** The glitch or critical glitch consequence, when the roll glitched. */
  glitchConsequence: z.string().optional(),
});
export type RollOutcome = z.infer<typeof RollOutcome>;

/** A roll request after the dice were counted and the opposition, if any, rolled by the system. */
export const ResolvedRoll = z.object({
  request: RollRequest,
  source: z.enum(["app", "physical"]),
  roll: RollResultSchema,
  opposed: z
    .object({
      by: z.string(),
      pool: z.number().int().min(0),
      role: z.enum(["acting", "defending"]),
      roll: RollResultSchema,
    })
    .optional(),
  outcome: RollOutcome,
});
export type ResolvedRoll = z.infer<typeof ResolvedRoll>;
