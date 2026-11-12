import { CharacterSheet } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { demoParty } from "../../src/game/demoParty.js";
import { derivedValues, newMonitor } from "../../src/rules/index.js";

const [kira, doc] = demoParty as [(typeof demoParty)[0], (typeof demoParty)[0]];

describe("the record sheet's worked-out boxes", () => {
  it("are worked out from the attributes as the rulebook says", () => {
    // Kira: Body 5, Agility 6, Reaction 5, Strength 4, Willpower 3, Logic 2, Intuition 4, Charisma 2.
    expect(derivedValues(kira)).toEqual({
      initiative: { base: 9, dice: 1 },
      composure: 5,
      judgeIntentions: 7,
      memory: 6,
      liftCarry: 8,
      defenseRating: 5,
      unarmedAttackRating: 9,
      physicalBoxes: 11,
      stunBoxes: 10,
      overflowBoxes: 10,
    });
  });

  it("follows a different character's numbers, not constants", () => {
    // Doc: Body 3, Reaction 3, Strength 2, Willpower 5, Logic 5, Intuition 4, Charisma 4.
    expect(derivedValues(doc)).toMatchObject({ composure: 9, judgeIntentions: 9, memory: 9, liftCarry: 8, unarmedAttackRating: 5, defenseRating: 3 });
  });

  it("adds the rating of the primary armor to Body for Defense Rating, and only the primary", () => {
    const armor = [{ name: "Jacket", rating: 12 }, { name: "Helmet", rating: 1, primary: true }];
    expect(derivedValues({ ...kira, armor }).defenseRating).toBe(6);
    expect(derivedValues({ ...kira, armor: [{ name: "Jacket", rating: 12, primary: true }, { name: "Helmet", rating: 1 }] }).defenseRating).toBe(17);
    expect(derivedValues({ ...kira, armor: [{ name: "Jacket", rating: 12 }] }).defenseRating).toBe(5);
  });

  it("counts the initiative dice on the sheet", () => {
    expect(derivedValues({ ...kira, initiativeDice: 3 }).initiative).toEqual({ base: 9, dice: 3 });
  });

  it("has the condition monitor the game uses for damage", () => {
    const monitor = newMonitor(kira.attributes.body, kira.attributes.willpower);
    expect(derivedValues(kira)).toMatchObject({ physicalBoxes: monitor.physicalBoxes, stunBoxes: monitor.stunBoxes, overflowBoxes: monitor.overflowBoxes });
  });

  it("takes an exported sheet's own attributes, as parsed", () => {
    const sheet = CharacterSheet.parse({ version: 1, id: "x", name: "X", metatype: "troll", attributes: { ...kira.attributes, body: 9, willpower: 2 } });
    expect(derivedValues(sheet)).toMatchObject({ liftCarry: 11, physicalBoxes: 13, stunBoxes: 9 });
  });
});
