import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterSheet } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { demoParty } from "../src/game/demoParty.js";
import { characterJsonSchema } from "../src/game/characterSchema.js";
import { describeCharacter } from "../src/game/sheetText.js";
import { CampaignStore } from "../src/game/store.js";

const read = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const example = () => read("../../docs/character-example.json");
const [kira] = demoParty as [(typeof demoParty)[0]];

describe("a character sheet with the record sheet's sections", () => {
  it("accepts the documented example, which uses every section", async () => {
    const sheet = CharacterSheet.parse(await example());
    for (const key of ["personal", "knowledge", "contacts", "lifestyle", "rangedWeapons", "meleeWeapons", "armor", "augmentations", "matrix", "vehicles", "spells", "abilities", "backstory", "history"] as const) {
      expect(sheet[key], key).toBeDefined();
    }
    expect(Array.isArray(sheet.gear) && Array.isArray(sheet.qualities)).toBe(true);
  });

  it("still accepts a sheet written before the sections existed, and adds nothing to it", () => {
    const old = { version: 1, id: "old", name: "Old", metatype: "human", attributes: kira.attributes, gear: "A knife.", qualities: "Lucky." };
    const parsed = CharacterSheet.parse(old);
    expect(parsed.gear).toBe("A knife.");
    expect(parsed.qualities).toBe("Lucky.");
    for (const key of ["personal", "contacts", "rangedWeapons", "armor", "matrix"]) expect(parsed, key).not.toHaveProperty(key);
  });

  it("takes gear and qualities as text or as a list, and nothing else", async () => {
    const base = await example();
    expect(CharacterSheet.safeParse({ ...base, gear: "Just text." }).success).toBe(true);
    expect(CharacterSheet.safeParse({ ...base, qualities: [{ name: "Lucky" }] }).success).toBe(true);
    expect(CharacterSheet.safeParse({ ...base, gear: 5 }).success).toBe(false);
    expect(CharacterSheet.safeParse({ ...base, gear: ["a knife"] }).success).toBe(false);
  });

  it.each([
    ["a misspelled field inside a section", { contacts: [{ name: "X", loyalty: 1, connection: 1, notez: "y" }] }],
    ["a contact rated past the book's 12", { contacts: [{ name: "X", loyalty: 13, connection: 1 }] }],
    ["a weapon that does neither physical nor stun damage", { rangedWeapons: [{ name: "X", damage: { value: 5, type: "fire" } }] }],
    ["a spell of an unknown kind", { spells: [{ name: "X", kind: "curse" }] }],
    ["a quality that is neither positive nor negative", { qualities: [{ name: "X", type: "neutral" }] }],
    ["a knowledge skill with no rating", { knowledge: [{ name: "X" }] }],
    ["more entries than a list may hold", { abilities: Array.from({ length: 51 }, (_, i) => ({ name: `Power ${i}` })) }],
    ["an unknown section", { pets: [] }],
    ["a run with no summary", { history: [{ run: 1, date: "2081-03-14" }] }],
    ["a run numbered 0", { history: [{ run: 0, date: "2081-03-14", summary: "s" }] }],
    ["a misspelled field in a run", { history: [{ run: 1, date: "2081-03-14", summary: "s", sumary: "x" }] }],
    ["a run with 13 companions", { history: [{ run: 1, date: "d", summary: "s", with: Array.from({ length: 13 }, (_, i) => `P${i}`) }] }],
    ["more runs than a history may hold", { history: Array.from({ length: 101 }, (_, i) => ({ run: i + 1, date: "d", summary: "s" })) }],
    ["a backstory past 4,000 characters", { backstory: "x".repeat(4001) }],
  ])("refuses %s", async (_what, over) => {
    expect(CharacterSheet.safeParse({ ...(await example()), ...over }).success).toBe(false);
  });

  it.each(["rangedWeapons", "meleeWeapons", "armor"] as const)("allows at most one primary entry in %s", async (list) => {
    const base = await example();
    const entry = base[list][0];
    expect(CharacterSheet.safeParse({ ...base, [list]: [{ ...entry, primary: true }, { ...entry, name: "Another", primary: false }] }).success).toBe(true);
    const twice = CharacterSheet.safeParse({ ...base, [list]: [{ ...entry, primary: true }, { ...entry, name: "Another", primary: true }] });
    expect(twice.success).toBe(false);
    expect(JSON.stringify(twice.error?.issues)).toContain("only one entry may be primary");
  });
});

describe("a character's backstory and history", () => {
  it("are optional, so a sheet without them is as valid as before", async () => {
    const { backstory: _b, history: _h, ...without } = await example();
    const parsed = CharacterSheet.parse(without);
    expect(parsed).not.toHaveProperty("backstory");
    expect(parsed).not.toHaveProperty("history");
  });

  it("tell the GM the backstory, cut to 600 characters", async () => {
    const sheet = CharacterSheet.parse(await example());
    expect(describeCharacter(sheet)).toContain("Backstory: Raised in Tacoma, joined the Eastside Kings at fourteen and left them at nineteen after a job went wrong.");
    const long = describeCharacter({ ...sheet, backstory: "x".repeat(900) });
    expect(long).toContain(`Backstory: ${"x".repeat(599)}…`);
    expect(long).not.toContain("x".repeat(601));
  });

  it("tell the GM the previous runs, oldest first, and say so when there are earlier ones", async () => {
    const sheet = CharacterSheet.parse(await example());
    expect(describeCharacter(sheet)).toContain("Previous runs: Run 1 in night-one (2081-03-14): Carried a case across the sprawl for Mr. Smith. Came of it: Paid 3,000 nuyen; earned 4 Karma.");
    const runs = Array.from({ length: 8 }, (_, i) => ({ run: i + 1, date: `2081-04-0${i + 1}`, summary: `Run ${i + 1} went on.` }));
    const text = describeCharacter({ ...sheet, history: runs });
    expect(text).toContain("Run 4 (2081-04-04): Run 4 went on.; Run 5 (2081-04-05): Run 5 went on.; Run 6 (2081-04-06): Run 6 went on.; Run 7 (2081-04-07): Run 7 went on.; Run 8 (2081-04-08): Run 8 went on.; 3 earlier runs not shown.");
    expect(text).not.toContain("Run 3 (");
    expect(describeCharacter({ ...sheet, history: runs.slice(0, 6) })).toContain("1 earlier run not shown.");
  });

  it("are left out of what the GM is told when empty", async () => {
    const text = describeCharacter({ ...CharacterSheet.parse(await example()), backstory: "  ", history: [] });
    expect(text).not.toContain("Backstory");
    expect(text).not.toContain("Previous runs");
  });

  it("trim a long run summary the way every other note is trimmed", async () => {
    const text = describeCharacter({ ...CharacterSheet.parse(await example()), history: [{ run: 1, date: "d", summary: "x".repeat(500), consequences: "y".repeat(300) }] });
    expect(text).not.toContain("x".repeat(121));
    expect(text).not.toContain("y".repeat(121));
  });
});

describe("loading a character from disk", () => {
  async function loaded(sheet: object) {
    const dir = await mkdtemp(join(tmpdir(), "sr-sheet-"));
    await mkdir(join(dir, "characters"));
    await writeFile(join(dir, "characters", "razor.json"), JSON.stringify(sheet));
    return new CampaignStore(dir).loadParty();
  }

  it("reads a sheet with the new sections", async () => {
    const party = await loaded(await example());
    expect(party?.[0]?.rangedWeapons?.[0]?.name).toBe("Ares Predator VI");
  });

  it("names the file and the section when one is wrong", async () => {
    await expect(loaded({ ...(await example()), armor: [{ name: "Jacket", rating: "twelve" }] })).rejects.toThrow(/razor\.json is not a valid character sheet[\s\S]*armor/);
  });
});

describe("what the GM is told", () => {
  it("is unchanged for a sheet with text gear and qualities and none of the new sections", () => {
    expect(describeCharacter({ ...kira, gear: "Ares Predator VI.", qualities: "Ambidextrous." })).toContain("Gear: Ares Predator VI. Qualities: Ambidextrous. Demo character. Street samurai.");
  });

  it("includes each section of the example, briefly", async () => {
    const text = describeCharacter(CharacterSheet.parse(await example()));
    expect(text).toContain("Gear: Commlink 3; Medkit 3 (Half used).");
    expect(text).toContain("Qualities: Ambidextrous [positive]; Distinctive Style 1 (Easy to remember) [negative].");
    expect(text).toContain("Personal: ethnicity Salish, age 29, sex male, height 2.0 m, weight 110 kg, reputation 2, heat 1, karma 6, total karma 24, Scar over the left eye.");
    expect(text).toContain("Knowledge and languages: Seattle gangs 3; Or'zet 2 (language).");
    expect(text).toContain("Ranged weapons: Ares Predator VI (primary) DV 8P, SA, Attack Rating close 10, near 9, far 6, extreme 3, ammo 15(c); Defiance EX Shocker DV 7S, SS, Attack Rating close 8, near 6, ammo 4(m).");
    expect(text).toContain("Melee weapons: Combat axe (primary) DV 7P, Attack Rating 9.");
    expect(text).toContain("Armor: Armor jacket (primary) 12; Helmet 1 (Adds to the jacket).");
    expect(text).toContain("Augmentations: Cybereyes 2 (Low-light, flare compensation), Essence 0.2.");
    expect(text).toContain("Abilities: Killing Hands 1 (Adept power).");
    expect(text).toContain("Matrix: Attack 0, Sleaze 1, Data Processing 3, Firewall 3; devices Commlink 3; programs Encryption.");
    expect(text).toContain("Vehicles: Americar (Handling 4/4, Speed 140, Body 10, Armor 6, Pilot 1, Seats 4).");
    expect(text).toContain("Contacts: Mama Rose (Loyalty 3, Connection 2): Runs the noodle stand; hears everything.");
    expect(text).toContain("Money and IDs: Low lifestyle, 2300 nuyen, licenses: Firearms, concealed carry, fake IDs: Rating 3 SIN: Dale Hart.");
  });

  it("says nothing about a section that is empty or missing", async () => {
    const text = describeCharacter({ ...CharacterSheet.parse(await example()), contacts: [], personal: {}, matrix: {}, lifestyle: {}, spells: [] });
    for (const word of ["Contacts", "Personal", "Matrix", "Money and IDs", "Spells"]) expect(text, word).not.toContain(word);
  });

  it("trims a long note, wherever it is written, so one sheet cannot swamp the prompt", () => {
    const long = "x".repeat(300);
    const text = describeCharacter({
      ...kira,
      contacts: [{ name: "A", loyalty: 1, connection: 1, notes: long }],
      armor: [{ name: "B", rating: 1, notes: long }],
      rangedWeapons: [{ name: "C", damage: { value: 1, type: "physical" }, notes: long }],
      abilities: [{ name: "D", notes: long }],
      personal: { misc: long },
      lifestyle: { licenses: long, fakeIds: [long] },
      gear: [{ name: "E", notes: long }],
    });
    expect(text).not.toContain("x".repeat(121));
    expect(text).toContain(`${"x".repeat(119)}…`);
    expect(text.length).toBeLessThan(1800);
  });

  it("ends a line with one full stop, whether or not the last note was written with one", () => {
    const text = describeCharacter({ ...kira, contacts: [{ name: "Fixer", loyalty: 1, connection: 1, notes: "Sells her jobs." }], personal: { misc: "Scarred." } });
    expect(text).toContain("Personal: Scarred. Contacts: Fixer (Loyalty 1, Connection 1): Sells her jobs. Demo character.");
    expect(text).not.toContain("..");
  });

  it("tells a spellcaster's spells and complex forms", () => {
    const text = describeCharacter({ ...kira, spells: [{ name: "Stunbolt", kind: "spell", typeTarget: "Combat, direct", range: "LOS", duration: "Instantaneous", drain: "F-3" }] });
    expect(text).toContain("Spells and complex forms: Stunbolt (spell, Combat, direct, LOS, Instantaneous, drain F-3).");
  });

  it("counts the entries it leaves out of a long list, so a long list cannot swamp the prompt", () => {
    const contacts = Array.from({ length: 20 }, (_, i) => ({ name: `Contact ${i + 1}`, loyalty: 1, connection: 1 }));
    const text = describeCharacter({ ...kira, contacts });
    expect(text).toContain("Contact 15 (Loyalty 1, Connection 1); and 5 more.");
    expect(text).not.toContain("Contact 16");
  });
});

describe("the JSON Schema for a character file", () => {
  it("is current: docs/character.schema.json matches the definition the server checks with", async () => {
    const committed = await readFile(new URL("../../docs/character.schema.json", import.meta.url), "utf8");
    expect(committed, "run `npm run character:schema` and commit the result").toBe(characterJsonSchema());
  });
});
