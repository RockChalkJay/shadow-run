import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@shadow-run/shared";
import { MEMORY_FILES } from "../../src/game/campaignMemory.js";
import type { GmDriver } from "../../src/gm/driver.js";
import { ScriptedGmDriver, type ScriptedTurn } from "../../src/gm/scriptedDriver.js";
import { demoParty } from "../../src/game/demoParty.js";
import { always, newSession, rollInput, tempStore, toolRunner } from "../helpers.js";

const NOW = new Date(2026, 10, 12, 12, 0, 0);
const WRITE_UP = { summary: "The team met Mr. Smith and took the courier job.", fictionDate: "Tue 14 Mar 2081, night", rolls: "Sneak past the guard: success", consequences: "Each earned 3 Karma." };
const wrapping = (input: { text: string }) => input.text.includes("WRAP UP THE SESSION");

/** A GM that says a line each turn, and writes the session up when the table wraps it up. */
const goodGm = (extra: (text: string) => ScriptedTurn | undefined = () => undefined) =>
  new ScriptedGmDriver((input, n) => extra(input.text) ?? (wrapping(input) ? { say: ["The night goes quiet."], endSession: WRITE_UP } : { say: [`Line ${n}.`] }));

async function table(driver: GmDriver, files: Record<string, string> = {}) {
  const store = await tempStore();
  await mkdir(store.dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(store.dir, name), text);
  const made = await newSession(driver, { store, now: () => NOW, d6: always(3) });
  const phases = () => made.events.filter((e): e is Extract<ServerEvent, { type: "session.updated" }> => e.type === "session.updated").map((e) => e.session.phase);
  return { ...made, store, phases, log: () => readFile(join(store.dir, MEMORY_FILES.log), "utf8") };
}

describe("wrapping up a session", () => {
  it("has the GM close the scene and write the session up, which goes in the log with the real date and the next number", async () => {
    const driver = goodGm();
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    expect(await t.session.wrapUp()).toEqual({ ok: true });
    await t.session.whenIdle();

    const log = await t.log();
    expect(log).toContain("## Session 1 — 2026-11-12 (in fiction: Tue 14 Mar 2081, night)");
    expect(log).toContain("The team met Mr. Smith and took the courier job.");
    expect(log).toContain("**Key rolls:** Sneak past the guard: success");
    expect(log).toContain("**Consequences:** Each earned 3 Karma.");
    expect(t.session.snapshot().session).toEqual({ number: 1, phase: "ended" });
    expect(t.phases()).toEqual(["open", "wrapping", "ended"]);
  });

  it("puts what the GM said, then a marker with the summary, in the story, and lets go of the GM's conversation", async () => {
    const t = await table(goodGm());
    await t.session.start();
    await t.session.whenIdle();
    expect(t.session.gmSessionId).toBe("scripted");
    await t.session.wrapUp();
    await t.session.whenIdle();
    const kinds = t.session.snapshot().transcript.map((e) => e.kind);
    expect(kinds).toEqual(["session", "gm", "system", "system", "gm", "session"]);
    expect(t.session.snapshot().transcript.at(-1)).toMatchObject({ kind: "session", event: "end", number: 1, summary: WRITE_UP.summary });
    expect(t.session.gmSessionId).toBeUndefined();
  });

  it("gives the GM an account the system wrote of the session to write from, and tells it to close gently", async () => {
    const driver = goodGm((text) => (text.includes("The players say") ? { say: ["A guard turns."], rolls: [rollInput()] } : undefined));
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "I creep forward.");
    await t.session.whenIdle();
    const id = t.session.snapshot().pendingRolls[0]!.id;
    await t.session.submitRoll(id, { mode: "app" });
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    const input = driver.inputs.at(-1)!.text;
    expect(input).toContain("WRAP UP THE SESSION");
    expect(input).toContain("call end_session once");
    expect(input).toContain("What the system recorded this session, to write from:");
    expect(input).toContain("Kira: I creep forward.");
    expect(input).toContain("[Roll] Kira, Sneak past the guard");
    expect(input).not.toContain("[Session 1 begins]");
  });

  it("is refused before a session has begun, while rolls are waiting, while the GM is mid-turn, and twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: GmDriver = {
      async takeTurn(input, ctx) {
        if (input.text.includes("slow")) await gate;
        if (wrapping(input)) await ctx.tools.endSession(WRITE_UP);
      },
    };
    const t = await table(slow);
    expect(await t.session.wrapUp()).toEqual({ ok: false, error: "There is no session in play to wrap up." });
    await t.session.start();
    await t.session.whenIdle();

    await t.session.say("kira", "slow");
    expect(await t.session.wrapUp()).toEqual({ ok: false, error: "The GM is in the middle of a turn. Wrap up when it has finished." });
    release();
    await t.session.whenIdle();

    await t.session.say("kira", "go on");
    await t.session.whenIdle();
    expect(await t.session.wrapUp()).toEqual({ ok: true });
    expect(await t.session.wrapUp()).toEqual({ ok: false, error: "The GM is already wrapping up the session." });
    await t.session.whenIdle();
    expect(await t.session.wrapUp()).toEqual({ ok: false, error: "There is no session in play to wrap up." });
  });

  it("waits for rolls that are waiting to be answered or skipped", async () => {
    const t = await table(goodGm(() => undefined));
    const withRoll = await table(new ScriptedGmDriver([{ say: ["Go."], rolls: [rollInput()] }]));
    await withRoll.session.start();
    await withRoll.session.whenIdle();
    expect(await withRoll.session.wrapUp()).toEqual({ ok: false, error: "Answer or skip the rolls that are waiting first." });
    expect(t.session.snapshot().session.phase).toBe("idle");
  });

  it("leaves the session open, and says so, when the GM does not write it up, and can be tried again", async () => {
    const stubborn = new ScriptedGmDriver((input, n) => (wrapping(input) && n < 3 ? { say: ["Hmm."] } : wrapping(input) ? { say: ["Done."], endSession: WRITE_UP } : { say: ["Hello."] }));
    const t = await table(stubborn);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session).toEqual({ number: 1, phase: "open" });
    expect(t.session.snapshot().transcript.at(-1)).toMatchObject({ kind: "system", text: "The GM did not write up the session, so it is still open. Wrap up again to try once more." });
    await expect(t.log()).rejects.toThrow();

    expect(await t.session.wrapUp()).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("ended");
  });

  it("is asked for again by a retry when the GM's turn failed", async () => {
    let attempts = 0;
    const driver = new ScriptedGmDriver((input) => {
      if (!wrapping(input)) return { say: ["Hello."] };
      return ++attempts === 1 ? { fail: "The GM went away." } : { say: ["Quiet."], endSession: WRITE_UP };
    });
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("wrapping");
    expect(t.session.retry()).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("ended");
    expect(attempts).toBe(2);
  });

  it("is saved the moment it is asked for, so a restart before the GM's turn does not lose it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (wrapping(input)) {
          await gate;
          await ctx.tools.endSession(WRITE_UP);
        }
      },
    };
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    expect((await t.store.loadState())?.wrapUpRequested).toBe(true);
    release();
    await t.session.whenIdle();
    expect((await t.store.loadState())).toMatchObject({ wrapUpRequested: false, ended: true });
  });

  it("ends the session even if the GM's turn fails after it has written the session up, and logs it once", async () => {
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (!wrapping(input)) return;
        await ctx.tools.endSession(WRITE_UP);
        throw new Error("The GM went away.");
      },
    };
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session).toEqual({ number: 1, phase: "ended" });
    expect((await t.log()).match(/## Session/g)).toHaveLength(1);
    expect(t.session.snapshot().transcript.at(-1)).toMatchObject({ kind: "system", text: expect.stringContaining("so the session is over anyway: The GM went away.") });
    expect(t.session.retry()).toMatchObject({ ok: false });
    expect(await t.session.wrapUp()).toMatchObject({ ok: false });
  });

  it("refuses the dice, damage and combat tools once the session is written up, and still takes notes", async () => {
    const replies: Array<{ ok: boolean; text: string }> = [];
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (!wrapping(input)) return;
        await ctx.tools.endSession(WRITE_UP);
        replies.push(await ctx.tools.requestRoll(rollInput()));
        replies.push(await ctx.tools.rollNpc({ label: "x", pool: 4, threshold: 2 }));
        replies.push(await ctx.tools.dealDamage({ label: "x", target: { kind: "npc", id: "g", name: "G", body: 3, willpower: 3 }, damageValue: 2, damageType: "physical" }));
        replies.push(await ctx.tools.attack({}));
        replies.push(await ctx.tools.awardEdge({}));
        replies.push(await ctx.tools.heal({}));
        replies.push(await ctx.tools.startCombat({ participants: [] }));
        replies.push(await ctx.tools.joinCombat({}));
        replies.push(await ctx.tools.nextRound());
        replies.push(await ctx.tools.endCombat());
        replies.push(await ctx.tools.noteNpc({ name: "Mr. Smith", status: "Ally" }));
      }
    };
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    const over = "The session is written up and over, so nothing more happens in it. Do not call tools now.";
    expect(replies.slice(0, 10)).toEqual(Array(10).fill({ ok: false, text: over }));
    expect(replies[10]).toMatchObject({ ok: true });
    expect(t.session.snapshot().pendingRolls).toEqual([]);
    expect(t.session.snapshot().session.phase).toBe("ended");
  });

  it("is the only time the GM may write the session up", async () => {
    const t = await table(goodGm());
    await t.session.start();
    await t.session.whenIdle();
    const runner = toolRunner();
    const other = await newSession(runner.driver, { store: t.store });
    expect(await runner.run(other.session, (ctx) => ctx.tools.endSession(WRITE_UP))).toEqual({ ok: false, text: "The table has not asked to wrap up the session, so do not write it up now." });
    await expect(t.log()).rejects.toThrow();
  });

  it("refuses a write-up that is too short to be one, and a second call in the same turn", async () => {
    const replies: unknown[] = [];
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (!wrapping(input)) return;
        replies.push(await ctx.tools.endSession({ summary: "Short." }));
        replies.push(await ctx.tools.endSession(WRITE_UP));
        replies.push(await ctx.tools.endSession(WRITE_UP));
      },
    };
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(replies[0]).toMatchObject({ ok: false, text: expect.stringContaining("summary") });
    expect(replies[1]).toMatchObject({ ok: true });
    expect(replies[2]).toEqual({ ok: false, text: "Session 1 is already written up." });
    expect((await t.log()).match(/## Session/g)).toHaveLength(1);
  });

  it("tells the GM only that the log cannot be written when it cannot, and keeps the session open", async () => {
    const replies: unknown[] = [];
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (wrapping(input)) replies.push(await ctx.tools.endSession(WRITE_UP));
      },
    };
    const t = await table(driver);
    // A folder where the log should be, so it can be neither read nor written.
    await mkdir(join(t.store.dir, MEMORY_FILES.log));
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("open");
    expect(t.session.snapshot().transcript.filter((e) => e.kind === "system").length).toBeGreaterThan(0);
  });
});

describe("the next session", () => {
  async function ended(extra: Record<string, string> = {}) {
    const driver = goodGm();
    const t = await table(driver, extra);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    return { ...t, driver };
  }

  it("is refused to talk to until it begins", async () => {
    const t = await ended();
    expect(await t.session.say("kira", "hello?")).toEqual({ ok: false, error: "The session is over. Begin the next one first." });
  });

  it("begins as a new conversation, numbered after the log, with the mission the table gave and a marker in the story", async () => {
    const t = await ended();
    expect(await t.session.start("Steal the courier.")).toEqual({ ok: true });
    await t.session.whenIdle();
    const input = t.driver.inputs.at(-1)!;
    expect(input.kind).toBe("open");
    expect(input.text).toBe("BEGIN SESSION 2. Open the first scene of this session, carrying on from your notes.\n\nWhat the table wants this session to be about: Steal the courier.");
    expect(t.session.snapshot().transcript.filter((e) => e.kind === "session").map((e) => [e.kind === "session" && e.event, e.kind === "session" && e.number])).toEqual([["start", 1], ["end", 1], ["start", 2]]);
    expect(t.session.snapshot().transcript.at(-2)).toMatchObject({ kind: "session", event: "start", number: 2, mission: "Steal the courier." });
    expect(t.session.snapshot().session).toEqual({ number: 2, phase: "open" });
    expect(t.phases().at(-1)).toBe("open");
  });

  it("keeps the mission only until the GM has opened with it, so it is not asked for again after a restart", async () => {
    const t = await ended();
    await t.session.start("Steal the courier.");
    expect((await t.store.loadState())?.mission).toBe("Steal the courier.");
    await t.session.whenIdle();
    expect((await t.store.loadState())?.mission).toBeUndefined();
  });

  it("begins without a mission when none is given, and says nothing about one", async () => {
    const t = await ended();
    await t.session.start("   ");
    await t.session.whenIdle();
    expect(t.driver.inputs.at(-1)!.text).toBe("BEGIN SESSION 2. Open the first scene of this session, carrying on from your notes.");
  });

  it("numbers a campaign's first session after the sessions already in its log", async () => {
    const log = "# Session Log\n\n## Session 1 — 2026-03-01\n\nOne.\n\n## Session 3 — 2026-03-15\n\nThree.\n";
    const driver = goodGm();
    const t = await table(driver, { [MEMORY_FILES.log]: log });
    await t.session.start("A new job.");
    await t.session.whenIdle();
    expect(driver.inputs[0]!.text).toBe("BEGIN SESSION 4. Open the first scene of this session, carrying on from your notes.\n\nWhat the table wants this session to be about: A new job.");
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(await t.log()).toContain("## Session 4 — 2026-11-12");
  });

  it("is refused while a session is in play", async () => {
    const t = await table(goodGm());
    await t.session.start();
    expect(await t.session.start()).toEqual({ ok: false, error: "The session has already begun." });
    await t.session.whenIdle();
    expect(await t.session.start()).toEqual({ ok: false, error: "The session has already begun." });
  });

  it("gives everyone their Edge back", async () => {
    const driver = new ScriptedGmDriver((input, n) => (wrapping(input) ? { say: ["Quiet."], endSession: WRITE_UP } : n === 1 ? { say: ["Go."], rolls: [rollInput()] } : { say: ["Ok."] }));
    const t = await table(driver);
    await t.session.start();
    await t.session.whenIdle();
    const id = t.session.snapshot().pendingRolls[0]!.id;
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    await t.session.spendEdge(id, { boost: "buy_hit", times: 1 });
    await t.session.whenIdle();
    expect(t.session.snapshot().edge.find((e) => e.id === "kira")!.points).toBe(0);
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().edge.find((e) => e.id === "kira")!.points).toBe(0);
    await t.session.start();
    await t.session.whenIdle();
    expect(t.session.snapshot().edge.find((e) => e.id === "kira")).toMatchObject({ points: 3, spentThisRound: false });
    expect(t.events.filter((e) => e.type === "edge.updated").length).toBeGreaterThan(0);
  });

  it("survives a restart: it is still over, and the next session still begins as the next", async () => {
    const first = await ended();
    await first.session.close();
    const driver = goodGm();
    const second = await newSession(driver, { store: first.store, now: () => NOW });
    expect(second.session.snapshot().session).toEqual({ number: 1, phase: "ended" });
    expect(await second.session.say("kira", "hello")).toMatchObject({ ok: false });
    await second.session.start();
    await second.session.whenIdle();
    expect(driver.inputs[0]!.text).toContain("BEGIN SESSION 2.");
  });

  it("takes up a wrap-up that was asked for before a restart", async () => {
    const first = await table(new ScriptedGmDriver([{ say: ["Hello."] }]));
    await first.session.start();
    await first.session.whenIdle();
    // Asked for, but the server stopped before the GM's turn ran.
    const state = (await first.store.loadState())!;
    await first.store.saveState({ ...state, wrapUpRequested: true });
    await first.session.close();
    const second = await newSession(goodGm(), { store: first.store, now: () => NOW });
    expect(second.session.snapshot().session.phase).toBe("wrapping");
    second.session.resume();
    await second.session.whenIdle();
    expect(second.session.snapshot().session.phase).toBe("ended");
  });

  it("reads an older save that has no session fields as session 1, in play", async () => {
    const first = await table(new ScriptedGmDriver([{ say: ["Hello."] }]));
    await first.session.start();
    await first.session.whenIdle();
    const { sessionNumber: _n, wrapUpRequested: _w, ended: _e, ...old } = (await first.store.loadState())!;
    await writeFile(join(first.store.dir, "state.json"), JSON.stringify(old));
    const second = await newSession(goodGm(), { store: first.store, now: () => NOW });
    expect(second.session.snapshot().session).toEqual({ number: 1, phase: "open" });
  });
});

describe("the demo GM", () => {
  it("wraps a session up when asked, so a table tried without Claude can end its sessions too", async () => {
    const { demoScript } = await import("../../src/gm/scriptedDriver.js");
    const { party } = await import("../helpers.js");
    const t = await table(new ScriptedGmDriver(demoScript(party)));
    await t.session.start();
    await t.session.whenIdle();
    const id = t.session.snapshot().pendingRolls[0]!.id;
    await t.session.cancelRoll(id);
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("ended");
    expect(await t.log()).toContain("The team took the courier job and began working the Renraku annex.");
  });
});

describe("what a run does for the characters", () => {
  const sheetFile = async (dir: string, id: string) => JSON.parse(await readFile(join(dir, "characters", `${id}.json`), "utf8"));
  const REWARDS = [
    { characterId: "kira", karma: 4, nuyen: 3000, gear: { add: [{ name: "Medkit", rating: 4 }] }, contacts: [{ name: "Mr. Smith", loyalty: 2, connection: 3 }], summary: "Carried the case across the sprawl.", goal: "Deliver it unopened.", consequences: "Paid in full." },
  ];
  const wrapUpWith = (rewards: unknown, calls: Array<{ ok: boolean; text: string }> = []): GmDriver => ({
    async takeTurn(input, ctx) {
      if (wrapping(input)) calls.push(await ctx.tools.endSession({ ...WRITE_UP, rewards }));
    },
  });

  async function wrapped(rewards: unknown, files: Record<string, string> = {}) {
    const calls: Array<{ ok: boolean; text: string }> = [];
    const t = await table(wrapUpWith(rewards, calls), files);
    // The sheets are on disk, as they are in a real campaign.
    await t.store.saveParty([...t.session.party]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    return { ...t, calls };
  }

  it("saves what the run earned to the sheet, after a dated copy of the old one, and adds the run to the history", async () => {
    const t = await wrapped(REWARDS);
    expect(t.calls[0]).toMatchObject({ ok: true });
    const kira = await sheetFile(t.store.dir, "kira");
    expect(kira.personal).toEqual({ karma: 4, totalKarma: 4 });
    expect(kira.lifestyle).toEqual({ nuyen: 3000 });
    expect(kira.gear).toBe("");
    expect(kira.contacts).toEqual([{ name: "Mr. Smith", loyalty: 2, connection: 3 }]);
    expect(kira.history).toEqual([{ summary: "Carried the case across the sprawl.", goal: "Deliver it unopened.", with: ["Doc"], campaign: expect.any(String), consequences: "Paid in full. Gear: + Medkit", run: 1, date: "2026-11-12" }]);
    const copy = JSON.parse(await readFile(join(t.store.dir, "characters", "history", "kira-2026-11-12.json"), "utf8"));
    expect(copy.personal).toBeUndefined();
    expect(copy.history).toBeUndefined();
  });

  it("gives a character the run in their history even when the GM gave them no reward, from the session's summary", async () => {
    const t = await wrapped(REWARDS);
    const doc = await sheetFile(t.store.dir, "doc");
    expect(doc.history).toEqual([{ run: 1, date: "2026-11-12", campaign: expect.any(String), summary: WRITE_UP.summary, with: ["Kira"] }]);
    expect(doc.personal).toBeUndefined();
  });

  it("cuts the session's summary to fit a history entry for a character with no reward of their own", async () => {
    const calls: Array<{ ok: boolean; text: string }> = [];
    const driver: GmDriver = { async takeTurn(input, ctx) { if (wrapping(input)) calls.push(await ctx.tools.endSession({ ...WRITE_UP, summary: "x".repeat(1000), rewards: [] })); } };
    const t = await table(driver);
    await t.store.saveParty([...t.session.party]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(calls[0]).toMatchObject({ ok: true });
    expect((await sheetFile(t.store.dir, "doc")).history[0].summary).toBe(`${"x".repeat(599)}…`);
  });

  it("makes the updated sheets the ones in play, and tells the table what changed", async () => {
    const t = await wrapped(REWARDS);
    const kira = t.session.snapshot().party.find((s) => s.id === "kira")!;
    expect(kira.personal?.karma).toBe(4);
    const notices = t.session.snapshot().transcript.filter((e) => e.kind === "system").map((e) => e.kind === "system" && e.text);
    expect(notices[0]).toBe("After session 1, Kira: Karma 0 → 4; Nuyen 0 → 3,000; Gear is written as text, so + Medkit is in the history only; Contact Mr. Smith added (Loyalty 2, Connection 3); History: run 1 added");
    expect(notices[1]).toBe("After session 1, Doc: History: run 1 added");
  });

  it("gives the GM's driver the updated sheets, so it is told them next time", async () => {
    const refreshed: Array<readonly { id: string; personal?: { karma?: number } | undefined }[]> = [];
    const driver: GmDriver = { ...wrapUpWith(REWARDS), refreshParty: async (party) => void refreshed.push(party) };
    const t = await table(driver);
    await t.store.saveParty([...t.session.party]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.find((s) => s.id === "kira")?.personal?.karma).toBe(4);
  });

  it("refuses the whole write-up, saving and logging nothing, if any part cannot be applied, and says which", async () => {
    const t = await wrapped([{ characterId: "kira", nuyen: -50 }, { characterId: "doc", contacts: [{ name: "Fixer", loyalty: 1 }] }]);
    expect(t.calls[0]).toEqual({ ok: false, text: "The session was not written up, because: Kira: Kira has 0 nuyen and cannot spend 50. Doc: Fixer is a new contact, so give both Loyalty and Connection." });
    expect(t.session.snapshot().session.phase).toBe("open");
    await expect(t.log()).rejects.toThrow();
    expect((await sheetFile(t.store.dir, "kira")).history).toBeUndefined();
  });

  it("tells the table why a write-up was refused, once, since some reasons are not the GM's to fix", async () => {
    const calls: Array<{ ok: boolean; text: string }> = [];
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        if (!wrapping(input)) return;
        calls.push(await ctx.tools.endSession({ ...WRITE_UP, rewards: [{ characterId: "kira", nuyen: -50 }] }));
        calls.push(await ctx.tools.endSession({ ...WRITE_UP, rewards: [{ characterId: "kira", nuyen: -50 }] }));
      },
    };
    const t = await table(driver);
    await t.store.saveParty([...t.session.party]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    const told = t.session.snapshot().transcript.filter((e) => e.kind === "system" && e.text.startsWith("The session was not written up, because: Kira: Kira has 0 nuyen"));
    expect(told).toHaveLength(1);
    expect(calls.every((c) => !c.ok)).toBe(true);
  });

  it("refuses a character that is not at the table, and one given twice", async () => {
    const t = await wrapped([{ characterId: "nobody", karma: 1 }]);
    expect(t.calls[0]).toEqual({ ok: false, text: 'There is no character "nobody" at the table. The ids are kira, doc.' });
    const twice = await wrapped([{ characterId: "kira", karma: 1 }, { characterId: "kira", karma: 2 }]);
    expect(twice.calls[0]).toEqual({ ok: false, text: "kira is in the rewards twice. Give each character once." });
  });

  it("refuses more Karma or nuyen than one run can give, before anything is applied", async () => {
    const t = await wrapped([{ characterId: "kira", karma: 31 }]);
    expect(t.calls[0]).toMatchObject({ ok: false, text: expect.stringContaining("karma") });
    expect((await wrapped([{ characterId: "kira", nuyen: 500_001 }])).calls[0]).toMatchObject({ ok: false });
  });

  it("keeps the Edge rank a character burned out of their sheet file, and in play", async () => {
    const t = await table(wrapUpWith([]));
    const [kira, doc] = t.session.party as [(typeof t.session.party)[0], (typeof t.session.party)[0]];
    // As played: Kira has burned a point of Edge rank, so her sheet in play has one less than her file.
    await t.store.saveParty([kira, doc]);
    await t.store.saveState({ ...(await t.store.loadState() ?? { version: 1, opened: false, openRequested: false, turnCounter: 0, pending: [], results: [], pcs: [], npcs: [], healBudgets: [], combat: null, burned: {}, sessionNumber: 1, wrapUpRequested: false, ended: false, held: [] }), burned: { kira: 1 } });
    await t.session.close();
    const burned = await newSession(wrapUpWith([{ characterId: "kira", karma: 2 }]), { store: t.store, now: () => NOW, party: [{ ...kira, attributes: { ...kira.attributes, edge: kira.attributes.edge - 1 } }, doc] });
    await burned.session.start();
    await burned.session.whenIdle();
    await burned.session.say("kira", "x");
    await burned.session.whenIdle();
    await burned.session.wrapUp();
    await burned.session.whenIdle();
    expect((await sheetFile(t.store.dir, "kira")).attributes.edge).toBe(kira.attributes.edge);
    expect(burned.session.snapshot().party.find((s) => s.id === "kira")?.attributes.edge).toBe(kira.attributes.edge - 1);
  });

  it("ends the session even when a sheet cannot be saved, and tells the table", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await table(wrapUpWith(REWARDS));
    await t.store.saveParty([...t.session.party]);
    await writeFile(join(t.store.dir, "characters", "history"), "a file where the copy folder should be");
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "x");
    await t.session.whenIdle();
    await t.session.wrapUp();
    await t.session.whenIdle();
    expect(t.session.snapshot().session.phase).toBe("ended");
    expect(await t.log()).toContain("## Session 1");
    expect(t.session.snapshot().transcript.some((e) => e.kind === "system" && e.text.includes("sheet could not be saved"))).toBe(true);
    expect((await sheetFile(t.store.dir, "kira")).history).toBeUndefined();
    warn.mockRestore();
  });

  it("adds a second run after the first, numbered by the history", async () => {
    const calls: Array<{ ok: boolean; text: string }> = [];
    const t = await table(wrapUpWith([], calls));
    await t.store.saveParty([...t.session.party]);
    for (const mission of ["First.", "Second."]) {
      await t.session.start(mission);
      await t.session.whenIdle();
      await t.session.say("kira", "x");
      await t.session.whenIdle();
      await t.session.wrapUp();
      await t.session.whenIdle();
    }
    expect((await sheetFile(t.store.dir, "kira")).history.map((r: { run: number }) => r.run)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });
});

describe("recalling a character's history", () => {
  async function withRuns(count: number) {
    const runs = Array.from({ length: count }, (_, i) => ({ run: i + 1, date: `2081-04-${String(i + 1).padStart(2, "0")}`, summary: `Run ${i + 1} happened.`, campaign: "night-one", with: ["Doc"] }));
    const runner = toolRunner();
    const made = await newSession(runner.driver, { party: demoParty.map((s) => (s.id === "kira" ? { ...s, history: runs } : s)) });
    return { ask: (input: object) => runner.run(made.session, (ctx) => ctx.tools.recall(input)) };
  }

  it("reads back the latest five runs, newest first, and counts the earlier ones", async () => {
    const { ask } = await withRuns(8);
    const reply = await ask({ what: "history", name: "Kira" });
    expect(reply.ok).toBe(true);
    expect(reply.text.split("\n")).toEqual([
      "Kira's runs, newest first (5 of 8; 3 earlier not shown):",
      "Run 8 in night-one (2081-04-08): Run 8 happened. With: Doc.",
      "Run 7 in night-one (2081-04-07): Run 7 happened. With: Doc.",
      "Run 6 in night-one (2081-04-06): Run 6 happened. With: Doc.",
      "Run 5 in night-one (2081-04-05): Run 5 happened. With: Doc.",
      "Run 4 in night-one (2081-04-04): Run 4 happened. With: Doc.",
    ]);
  });

  it("gives as many as asked for, at most twenty", async () => {
    const { ask } = await withRuns(30);
    expect((await ask({ what: "history", name: "kira", last: 12 })).text.split("\n")).toHaveLength(13);
    const most = await ask({ what: "history", name: "kira", last: 20 });
    expect(most.text.split("\n")).toHaveLength(21);
    expect(most.text).toContain("(20 of 30; 10 earlier not shown)");
    expect((await ask({ what: "history", name: "kira", last: 21 })).ok).toBe(false);
  });

  it("is found by name in any capitals or by id, and says who is at the table when it is not found", async () => {
    const { ask } = await withRuns(1);
    expect((await ask({ what: "history", name: "KIRA" })).text).toContain("Kira's runs");
    expect((await ask({ what: "history", name: "ki" })).text).toContain("Kira's runs");
    expect(await ask({ what: "history", name: "Ana" })).toEqual({ ok: false, text: 'No player character called "Ana". At the table: Kira, Doc.' });
    expect(await ask({ what: "history" })).toEqual({ ok: false, text: "Say which character: give their name." });
  });

  it("says so when a character has no runs yet", async () => {
    const { ask } = await withRuns(0);
    expect(await ask({ what: "history", name: "Doc" })).toEqual({ ok: true, text: "Doc has no runs in their history yet." });
  });

  it("tells a run's goal and what came of it when it has them", async () => {
    const runner = toolRunner();
    const full = { run: 1, date: "2081-04-01", campaign: "night-one", summary: "Carried a case.", goal: "Deliver it unopened.", with: ["Doc"], consequences: "Paid 3,000 nuyen." };
    const made = await newSession(runner.driver, { party: demoParty.map((s) => (s.id === "kira" ? { ...s, history: [full] } : s)) });
    const reply = await runner.run(made.session, (ctx) => ctx.tools.recall({ what: "history", name: "kira" }));
    expect(reply.text.split("\n")[1]).toBe("Run 1 in night-one (2081-04-01): Carried a case. Goal: Deliver it unopened. With: Doc. Came of it: Paid 3,000 nuyen.");
  });

  it("still reads the session log for sessions, at most five at a time, the latest five oldest first", async () => {
    const log = "# Session Log\n\n" + Array.from({ length: 7 }, (_, i) => `## Session ${i + 1} — 2026-03-0${i + 1}\n\nBody ${i + 1}.\n`).join("\n");
    const runner = toolRunner();
    const store = await tempStore();
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, MEMORY_FILES.log), log);
    const made = await newSession(runner.driver, { store });
    const reply = await runner.run(made.session, (ctx) => ctx.tools.recall({ what: "sessions", last: 20 }));
    expect(reply.text.split("\n\n").map((s) => s.split("\n")[0])).toEqual(["Session 3 — 2026-03-03", "Session 4 — 2026-03-04", "Session 5 — 2026-03-05", "Session 6 — 2026-03-06", "Session 7 — 2026-03-07"]);
  });

  it("reads the session log with nothing in it", async () => {
    const { ask } = await withRuns(0);
    expect((await ask({ what: "sessions", last: 20 })).text).toBe("No sessions are logged yet.");
  });
});
