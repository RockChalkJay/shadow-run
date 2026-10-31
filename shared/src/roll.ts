import { z } from "zod";

/** What the GM supplies when it asks a player to roll. The server adds the id. */
export const RollRequestInput = z.object({
  characterId: z.string().describe("Id of the character who rolls"),
  label: z.string().describe("The action being attempted, e.g. 'Sneak past the guard'"),
  pool: z.object({
    total: z.number().int().min(1).describe("Number of d6 to roll"),
    breakdown: z.string().describe("How the pool was built, e.g. 'Agility 5 + Sneaking 4 + 1 gear'"),
  }),
  threshold: z.number().int().min(0).optional().describe("Hits needed on a simple test"),
  opposed: z
    .object({
      by: z.string().describe("Who or what opposes the roll"),
      pool: z.number().int().min(0).describe("Opponent's dice pool, rolled server-side"),
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
  dice: number[];
  hits: number;
  ones: number;
  glitch: boolean;
  /** A glitch with no hits. */
  criticalGlitch: boolean;
}
