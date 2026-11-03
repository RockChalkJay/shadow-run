import { z } from "zod";

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
});
export type RollRequestInput = z.infer<typeof RollRequestInput>;

export const RollRequest = RollRequestInput.extend({ id: z.string() });
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
