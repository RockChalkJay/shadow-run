import { describe, expect, it } from "vitest";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { newSession, rollInput } from "../helpers.js";

// Kira has Edge 3 (so 3 points). Rolling again is a test-mode tool: a held roll is thrown away and made again.
const ask = (over: object = {}) => rollInput({ pool: { total: 4, breakdown: "Agility 3 + Skill 1" }, threshold: 2, ...over });

/** A game whose GM does whatever job it is next given, and remembers what it was told. */
async function table(extra: Parameters<typeof newSession>[1] = {}) {
  const inputs: string[] = [];
  const jobs: Array<(ctx: GmTurnContext) => Promise<unknown>> = [];
  const driver: GmDriver = {
    async takeTurn(input, ctx) {
      inputs.push(input.text);
      await jobs.shift()?.(ctx);
    },
  };
  const made = await newSession(driver, extra);
  const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
  };
  const pending = () => made.session.snapshot().pendingRolls;
  const edge = () => made.session.snapshot().edge.find((e) => e.id === "kira")!;
  const request = async () => {
    await gm((tools) => tools.requestRoll(ask()));
    return pending().at(-1)!.id;
  };
  const counted = async () => (await made.store.recentEntries(50)).filter((e) => e.kind === "roll");
  return { ...made, inputs, gm, pending, edge, request, counted };
}

describe("rolling again", () => {
  it("throws a held roll's dice away and leaves the roll waiting for dice, as if it had not been rolled", async () => {
    const t = await table({ testMode: true });
    const id = await t.request();
    await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    expect(t.pending()[0]?.held?.roll.dice).toEqual([1, 1, 1, 1]);

    expect(await t.session.redoRoll(id)).toEqual({ ok: true });
    const { held, ...bare } = t.pending()[0]!;
    expect(held).toBeUndefined();
    expect(bare).toMatchObject({ id, label: "Sneak past the guard" });
    expect(t.events.filter((e) => e.type === "roll.updated").at(-1)).toMatchObject({ request: { id } });
    expect(t.events.filter((e) => e.type === "roll.updated").at(-1)).not.toHaveProperty("request.held");
  });

  it("costs nothing, and the GM hears only the roll that is kept", async () => {
    const t = await table({ testMode: true });
    const id = await t.request();
    const before = t.edge();
    const told = t.inputs.length;

    await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    await t.session.redoRoll(id);
    expect(t.edge()).toEqual(before);
    expect(t.inputs).toHaveLength(told);

    await t.session.submitRoll(id, { mode: "physical", dice: "6 6 6 6", hold: true });
    await t.session.keepRoll(id);
    await t.session.whenIdle();
    const rolls = await t.counted();
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ resolved: { roll: { dice: [6, 6, 6, 6] }, outcome: { success: true } } });
    expect(t.edge()).toEqual(before);
  });

  it("can be done again and again, and survives a restart in between", async () => {
    const first = await table({ testMode: true });
    const id = await first.request();
    for (const dice of ["1 1 1 1", "2 2 2 2", "3 3 3 3"]) {
      await first.session.submitRoll(id, { mode: "physical", dice, hold: true });
      await first.session.redoRoll(id);
    }
    await first.session.submitRoll(id, { mode: "physical", dice: "5 5 5 5", hold: true });
    await first.session.close();

    const second = await table({ testMode: true, store: first.store });
    expect(second.pending()[0]?.held?.roll.dice).toEqual([5, 5, 5, 5]);
    expect(await second.session.redoRoll(id)).toEqual({ ok: true });
    await second.session.close();
    const third = await table({ testMode: true, store: first.store });
    expect(third.pending()[0]).not.toHaveProperty("held");
  });

  it("is refused when the server is not in test mode, and the roll stays held", async () => {
    const t = await table();
    const id = await t.request();
    await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    expect(await t.session.redoRoll(id)).toEqual({ ok: false, error: "Rolling again is for testing. Start the server with SHADOWRUN_TEST_MODE=1 to use it." });
    expect(t.pending()[0]?.held).toBeDefined();
  });

  it("is refused for a roll that has not been rolled, and for one that is not there", async () => {
    const t = await table({ testMode: true });
    const id = await t.request();
    expect(await t.session.redoRoll(id)).toEqual({ ok: false, error: "That roll has not been rolled yet, so there is nothing to roll again." });
    expect(await t.session.redoRoll("nope")).toEqual({ ok: false, error: "That roll is not waiting; it may already have counted or been skipped." });
  });

  it("is refused once the roll has been kept", async () => {
    const t = await table({ testMode: true });
    const id = await t.request();
    await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    await t.session.keepRoll(id);
    expect(await t.session.redoRoll(id)).toEqual({ ok: false, error: "That roll is not waiting; it may already have counted or been skipped." });
  });

  it("drops a roll whose character has left the table, as any answer to it would", async () => {
    const first = await table({ testMode: true });
    const id = await first.request();
    await first.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    await first.session.close();
    const second = await table({ testMode: true, store: first.store, party: (await import("../helpers.js")).party.filter((m) => m.id !== "kira") });
    expect(await second.session.redoRoll(id)).toEqual({ ok: false, error: "That character is no longer at the table, so the roll was dropped." });
    expect(second.pending()).toHaveLength(0);
  });
});

/** Kira buys three hits on a roll, which is all 3 of her Edge points. */
async function spendAllEdge(t: Awaited<ReturnType<typeof table>>) {
  const id = await t.request();
  await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
  await t.session.spendEdge(id, { boost: "buy_hit", times: 1 });
  await t.session.whenIdle();
}

describe("holding a roll", () => {
  it("is refused without Edge to spend, as it always was", async () => {
    const t = await table();
    await spendAllEdge(t);
    const id = await t.request();
    const ack = await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true });
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining("Roll without holding.") });
  });

  it("is allowed in test mode with no Edge left, so every roll can be rolled again", async () => {
    const t = await table({ testMode: true });
    await spendAllEdge(t);
    const id = await t.request();
    expect(t.edge().points).toBe(0);
    expect(await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1", hold: true })).toEqual({ ok: true });
    expect(t.pending()[0]?.held).toBeDefined();
    expect(await t.session.keepRoll(id)).toEqual({ ok: true });
  });

  it("is still refused in test mode when Edge is spent on the roll itself", async () => {
    const t = await table({ testMode: true });
    const id = await t.request();
    const ack = await t.session.submitRoll(id, { mode: "app", edge: "dice", hold: true });
    expect(ack).toMatchObject({ ok: false });
    expect(t.pending()[0]?.held).toBeUndefined();
  });
});

describe("the snapshot", () => {
  it("says whether the table is in test mode", async () => {
    expect((await table()).session.snapshot().testMode).toBe(false);
    expect((await table({ testMode: true })).session.snapshot().testMode).toBe(true);
  });
});
