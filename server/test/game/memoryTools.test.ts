import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampaignMemory, MEMORY_FILES } from "../../src/game/campaignMemory.js";
import type { GmTurnContext } from "../../src/gm/driver.js";
import { newSession, tempStore, toolRunner } from "../helpers.js";

const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const hurt = (target: object) => ({ label: "Pistol", target, damageValue: 2, damageType: "physical" });

/** A session whose GM runs `job` on its next turn, over a campaign folder that has the given memory files already. */
async function table(files: Record<string, string> = {}) {
  const store = await tempStore();
  await mkdir(store.dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(store.dir, name), text);
  const runner = toolRunner();
  const made = await newSession(runner.driver, { store });
  const ctxOf = async () => runner.run(made.session, async (ctx: GmTurnContext) => ctx);
  return { ...made, store, run: runner.run, ctxOf, file: (name: string) => readFile(join(store.dir, name), "utf8") };
}

const BIBLE = "# Campaign Bible\n\n## Standing Plot Threads\n\n1. **The Train Fallout** — active. A corp noticed.\n";

describe("the GM's notes", () => {
  it("note_npc writes an NPC into the tracker, and says what is there now", async () => {
    const t = await table();
    const reply = await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith", role: "Fixer, Renraku", status: "Ally", stats: "PR 3, Body 3, Willpower 4", notes: "Pays on time" }));
    expect(reply).toEqual({ ok: true, text: "Noted. Mr. Smith (Fixer, Renraku): Ally. PR 3, Body 3, Willpower 4." });
    expect(await t.file(MEMORY_FILES.npcs)).toContain("| Mr. Smith | Fixer, Renraku | Ally | PR 3, Body 3, Willpower 4 | Pays on time |");
  });

  it("note_npc updates only what it is given, so a status change keeps the rest", async () => {
    const t = await table();
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith", role: "Fixer", stats: "PR 3" }));
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "mr. smith", status: "Burned" }));
    expect(await new CampaignMemory(t.store.dir).npcs()).toEqual([{ name: "Mr. Smith", role: "Fixer", status: "Burned", stats: "PR 3", notes: "" }]);
  });

  it("note_thread writes a thread as status then summary, and the same title updates it", async () => {
    const t = await table({ [MEMORY_FILES.bible]: BIBLE });
    expect(await t.run(t.session, (ctx) => ctx.tools.noteThread({ title: "Gang Beef", status: "active", summary: "They burned the safehouse." }))).toEqual({ ok: true, text: 'Noted the thread "Gang Beef".' });
    await t.run(t.session, (ctx) => ctx.tools.noteThread({ title: "gang beef", status: "resolved.", summary: "Made peace." }));
    const bible = await t.file(MEMORY_FILES.bible);
    expect(bible).toContain("1. **The Train Fallout** — active. A corp noticed.");
    expect(bible).toContain("2. **Gang Beef** — resolved. Made peace.");
    expect(bible).not.toContain("burned the safehouse");
  });

  it("refuses a note that is not in the right shape, naming what is wrong, and writes nothing", async () => {
    const t = await table();
    expect(await t.run(t.session, (ctx) => ctx.tools.noteNpc({ role: "Fixer" }))).toMatchObject({ ok: false, text: expect.stringContaining("name") });
    expect(await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "x".repeat(61) }))).toMatchObject({ ok: false });
    expect(await t.run(t.session, (ctx) => ctx.tools.noteThread({ title: "A" }))).toMatchObject({ ok: false });
    expect(await t.run(t.session, (ctx) => ctx.tools.recall({ what: "everything" }))).toMatchObject({ ok: false });
    await expect(t.file(MEMORY_FILES.npcs)).rejects.toThrow();
  });

  it("recall reads back an NPC, everyone, the threads and the last session", async () => {
    const t = await table({ [MEMORY_FILES.bible]: BIBLE });
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith", role: "Fixer", status: "Ally", notes: "Pays on time" }));
    await new CampaignMemory(t.store.dir).logSession({ date: "2026-11-12", summary: "The team met Mr. Smith." });
    const ask = (input: object) => t.run(t.session, (ctx) => ctx.tools.recall(input));
    expect(await ask({ what: "npc", name: "smith" })).toEqual({ ok: true, text: "Mr. Smith (Fixer): Ally. Notes: Pays on time" });
    expect(await ask({ what: "npcs" })).toEqual({ ok: true, text: "- Mr. Smith (Fixer): Ally." });
    expect(await ask({ what: "threads" })).toEqual({ ok: true, text: "1. The Train Fallout: active. A corp noticed." });
    expect(await ask({ what: "sessions" })).toEqual({ ok: true, text: "Session 1 — 2026-11-12\nThe team met Mr. Smith." });
  });

  it("recall says so when there is nothing, and names who is noted when the one asked for is not", async () => {
    const t = await table();
    const ask = (input: object) => t.run(t.session, (ctx) => ctx.tools.recall(input));
    expect(await ask({ what: "npcs" })).toEqual({ ok: true, text: "No non-player characters are noted yet." });
    expect(await ask({ what: "threads" })).toEqual({ ok: true, text: "No plot threads are noted yet." });
    expect(await ask({ what: "sessions" })).toEqual({ ok: true, text: "No sessions are logged yet." });
    expect(await ask({ what: "npc", name: "Ana" })).toEqual({ ok: false, text: 'No one called "Ana" is in the notes. No one is noted yet.' });
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith" }));
    expect(await ask({ what: "npc", name: "Ana" })).toEqual({ ok: false, text: 'No one called "Ana" is in the notes. Noted so far: Mr. Smith.' });
    expect(await ask({ what: "npc" })).toEqual({ ok: false, text: "Say which character: give their name." });
  });

  it("gives the GM the notes as a brief for a new conversation, and nothing when there are none", async () => {
    const empty = await table();
    expect(await (await empty.ctxOf()).brief?.()).toBe("");
    const t = await table({ [MEMORY_FILES.bible]: BIBLE });
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith", role: "Fixer", status: "Ally" }));
    const brief = await (await t.ctxOf()).brief?.();
    expect(brief).toContain("CAMPAIGN MEMORY");
    expect(brief).toContain("- The Train Fallout: active. A corp noticed.");
    expect(brief).toContain("- Mr. Smith (Fixer): Ally.");
  });
});

describe("the notes when a named character joins the table", () => {
  it("lists them in the tracker the first time the GM names them, with the numbers it gave, even if it never writes them up", async () => {
    const t = await table();
    await t.run(t.session, (ctx) => ctx.tools.dealDamage(hurt(ganger)));
    await t.session.whenIdle();
    await new CampaignMemory(t.store.dir).npcs();
    expect(await new CampaignMemory(t.store.dir).npcs()).toEqual([{ name: "Ganger", role: "", status: "Unknown", stats: "Body 3, Willpower 3", notes: "" }]);
  });

  it("leaves what the GM wrote about them alone", async () => {
    const t = await table();
    await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Ganger", role: "Eastside Kings", status: "Enemy", stats: "PR 2, Body 3, Willpower 3" }));
    await t.run(t.session, (ctx) => ctx.tools.dealDamage(hurt(ganger)));
    await t.session.whenIdle();
    await new CampaignMemory(t.store.dir).npcs();
    expect(await new CampaignMemory(t.store.dir).npcs()).toEqual([{ name: "Ganger", role: "Eastside Kings", status: "Enemy", stats: "PR 2, Body 3, Willpower 3", notes: "" }]);
  });

  it("does not list a nameless grunt", async () => {
    const t = await table();
    const grunt = { kind: "npc", id: "guard-1", name: "Guard", body: 2, willpower: 2, professionalRating: 3, charisma: 2 };
    await t.run(t.session, (ctx) => ctx.tools.dealDamage(hurt(grunt)));
    await t.session.whenIdle();
    expect(await new CampaignMemory(t.store.dir).npcs()).toEqual([]);
  });

  it("does not list the same character twice", async () => {
    const t = await table();
    await t.run(t.session, (ctx) => ctx.tools.dealDamage(hurt(ganger)));
    await t.run(t.session, (ctx) => ctx.tools.dealDamage(hurt({ kind: "npc", id: "ganger-1" })));
    await t.session.whenIdle();
    expect((await new CampaignMemory(t.store.dir).npcs()).map((n) => n.name)).toEqual(["Ganger"]);
  });
});

describe("when the notes cannot be used", () => {
  const bad = "| Who | Status |\n| --- | --- |\n| Ana | Ally |\n";

  it("tells the GM only that they cannot, tells the table why, and carries on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await table({ [MEMORY_FILES.npcs]: bad });
    const reply = await t.run(t.session, (ctx) => ctx.tools.noteNpc({ name: "Mr. Smith" }));
    expect(reply).toEqual({ ok: false, text: "The campaign notes cannot be used just now, so carry on without them. Do not mention this to the players." });
    expect(t.session.snapshot().transcript.at(-1)).toMatchObject({ kind: "system", text: expect.stringMatching(/npc-tracker\.md line 1: the table has no Name column/) });
    expect(await t.file(MEMORY_FILES.npcs)).toBe(bad);
    warn.mockRestore();
  });

  it("gives the GM an empty brief instead of failing its turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await table({ [MEMORY_FILES.npcs]: bad });
    expect(await (await t.ctxOf()).brief?.()).toBe("");
    warn.mockRestore();
  });
});
