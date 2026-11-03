import type { PartyMember } from "@shadow-run/shared";

/** Two made-up characters so the game can be tried before real character sheets exist. */
export const demoParty: PartyMember[] = [
  {
    id: "kira",
    name: "Kira",
    body: 5,
    willpower: 3,
    edge: 3,
    sheet:
      "Demo character. Human street samurai. Body 5, Agility 6, Reaction 5, Strength 4, Willpower 3, Logic 2, Intuition 4, Charisma 2, Edge 3. Firearms 6, Close Combat 4, Athletics 3, Stealth 3.",
  },
  {
    id: "doc",
    name: "Doc",
    body: 3,
    willpower: 5,
    edge: 4,
    sheet:
      "Demo character. Elf street mage. Body 3, Agility 3, Reaction 3, Strength 2, Willpower 5, Logic 5, Intuition 4, Charisma 4, Edge 4, Magic 6. Sorcery 6, Conjuring 4, Biotech 3, Perception 3.",
  },
];
