import { readFileSync } from "node:fs";
import { z } from "zod";

/** The numbers the engine plays by. Kept in a JSON file so a table can correct any of them. */
export const Ruleset = z.object({
  hitMinimum: z.number().int().min(2).max(6),
  glitch: z.object({ rule: z.enum(["half_or_more", "more_than_half"]) }),
  edge: z.object({
    max: z.number().int().min(1),
    maxGainPerRound: z.number().int().min(1),
    ratingGapForEdge: z.number().int().min(1),
  }),
  conditionMonitor: z.object({
    baseBoxes: z.number().int().min(1),
    stunOverflowPerPhysical: z.number().int().min(1),
    /** Overflow boxes, as a multiple of Body; the character dies when they are all filled. */
    overflowMultiplier: z.number().int().min(1),
  }),
  woundModifier: z.object({ boxesPerRow: z.number().int().min(1) }),
  initiative: z.object({
    maxDice: z.number().int().min(1),
    majorActions: z.number().int().min(1),
    baseMinorActions: z.number().int().min(0),
    minorActionsPerDie: z.number().int().min(0),
  }),
  /** Where each setting is in the core rulebook PDF, keyed by the setting's path, so any value can be checked. */
  pages: z.record(z.string(), z.string()),
  /** Rules the engine applies in code rather than as a setting, with their rulebook PDF pages. */
  rulesInCode: z.record(z.string(), z.string()),
  /** Rulings the engine makes where the book is silent. */
  unverified: z.array(z.string()),
});
export type Ruleset = z.infer<typeof Ruleset>;

export function loadRuleset(file = new URL("../data/sr6/ruleset.json", import.meta.url)): Ruleset {
  return Ruleset.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const defaultRuleset: Ruleset = loadRuleset();
