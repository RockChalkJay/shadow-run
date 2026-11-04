import type { CharacterSheet } from "@shadow-run/shared";

/** Two made-up characters so the table can be tried before real ones exist. */
export const demoParty: CharacterSheet[] = [
  {
    version: 1,
    id: "kira",
    name: "Kira",
    metatype: "human",
    attributes: { body: 5, agility: 6, reaction: 5, strength: 4, willpower: 3, logic: 2, intuition: 4, charisma: 2, edge: 3, essence: 6, magic: 0, resonance: 0 },
    initiativeDice: 1,
    skills: { firearms: 6, closeCombat: 4, athletics: 3, stealth: 3 },
    specializations: [],
    gear: "",
    qualities: "",
    notes: "Demo character. Street samurai.",
  },
  {
    version: 1,
    id: "doc",
    name: "Doc",
    metatype: "elf",
    attributes: { body: 3, agility: 3, reaction: 3, strength: 2, willpower: 5, logic: 5, intuition: 4, charisma: 4, edge: 4, essence: 6, magic: 6, resonance: 0 },
    initiativeDice: 1,
    skills: { sorcery: 6, conjuring: 4, biotech: 3, perception: 3 },
    specializations: [],
    gear: "",
    qualities: "",
    notes: "Demo character. Street mage.",
  },
];
