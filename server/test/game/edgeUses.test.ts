import { describe, expect, it } from "vitest";
import { formatRecap } from "../../src/game/recap.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party, rollInput } from "../helpers.js";

// Kira has Edge 3 and Doc Edge 4. Costs: give an ally 2, heal a stun box 3, heal a physical box 4, initiative 1, special effect 5, widen glitches 5.
const kira = { kind: "pc", id: "kira" };
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const withEdge = (id: string, edge: number) => party.map((m) => (m.id === id ? { ...m, attributes: { ...m.attributes, edge } } : m));

/** A game whose GM does whatever job it is next given, and remembers what it was told. */
async function table(faces: number[] = [], extra: Parameters<typeof newSession>[1] = {}) {
  const inputs: string[] = [];
  const jobs: Array<(ctx: GmTurnContext) => Promise<unknown>> = [];
  const results: unknown[] = [];
  const driver: GmDriver = {
    async takeTurn(input, ctx) {
      inputs.push(input.text);
      const job = jobs.shift();
      if (job) results.push(await job(ctx));
    },
  };
  const made = await newSession(driver, { d6: scriptedD6([...faces, ...Array(60).fill(3)]), flip: () => 0.5, ...extra });
  const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1);
  };
  const edgeOf = (id: string) => made.session.snapshot().edge.find((e) => e.id === id)!;
  const characterOf = (id: string) => made.session.snapshot().characters.find((c) => c.id === id)!;
  /** Starts a fight, with the dice that roll initiative. */
  const startFight = (ids: Array<"kira" | "doc" | "ganger">) =>
    gm((tools) =>
      tools.startCombat({
        participants: ids.map((id) => (id === "ganger" ? { who: ganger, initiative: { reaction: 3, intuition: 3, dice: 1 } } : { who: { kind: "pc", id } })),
      }),
    );
  return { ...made, inputs, gm, edgeOf, characterOf, startFight };
}

describe("giving an ally Edge", () => {
  it("costs the giver 2 and gives the ally 1, in a confrontation, and is recorded and reported", async () => {
    const t = await table([4, 5]);
    await t.startFight(["kira", "doc"]);
    expect(await t.session.useEdge("doc", { use: "give_ally", allyId: "kira" })).toEqual({ ok: true });
    expect(t.edgeOf("doc")).toMatchObject({ points: 2, spentThisRound: true });
    expect(t.edgeOf("kira").points).toBe(4);
    const entries = await t.store.recentEntries(30);
    expect(entries.find((e) => e.kind === "edge")).toMatchObject({ characterId: "kira", gained: 1, source: "ally", reason: "given by Doc" });
    expect(entries.find((e) => e.kind === "edge_use")).toMatchObject({ characterId: "doc", cost: 2, detail: "gave Kira 1 Edge" });
    await t.gm(async () => undefined);
    expect(t.inputs.at(-1)).toContain("EDGE. Doc spent 2 Edge to give Kira 1 Edge.");
  });

  it("counts toward the ally's limit of two gained a round, and charges the giver nothing when refused", async () => {
    const t = await table([4, 5]);
    await t.startFight(["kira", "doc"]);
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A clever distraction" }));
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "Another clever move" }));
    expect(await t.session.useEdge("doc", { use: "give_ally", allyId: "kira" })).toEqual({
      ok: false,
      error: "Kira cannot gain any more Edge now: at most two a round and seven in all.",
    });
    expect(t.edgeOf("doc").points).toBe(4);
  });

  it.each([
    ["with no fight under way", { use: "give_ally", allyId: "kira" }, false, "Edge is gained only in a confrontation, so it can be given only in one."],
    ["to oneself", { use: "give_ally", allyId: "doc" }, true, "Doc cannot give Edge to themselves."],
    ["to no one", { use: "give_ally" }, true, "Say which player character to give the Edge to."],
    ["to someone who is not there", { use: "give_ally", allyId: "nobody" }, true, "Say which player character to give the Edge to."],
  ])("is refused %s, and charges nothing", async (_name, input, inFight, message) => {
    const t = await table([4, 5]);
    if (inFight) await t.startFight(["kira", "doc"]);
    expect(await t.session.useEdge("doc", input as never)).toEqual({ ok: false, error: message });
    expect(t.edgeOf("doc").points).toBe(4);
  });

  it("is refused when the giver has too little, or has already spent Edge this round", async () => {
    const t = await table([4, 5]);
    await t.startFight(["kira", "doc"]);
    expect(await t.session.useEdge("doc", { use: "give_ally", allyId: "kira" })).toEqual({ ok: true });
    expect(await t.session.useEdge("doc", { use: "give_ally", allyId: "kira" })).toMatchObject({ ok: false, error: expect.stringContaining("already spent Edge this round") });
    const poor = await table([4, 5], { party: withEdge("doc", 1) });
    await poor.startFight(["kira", "doc"]);
    expect(await poor.session.useEdge("doc", { use: "give_ally", allyId: "kira" })).toEqual({ ok: false, error: "Doc has 1 Edge and this costs 2." });
  });
});

describe("healing a box with Edge", () => {
  /** Kira takes this stun or physical damage and fails every die resisting it. */
  const hurt = async (t: Awaited<ReturnType<typeof table>>, damageValue: number, damageType: string) => {
    await t.gm((tools) => tools.dealDamage({ label: "Test harm", target: kira, damageValue, damageType }));
    await t.session.submitRoll(t.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "1 1 1 1 1" });
    await t.session.whenIdle();
  };

  it("clears a box of stun for 3 and of physical for 4, and records it", async () => {
    const t = await table();
    await hurt(t, 5, "stun");
    expect(await t.session.useEdge("kira", { use: "heal_stun" })).toEqual({ ok: true });
    expect(t.characterOf("kira").monitor.stun).toBe(4);
    expect(t.edgeOf("kira").points).toBe(0);
    expect((await t.store.recentEntries(30)).filter((e) => e.kind === "heal")).toMatchObject([{ reason: "Kira's Edge", type: "stun", healed: 1 }]);

    const u = await table();
    await hurt(u, 5, "physical");
    expect(await u.session.useEdge("doc", { use: "heal_physical" })).toMatchObject({ ok: false, error: "Doc has no physical damage to heal." });
    await u.gm((tools) => tools.dealDamage({ label: "More harm", target: { kind: "pc", id: "doc" }, damageValue: 5, damageType: "physical" }));
    await u.session.submitRoll(u.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "1 1 1" });
    await u.session.whenIdle();
    expect(await u.session.useEdge("doc", { use: "heal_physical" })).toEqual({ ok: true });
    expect(u.characterOf("doc").monitor.physical).toBe(4);
    expect(u.edgeOf("doc").points).toBe(0);
  });

  it("is refused with too little Edge, or nothing to heal, and charges nothing", async () => {
    const t = await table();
    await hurt(t, 5, "physical");
    expect(await t.session.useEdge("kira", { use: "heal_physical" })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 4." });
    expect(await t.session.useEdge("kira", { use: "heal_stun" })).toEqual({ ok: false, error: "Kira has no stun damage to heal." });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("brings an unconscious character round with a second wind, but cannot help the dead", async () => {
    const t = await table();
    await hurt(t, 10, "stun");
    expect(t.characterOf("kira").status).toBe("unconscious");
    expect(await t.session.useEdge("kira", { use: "heal_stun" })).toEqual({ ok: true });
    expect(t.characterOf("kira")).toMatchObject({ status: "active", monitor: { stun: 9 } });

    const dead = await table();
    await hurt(dead, 40, "physical");
    expect(dead.characterOf("kira").status).toBe("dead");
    expect(await dead.session.useEdge("kira", { use: "heal_stun" })).toEqual({ ok: false, error: "Kira is dead and cannot spend Edge." });
  });

  it("is each its own round outside a fight", async () => {
    const t = await table();
    await hurt(t, 8, "stun");
    expect(await t.session.useEdge("kira", { use: "heal_stun" })).toEqual({ ok: true });
    expect(t.edgeOf("kira").spentThisRound).toBe(false);
  });
});

describe("raising initiative with Edge", () => {
  it("costs 1, shows as coming, and takes effect when the next round begins", async () => {
    // Kira 9 + 1 = 10 and the ganger 6 + 6 = 12, so he goes first until she adds 3.
    const t = await table([1, 6]);
    await t.startFight(["kira", "ganger"]);
    const order = () => t.session.snapshot().combat!.order.map((e) => `${e.members[0]!.id}:${e.score}`);
    expect(order()).toEqual(["ganger-1:12", "kira:10"]);

    expect(await t.session.useEdge("kira", { use: "initiative" })).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(2);
    expect(order()).toEqual(["ganger-1:12", "kira:10"]);
    expect(t.session.snapshot().combat!.order[1]).toMatchObject({ bonus: 3 });

    await t.gm((tools) => tools.nextRound());
    expect(order()).toEqual(["kira:13", "ganger-1:12"]);
    expect(t.session.snapshot().combat!.order[0]!.bonus).toBeUndefined();
    expect(t.session.snapshot().combat!.round).toBe(2);
  });

  it("is refused with no fight, for someone not in it, and a second time in a round", async () => {
    const none = await table();
    expect(await none.session.useEdge("kira", { use: "initiative" })).toEqual({ ok: false, error: "Kira is not in a fight, so there is no initiative to raise." });
    const t = await table([1, 6]);
    await t.startFight(["kira", "ganger"]);
    expect(await t.session.useEdge("doc", { use: "initiative" })).toEqual({ ok: false, error: "Doc is not in a fight, so there is no initiative to raise." });
    expect(t.edgeOf("doc").points).toBe(4);
    await t.session.useEdge("kira", { use: "initiative" });
    expect(await t.session.useEdge("kira", { use: "initiative" })).toMatchObject({ ok: false, error: expect.stringContaining("already spent Edge this round") });
  });
});

describe("a special effect", () => {
  it("costs 5, is told to the GM at once as a request to act, and is recorded", async () => {
    const t = await table([], { party: withEdge("kira", 5) });
    const before = t.inputs.length;
    expect(await t.session.useEdge("kira", { use: "special_effect", description: "A fire alarm goes off in the next room" })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.edgeOf("kira").points).toBe(0);
    expect(t.inputs).toHaveLength(before + 1);
    expect(t.inputs.at(-1)).toContain("EDGE. Kira spent 5 Edge to create a special effect: A fire alarm goes off in the next room.");
    expect(t.inputs.at(-1)).toContain("it is for you to decide exactly what");
    expect((await t.store.recentEntries(30)).find((e) => e.kind === "edge_use")).toMatchObject({ cost: 5, detail: "created a special effect: A fire alarm goes off in the next room" });
  });

  it("is refused without a description, or with too little Edge", async () => {
    const t = await table([], { party: withEdge("kira", 5) });
    expect(await t.session.useEdge("kira", { use: "special_effect", description: "x" })).toEqual({ ok: false, error: "Describe the special effect, so the GM knows what the player has in mind." });
    expect(t.edgeOf("kira").points).toBe(5);
    const poor = await table();
    expect(await poor.session.useEdge("kira", { use: "special_effect", description: "A fire alarm goes off" })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 5." });
  });
});

describe("Edge uses in the recap", () => {
  it("say what was spent", async () => {
    const t = await table([4, 5]);
    await t.startFight(["kira", "doc"]);
    await t.session.useEdge("doc", { use: "give_ally", allyId: "kira" });
    const entries = (await t.store.recentEntries(30)).filter((e) => e.kind === "edge" || e.kind === "edge_use");
    expect(formatRecap(entries, (id) => id)).toBe("[Edge] Kira gained 1 Edge: given by Doc.\n[Edge] Doc spent 2 Edge and gave Kira 1 Edge.");
  });
});

describe("making 2s count as glitches", () => {
  const opposed = (over: object = {}) =>
    rollInput({ characterId: "kira", pool: { total: 4, breakdown: "Agility 3 + Skill 1" }, threshold: undefined, opposed: { by: "Guard", pool: 4, role: "acting" }, ...over });

  it("costs 5 and lets the opposition glitch on 2s as well as 1s, which the GM must deal with", async () => {
    // The guard's four dice: 2 2 2 6 is three 2s, which are glitch dice only when widened.
    const widened = await table([2, 2, 2, 6], { party: withEdge("kira", 5) });
    await widened.gm((tools) => tools.requestRoll(opposed()));
    const id = widened.session.snapshot().pendingRolls[0]!.id;
    expect(await widened.session.submitRoll(id, { mode: "physical", dice: "6 5 3 3", edge: "widen_glitch" })).toEqual({ ok: true });
    await widened.session.whenIdle();
    const text = widened.inputs.at(-1)!;
    expect(text).toContain("EDGE. Kira spent 5 Edge and made 2s count toward a glitch on the opposing roll, as well as 1s.");
    expect(text).toContain("Guard: GLITCH. The GM decides what goes wrong, keeping it inconvenient, not disastrous.");
    expect(widened.edgeOf("kira").points).toBe(0);

    const plain = await table([2, 2, 2, 6]);
    await plain.gm((tools) => tools.requestRoll(opposed()));
    await plain.session.submitRoll(plain.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "6 5 3 3" });
    await plain.session.whenIdle();
    expect(plain.inputs.at(-1)).not.toContain("GLITCH");
  });

  it("is refused for a roll with nothing opposing it, with too little Edge, or together with holding", async () => {
    const t = await table([], { party: withEdge("kira", 5) });
    await t.gm((tools) => tools.requestRoll(rollInput({ characterId: "kira" })));
    const plainId = t.session.snapshot().pendingRolls[0]!.id;
    expect(await t.session.submitRoll(plainId, { mode: "app", edge: "widen_glitch" })).toEqual({ ok: false, error: "There is no opposing roll, so there are no glitches to widen." });

    const poor = await table();
    await poor.gm((tools) => tools.requestRoll(opposed()));
    const poorId = poor.session.snapshot().pendingRolls[0]!.id;
    expect(await poor.session.submitRoll(poorId, { mode: "app", edge: "widen_glitch" })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 5." });

    const held = await table([], { party: withEdge("kira", 5) });
    await held.gm((tools) => tools.requestRoll(opposed()));
    expect(await held.session.submitRoll(held.session.snapshot().pendingRolls[0]!.id, { mode: "app", edge: "widen_glitch", hold: true })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to decide afterwards") });
    expect(held.edgeOf("kira").points).toBe(5);
  });
});
