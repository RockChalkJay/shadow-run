import { SKILL_NAMES, type CharacterSheet, type Skill } from "@shadow-run/shared";

const ATTRIBUTES = ["body", "agility", "reaction", "strength", "willpower", "logic", "intuition", "charisma"] as const;
const cap = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** What the GM is told about a character, written from the sheet so that the numbers it reads are the sheet's own. */
export function describeCharacter(sheet: CharacterSheet): string {
  const a = sheet.attributes;
  const numbers = [...ATTRIBUTES.map((name) => `${cap(name)} ${a[name]}`), `Edge ${a.edge}`, `Essence ${a.essence}`];
  if (a.magic > 0) numbers.push(`Magic ${a.magic}`);
  if (a.resonance > 0) numbers.push(`Resonance ${a.resonance}`);

  const skills = (Object.keys(SKILL_NAMES) as Skill[])
    .filter((skill) => sheet.skills[skill] !== undefined)
    .map((skill) => `${SKILL_NAMES[skill]} ${sheet.skills[skill]}`);
  const specializations = sheet.specializations.map((s) => `${s.name} (${SKILL_NAMES[s.skill]}, ${s.expertise ? "expertise +3" : "+2"})`);

  const parts = [
    `${cap(sheet.metatype)}.`,
    `${numbers.join(", ")}.`,
    `Initiative: Reaction + Intuition = ${a.reaction + a.intuition}, plus ${sheet.initiativeDice}D6.`,
    skills.length > 0 ? `Skills: ${skills.join(", ")}.` : "No skills.",
  ];
  if (specializations.length > 0) parts.push(`Specializations: ${specializations.join(", ")}.`);
  if (sheet.gear) parts.push(`Gear: ${sheet.gear}`);
  if (sheet.qualities) parts.push(`Qualities: ${sheet.qualities}`);
  if (sheet.notes) parts.push(sheet.notes);
  return parts.join(" ");
}
