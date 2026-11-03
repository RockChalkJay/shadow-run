import { describe, expect, it } from "vitest";
import type { GmDriver, GmTurnContext, GmTurnInput } from "../../src/gm/driver.js";
import { ScriptedGmDriver, type ScriptedTurn } from "../../src/gm/scriptedDriver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { MAX_PENDING_ROLLS } from "../../src/game/rollManager.js";
import { newSession, party, rollInput, toolRunner } from "../helpers.js";

// Kira: Body 5, Willpower 3 -> Physical 11, Stun 10, Overflow 10. Doc: Body 3, Willpower 5 -> Physical 10, Stun 11, Overflow 6.
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const hurt = (target: object, damageValue: number, damageType = "physical", label = "Ganger's pistol") => ({ label, target, damageValue, damageType });
const kira = { kind: "pc", id: "kira" };

const requestedId = (events: Array<{ type: string }>) =>
  (events.find((e) => e.type === "roll.requested") as unknown as { request: { id: string } }).request.id;

/** A session where the GM, on its first turn, deals this damage and then speaks. */
async function dealt(damage: object[], d6: number[] = [], extra: ScriptedTurn[] = [{ say: ["It goes on."] }]) {
  const driver = new ScriptedGmDriver([{ damage }, ...extra]);
  const made = await newSession(driver, { d6: scriptedD6(d6) });
  await made.session.start();
  await made.session.whenIdle();
  return { driver, ...made };
}

/**
 * A table where the GM's first turn deals damage and, once the player's resistance roll is answered with
 * `soakDice`, the session carries on; `run` then makes the GM take a later turn that does whatever you give it.
 */
async function afterwards(damage: object[], soakDice: string) {
  let job: ((ctx: GmTurnContext) => Promise<unknown>) | undefined;
  let result: unknown;
  const inputs: GmTurnInput[] = [];
  const driver: GmDriver = {
    async takeTurn(input, ctx) {
      inputs.push(input);
      if (input.kind === "open") {
        for (const call of damage) await ctx.tools.dealDamage(call);
        return;
      }
      const next = job;
      job = undefined;
      if (next) result = await next(ctx);
    },
  };
  const made = await newSession(driver);
  await made.session.start();
  await made.session.whenIdle();
  await made.session.submitRoll(requestedId(made.events), { mode: "physical", dice: soakDice });
  await made.session.whenIdle();
  const run = async <T>(fn: (ctx: GmTurnContext) => Promise<T>): Promise<T> => {
    job = fn;
    await made.session.say("kira", "Anyone there?");
    await made.session.whenIdle();
    return result as T;
  };
  return { ...made, inputs, run };
}

describe("hurting a non-player character", () => {
  it("rolls their Body for them, applies what gets through, and tells the GM at once", async () => {
    const runner = toolRunner();
    const { session, events, store } = await newSession(runner.driver, { d6: scriptedD6([5, 2, 1]) });
    const reply = await runner.run(session, (ctx) => ctx.tools.dealDamage(hurt(ganger, 6)));

    expect(reply).toEqual({
      ok: true,
      text: [
        "DAMAGE RESULT. Ganger's pistol: 6 physical damage to Ganger.",
        "Ganger resisted with Body 3 (the system's dice): 5 2 1 = 1 hit, so 5 physical damage got through.",
        "Ganger: Physical 5/10, Stun 0/10, Overflow 0/6. Wound penalty: -1 dice on everything but damage resistance.",
      ].join("\n"),
    });
    expect(session.snapshot().characters.find((c) => c.id === "ganger-1")).toMatchObject({ kind: "npc", status: "active", monitor: { physical: 5 } });
    expect(events).toContainEqual({ type: "character.updated", character: expect.objectContaining({ id: "ganger-1", kind: "npc" }) });
    const entry = (await store.recentEntries(10)).find((e) => e.kind === "damage");
    expect(entry).toMatchObject({ label: "Ganger's pistol", damageValue: 6, taken: 5, resistedBy: "system", resistance: { dice: [5, 2, 1], hits: 1 } });
    expect(session.snapshot().pendingRolls).toHaveLength(0);
  });

  it("takes an NPC out as they fill up: unconscious from stun, dead from overflow", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver, { d6: scriptedD6([2, 2, 2, 2, 2, 2]) });
    const [stunned, killed] = await runner.run(session, async (ctx) => [
      await ctx.tools.dealDamage(hurt(ganger, 10, "stun", "Stun baton")),
      await ctx.tools.dealDamage(hurt({ kind: "npc", id: "ganger-1" }, 16, "physical", "Shotgun")),
    ]);
    expect(stunned.text).toContain("Ganger is UNCONSCIOUS and out of the action until healed.");
    expect(killed.text).toContain("Ganger is DEAD.");
    expect(session.snapshot().characters.find((c) => c.id === "ganger-1")?.status).toBe("dead");
  });

  it("will not hurt the dead again", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver, { d6: scriptedD6([2, 2, 2]) });
    const [, again] = await runner.run(session, async (ctx) => [
      await ctx.tools.dealDamage(hurt(ganger, 30)),
      await ctx.tools.dealDamage(hurt({ kind: "npc", id: "ganger-1" }, 3)),
    ]);
    expect(again).toEqual({ ok: false, text: "Ganger is already dead." });
  });
});

describe("hurting a player character", () => {
  it("puts a Body roll in front of the player, then applies it and tells the GM how they stand", async () => {
    const { session, events, driver, store } = await dealt([hurt(kira, 8)], [], [{ say: ["The round tears through her arm."] }]);

    expect(driver.inputs).toHaveLength(1);
    const [card] = session.snapshot().pendingRolls;
    expect(card).toMatchObject({
      characterId: "kira",
      label: "Resist 8P damage: Ganger's pistol",
      pool: { total: 5, breakdown: "Body 5" },
      soak: { damageValue: 8, damageType: "physical", source: "Ganger's pistol" },
    });
    expect(session.snapshot().gm).toEqual({ phase: "waiting_for_rolls" });

    await session.submitRoll(requestedId(events), { mode: "physical", dice: "6 5 3 1 1" });
    await session.whenIdle();

    // Two hits blocked two points, so six got through.
    expect(session.snapshot().characters.find((c) => c.id === "kira")).toMatchObject({ monitor: { physical: 6 }, woundModifier: 2, status: "active" });
    expect(events).toContainEqual({ type: "character.updated", character: expect.objectContaining({ id: "kira", monitor: expect.objectContaining({ physical: 6 }) }) });
    expect(driver.inputs[1]?.text).toContain("DAMAGE RESULT. Ganger's pistol: 8 physical damage to Kira.");
    expect(driver.inputs[1]?.text).toContain("Kira resisted with Body 5 (dice at the table): 6 5 3 1 1 = 2 hits, so 6 physical damage got through.");
    expect(driver.inputs[1]?.text).toContain("Kira: Physical 6/11, Stun 0/10, Overflow 0/10. Wound penalty: -2 dice");
    expect(driver.inputs[1]?.text).not.toContain("ROLL RESULT");
    expect((await store.recentEntries(20)).map((e) => e.kind)).toEqual(["roll", "damage", "gm"]);
  });

  it("uses the app's dice when asked", async () => {
    const { session, events } = await dealt([hurt(kira, 4)], [6, 6, 1, 1, 1]);
    await session.submitRoll(requestedId(events), { mode: "app" });
    await session.whenIdle();
    expect(session.snapshot().characters.find((c) => c.id === "kira")?.monitor.physical).toBe(2);
  });

  it("cannot be skipped, because skipping would dodge the wound", async () => {
    const { session, events } = await dealt([hurt(kira, 8)]);
    const id = requestedId(events);
    expect(await session.cancelRoll(id)).toMatchObject({ ok: false, error: expect.stringContaining("cannot be skipped") });
    expect(session.snapshot().pendingRolls).toHaveLength(1);
    expect(session.snapshot().characters.find((c) => c.id === "kira")?.monitor.physical).toBe(0);
  });

  it("takes only what gets past the resistance, and nothing when every point is blocked", async () => {
    const { session, events, driver } = await dealt([hurt(kira, 3)]);
    await session.submitRoll(requestedId(events), { mode: "physical", dice: "6 6 5 5 1" });
    await session.whenIdle();
    expect(session.snapshot().characters.find((c) => c.id === "kira")?.monitor.physical).toBe(0);
    expect(driver.inputs[1]?.text).toContain("so no damage got through");
  });

  it("builds up across hits and costs dice on the next roll the GM asks for", async () => {
    const driver = new ScriptedGmDriver([{ damage: [hurt(kira, 7)] }, { rolls: [rollInput({ pool: { total: 8, breakdown: "Agility 6 + Stealth 2" } })] }, { say: ["ok"] }]);
    const { session, events } = await newSession(driver);
    await session.start();
    await session.whenIdle();
    await session.submitRoll(requestedId(events), { mode: "physical", dice: "2 2 2 2 2" });
    await session.whenIdle();

    const roll = session.snapshot().pendingRolls[0];
    expect(roll).toMatchObject({ pool: { total: 6, breakdown: "Agility 6 + Stealth 2, minus 2 for wounds" }, woundPenalty: 2 });
    expect(await session.submitRoll(roll!.id, { mode: "physical", dice: "6 5 3 1 1 1 1 1" })).toEqual({ ok: false, error: "This roll is 6 dice; you entered 8." });
  });

  it("knocks a character out when a monitor fills, tells the GM, and the GM can no longer ask them for rolls", async () => {
    const t = await afterwards([hurt(kira, 12, "stun", "Shock baton")], "2 2 2 2 2");

    // 12 stun against 10 boxes: stun fills and the other 2 carry into physical.
    expect(t.session.snapshot().characters.find((c) => c.id === "kira")).toMatchObject({ status: "unconscious", monitor: { stun: 10, physical: 2 }, woundModifier: 3 });
    expect(t.inputs[1]?.text).toContain("Kira is UNCONSCIOUS and out of the action until healed.");

    const refused = await t.run((ctx) => ctx.tools.requestRoll(rollInput()));
    expect(refused).toMatchObject({ ok: false, text: "Kira is unconscious and cannot act until healed. Narrate what happens instead of asking for a roll." });
  });

  it("kills a character whose overflow fills, tells the GM, and refuses everything more for them", async () => {
    const t = await afterwards([hurt(kira, 21)], "2 2 2 2 2");
    expect(t.session.snapshot().characters.find((c) => c.id === "kira")).toMatchObject({ status: "dead", monitor: { physical: 11, overflow: 10 } });
    expect(t.inputs[1]?.text).toContain("Kira is DEAD.");

    const [roll, damage] = await t.run(async (ctx) => [await ctx.tools.requestRoll(rollInput()), await ctx.tools.dealDamage(hurt(kira, 2))]);
    expect(roll).toMatchObject({ ok: false, text: expect.stringContaining("Kira is dead and cannot act.") });
    expect(damage).toEqual({ ok: false, text: "Kira is already dead." });
  });
});

describe("a GM stuck in a loop", () => {
  it("cannot stack up resistance cards, each of which would land damage when answered", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver);
    const replies = await runner.run(session, async (ctx) => {
      const out = [];
      for (let i = 0; i < MAX_PENDING_ROLLS + 3; i++) out.push(await ctx.tools.dealDamage(hurt(kira, 3)));
      return out;
    });
    expect(replies.filter((r) => r.ok)).toHaveLength(MAX_PENDING_ROLLS);
    expect(replies[MAX_PENDING_ROLLS]).toMatchObject({ ok: false, text: expect.stringContaining("Stop and wait") });
    expect(session.snapshot().pendingRolls).toHaveLength(MAX_PENDING_ROLLS);
  });

  it("counts rolls it asked for as well", async () => {
    const runner = toolRunner();
    const { session } = await newSession(runner.driver);
    const reply = await runner.run(session, async (ctx) => {
      for (let i = 0; i < MAX_PENDING_ROLLS; i++) await ctx.tools.requestRoll(rollInput());
      return ctx.tools.dealDamage(hurt(kira, 3));
    });
    expect(reply).toMatchObject({ ok: false });
  });
});

describe("a resistance roll whose character has left the table", () => {
  it("is dropped, the player is told, and the GM is told nothing came of it", async () => {
    const first = await dealt([hurt(kira, 8)]);
    const card = first.session.snapshot().pendingRolls[0]!;
    await first.session.close();

    // The party was edited while the card waited: Kira is gone.
    const driver = new ScriptedGmDriver([{ say: ["Doc looks around."] }]);
    const second = await newSession(driver, { store: first.store, party: party.filter((m) => m.id !== "kira") });
    expect(second.session.snapshot().pendingRolls).toHaveLength(1);

    const ack = await second.session.submitRoll(card.id, { mode: "physical", dice: "6 5 3 1 1" });
    expect(ack).toEqual({ ok: false, error: "That character is no longer at the table, so the roll was dropped." });
    expect(second.session.snapshot().pendingRolls).toHaveLength(0);
    expect(second.events).toContainEqual({ type: "roll.cancelled", requestId: card.id });

    await second.session.whenIdle();
    expect(driver.inputs[0]?.text).toContain("ROLL DROPPED. Resist 8P damage: Ganger's pistol: that character is no longer at the table");
  });
});

describe("bad damage", () => {
  it.each([
    ["no damage at all", hurt(kira, 0)],
    ["damage over the limit", hurt(kira, 41)],
    ["a type that does not exist", hurt(kira, 4, "psychic")],
    ["no label", { target: kira, damageValue: 4, damageType: "physical" }],
    ["a player who is not at the table", hurt({ kind: "pc", id: "nobody" }, 4)],
    ["an NPC with no stats the first time", hurt({ kind: "npc", id: "g2" }, 4)],
    ["an NPC id that is a player's", hurt({ kind: "npc", id: "kira", name: "K", body: 3, willpower: 3 }, 4)],
    ["an id with capitals", hurt({ kind: "npc", id: "Ganger One", name: "G", body: 3, willpower: 3 }, 4)],
  ])("refuses %s, and nothing changes", async (_name, call) => {
    const runner = toolRunner();
    const { session, events } = await newSession(runner.driver);
    const reply = await runner.run(session, (ctx) => ctx.tools.dealDamage(call));
    expect(reply.ok).toBe(false);
    expect(session.snapshot().pendingRolls).toHaveLength(0);
    expect(events.some((e) => e.type === "roll.requested")).toBe(false);
    expect(session.snapshot().characters.every((c) => c.monitor.physical === 0 && c.monitor.stun === 0)).toBe(true);
  });
});

describe("a restart", () => {
  it("keeps how hurt everyone is, including non-player characters", async () => {
    const runner = toolRunner();
    const first = await newSession(runner.driver, { d6: scriptedD6([5, 2, 1]) });
    await runner.run(first.session, (ctx) => ctx.tools.dealDamage(hurt(ganger, 6)));
    await first.session.close();

    const second = await newSession(new ScriptedGmDriver([]), { store: first.store });
    expect(second.session.snapshot().characters.find((c) => c.id === "ganger-1")).toMatchObject({ name: "Ganger", monitor: { physical: 5 } });
  });

  it("still applies a resistance roll that was waiting when the server stopped", async () => {
    const first = await dealt([hurt(kira, 8)]);
    const pending = first.session.snapshot().pendingRolls[0]!;
    await first.session.close();

    const driver = new ScriptedGmDriver([{ say: ["She winces."] }]);
    const second = await newSession(driver, { store: first.store });
    expect(second.session.snapshot().pendingRolls[0]).toMatchObject({ id: pending.id, soak: { damageValue: 8 } });
    await second.session.submitRoll(pending.id, { mode: "physical", dice: "6 5 3 1 1" });
    await second.session.whenIdle();
    expect(second.session.snapshot().characters.find((c) => c.id === "kira")?.monitor.physical).toBe(6);
    expect(driver.inputs[0]?.text).toContain("DAMAGE RESULT");
  });
});

describe("snapshot", () => {
  it("shows every player character to a newly connected client, hurt or not", async () => {
    const { session } = await newSession(new ScriptedGmDriver([]));
    expect(session.snapshot().characters.map((c) => [c.id, c.kind, c.status])).toEqual([
      ["kira", "pc", "active"],
      ["doc", "pc", "active"],
    ]);
  });
});

