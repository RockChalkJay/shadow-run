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
  }),
  woundModifier: z.object({ boxesPerDie: z.number().int().min(1) }),
  damageResistance: z.object({ pool: z.enum(["body_plus_armor", "body"]) }),
  initiative: z.object({
    maxDice: z.number().int().min(1),
    majorActions: z.number().int().min(1),
    baseMinorActions: z.number().int().min(0),
    minorActionsPerDie: z.number().int().min(0),
  }),
  /** Rules that came from conflicting or single secondary sources; check them against the rulebook. */
  unverified: z.array(z.string()),
});
export type Ruleset = z.infer<typeof Ruleset>;

export function loadRuleset(file = new URL("../data/sr6/ruleset.json", import.meta.url)): Ruleset {
  return Ruleset.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const defaultRuleset: Ruleset = loadRuleset();
