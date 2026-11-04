import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampaignStore, sheetFiles, type SavedState } from "../../src/game/store.js";
import { demoParty } from "../../src/game/demoParty.js";

const dir = () => mkdtemp(join(tmpdir(), "sr-store-"));
const emptyState: SavedState = { version: 1, opened: false, openRequested: false, turnCounter: 0, pending: [], results: [], pcs: [], npcs: [], healBudgets: [], combat: null, held: [] };

describe("character sheets", () => {
  const sheetsIn = (d: string) => readdir(join(d, "characters"));

  it("is null before anything is saved, and round-trips after, one file per character", async () => {
    const d = await dir();
    const store = new CampaignStore(d);
    expect(await store.loadParty()).toBeNull();
    await store.saveParty(demoParty);
    expect((await sheetsIn(d)).sort()).toEqual(["doc.json", "kira.json"]);
    expect(await store.loadParty()).toEqual([...demoParty].sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("is null when the folder holds no sheets", async () => {
    const d = await dir();
    await mkdir(join(d, "characters"));
    await writeFile(join(d, "characters", "notes.txt"), "not a sheet");
    expect(await new CampaignStore(d).loadParty()).toBeNull();
  });

  it("fills in what a sheet leaves out and leaves no temporary files behind", async () => {
    const d = await dir();
    const { gear: _g, qualities: _q, notes: _n, specializations: _s, skills: _k, initiativeDice: _i, ...bare } = demoParty[0]!;
    const { magic: _m, resonance: _r, ...attributes } = bare.attributes;
    await mkdir(join(d, "characters"));
    await writeFile(join(d, "characters", "kira.json"), JSON.stringify({ ...bare, attributes }));
    expect(await new CampaignStore(d).loadParty()).toMatchObject([{ initiativeDice: 1, skills: {}, specializations: [], gear: "", attributes: { magic: 0, resonance: 0 } }]);
    await new CampaignStore(d).saveParty(demoParty);
    expect((await sheetsIn(d)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a sheet that is not valid, naming the file and the problem", async () => {
    const d = await dir();
    await mkdir(join(d, "characters"));
    await writeFile(join(d, "characters", "kira.json"), JSON.stringify({ ...demoParty[0], attributes: { ...demoParty[0]!.attributes, willpowr: 3 } }));
    await expect(new CampaignStore(d).loadParty()).rejects.toThrow(/characters[/\\]kira\.json is not a valid character sheet/);
  });

  it("refuses a file that is not named after its character, so two cannot share an id", async () => {
    const d = await dir();
    await mkdir(join(d, "characters"));
    await writeFile(join(d, "characters", "second.json"), JSON.stringify(demoParty[0]));
    await expect(new CampaignStore(d).loadParty()).rejects.toThrow(/holds the character "kira", so the file must be named kira\.json/);
  });

  it("refuses a file that is not JSON, naming it", async () => {
    const d = await dir();
    await mkdir(join(d, "characters"));
    await writeFile(join(d, "characters", "kira.json"), "{not json");
    await expect(new CampaignStore(d).loadParty()).rejects.toThrow(/kira\.json could not be read/);
  });

  it("reads sheets in order of id, whatever order the disk lists them in, and only the .json ones", () => {
    expect(sheetFiles(["razor.json", "notes.txt", "doc.json", "kira.json", "kira.json.tmp"])).toEqual(["doc.json", "kira.json", "razor.json"]);
  });

  it("writes the fallback characters to a new campaign and reads them back, in the same order as every later start", async () => {
    const d = await dir();
    const first = await new CampaignStore(d).loadOrCreateParty(demoParty);
    expect(first.created).toBe(true);
    const second = await new CampaignStore(d).loadOrCreateParty(demoParty);
    expect(second.created).toBe(false);
    expect(first.party.map((m) => m.id)).toEqual(second.party.map((m) => m.id));
    expect(first.party.map((m) => m.id)).toEqual(["doc", "kira"]);
  });

  it("no longer reads an old party.json", async () => {
    const d = await dir();
    await writeFile(join(d, "party.json"), JSON.stringify(demoParty));
    expect(await new CampaignStore(d).loadParty()).toBeNull();
  });
});

describe("game state", () => {
  it("round-trips and leaves no temporary files behind", async () => {
    const d = await dir();
    const store = new CampaignStore(d);
    expect(await store.loadState()).toBeNull();
    const state = { ...emptyState, opened: true, claudeSessionId: "abc", turnCounter: 3 };
    await store.saveState(state);
    expect(await store.loadState()).toEqual(state);
    expect(await readdir(d)).toEqual(["state.json"]);
  });

  it("loads a save from before health was tracked, with everyone unhurt", async () => {
    const d = await dir();
    const { pcs: _p, npcs: _n, ...old } = emptyState;
    await writeFile(join(d, "state.json"), JSON.stringify(old));
    expect(await new CampaignStore(d).loadState()).toMatchObject({ pcs: [], npcs: [] });
  });

  it("round-trips health and a report waiting for the GM", async () => {
    const store = new CampaignStore(await dir());
    const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 4, stun: 0, overflow: 0 };
    const state = {
      ...emptyState,
      pcs: [{ id: "kira", monitor, treated: ["first_aid" as const] }],
      npcs: [{ id: "ganger-1", name: "Ganger", body: 3, willpower: 3, monitor, treated: [] }],
      results: [{ kind: "report" as const, text: "DAMAGE RESULT. x" }],
      healBudgets: [{ rollId: "r-1", patient: { kind: "pc" as const, id: "kira" }, method: "first_aid" as const, remaining: 2 }],
    };
    await store.saveState(state);
    expect(await store.loadState()).toEqual(state);
  });

  it("reads a save from before treatments were tracked as untreated", async () => {
    const d = await dir();
    const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 4, stun: 0, overflow: 0 };
    const old = { ...emptyState, pcs: [{ id: "kira", monitor }], npcs: [{ id: "g", name: "G", body: 3, willpower: 3, monitor }] };
    await writeFile(join(d, "state.json"), JSON.stringify(old));
    expect(await new CampaignStore(d).loadState()).toMatchObject({ pcs: [{ treated: [] }], npcs: [{ treated: [] }] });
  });

  it("refuses a state file it cannot understand rather than starting over silently", async () => {
    const d = await dir();
    await writeFile(join(d, "state.json"), JSON.stringify({ version: 2 }));
    await expect(new CampaignStore(d).loadState()).rejects.toThrow(/state\.json is not a valid game state; move it aside/);
    await writeFile(join(d, "state.json"), "{not json");
    await expect(new CampaignStore(d).loadState()).rejects.toThrow(/state\.json could not be read/);
  });

  it("keeps the last of several saves made at once", async () => {
    const store = new CampaignStore(await dir());
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.saveState({ ...emptyState, turnCounter: n })));
    expect((await store.loadState())?.turnCounter).toBe(5);
  });
});

describe("transcript", () => {
  const say = (text: string) => ({ kind: "say" as const, name: "Kira", text });

  it("numbers entries from 1, stamps them, and returns the newest in order", async () => {
    const store = new CampaignStore(await dir(), () => new Date("2026-11-02T10:00:00Z"));
    for (const word of ["a", "b", "c"]) await store.appendEntry(say(word));
    const recent = await store.recentEntries(2);
    expect(recent.map((e) => [e.id, e.kind === "say" && e.text])).toEqual([[2, "b"], [3, "c"]]);
    expect(recent[0]?.ts).toBe("2026-11-02T10:00:00.000Z");
  });

  it("keeps ids in write order when appends are made at once", async () => {
    const store = new CampaignStore(await dir());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendEntry(say(`m${i}`))));
    const all = await store.recentEntries(100);
    expect(all.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(all.map((e) => e.kind === "say" && e.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });

  it("carries on numbering after a restart", async () => {
    const d = await dir();
    await new CampaignStore(d).appendEntry(say("one"));
    const entry = await new CampaignStore(d).appendEntry(say("two"));
    expect(entry.id).toBe(2);
  });

  it("skips a line cut short by a crash instead of losing the whole transcript", async () => {
    const d = await dir();
    const store = new CampaignStore(d);
    await store.appendEntry(say("whole"));
    await appendFile(join(d, "transcript.jsonl"), '{"id":2,"kind":"say","na');
    expect((await new CampaignStore(d).recentEntries(10)).map((e) => e.id)).toEqual([1]);
    expect(await readFile(join(d, "transcript.jsonl"), "utf8")).toContain("whole");
  });

  it("is empty before anything is said", async () => {
    expect(await new CampaignStore(await dir()).recentEntries(10)).toEqual([]);
  });
});
