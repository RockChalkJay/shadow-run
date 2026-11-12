import { z } from "zod";
import { DamageType } from "./character.js";

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

/** Free text on a sheet: a short name or a note. */
const label = z.string().trim().min(1).max(120);
const note = z.string().max(300);
/** The most entries any one list on a sheet may hold, so a sheet stays a size the GM can be told about. */
const MAX_ENTRIES = 50;
const entries = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_ENTRIES);
const wholeNumber = z.number().int().min(0).max(99);

/** The personal data box of the record sheet. Every part is optional; `metatype` is kept on the sheet itself. */
export const PersonalData = z.strictObject({
  ethnicity: z.string().max(60).optional(),
  age: z.string().max(30).optional(),
  sex: z.string().max(30).optional(),
  height: z.string().max(30).optional(),
  weight: z.string().max(30).optional(),
  reputation: wholeNumber.optional(),
  heat: wholeNumber.optional(),
  karma: z.number().int().min(0).max(9999).optional(),
  totalKarma: z.number().int().min(0).max(9999).optional(),
  misc: note.optional(),
});
export type PersonalData = z.infer<typeof PersonalData>;

/** A Knowledge or Language skill, which the book's list of skills does not cover. */
export const KnowledgeSkill = z.strictObject({
  name: label,
  rating: z.number().int().min(1).max(12),
  type: z.enum(["knowledge", "language"]).default("knowledge"),
});
export type KnowledgeSkill = z.infer<typeof KnowledgeSkill>;

export const Quality = z.strictObject({
  name: label,
  rating: wholeNumber.optional(),
  notes: note.optional(),
  type: z.enum(["positive", "negative"]).optional(),
});
export type Quality = z.infer<typeof Quality>;

export const Contact = z.strictObject({
  name: label,
  loyalty: z.number().int().min(0).max(12),
  connection: z.number().int().min(0).max(12),
  notes: note.optional(),
});
export type Contact = z.infer<typeof Contact>;

/** The IDs, lifestyles and currency box. */
export const Lifestyle = z.strictObject({
  primary: z.string().max(120).optional(),
  nuyen: z.number().int().min(0).max(1_000_000_000).optional(),
  licenses: z.string().max(300).optional(),
  fakeIds: z.array(z.string().max(300)).max(MAX_ENTRIES).optional(),
});
export type Lifestyle = z.infer<typeof Lifestyle>;

/** A weapon's Damage Value and whether it is physical or stun. */
export const WeaponDamage = z.strictObject({ value: z.number().int().min(0).max(40), type: DamageType });
export type WeaponDamage = z.infer<typeof WeaponDamage>;

/** The Attack Rating at each range; a range left out is one the weapon cannot reach. */
const attackRating = z.number().int().min(0).max(40).optional();

export const RangedWeapon = z.strictObject({
  name: label,
  damage: WeaponDamage,
  mode: z.string().max(30).optional(),
  ranges: z.strictObject({ close: attackRating, near: attackRating, far: attackRating, extreme: attackRating }).optional(),
  ammo: z.string().max(60).optional(),
  notes: note.optional(),
  /** The weapon the sheet's Core Combat Info shows. At most one ranged weapon is primary. */
  primary: z.boolean().optional(),
});
export type RangedWeapon = z.infer<typeof RangedWeapon>;

export const MeleeWeapon = z.strictObject({
  name: label,
  damage: WeaponDamage,
  close: attackRating,
  notes: note.optional(),
  primary: z.boolean().optional(),
});
export type MeleeWeapon = z.infer<typeof MeleeWeapon>;

export const Armor = z.strictObject({
  name: label,
  rating: z.number().int().min(0).max(40),
  notes: note.optional(),
  primary: z.boolean().optional(),
});
export type Armor = z.infer<typeof Armor>;

export const Augmentation = z.strictObject({
  name: label,
  rating: wholeNumber.optional(),
  notes: note.optional(),
  /** The Essence it costs. */
  essence: z.number().min(0).max(6).optional(),
});
export type Augmentation = z.infer<typeof Augmentation>;

export const GearItem = z.strictObject({ name: label, rating: wholeNumber.optional(), notes: note.optional() });
export type GearItem = z.infer<typeof GearItem>;

const matrixRating = z.number().int().min(0).max(30).optional();

/** The Matrix stats box: the deck's four ratings, its devices and its programs. */
export const MatrixStats = z.strictObject({
  attack: matrixRating,
  sleaze: matrixRating,
  dataProcessing: matrixRating,
  firewall: matrixRating,
  devices: entries(z.strictObject({ name: label, rating: wholeNumber.optional() })).optional(),
  programs: entries(label).optional(),
});
export type MatrixStats = z.infer<typeof MatrixStats>;

const vehicleStat = z.string().max(30).optional();

export const Vehicle = z.strictObject({
  name: label,
  handling: vehicleStat,
  acceleration: vehicleStat,
  speedInterval: vehicleStat,
  topSpeed: vehicleStat,
  body: vehicleStat,
  armor: vehicleStat,
  pilot: vehicleStat,
  sensor: vehicleStat,
  seats: vehicleStat,
  notes: note.optional(),
});
export type Vehicle = z.infer<typeof Vehicle>;

/** A spell, preparation, ritual or complex form, as the sheet's S/P/R/CF box lists them. */
export const Spell = z.strictObject({
  name: label,
  kind: z.enum(["spell", "preparation", "ritual", "complexForm"]),
  typeTarget: z.string().max(60).optional(),
  range: z.string().max(60).optional(),
  duration: z.string().max(60).optional(),
  drain: z.string().max(60).optional(),
});
export type Spell = z.infer<typeof Spell>;

/** An adept power or other ability. */
export const Ability = z.strictObject({ name: label, level: wholeNumber.optional(), notes: note.optional() });
export type Ability = z.infer<typeof Ability>;

/** The most runs a sheet's history may list. */
export const MAX_HISTORY = 100;

/** One run the character has been on: what it was, when, who was in it, and what came of it. */
export const RunEntry = z.strictObject({
  /** Counts from 1, in the order the runs were played. */
  run: z.number().int().min(1).max(999),
  /** When it ended, as the table writes dates (YYYY-MM-DD). */
  date: z.string().trim().min(1).max(40),
  /** The campaign it was played in. */
  campaign: z.string().max(60).optional(),
  summary: z.string().trim().min(1).max(600),
  goal: note.optional(),
  /** The other characters in it. */
  with: z.array(label).max(12).optional(),
  consequences: note.optional(),
});
export type RunEntry = z.infer<typeof RunEntry>;

/** The lists on a sheet that mark one entry as primary. */
const PRIMARY_LISTS = ["rangedWeapons", "meleeWeapons", "armor"] as const;

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
  /** The sheet's Gear list: items, or free text as older sheets have it. */
  gear: z.union([z.string().max(4000), entries(GearItem)]).default(""),
  /** The sheet's Qualities list: entries, or free text as older sheets have it. */
  qualities: z.union([z.string().max(2000), entries(Quality)]).default(""),
  notes: z.string().max(4000).default(""),
  /** The sections below are the rest of the record sheet. All are optional, so a sheet written before they existed is still valid. */
  player: z.string().max(60).optional(),
  personal: PersonalData.optional(),
  knowledge: entries(KnowledgeSkill).optional(),
  contacts: entries(Contact).optional(),
  lifestyle: Lifestyle.optional(),
  rangedWeapons: entries(RangedWeapon).optional(),
  meleeWeapons: entries(MeleeWeapon).optional(),
  armor: entries(Armor).optional(),
  augmentations: entries(Augmentation).optional(),
  matrix: MatrixStats.optional(),
  vehicles: entries(Vehicle).optional(),
  spells: entries(Spell).optional(),
  abilities: entries(Ability).optional(),
  /** Who the character was before the game began. Written by the owner; the game never changes it. */
  backstory: z.string().max(4000).optional(),
  /** The runs the character has been on, oldest first. */
  history: z.array(RunEntry).max(MAX_HISTORY).optional(),
}).superRefine((sheet, ctx) => {
  for (const list of PRIMARY_LISTS) {
    if ((sheet[list] ?? []).filter((entry) => entry.primary).length > 1) {
      ctx.addIssue({ code: "custom", path: [list], message: "only one entry may be primary" });
    }
  }
});
export type CharacterSheet = z.infer<typeof CharacterSheet>;

export const Party = z
  .array(CharacterSheet)
  .min(1)
  .refine((party) => new Set(party.map((m) => m.id)).size === party.length, "character ids must be unique");
export type Party = z.infer<typeof Party>;
