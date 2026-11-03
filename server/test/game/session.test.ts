import type { GmEvent } from "@shadow-run/shared";
import { describe, expect, it, vi } from "vitest";
import type { GmDriver, GmTurnContext, GmTurnInput } from "../../src/gm/driver.js";
import { demoScript, ScriptedGmDriver, type ScriptedTurn } from "../../src/gm/scriptedDriver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import type { GameSession } from "../../src/game/session.js";
import { MAX_PENDING_ROLLS } from "../../src/game/rollManager.js";
import { MemoryStore, newSession, party, rollInput, toolRunner, types } from "../helpers.js";

const scripted = (turns: ScriptedTurn[]) => new ScriptedGmDriver(turns);

/** A driver whose turns end only when the test releases them. */
function gated() {
  const gates: Array<() => void> = [];
  const inputs: GmTurnInput[] = [];
  let running = 0;
  let maxRunning = 0;
  let onTurn: ((ctx: GmTurnContext) => Promise<void> | void) | undefined;
  let failure: string | undefined;
  const driver: GmDriver = {
    async takeTurn(input, ctx) {
      inputs.push(input);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await onTurn?.(ctx);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      if (failure !== undefined) {
        const message = failure;
        failure = undefined;
        throw new Error(message);
      }
      ctx.onEvent({ type: "text", text: "ok" });
    },
  };
  return {
    driver,
    inputs,
    release: () => gates.shift()?.(),
    /** Makes the turn that is released next fail. */
    failNext: (message: string) => {
      failure = message;
    },
    get maxRunning() {
      return maxRunning;
    },
    set onTurn(fn: (ctx: GmTurnContext) => Promise<void> | void) {
      onTurn = fn;
    },
  };
}

/** A driver that never finishes by itself and rejects when aborted. */
const stuck = (): GmDriver => ({
  takeTurn: (_input, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true })),
});

describe("beginning", () => {
  it("opens the first scene and records what the GM said, one paragraph per block", async () => {
    const driver = scripted([{ say: ["Rain falls.", "A door opens."] }]);
    const { session, events, store } = await newSession(driver);

    expect(await session.start()).toEqual({ ok: true });
    await session.whenIdle();

    expect(driver.inputs).toEqual([{ kind: "open", text: "BEGIN SESSION. Open the first scene." }]);
    expect(types(events).filter((t) => t === "gm.block")).toHaveLength(2);
    expect(types(events)).toContain("gm.turn_done");
    const gm = (await store.recentEntries(10)).find((e) => e.kind === "gm");
    expect(gm).toMatchObject({ text: "Rain falls.\n\nA door opens." });
    expect(events.filter((e) => e.type === "gm.status").map((e) => (e as { status: { phase: string } }).status.phase)).toEqual(["thinking", "idle"]);
  });

  it("will not begin twice", async () => {
    const { session } = await newSession(scripted([{ say: ["Hi."] }]));
    await session.start();
    await session.whenIdle();
    expect(await session.start()).toEqual({ ok: false, error: "The session has already begun." });
  });

  it("opens with a player's first words if they speak before anyone starts it", async () => {
    const driver = scripted([{ say: ["Welcome."] }]);
    const { session } = await newSession(driver);
    await session.say("kira", "Is anyone here?");
    await session.whenIdle();
    expect(driver.inputs[0]).toEqual({ kind: "open", text: "BEGIN SESSION. Open the first scene.\n\nThe players say:\n- Kira: Is anyone here?" });
  });
});

describe("a roll", () => {
  it("is asked for, held until the dice come in, then reported to the GM", async () => {
    const driver = scripted([{ say: ["The guard turns."], rolls: [rollInput()] }, { say: ["You slip by."] }]);
    const { session, events, store } = await newSession(driver, { d6: scriptedD6([6, 5, 3, 1]) });

    await session.start();
    await session.whenIdle();
    const requested = events.find((e) => e.type === "roll.requested");
    expect(requested).toMatchObject({ request: { characterId: "kira", label: "Sneak past the guard" } });
    expect(session.snapshot().gm).toEqual({ phase: "waiting_for_rolls" });
    expect(driver.inputs).toHaveLength(1);

    const id = (requested as { request: { id: string } }).request.id;
    expect(await session.submitRoll(id, { mode: "app" })).toEqual({ ok: true });
    await session.whenIdle();

    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1]?.kind).toBe("continue");
    expect(driver.inputs[1]?.text).toContain("ROLL RESULT. Kira: Sneak past the guard.");
    expect(driver.inputs[1]?.text).toContain("6 5 3 1 = 2 hits");
    expect((await store.recentEntries(20)).map((e) => e.kind)).toEqual(["gm", "roll", "gm"]);
    expect(session.snapshot().gm).toEqual({ phase: "idle" });
  });

  it("keeps anything said while dice are owed and delivers it with the result", async () => {
    const driver = scripted([{ rolls: [rollInput()] }, { say: ["ok"] }]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();

    await session.say("kira", "Wait, I check my gun first.");
    await session.whenIdle();
    expect(driver.inputs).toHaveLength(1);

    const id = (events.find((e) => e.type === "roll.requested") as { request: { id: string } }).request.id;
    await session.submitRoll(id, { mode: "physical", dice: "6 5 3 1" });
    await session.whenIdle();
    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1]?.text).toMatch(/ROLL RESULT[\s\S]*The players say:\n- Kira: Wait, I check my gun first\./);
  });

  it("waits for every roll the GM asked for, then reports them together", async () => {
    const driver = scripted([
      { rolls: [rollInput(), rollInput({ characterId: "doc", label: "Spot the camera" })] },
      { say: ["ok"] },
    ]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    const [first, second] = events.filter((e) => e.type === "roll.requested").map((e) => (e as { request: { id: string } }).request.id);

    await session.submitRoll(first!, { mode: "physical", dice: "6 5 3 1" });
    await session.whenIdle();
    expect(driver.inputs).toHaveLength(1);

    await session.submitRoll(second!, { mode: "physical", dice: "1 2 3 4" });
    await session.whenIdle();
    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1]?.text).toContain("Kira: Sneak past the guard");
    expect(driver.inputs[1]?.text).toContain("Doc: Spot the camera");
  });

  it("can be skipped, and the GM is told to apply nothing", async () => {
    const driver = scripted([{ rolls: [rollInput()] }, { say: ["ok"] }]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    const id = (events.find((e) => e.type === "roll.requested") as { request: { id: string } }).request.id;

    expect(await session.cancelRoll(id)).toEqual({ ok: true });
    await session.whenIdle();
    expect(events).toContainEqual({ type: "roll.cancelled", requestId: id });
    expect(driver.inputs[1]?.text).toContain("ROLL SKIPPED. The table skipped Kira's roll");
    expect(await session.cancelRoll(id)).toMatchObject({ ok: false });
  });

  it("is refused if the dice are wrong, and stays pending", async () => {
    const driver = scripted([{ rolls: [rollInput()] }]);
    const { session, events, store } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    const id = (events.find((e) => e.type === "roll.requested") as { request: { id: string } }).request.id;

    expect(await session.submitRoll(id, { mode: "physical", dice: "6 5" })).toEqual({ ok: false, error: "This roll is 4 dice; you entered 2." });
    expect(await session.submitRoll("nope", { mode: "app" })).toMatchObject({ ok: false });
    expect(session.snapshot().pendingRolls).toHaveLength(1);
    expect((await store.recentEntries(20)).some((e) => e.kind === "roll")).toBe(false);
  });

  it("can be requested by the GM only for someone at the table, with a reason it can act on", async () => {
    const runner = toolRunner();
    const { session, events } = await newSession(runner.driver);
    const [bad, good] = await runner.run(session, async (ctx) => [
      await ctx.tools.requestRoll(rollInput({ characterId: "nobody" })),
      await ctx.tools.requestRoll(rollInput()),
    ]);
    expect(bad).toEqual({ ok: false, text: 'There is no character "nobody" at the table.' });
    expect(good).toMatchObject({ ok: true, text: expect.stringContaining("End your turn now") });
    expect(events.filter((e) => e.type === "roll.requested")).toHaveLength(1);
  });

  it("is limited in how many can wait at once, so a GM stuck in a loop cannot flood the table", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver);
    const replies = await runner.run(session, async (ctx) => {
      const out = [];
      for (let i = 0; i < 12; i++) out.push(await ctx.tools.requestRoll(rollInput()));
      return out;
    });
    expect(replies.filter((r) => r.ok)).toHaveLength(MAX_PENDING_ROLLS);
    expect(replies[MAX_PENDING_ROLLS]).toMatchObject({ ok: false, text: expect.stringContaining("Stop asking") });
    expect(session.snapshot().pendingRolls).toHaveLength(MAX_PENDING_ROLLS);
  });
});

describe("the GM's tools", () => {
  it("stop working once the turn they belong to is over", async () => {
    const runner = toolRunner();
    const { session, events } = await newSession(runner.driver);
    const ctx = await runner.run(session, async (turn) => turn);

    const late = await ctx.tools.requestRoll(rollInput());
    expect(late).toMatchObject({ ok: false, text: expect.stringContaining("That turn is over") });
    expect(await ctx.tools.rollNpc({ label: "x", pool: 3 })).toMatchObject({ ok: false });
    expect(session.snapshot().pendingRolls).toHaveLength(0);
    expect(events.some((e) => e.type === "roll.requested")).toBe(false);
  });

  it("stop working the moment the turn is cancelled, even before the GM process has exited", async () => {
    let captured: GmTurnContext | undefined;
    const driver: GmDriver = {
      takeTurn: (_input, ctx) => {
        captured = ctx;
        return new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
      },
    };
    const { session, events } = await newSession(driver);
    await session.say("kira", "hi");
    await vi.waitFor(() => expect(captured).toBeDefined());

    expect(await captured!.tools.requestRoll(rollInput())).toMatchObject({ ok: true });
    session.cancelTurn();
    expect(await captured!.tools.requestRoll(rollInput())).toMatchObject({ ok: false });
    await session.whenIdle();
    expect(events.filter((e) => e.type === "roll.requested")).toHaveLength(1);
  });

  it("do not work for a turn that has been replaced by a newer one", async () => {
    const contexts: GmTurnContext[] = [];
    const driver: GmDriver = { takeTurn: async (_input, ctx) => void contexts.push(ctx) };
    const { session } = await newSession(driver);
    await session.say("kira", "one");
    await session.whenIdle();
    await session.say("kira", "two");
    await session.whenIdle();

    expect(contexts).toHaveLength(2);
    expect(await contexts[0]!.tools.requestRoll(rollInput())).toMatchObject({ ok: false });
    expect(session.snapshot().pendingRolls).toHaveLength(0);
  });
});

describe("turns", () => {
  it("run one at a time, and what is said during one is heard in the next", async () => {
    const g = gated();
    const { session } = await newSession(g.driver);

    await session.say("kira", "first");
    await vi.waitFor(() => expect(g.inputs).toHaveLength(1));
    await session.say("doc", "second");
    await session.say("kira", "third");
    expect(g.inputs).toHaveLength(1);

    g.release();
    await vi.waitFor(() => expect(g.inputs).toHaveLength(2));
    expect(g.inputs[1]?.text).toBe("The players say:\n- Doc: second\n- Kira: third");
    g.release();
    await session.whenIdle();
    expect(g.maxRunning).toBe(1);
  });

  it("hear every message exactly once however fast they arrive", async () => {
    const heard: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const driver: GmDriver = {
      async takeTurn(input) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        heard.push(...[...input.text.matchAll(/- Kira: (m\d+)/g)].map((m) => m[1]!));
        await new Promise((resolve) => setImmediate(resolve));
        running--;
      },
    };
    const { session } = await newSession(driver);
    const sent = Array.from({ length: 25 }, (_, i) => `m${i}`);
    await Promise.all(
      sent.map(async (text, i) => {
        if (i % 3 === 0) await new Promise((resolve) => setImmediate(resolve));
        await session.say("kira", text);
      }),
    );
    await session.whenIdle();
    expect(heard.sort()).toEqual([...sent].sort());
    expect(maxRunning).toBe(1);
  });

  it("do not lose a message that arrives just as a turn is finishing", async () => {
    // A message can land in the instant after the loop decides there is nothing left to do. Walk its
    // arrival across every microtask offset near the end of a turn, so a change that opens a gap there fails.
    for (let ticks = 0; ticks < 40; ticks++) {
      const heard: string[] = [];
      let late: Promise<unknown> | undefined;
      let table: GameSession | undefined;
      const driver: GmDriver = {
        async takeTurn(input) {
          heard.push(input.text);
          if (input.text.includes("first")) {
            for (let i = 0; i < ticks; i++) await Promise.resolve();
            late = table?.say("doc", "late");
          }
        },
      };
      const { session } = await newSession(driver, { store: new MemoryStore() });
      table = session;
      await session.say("kira", "first");
      await session.whenIdle();
      await late;
      await session.whenIdle();
      expect(heard.join("\n"), `message sent ${ticks} ticks into the turn`).toContain("- Doc: late");
    }
  });

  it("take a roll answered while the GM is still speaking into the next turn", async () => {
    const g = gated();
    g.onTurn = async (ctx) => {
      if (g.inputs.length === 1) await ctx.tools.requestRoll(rollInput());
    };
    const { session, events } = await newSession(g.driver);
    await session.start();
    await vi.waitFor(() => expect(events.some((e) => e.type === "roll.requested")).toBe(true));
    const id = (events.find((e) => e.type === "roll.requested") as { request: { id: string } }).request.id;

    await session.submitRoll(id, { mode: "physical", dice: "6 5 3 1" });
    expect(g.inputs).toHaveLength(1);
    g.release();
    await vi.waitFor(() => expect(g.inputs).toHaveLength(2));
    expect(g.inputs[1]?.text).toContain("ROLL RESULT");
    g.release();
    await session.whenIdle();
  });

  it("refuse words from someone who is not at the table", async () => {
    const { session } = await newSession(scripted([]));
    expect(await session.say("nobody", "hello")).toEqual({ ok: false, error: 'There is no character "nobody" at the table.' });
  });

  it("let the table speak without a character", async () => {
    const driver = scripted([{ say: ["ok"] }]);
    const { session } = await newSession(driver);
    await session.say(undefined, "Can we take a break?");
    await session.whenIdle();
    expect(driver.inputs[0]?.text).toContain("- Table: Can we take a break?");
  });
});

describe("when a turn fails", () => {
  it("keeps what the GM was told, waits, and tries again with it on retry", async () => {
    const driver = scripted([{ fail: "boom" }, { say: ["Back now."] }]);
    const { session, store, events } = await newSession(driver);
    await session.say("kira", "hello");
    await session.whenIdle();

    expect(session.snapshot().gm).toEqual({ phase: "error", message: "boom" });
    expect((await store.recentEntries(10)).at(-1)).toMatchObject({ kind: "system", text: "The GM's turn failed: boom" });
    expect(driver.inputs).toHaveLength(1);

    expect(session.retry()).toEqual({ ok: true });
    await session.whenIdle();
    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1]).toEqual({ kind: "open", text: "BEGIN SESSION. Open the first scene.\n\nThe players say:\n- Kira: hello" });
    expect(session.snapshot().gm).toEqual({ phase: "idle" });
    expect(events.filter((e) => e.type === "gm.turn_done")).toHaveLength(2);
  });

  it("retries when someone speaks, with the old message and the new one", async () => {
    const driver = scripted([{ fail: "boom" }, { say: ["ok"] }]);
    const { session } = await newSession(driver);
    await session.say("kira", "one");
    await session.whenIdle();
    await session.say("doc", "two");
    await session.whenIdle();
    expect(driver.inputs[1]?.text).toContain("- Kira: one\n- Doc: two");
  });

  it("does not repeat a failed turn by itself", async () => {
    const driver = scripted([{ fail: "boom" }]);
    const { session } = await newSession(driver);
    await session.say("kira", "hi");
    await session.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(driver.inputs).toHaveLength(1);
    expect(session.retry()).toEqual({ ok: true });
    expect(session.retry()).toEqual({ ok: false, error: "There is nothing to retry." });
  });

  it("waits for a retry, not hammering a failing GM, when a message arrived during the turn that failed", async () => {
    const g = gated();
    const { session } = await newSession(g.driver);
    await session.say("kira", "one");
    await vi.waitFor(() => expect(g.inputs).toHaveLength(1));
    await session.say("doc", "two");
    g.failNext("boom");
    g.release();
    await session.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(g.inputs).toHaveLength(1);
    expect(session.snapshot().gm).toMatchObject({ phase: "error", message: "boom" });

    session.retry();
    await vi.waitFor(() => expect(g.inputs).toHaveLength(2));
    expect(g.inputs[1]?.text).toContain("- Kira: one\n- Doc: two");
    g.release();
    await session.whenIdle();
  });

  it("keeps roll results the GM never heard", async () => {
    const driver = scripted([{ rolls: [rollInput()] }, { fail: "boom" }, { say: ["ok"] }]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    const id = (events.find((e) => e.type === "roll.requested") as { request: { id: string } }).request.id;
    await session.submitRoll(id, { mode: "physical", dice: "6 5 3 1" });
    await session.whenIdle();
    expect(session.snapshot().gm.phase).toBe("error");

    session.retry();
    await session.whenIdle();
    expect(driver.inputs[2]?.text).toContain("ROLL RESULT. Kira");
  });

  it("can be stopped mid-turn, and what was said waits for the next one", async () => {
    const { session, store } = await newSession(stuck());
    await session.say("kira", "hi");
    await vi.waitFor(async () => expect(session.snapshot().gm.phase).toBe("thinking"));

    expect(session.cancelTurn()).toEqual({ ok: true });
    await session.whenIdle();
    expect(session.snapshot().gm).toEqual({ phase: "error", message: "The turn was cancelled." });
    expect((await store.recentEntries(10)).at(-1)).toMatchObject({ kind: "system", text: "The turn was cancelled." });
    expect(session.cancelTurn()).toEqual({ ok: false, error: "The GM is not in the middle of a turn." });
  });

  it("is stopped when it takes too long", async () => {
    const { session } = await newSession(stuck(), { turnTimeoutMs: 30 });
    await session.say("kira", "hi");
    await session.whenIdle();
    expect(session.snapshot().gm).toEqual({ phase: "error", message: "The GM took too long to answer." });
  });

  it("is treated as an error when the driver reports one but returns normally", async () => {
    const driver: GmDriver = { takeTurn: async (_i, ctx) => ctx.onEvent({ type: "error", message: "claude ended the turn with an error: boom" }) };
    const { session } = await newSession(driver);
    await session.say("kira", "hi");
    await session.whenIdle();
    expect(session.snapshot().gm).toMatchObject({ phase: "error", message: expect.stringContaining("boom") });
  });

  it("keeps the narration the table already saw", async () => {
    const driver: GmDriver = {
      async takeTurn(_i, ctx) {
        ctx.onEvent({ type: "text", text: "Half a sentence" });
        throw new Error("cut off");
      },
    };
    const { session, store } = await newSession(driver);
    await session.say("kira", "hi");
    await session.whenIdle();
    expect((await store.recentEntries(10)).map((e) => e.kind)).toEqual(["say", "gm", "system"]);
  });

  it("rests, rather than errors, when the plan's usage limit is reached", async () => {
    const { session, store } = await newSession(scripted([{ fail: "You've hit your usage limit" }]));
    await session.say("kira", "hi");
    await session.whenIdle();
    const { gm } = session.snapshot();
    expect(gm).toMatchObject({ phase: "resting", until: null });
    expect((await store.recentEntries(10)).at(-1)).toMatchObject({ kind: "system", text: expect.stringContaining("usage limit") });
  });

  it("says when the window resets, if the CLI reported the usage", async () => {
    const driver: GmDriver = {
      async takeTurn(_i, ctx) {
        ctx.onEvent({ type: "rate_limit", fiveHourUtilization: 1, resetsAt: 1_000_600 });
        throw new Error("claude exited with code 1");
      },
    };
    const { session, events } = await newSession(driver, { now: () => new Date(1_000_000 * 1000) });
    await session.say("kira", "hi");
    await session.whenIdle();
    expect(session.snapshot().gm).toMatchObject({ phase: "resting", until: 1_000_600 });
    expect(events).toContainEqual({ type: "usage", usage: { fiveHourUtilization: 1, resetsAt: 1_000_600 } });
  });
});

describe("rolling for non-player characters", () => {
  it("rolls with the system's dice, shows the table, and tells the GM", async () => {
    const runner = toolRunner();
    const { session, store, events } = await newSession(runner.driver, { d6: scriptedD6([6, 5, 2, 1]) });
    const reply = await runner.run(session, (ctx) => ctx.tools.rollNpc({ label: "Ganger fires", pool: 4, threshold: 2 }));
    expect(reply).toEqual({
      ok: true,
      text: "NPC ROLL. Ganger fires: 4 dice: 6 5 2 1 = 2 hits.\nThreshold 2: SUCCESS.",
    });
    const npc = (await store.recentEntries(10)).find((e) => e.kind === "npc");
    expect(npc).toMatchObject({ kind: "npc", label: "Ganger fires", pool: 4, threshold: 2, success: true });
    expect(events.some((e) => e.type === "entry" && e.entry.kind === "npc")).toBe(true);
  });

  it("refuses a pool that is out of range", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver);
    const replies = await runner.run(session, async (ctx) => [
      await ctx.tools.rollNpc({ label: "x", pool: 101 }),
      await ctx.tools.rollNpc({ label: "x", pool: -1 }),
      await ctx.tools.rollNpc({ pool: 3 }),
    ]);
    expect(replies.every((r) => !r.ok)).toBe(true);
  });
});

describe("a restart", () => {
  it("brings back the roll that was waiting and the fact the session had begun", async () => {
    const first = await newSession(scripted([{ say: ["Rain."], rolls: [rollInput()] }]));
    await first.session.start();
    await first.session.whenIdle();
    await first.session.close();

    const driver = scripted([{ say: ["You slip by."] }]);
    const second = await newSession(driver, { store: first.store });
    const snapshot = second.session.snapshot();
    expect(snapshot.pendingRolls).toHaveLength(1);
    expect(snapshot.gm).toEqual({ phase: "waiting_for_rolls" });
    expect(snapshot.transcript.map((e) => e.kind)).toEqual(["gm"]);
    expect(second.session.gmSessionId).toBe("scripted");

    await second.session.submitRoll(snapshot.pendingRolls[0]!.id, { mode: "physical", dice: "6 5 3 1" });
    await second.session.whenIdle();
    expect(driver.inputs[0]?.kind).toBe("continue");
    expect(driver.inputs[0]?.text).toContain("ROLL RESULT. Kira");
  });

  it("keeps a roll the GM asked for even if the server stops in the middle of that turn", async () => {
    const g = gated();
    g.onTurn = (ctx) => void ctx.tools.requestRoll(rollInput());
    const first = await newSession(g.driver);
    await first.session.say("kira", "go");
    // The card is announced only once the roll has been saved.
    await vi.waitFor(() => expect(first.events.some((e) => e.type === "roll.requested")).toBe(true));

    // The turn has not ended and nothing was closed: this is a crash.
    const second = await newSession(scripted([]), { store: first.store });
    expect(second.session.snapshot().pendingRolls).toHaveLength(1);
    g.release();
    await first.session.whenIdle();
  });

  it("gives the GM what it never heard before the server stopped", async () => {
    const first = await newSession(scripted([{ fail: "boom" }]));
    await first.session.say("kira", "hello");
    await first.session.whenIdle();
    await first.session.close();

    const driver = scripted([{ say: ["Welcome back."] }]);
    const second = await newSession(driver, { store: first.store });
    second.session.resume();
    await second.session.whenIdle();
    expect(driver.inputs[0]?.text).toContain("- Kira: hello");
  });
});

describe("snapshot", () => {
  it("gives a newly connected client everything it needs to catch up", async () => {
    const driver = scripted([{ say: ["Rain."], rolls: [rollInput()] }]);
    const { session } = await newSession(driver);
    await session.say("kira", "ready");
    await session.whenIdle();
    const snapshot = session.snapshot();
    expect(snapshot).toMatchObject({
      type: "snapshot",
      gm: { phase: "waiting_for_rolls" },
      usage: null,
    });
    expect(snapshot.party.map((m) => m.id)).toEqual(["kira", "doc"]);
    expect(snapshot.pendingRolls).toHaveLength(1);
    expect(snapshot.transcript.map((e) => e.kind)).toEqual(["say", "gm"]);
  });
});

describe("the events a client sees", () => {
  it("tag narration with its turn", async () => {
    const driver = scripted([{ say: ["One.", "Two."] }]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    const turned = events.filter((e): e is Extract<typeof e, { turnId: number }> => "turnId" in e);
    expect(new Set(turned.map((e) => e.turnId))).toEqual(new Set([1]));
    // A block event marks each paragraph break; the text itself carries no separator.
    const narration = events.filter((e) => e.type === "gm.block" || e.type === "gm.text").map((e) => (e.type === "gm.block" ? "|" : (e as { text: string }).text));
    expect(narration).toEqual(["|", "One.", "|", "Two."]);
  });

  it("report usage from the CLI", async () => {
    const driver: GmDriver = {
      async takeTurn(_i, ctx) {
        const event: GmEvent = { type: "rate_limit", fiveHourUtilization: 0.25, resetsAt: 123 };
        ctx.onEvent(event);
      },
    };
    const { session, events } = await newSession(driver);
    await session.say("kira", "hi");
    await session.whenIdle();
    expect(events).toContainEqual({ type: "usage", usage: { fiveHourUtilization: 0.25, resetsAt: 123 } });
    expect(session.snapshot().usage).toEqual({ fiveHourUtilization: 0.25, resetsAt: 123 });
  });
});

describe("the demo script", () => {
  it("opens the scene once, and after a restart carries on instead of starting over", async () => {
    const first = await newSession(new ScriptedGmDriver(demoScript(party)));
    await first.session.start();
    await first.session.whenIdle();
    const [pending] = first.session.snapshot().pendingRolls;
    await first.session.submitRoll(pending!.id, { mode: "physical", dice: "6 5 5 1 4 2 3 3" });
    await first.session.whenIdle();
    await first.session.close();

    // A new process has a new driver that has counted no turns.
    const driver = new ScriptedGmDriver(demoScript(party));
    const second = await newSession(driver, { store: first.store });
    await second.session.say("kira", "Still here?");
    await second.session.whenIdle();
    expect(driver.inputs[0]?.kind).toBe("continue");
    expect(second.session.snapshot().pendingRolls).toHaveLength(0);
    expect((await second.store.recentEntries(20)).filter((e) => e.kind === "gm")).toHaveLength(3);
  });
});
