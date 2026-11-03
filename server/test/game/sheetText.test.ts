import { readFileSync } from "node:fs";
import { SKILL_NAMES } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { demoParty } from "../../src/game/demoParty.js";
import { describeCharacter } from "../../src/game/sheetText.js";

const [kira, doc] = demoParty as [(typeof demoParty)[0], (typeof demoParty)[0]];

describe("describeCharacter", () => {
  it("lists the metatype, every attribute, the initiative and the skills in the book's order", () => {
    expect(describeCharacter(kira)).toBe(
      "Human. Body 5, Agility 6, Reaction 5, Strength 4, Willpower 3, Logic 2, Intuition 4, Charisma 2, Edge 3, Essence 6. Initiative: Reaction + Intuition = 9, plus 1D6. Skills: Athletics 3, Close Combat 4, Firearms 6, Stealth 3. Demo character. Street samurai.",
    );
  });

  it("shows Magic only for someone who has it, and Resonance only for a technomancer", () => {
    expect(describeCharacter(doc)).toContain("Essence 6, Magic 6.");
    expect(describeCharacter(doc)).not.toContain("Resonance");
    expect(describeCharacter({ ...kira, attributes: { ...kira.attributes, resonance: 5 } })).toContain("Essence 6, Resonance 5.");
  });

  it("counts extra initiative dice and lower Essence", () => {
    const text = describeCharacter({ ...kira, initiativeDice: 3, attributes: { ...kira.attributes, essence: 3.5 } });
    expect(text).toContain("Essence 3.5");
    expect(text).toContain("= 9, plus 3D6.");
  });

  it("gives specializations with their bonus, and gear and qualities when there are any", () => {
    const text = describeCharacter({
      ...kira,
      specializations: [{ skill: "firearms", name: "Pistols", expertise: false }, { skill: "closeCombat", name: "Blades", expertise: true }],
      gear: "Ares Predator VI.",
      qualities: "Ambidextrous.",
    });
    expect(text).toContain("Specializations: Pistols (Firearms, +2), Blades (Close Combat, expertise +3).");
    expect(text).toContain("Gear: Ares Predator VI. Qualities: Ambidextrous.");
  });

  it("says so when a character has no skills", () => {
    expect(describeCharacter({ ...kira, skills: {} })).toContain("No skills.");
  });
});

describe("the README", () => {
  it("names every skill key a sheet accepts", () => {
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    for (const key of Object.keys(SKILL_NAMES)) expect(readme, key).toContain(`\`${key}\``);
  });
});
