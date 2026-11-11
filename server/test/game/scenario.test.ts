import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listScenarios, loadScenario, parseSaveArgs, saveScenario } from "../../src/game/scenario.js";

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "sr-scenario-"));
  return { campaigns: join(root, "campaigns"), scenarios: join(root, "scenarios") };
}

/** A campaign folder with two sheets, a state that names a GM session, a transcript and a premise, plus files that are not part of a game. */
async function campaign(dir: string, extra: Record<string, string> = {}) {
  await mkdir(join(dir, "characters"), { recursive: true });
  await writeFile(join(dir, "characters", "kira.json"), '{"id":"kira"}');
  await writeFile(join(dir, "characters", "doc.json"), '{"id":"doc"}');
  await writeFile(join(dir, "characters", "notes.txt"), "not a sheet");
  await writeFile(join(dir, "state.json"), JSON.stringify({ version: 1, claudeSessionId: "abc", turnCounter: 7 }));
  await writeFile(join(dir, "state.json.bak"), "old");
  await writeFile(join(dir, "transcript.jsonl"), '{"id":1}\n');
  await writeFile(join(dir, "premise.md"), "A rainy night.");
  for (const [name, text] of Object.entries(extra)) await writeFile(join(dir, name), text);
}

const names = async (dir: string) => (await readdir(dir)).sort();

describe("saveScenario", () => {
  it("keeps the sheets, state, transcript and premise, and not the GM's session or anything else", async () => {
    const d = await dirs();
    await campaign(join(d.campaigns, "default"));
    const target = await saveScenario({ campaignDir: join(d.campaigns, "default"), scenariosDir: d.scenarios, name: "ambush" });

    expect(await names(target)).toEqual(["characters", "premise.md", "state.json", "transcript.jsonl"]);
    expect(await names(join(target, "characters"))).toEqual(["doc.json", "kira.json"]);
    expect(JSON.parse(await readFile(join(target, "state.json"), "utf8"))).toEqual({ version: 1, turnCounter: 7 });
    expect(await readFile(join(target, "transcript.jsonl"), "utf8")).toBe('{"id":1}\n');
    expect(await readFile(join(target, "premise.md"), "utf8")).toBe("A rainy night.");
    expect(await listScenarios(d.scenarios)).toEqual(["ambush"]);
  });

  it("saves a campaign that has only sheets", async () => {
    const d = await dirs();
    await mkdir(join(d.campaigns, "new", "characters"), { recursive: true });
    await writeFile(join(d.campaigns, "new", "characters", "kira.json"), '{"id":"kira"}');
    const target = await saveScenario({ campaignDir: join(d.campaigns, "new"), scenariosDir: d.scenarios, name: "bare" });
    expect(await names(target)).toEqual(["characters"]);
  });

  it("will not replace a scenario unless told to, and then leaves nothing of the old one", async () => {
    const d = await dirs();
    const dir = join(d.campaigns, "default");
    await campaign(dir);
    const save = (force?: boolean) => saveScenario({ campaignDir: dir, scenariosDir: d.scenarios, name: "ambush", ...(force && { force }) });
    const target = await save();
    await expect(save()).rejects.toThrow(/already exists.*--force/);

    await writeFile(join(target, "stale.txt"), "left over");
    await save(true);
    expect(await names(target)).not.toContain("stale.txt");
  });

  it("leaves the scenario that was there as it was when the new one cannot be saved", async () => {
    const d = await dirs();
    const dir = join(d.campaigns, "default");
    await campaign(dir);
    const target = await saveScenario({ campaignDir: dir, scenariosDir: d.scenarios, name: "ambush" });
    await writeFile(join(dir, "state.json"), "{ not json");

    await expect(saveScenario({ campaignDir: dir, scenariosDir: d.scenarios, name: "ambush", force: true })).rejects.toThrow(/could not be read/);
    expect(JSON.parse(await readFile(join(target, "state.json"), "utf8"))).toEqual({ version: 1, turnCounter: 7 });
    expect(await names(d.scenarios)).toEqual(["ambush"]);
  });

  it("refuses a campaign with no sheets, and a name that is not safe", async () => {
    const d = await dirs();
    await mkdir(join(d.campaigns, "empty"), { recursive: true });
    await expect(saveScenario({ campaignDir: join(d.campaigns, "empty"), scenariosDir: d.scenarios, name: "x" })).rejects.toThrow(/no character sheets/);
    await expect(saveScenario({ campaignDir: join(d.campaigns, "empty"), scenariosDir: d.scenarios, name: "../x" })).rejects.toThrow(/letters, digits/);
  });
});

describe("loadScenario", () => {
  it("replaces the working folder with a fresh copy every time", async () => {
    const d = await dirs();
    await campaign(join(d.campaigns, "default"));
    await saveScenario({ campaignDir: join(d.campaigns, "default"), scenariosDir: d.scenarios, name: "ambush" });
    const into = join(d.campaigns, "scenario-ambush");

    await loadScenario({ scenariosDir: d.scenarios, name: "ambush", into });
    await writeFile(join(into, "state.json"), '{"played":"on"}');
    await writeFile(join(into, "extra.txt"), "from the last run");
    await loadScenario({ scenariosDir: d.scenarios, name: "ambush", into });

    expect(await names(into)).toEqual([".made-from-scenario", "characters", "premise.md", "state.json", "transcript.jsonl"]);
    expect(JSON.parse(await readFile(join(into, "state.json"), "utf8"))).toEqual({ version: 1, turnCounter: 7 });
  });

  it("leaves the campaign it was saved from alone", async () => {
    const d = await dirs();
    const source = join(d.campaigns, "default");
    await campaign(source);
    await saveScenario({ campaignDir: source, scenariosDir: d.scenarios, name: "ambush" });
    await loadScenario({ scenariosDir: d.scenarios, name: "ambush", into: join(d.campaigns, "scenario-ambush") });
    expect(JSON.parse(await readFile(join(source, "state.json"), "utf8")).claudeSessionId).toBe("abc");
  });

  it("starts the GM over even from a scenario written by hand with a session in it", async () => {
    const d = await dirs();
    await campaign(join(d.scenarios, "by-hand"));
    const into = join(d.campaigns, "scenario-by-hand");
    await loadScenario({ scenariosDir: d.scenarios, name: "by-hand", into });
    expect(JSON.parse(await readFile(join(into, "state.json"), "utf8"))).not.toHaveProperty("claudeSessionId");
  });

  it("starts from sheets alone", async () => {
    const d = await dirs();
    await mkdir(join(d.scenarios, "bare", "characters"), { recursive: true });
    await writeFile(join(d.scenarios, "bare", "characters", "kira.json"), '{"id":"kira"}');
    const into = join(d.campaigns, "scenario-bare");
    await loadScenario({ scenariosDir: d.scenarios, name: "bare", into });
    expect(await names(into)).toEqual([".made-from-scenario", "characters"]);
  });

  it("says which scenarios there are when the name is wrong", async () => {
    const d = await dirs();
    await campaign(join(d.scenarios, "ambush"));
    await expect(loadScenario({ scenariosDir: d.scenarios, name: "ambsh", into: join(d.campaigns, "scenario-ambsh") })).rejects.toThrow(
      /no scenario "ambsh". Saved scenarios: ambush/,
    );
    await expect(loadScenario({ scenariosDir: join(d.scenarios, "nowhere"), name: "x", into: join(d.campaigns, "scenario-x") })).rejects.toThrow(/none saved/);
  });

  it("never wipes a folder that was not made from a scenario, whatever it is called", async () => {
    const d = await dirs();
    await campaign(join(d.scenarios, "ambush"));
    for (const folder of ["default", "scenario-ambush"]) {
      await campaign(join(d.campaigns, folder));
      await expect(loadScenario({ scenariosDir: d.scenarios, name: "ambush", into: join(d.campaigns, folder) })).rejects.toThrow(/not made from a scenario/);
      expect(await names(join(d.campaigns, folder, "characters"))).toContain("kira.json");
    }
  });

  it("starts in a folder that exists but is empty", async () => {
    const d = await dirs();
    await campaign(join(d.scenarios, "ambush"));
    const into = join(d.campaigns, "scenario-ambush");
    await mkdir(into, { recursive: true });
    await loadScenario({ scenariosDir: d.scenarios, name: "ambush", into });
    expect(await names(into)).toContain("characters");
  });

  it("wipes a folder from an earlier run even if that run stopped partway", async () => {
    const d = await dirs();
    await campaign(join(d.scenarios, "ambush"));
    const into = join(d.campaigns, "scenario-ambush");
    await mkdir(into, { recursive: true });
    await writeFile(join(into, ".made-from-scenario"), "ambush\n");
    await writeFile(join(into, "half.txt"), "left by a crash");
    await loadScenario({ scenariosDir: d.scenarios, name: "ambush", into });
    expect(await names(into)).not.toContain("half.txt");
  });
});

describe("parseSaveArgs", () => {
  it("reads a name alone, or with a campaign and force in any order", () => {
    expect(parseSaveArgs(["ambush"])).toEqual({ name: "ambush", force: false });
    expect(parseSaveArgs(["ambush", "--force"])).toEqual({ name: "ambush", force: true });
    expect(parseSaveArgs(["--campaign", "night-one", "ambush"])).toEqual({ name: "ambush", campaign: "night-one", force: false });
    expect(parseSaveArgs(["ambush", "--force", "--campaign", "night-one"])).toEqual({ name: "ambush", campaign: "night-one", force: true });
  });

  it.each([[[]], [["--force"]], [["a", "b"]], [["a", "--campaign"]], [["a", "--campaign", "--force"]], [["a", "--forse"]]])("refuses %j", (args) => {
    expect(parseSaveArgs(args)).toBeUndefined();
  });
});
