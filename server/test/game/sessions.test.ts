import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@shadow-run/shared";
import { MEMORY_FILES } from "../../src/game/campaignMemory.js";
import type { GmDriver } from "../../src/gm/driver.js";
import { ScriptedGmDriver, type ScriptedTurn } from "../../src/gm/scriptedDriver.js";
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
    expect(kinds).toEqual(["session", "gm", "gm", "session"]);
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
