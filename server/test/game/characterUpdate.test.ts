import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharacterSheet } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { applyRunUpdate, describeChanges, MAX_KARMA_PER_RUN, MAX_NUYEN_CHANGE, saveSheetWithCopy, type RunUpdate } from "../../src/game/characterUpdate.js";
import { loadScenario, saveScenario } from "../../src/game/scenario.js";
import { CampaignStore } from "../../src/game/store.js";

const example = async () => CharacterSheet.parse(JSON.parse(await readFile(new URL("../../../docs/character-example.json", import.meta.url), "utf8")));
const DATE = { date: "2081-04-02" };
const apply = async (update: RunUpdate, tweak: (s: CharacterSheet) => CharacterSheet = (s) => s) => applyRunUpdate(tweak(await example()), update, DATE);
const ok = (r: Awaited<ReturnType<typeof apply>>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("a run's changes to a sheet", () => {
  it("add Karma to the Karma in hand and the total, and say so", async () => {
    const r = ok(await apply({ karma: 10 }));
    expect(r.sheet.personal).toMatchObject({ karma: 16, totalKarma: 34 });
    expect(r.changes).toEqual(["Karma 6 → 16"]);
  });

  it("start the Karma of a sheet that has none", async () => {
    const r = ok(await apply({ karma: 4 }, (s) => ({ ...s, personal: undefined })));
    expect(r.sheet.personal).toEqual({ karma: 4, totalKarma: 4 });
  });

  it("change nothing for a run that earned no Karma and moved no nuyen", async () => {
    const r = ok(await apply({ karma: 0, nuyen: 0 }, (s) => ({ ...s, personal: undefined, lifestyle: undefined })));
    expect(r.sheet.personal).toBeUndefined();
    expect(r.sheet.lifestyle).toBeUndefined();
    expect(r.changes).toEqual([]);
  });

  it("gain and spend nuyen, and refuse to spend what is not there", async () => {
    expect(ok(await apply({ nuyen: 3000 })).sheet.lifestyle?.nuyen).toBe(5300);
    expect(ok(await apply({ nuyen: 3000 })).changes).toEqual(["Nuyen 2,300 → 5,300"]);
    expect(ok(await apply({ nuyen: -2300 })).sheet.lifestyle?.nuyen).toBe(0);
    expect(await apply({ nuyen: -2301 })).toEqual({ ok: false, error: "Razor has 2,300 nuyen and cannot spend 2,301." });
  });

  it("keep Karma and nuyen within what one run can change, and whole numbers", async () => {
    expect((await apply({ karma: MAX_KARMA_PER_RUN + 1 })).ok).toBe(false);
    expect((await apply({ karma: -1 })).ok).toBe(false);
    expect(await apply({ karma: 1.5 })).toEqual({ ok: false, error: `Karma for one run is a whole number from 0 to ${MAX_KARMA_PER_RUN}, got 1.5.` });
    expect(ok(await apply({ karma: MAX_KARMA_PER_RUN })).ok).toBe(true);
    expect((await apply({ nuyen: MAX_NUYEN_CHANGE + 1 })).ok).toBe(false);
    expect(ok(await apply({ nuyen: MAX_NUYEN_CHANGE })).ok).toBe(true);
    expect((await apply({ nuyen: 10.5 })).ok).toBe(false);
  });

  it("add gear, update gear that is there under its own name, and take gear out", async () => {
    const r = ok(await apply({ gear: { add: [{ name: "Fake SIN", rating: 4 }, { name: "medkit", rating: 5 }], remove: ["Commlink", "Lock pick"] } }));
    expect(r.sheet.gear).toEqual([{ name: "Medkit", rating: 5, notes: "Half used" }, { name: "Fake SIN", rating: 4 }]);
    expect(r.changes).toEqual(["Gear − Commlink", "Lock pick was not in the gear", "Gear + Fake SIN", "Gear Medkit updated"]);
  });

  it("leave gear written as text as text, and put what changed in the run's history", async () => {
    const r = ok(await apply({ gear: { add: [{ name: "Medkit" }], remove: ["Knife"] }, history: { summary: "A run." } }, (s) => ({ ...s, gear: "A knife and a pistol." })));
    expect(r.sheet.gear).toBe("A knife and a pistol.");
    expect(r.sheet.history?.at(-1)?.consequences).toBe("Gear: + Medkit, − Knife");
    expect(r.changes[0]).toBe("Gear is written as text, so + Medkit, − Knife is in the history only");
  });

  it("does not say gear changes are in the history when there is no history entry to hold them", async () => {
    const r = ok(await apply({ gear: { add: [{ name: "Medkit" }] } }, (s) => ({ ...s, gear: "A knife." })));
    expect(r.changes).toEqual(["Gear is written as text, so + Medkit was not applied, and there is no history entry to hold it"]);
    expect(r.sheet.history).toHaveLength(1);
  });

  it("refuse more gear than a list holds", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}` }));
    expect((await apply({ gear: { add: [{ name: "One more" }] } }, (s) => ({ ...s, gear: full }))).ok).toBe(false);
  });

  it("add a contact with both ratings, and update one by name, changing only what is given", async () => {
    const added = ok(await apply({ contacts: [{ name: "Mr. Smith", loyalty: 2, connection: 3, notes: "Pays on time" }] }));
    expect(added.sheet.contacts?.at(-1)).toEqual({ name: "Mr. Smith", loyalty: 2, connection: 3, notes: "Pays on time" });
    expect(added.changes).toEqual(["Contact Mr. Smith added (Loyalty 2, Connection 3)"]);
    const updated = ok(await apply({ contacts: [{ name: "mama rose", loyalty: 4 }] }));
    expect(updated.sheet.contacts?.[0]).toEqual({ name: "Mama Rose", loyalty: 4, connection: 2, notes: "Runs the noodle stand; hears everything" });
    expect(updated.changes).toEqual(["Contact Mama Rose: Loyalty 3 → 4"]);
    expect(ok(await apply({ contacts: [{ name: "Mama Rose", loyalty: 3 }] })).changes).toEqual([]);
    const connection = ok(await apply({ contacts: [{ name: "Mama Rose", connection: 5 }] }));
    expect(connection.sheet.contacts?.[0]).toMatchObject({ loyalty: 3, connection: 5 });
    const notes = ok(await apply({ contacts: [{ name: "Mama Rose", notes: "Closed the stand." }] }));
    expect(notes.sheet.contacts?.[0]).toMatchObject({ loyalty: 3, connection: 2, notes: "Closed the stand." });
    expect(notes.changes).toEqual(["Contact Mama Rose: notes changed"]);
  });

  it("refuse a new contact that has no ratings, and change nothing", async () => {
    expect(await apply({ karma: 5, contacts: [{ name: "Mr. Smith", loyalty: 2 }] })).toEqual({ ok: false, error: "Mr. Smith is a new contact, so give both Loyalty and Connection." });
  });

  it("add a line to the notes", async () => {
    const r = ok(await apply({ note: "  Owes Mama Rose a favor.  " }));
    expect(r.sheet.notes).toBe("Example character used by the tests and the docs.\nOwes Mama Rose a favor.");
    expect(ok(await apply({ note: "First." }, (s) => ({ ...s, notes: "" }))).sheet.notes).toBe("First.");
  });

  it("add the run to the history as the next number, and never replace one", async () => {
    const r = ok(await apply({ history: { summary: "Guarded a shipment.", goal: "Get it to the docks.", with: ["Doc"], campaign: "night-one", consequences: "Paid." } }));
    expect(r.sheet.history).toHaveLength(2);
    expect(r.sheet.history?.[0]).toMatchObject({ run: 1, summary: "Carried a case across the sprawl for Mr. Smith." });
    expect(r.sheet.history?.[1]).toEqual({ run: 2, date: "2081-04-02", campaign: "night-one", summary: "Guarded a shipment.", goal: "Get it to the docks.", with: ["Doc"], consequences: "Paid." });
    expect(ok(await apply({ history: { summary: "First." } }, (s) => ({ ...s, history: undefined }))).sheet.history).toEqual([{ run: 1, date: "2081-04-02", summary: "First." }]);
    expect(ok(await apply({ history: { summary: "Next." } }, (s) => ({ ...s, history: [{ run: 7, date: "d", summary: "x" }, { run: 3, date: "d", summary: "y" }] }))).sheet.history?.at(-1)?.run).toBe(8);
  });

  it("do everything in one go, and leave the sheet they were given alone", async () => {
    const sheet = await example();
    const before = structuredClone(sheet);
    const r = ok(applyRunUpdate(sheet, { karma: 4, nuyen: 3000, gear: { add: [{ name: "Medkit", rating: 4 }] }, contacts: [{ name: "Fixer", loyalty: 1, connection: 2 }], history: { summary: "A run." } }, DATE));
    expect(sheet).toEqual(before);
    expect(r.changes).toEqual(["Karma 6 → 10", "Nuyen 2,300 → 5,300", "Gear Medkit updated", "Contact Fixer added (Loyalty 1, Connection 2)", "History: run 2 added"]);
    expect(CharacterSheet.safeParse(r.sheet).success).toBe(true);
  });

  it("refuse a result that is not a valid sheet, and say why", async () => {
    const r = await apply({ history: { summary: "x".repeat(601) } });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("would not make a valid sheet") });
  });

  it("are told to the table in one line", () => {
    expect(describeChanges("Kira", ["Karma 6 → 16", "Gear + Medkit"])).toBe("Kira: Karma 6 → 16; Gear + Medkit");
    expect(describeChanges("Kira", [])).toBe("Kira: no change");
  });
});

describe("saving a sheet with a dated copy of the old one", () => {
  const folder = async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-update-"));
    await new CampaignStore(dir).saveParty([await example()]);
    return dir;
  };
  const sheetOnDisk = async (dir: string) => JSON.parse(await readFile(join(dir, "characters", "razor.json"), "utf8"));

  it("copies the old file first, then writes the new one", async () => {
    const dir = await folder();
    const changed = { ...(await example()), name: "Razor Two" };
    const { copy } = await saveSheetWithCopy({ dir, sheet: changed, date: "2081-04-02" });
    expect(copy).toBe(join(dir, "characters", "history", "razor-2081-04-02.json"));
    expect(JSON.parse(await readFile(copy!, "utf8")).name).toBe("Razor");
    expect((await sheetOnDisk(dir)).name).toBe("Razor Two");
  });

  it("numbers a second copy on the same day, and never writes over one", async () => {
    const dir = await folder();
    for (const name of ["One", "Two", "Three"]) await saveSheetWithCopy({ dir, sheet: { ...(await example()), name }, date: "2081-04-02" });
    expect((await readdir(join(dir, "characters", "history"))).sort()).toEqual(["razor-2081-04-02-2.json", "razor-2081-04-02-3.json", "razor-2081-04-02.json"]);
    const names = await Promise.all(["razor-2081-04-02.json", "razor-2081-04-02-2.json", "razor-2081-04-02-3.json"].map(async (f) => JSON.parse(await readFile(join(dir, "characters", "history", f), "utf8")).name));
    expect(names).toEqual(["Razor", "One", "Two"]);
    expect((await sheetOnDisk(dir)).name).toBe("Three");
  });

  it("makes no copy for a character who has no sheet yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-update-"));
    expect(await saveSheetWithCopy({ dir, sheet: await example(), date: "2081-04-02" })).toEqual({});
    await expect(readdir(join(dir, "characters", "history"))).rejects.toThrow();
    expect((await sheetOnDisk(dir)).name).toBe("Razor");
  });

  it("writes nothing when the copy cannot be made", async () => {
    const dir = await folder();
    await writeFile(join(dir, "characters", "history"), "a file where the folder should be");
    await expect(saveSheetWithCopy({ dir, sheet: { ...(await example()), name: "Changed" }, date: "2081-04-02" })).rejects.toThrow();
    expect((await sheetOnDisk(dir)).name).toBe("Razor");
  });

  it("refuses a date that is not YYYY-MM-DD, which would make a bad file name", async () => {
    const dir = await folder();
    await expect(saveSheetWithCopy({ dir, sheet: await example(), date: "../x" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("keeps the copies out of the characters the game loads and out of a scenario", async () => {
    const dir = await folder();
    await saveSheetWithCopy({ dir, sheet: { ...(await example()), name: "Razor Two" }, date: "2081-04-02" });
    expect((await new CampaignStore(dir).loadParty())?.map((s) => s.name)).toEqual(["Razor Two"]);
    const root = await mkdtemp(join(tmpdir(), "sr-update-"));
    await saveScenario({ campaignDir: dir, scenariosDir: join(root, "scenarios"), name: "run" });
    await expect(readdir(join(root, "scenarios", "run", "characters", "history"))).rejects.toThrow();
    await mkdir(join(root, "campaigns"), { recursive: true });
    await loadScenario({ scenariosDir: join(root, "scenarios"), name: "run", into: join(root, "campaigns", "scenario-run") });
    expect(await readdir(join(root, "campaigns", "scenario-run", "characters"))).toEqual(["razor.json"]);
  });
});
