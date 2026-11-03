import { z } from "zod";

/**
 * A player character as the table needs it before full character sheets exist: the two attributes
 * that size the condition monitors, the Edge rank, and free text for the GM.
 */
export const PartyMember = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/, "ids are lowercase letters, digits, - or _"),
  name: z.string().min(1).max(60),
  body: z.number().int().min(1).max(20),
  willpower: z.number().int().min(1).max(20),
  edge: z.number().int().min(0).max(7),
  /** What the GM knows about the character: attributes, skills, gear, backstory. */
  sheet: z.string().max(8000),
});
export type PartyMember = z.infer<typeof PartyMember>;

export const Party = z
  .array(PartyMember)
  .min(1)
  .refine((party) => new Set(party.map((m) => m.id)).size === party.length, "character ids must be unique");
export type Party = z.infer<typeof Party>;
