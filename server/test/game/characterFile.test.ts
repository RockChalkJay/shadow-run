import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterSheet } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { characterFileText, exportCharacters, importCharacters, parseExportArgs, parseImportArgs, placeDirectory, readCharacterFile, refuseRebuiltFolder } from "../../src/game/characterFile.js";
import { demoParty } from "../../src/game/demoParty.js";
import { loadScenario } from "../../src/game/scenario.js";
import { CampaignStore } from "../../src/game/store.js";

const example = async () => await readFile(new URL("../../../docs/character-example.json", import.meta.url), "utf8");
const exampleSheet = async () => CharacterSheet.parse(JSON.parse(await example()));
const folder = async () => mkdtemp(join(tmpdir(), "sr-chars-"));
const idsIn = async (dir: string) => (await readdir(join(dir, "characters"))).sort();

async function campaignWith(sheets: CharacterSheet[]) {
  const dir = await folder();
  await new CampaignStore(dir).saveParty(sheets);
  return dir;
}

describe("exporting characters", () => {
  it("gives the sheet as the game reads it, which can be put straight back as a character file", async () => {
    const sheet = await exampleSheet();
    const text = characterFileText(sheet);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(sheet)));
    expect(CharacterSheet.parse(JSON.parse(text))).toEqual(sheet);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("adds the worked-out boxes only when asked", async () => {
    const sheet = await exampleSheet();
    expect(JSON.parse(characterFileText(sheet))).not.toHaveProperty("derived");
    const withBoxes = JSON.parse(characterFileText(sheet, { derived: true }));
    expect(withBoxes.derived).toMatchObject({ composure: 5, memory: 6, defenseRating: 18, initiative: { base: 8, dice: 2 } });
  });

  it("reads one character or all of them from a campaign folder", async () => {
    const dir = await campaignWith([...demoParty]);
    expect((await exportCharacters({ dir })).map((s) => s.id)).toEqual(["doc", "kira"]);
    expect((await exportCharacters({ dir, id: "kira" })).map((s) => s.id)).toEqual(["kira"]);
  });

  it("names the characters there are when the one asked for is not there, and says when there are none", async () => {
    const dir = await campaignWith([...demoParty]);
    await expect(exportCharacters({ dir, id: "razor" })).rejects.toThrow('There is no character "razor"');
    await expect(exportCharacters({ dir, id: "razor" })).rejects.toThrow("It has: doc, kira.");
    await expect(exportCharacters({ dir: await folder() })).rejects.toThrow(/has no character sheets/);
  });
});

describe("reading a character file", () => {
  it("accepts the example, and one that an export added the worked-out boxes to", async () => {
    const sheet = await exampleSheet();
    expect(readCharacterFile({ name: "razor.json", text: await example() })).toEqual(sheet);
    expect(readCharacterFile({ name: "razor.json", text: characterFileText(sheet, { derived: true }) })).toEqual(sheet);
  });

  it("keeps the old text gear and qualities as they are", () => {
    const text = JSON.stringify({ version: 1, id: "old", name: "Old", metatype: "human", attributes: demoParty[0]!.attributes, gear: "A knife.", qualities: "Lucky." });
    expect(readCharacterFile({ name: "old.json", text })).toMatchObject({ gear: "A knife.", qualities: "Lucky." });
  });

  it("says which file is not JSON, and which is not a sheet and where", async () => {
    expect(() => readCharacterFile({ name: "bad.json", text: "{ nope" })).toThrow(/^bad\.json is not valid JSON/);
    const wrong = JSON.stringify({ ...JSON.parse(await example()), contacts: [{ name: "X", loyalty: 99, connection: 1 }] });
    expect(() => readCharacterFile({ name: "razor.json", text: wrong })).toThrow(/^razor\.json is not a valid character sheet[\s\S]*contacts/);
    expect(() => readCharacterFile({ name: "list.json", text: "[1]" })).toThrow(/^list\.json is not a valid character sheet/);
  });

  it("still refuses a field it does not know, whatever else was dropped", async () => {
    const text = JSON.stringify({ ...JSON.parse(await example()), derived: { composure: 1 }, pets: [] });
    expect(() => readCharacterFile({ name: "razor.json", text })).toThrow(/pets/);
  });
});

describe("importing characters", () => {
  it("writes each as characters/<id>.json, which the game then loads", async () => {
    const dir = await folder();
    const result = await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir });
    expect(result).toMatchObject({ written: true, problems: [] });
    expect(await idsIn(dir)).toEqual(["razor.json"]);
    expect((await new CampaignStore(dir).loadParty())?.[0]).toEqual(await exampleSheet());
  });

  it("round trips: exported files import to the same characters", async () => {
    const from = await campaignWith([await exampleSheet(), ...demoParty]);
    const exported = (await exportCharacters({ dir: from })).map((sheet) => ({ name: `${sheet.id}.json`, text: characterFileText(sheet, { derived: true }) }));
    const to = await folder();
    await importCharacters({ sources: exported, dir: to });
    expect(await new CampaignStore(to).loadParty()).toEqual(await new CampaignStore(from).loadParty());
  });

  it("writes none when any file is wrong, and lists every problem", async () => {
    const dir = await folder();
    const result = await importCharacters({ sources: [{ name: "razor.json", text: await example() }, { name: "a.json", text: "{ nope" }, { name: "b.json", text: "[]" }], dir });
    expect(result.written).toBe(false);
    expect(result.problems).toHaveLength(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses two files for one character", async () => {
    const dir = await folder();
    const result = await importCharacters({ sources: [{ name: "one.json", text: await example() }, { name: "two.json", text: await example() }], dir });
    expect(result.problems).toEqual(['two.json holds the character "razor", which one.json also holds']);
    expect(result.written).toBe(false);
  });

  it("will not replace a character that is there unless told to", async () => {
    const dir = await campaignWith([await exampleSheet()]);
    const changed = JSON.stringify({ ...JSON.parse(await example()), name: "Razor Two" });
    const refused = await importCharacters({ sources: [{ name: "razor.json", text: changed }], dir });
    expect(refused.problems).toEqual([expect.stringContaining("razor is already in")]);
    expect((await new CampaignStore(dir).loadParty())?.[0]?.name).toBe("Razor");

    const forced = await importCharacters({ sources: [{ name: "razor.json", text: changed }], dir, force: true });
    expect(forced.written).toBe(true);
    expect((await new CampaignStore(dir).loadParty())?.[0]?.name).toBe("Razor Two");
  });

  it("will not replace a file that is there but is not a valid sheet, unless told to", async () => {
    const dir = await folder();
    await mkdir(join(dir, "characters"));
    await writeFile(join(dir, "characters", "razor.json"), "{ half edited");
    const refused = await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir });
    expect(refused).toMatchObject({ written: false, problems: [expect.stringContaining("razor is already in")] });
    expect(await readFile(join(dir, "characters", "razor.json"), "utf8")).toBe("{ half edited");
    expect((await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir, force: true })).written).toBe(true);
  });

  it("leaves the other characters in the folder alone", async () => {
    const dir = await campaignWith([...demoParty]);
    await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir });
    expect(await idsIn(dir)).toEqual(["doc.json", "kira.json", "razor.json"]);
  });

  it("checks and reports without writing, with or without problems", async () => {
    const dir = await folder();
    const fine = await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir, check: true });
    expect(fine).toMatchObject({ written: false, problems: [] });
    expect(fine.sheets).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
    const bad = await importCharacters({ sources: [{ name: "a.json", text: "x" }], dir, check: true });
    expect(bad.problems).toHaveLength(1);
  });

  it("imports into a scenario, which is then a start for a game", async () => {
    const root = await folder();
    const scenarios = join(root, "scenarios");
    const dir = placeDirectory({ scenario: "ambush" }, { campaignsDir: join(root, "campaigns"), scenariosDir: scenarios });
    await importCharacters({ sources: [{ name: "razor.json", text: await example() }], dir });
    const into = join(root, "campaigns", "scenario-ambush");
    await loadScenario({ scenariosDir: scenarios, name: "ambush", into });
    expect((await new CampaignStore(into).loadParty())?.[0]?.id).toBe("razor");
  });
});

describe("where an import or export goes", () => {
  const dirs = { campaignsDir: "/c", scenariosDir: "/s" };

  it("is the default campaign unless a campaign or a scenario is named", () => {
    expect(placeDirectory({}, dirs)).toBe("/c/default");
    expect(placeDirectory({ campaign: "night-one" }, dirs)).toBe("/c/night-one");
    expect(placeDirectory({ scenario: "ambush" }, dirs)).toBe("/s/ambush");
  });

  it("refuses a name that could point anywhere", () => {
    expect(() => placeDirectory({ campaign: "../x" }, dirs)).toThrow(/campaign name/);
    expect(() => placeDirectory({ scenario: "a/b" }, dirs)).toThrow(/scenario name/);
  });

  it("refuses a folder that is rebuilt from a scenario on every start", async () => {
    const root = await folder();
    await mkdir(join(root, "scenarios", "ambush", "characters"), { recursive: true });
    await writeFile(join(root, "scenarios", "ambush", "characters", "x.json"), "{}");
    const into = join(root, "campaigns", "scenario-ambush");
    await loadScenario({ scenariosDir: join(root, "scenarios"), name: "ambush", into });
    await expect(refuseRebuiltFolder(into)).rejects.toThrow(/rebuilt from a scenario on every start/);
    await expect(refuseRebuiltFolder(join(root, "scenarios", "ambush"))).resolves.toBeUndefined();
    await expect(refuseRebuiltFolder(join(root, "nowhere"))).resolves.toBeUndefined();
  });
});

describe("the words an export or import is given", () => {
  it("reads an export of one character, or of all with a folder", () => {
    expect(parseExportArgs(["kira"])).toEqual({ id: "kira", derived: false });
    expect(parseExportArgs(["kira", "--out", "k.json", "--derived", "--campaign", "night"])).toEqual({ id: "kira", out: "k.json", derived: true, campaign: "night" });
    expect(parseExportArgs(["--all", "--out", "party", "--scenario", "ambush"])).toEqual({ out: "party", derived: false, scenario: "ambush" });
  });

  it.each([[[]], [["--all"]], [["a", "b"]], [["--all", "kira", "--out", "x"]], [["kira", "--out"]], [["kira", "--campaign", "a", "--scenario", "b"]], [["kira", "--forse"]], [["kira", "--out", "--derived"]]])("refuses the export %j", (args) => {
    expect(parseExportArgs(args)).toBeUndefined();
  });

  it("reads an import of one or many files", () => {
    expect(parseImportArgs(["a.json"])).toEqual({ files: ["a.json"], force: false, check: false });
    expect(parseImportArgs(["a.json", "b.json", "--force", "--check", "--scenario", "ambush"])).toEqual({ files: ["a.json", "b.json"], force: true, check: true, scenario: "ambush" });
  });

  it.each([[[]], [["--force"]], [["a.json", "--campaign"]], [["a.json", "--campaign", "x", "--scenario", "y"]], [["a.json", "--frce"]]])("refuses the import %j", (args) => {
    expect(parseImportArgs(args)).toBeUndefined();
  });
});
