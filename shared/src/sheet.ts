import { z } from "zod";

export const Metatype = z.enum(["human", "elf", "dwarf", "ork", "troll"]);
export type Metatype = z.infer<typeof Metatype>;

/** The core rulebook's skills (PDF pp. 94-98), as the keys a sheet uses and the names the GM reads. */
export const SKILL_NAMES = {
  astral: "Astral",
  athletics: "Athletics",
  biotech: "Biotech",
  closeCombat: "Close Combat",
  con: "Con",
  conjuring: "Conjuring",
  cracking: "Cracking",
  electronics: "Electronics",
  enchanting: "Enchanting",
  engineering: "Engineering",
  exoticWeapons: "Exotic Weapons",
  firearms: "Firearms",
  influence: "Influence",
  outdoors: "Outdoors",
  perception: "Perception",
  piloting: "Piloting",
  sorcery: "Sorcery",
  stealth: "Stealth",
  tasking: "Tasking",
} as const;
export const Skill = z.enum(Object.keys(SKILL_NAMES) as [keyof typeof SKILL_NAMES, ...Array<keyof typeof SKILL_NAMES>]);
export type Skill = z.infer<typeof Skill>;

const attribute = z.number().int().min(1).max(20);

/** The numbers the character is built from, exactly as they stand now, with any metatype or augmentation already counted. */
export const Attributes = z.strictObject({
  body: attribute,
  agility: attribute,
  reaction: attribute,
  strength: attribute,
  willpower: attribute,
  logic: attribute,
  intuition: attribute,
  charisma: attribute,
  edge: z.number().int().min(0).max(7),
  /** 6 with no cyberware or bioware, less with it; it sets how hard the character is to heal. */
  essence: z.number().min(0).max(6),
  magic: z.number().int().min(0).max(20).default(0),
  resonance: z.number().int().min(0).max(20).default(0),
});
export type Attributes = z.infer<typeof Attributes>;

/** A character sheet: what the character is. How hurt they are is kept separately, in the game's state. */
export const CharacterSheet = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/, "ids are lowercase letters, digits, - or _"),
  name: z.string().min(1).max(60),
  metatype: Metatype,
  attributes: Attributes,
  /** Initiative dice, 1 unless augmentations or magic add more; the book allows at most 5. */
  initiativeDice: z.number().int().min(1).max(5).default(1),
  /** Ranks in each skill the character has; a skill that is left out means no ranks. */
  skills: z.partialRecord(Skill, z.number().int().min(1).max(12)).default({}),
  /** A specialization adds 2 dice to the skill in its area; an expertise adds 3. */
  specializations: z
    .array(z.strictObject({ skill: Skill, name: z.string().min(1).max(60), expertise: z.boolean().default(false) }))
    .default([]),
  gear: z.string().max(4000).default(""),
  qualities: z.string().max(2000).default(""),
  notes: z.string().max(4000).default(""),
});
export type CharacterSheet = z.infer<typeof CharacterSheet>;

export const Party = z
  .array(CharacterSheet)
  .min(1)
  .refine((party) => new Set(party.map((m) => m.id)).size === party.length, "character ids must be unique");
export type Party = z.infer<typeof Party>;
