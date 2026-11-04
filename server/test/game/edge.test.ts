import { describe, expect, it } from "vitest";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party, rollInput } from "../helpers.js";

// Kira has Edge 3 and Doc Edge 4, so they start a session with that many Edge points.
// Costs (the book's): reroll a die 1, add 1 to a die 2, buy a hit 3, Edge dice 4, reroll failed dice 4.
const ask = (characterId: string, over: object = {}) => rollInput({ characterId, pool: { total: 4, breakdown: "Agility 3 + Skill 1" }, threshold: 2, ...over });

/** A game whose GM does whatever job it is next given, one job per turn, and remembers what it was told. */
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
  const made = await newSession(driver, { d6: scriptedD6(faces), flip: () => 0.5, ...extra });
  const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1);
  };
  /** Gives the GM something to do on its next turn, without starting one. */
  const later = (job: (tools: GmTools) => Promise<unknown>) => void jobs.push((ctx) => job(ctx.tools));
  const pending = () => made.session.snapshot().pendingRolls;
  const edgeOf = (id: string) => made.session.snapshot().edge.find((e) => e.id === id)!;
  /** Asks for a roll and returns its id. */
  const request = async (characterId: string, over: object = {}) => {
    await gm((tools) => tools.requestRoll(ask(characterId, over)));
    return pending().at(-1)!.id;
  };
  return { ...made, inputs, gm, later, pending, edgeOf, request };
}

describe("Edge points", () => {
  it("start at each player's Edge attribute, and are shown to everyone", async () => {
    const t = await table();
    expect(t.session.snapshot().edge).toEqual([
      { id: "kira", points: 3, rank: 3, spentThisRound: false },
      { id: "doc", points: 4, rank: 4, spentThisRound: false },
    ]);
  });

  it("start again at the Edge attribute when the server restarts", async () => {
    const first = await table([6, 5, 3, 3]);
    const id = await first.request("kira");
    await first.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    await first.session.spendEdge(id, { boost: "buy_hit", times: 1 });
    expect(first.edgeOf("kira").points).toBe(0);
    await first.session.close();
    const second = await table([], { store: first.store });
    expect(second.edgeOf("kira").points).toBe(3);
  });
});

describe("Edge dice, spent before the roll", () => {
  it("add the Edge attribute to the pool, make 6s explode, cost 4, and are reported to the GM", async () => {
    // Doc rolls 4 + 4 Edge dice with the app: one 6, which earns a die (another 6) and then another (a 2).
    const t = await table([6, 3, 3, 3, 3, 3, 3, 3, 6, 2]);
    const id = await t.request("doc");
    await t.session.submitRoll(id, { mode: "app", edge: "dice" });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("Doc rolled 8 dice (app dice): 6 3 3 3 3 3 3 3 (exploded: 6 2) = 2 hits.");
    expect(t.inputs.at(-1)).toContain("EDGE. Doc spent 4 Edge and added 4 Edge dice to the pool, and 6s exploded.");
    expect(t.edgeOf("doc").points).toBe(0);
    expect(t.pending()).toHaveLength(0);
  });

  it("take dice rolled by hand, with the extra dice for 6s rolled by hand or by the app", async () => {
    const byHand = await table();
    const a = await byHand.request("doc");
    await byHand.session.submitRoll(a, { mode: "physical", dice: "6 3 3 3 3 3 3 3", explosions: "6 2", edge: "dice" });
    await byHand.session.whenIdle();
    expect(byHand.inputs.at(-1)).toContain("Doc rolled 8 dice (dice at the table): 6 3 3 3 3 3 3 3 (exploded: 6 2) = 2 hits.");

    const byApp = await table([6, 2]);
    const b = await byApp.request("doc");
    await byApp.session.submitRoll(b, { mode: "physical", dice: "6 3 3 3 3 3 3 3", edge: "dice" });
    await byApp.session.whenIdle();
    expect(byApp.inputs.at(-1)).toContain("(exploded: 6 2)");
  });

  it.each([
    ["too few dice", { dice: "6 3 3 3" }, "This roll is 8 dice (4 plus 4 Edge dice); you entered 4."],
    ["a 6 with no extra die rolled for it", { dice: "6 3 3 3 3 3 3 3", explosions: "" }, "No dice entered"],
    ["too few extra dice", { dice: "6 6 3 3 3 3 3 3", explosions: "5" }, "You gave 1 extra die and it needs more."],
    ["extra dice that were not earned", { dice: "6 3 3 3 3 3 3 3", explosions: "5 5" }, "You gave 2 extra dice but only 1 is earned"],
    ["extra dice for a 6 that came up on an extra die", { dice: "6 3 3 3 3 3 3 3", explosions: "6" }, "You gave 1 extra die and it needs more."],
  ])("refuse %s, and charge nothing", async (_name, extra, message) => {
    const t = await table();
    const id = await t.request("doc");
    const ack = await t.session.submitRoll(id, { mode: "physical", edge: "dice", ...extra } as never);
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining(message) });
    expect(t.edgeOf("doc").points).toBe(4);
    expect(t.pending()).toHaveLength(1);
  });

  it("refuse extra dice when no Edge dice were bought", async () => {
    const t = await table();
    const id = await t.request("kira");
    expect(await t.session.submitRoll(id, { mode: "physical", dice: "6 3 3 3", explosions: "5" })).toEqual({
      ok: false,
      error: "Extra dice for 6s come only with Edge dice, which were not spent on this roll.",
    });
  });

  it("are refused for someone with too little Edge, or with no Edge attribute", async () => {
    const t = await table();
    const kira = await t.request("kira");
    expect(await t.session.submitRoll(kira, { mode: "app", edge: "dice" })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 4." });
    expect(t.edgeOf("kira").points).toBe(3);

    const none = party.map((m) => (m.id === "kira" ? { ...m, attributes: { ...m.attributes, edge: 0 } } : m));
    const u = await table([], { party: none });
    const id = await u.request("kira");
    expect(await u.session.submitRoll(id, { mode: "app", edge: "dice" })).toMatchObject({ ok: false });
  });

  it("cannot be combined with holding, since they use up the round's Edge", async () => {
    const t = await table();
    const id = await t.request("doc");
    expect(await t.session.submitRoll(id, { mode: "app", edge: "dice", hold: true })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to decide afterwards") });
  });
});

describe("holding a roll to decide on Edge", () => {
  it("counts the dice but keeps the roll waiting, and the GM hears nothing until it counts", async () => {
    const t = await table();
    const id = await t.request("kira");
    const before = t.inputs.length;
    expect(await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs).toHaveLength(before);
    expect(t.pending()[0]).toMatchObject({ id, held: { source: "physical", roll: { dice: [3, 3, 3, 3], hits: 0 } } });
    expect(t.events.at(-1)).toMatchObject({ type: "roll.updated", request: { id } });
    expect(t.session.snapshot().gm).toEqual({ phase: "waiting_for_rolls" });
  });

  it("lets the player keep the roll as it stands, spending nothing", async () => {
    const t = await table();
    const id = await t.request("kira");
    await t.session.submitRoll(id, { mode: "physical", dice: "6 5 3 3", hold: true });
    expect(await t.session.keepRoll(id)).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("SUCCESS");
    expect(t.inputs.at(-1)).not.toContain("EDGE.");
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("is refused when the player has no Edge to spend", async () => {
    const t = await table([3, 3, 3, 3], { party: party.map((m) => (m.id === "kira" ? { ...m, attributes: { ...m.attributes, edge: 0 } } : m)) });
    const id = await t.request("kira");
    expect(await t.session.submitRoll(id, { mode: "app", hold: true })).toEqual({ ok: false, error: "Kira has 0 Edge and this costs 1. Roll without holding." });
  });

  it("survives a restart with its dice, and still counts afterwards", async () => {
    const first = await table();
    const id = await first.request("kira");
    await first.session.submitRoll(id, { mode: "physical", dice: "6 5 3 3", hold: true });
    await first.session.close();

    const second = await table([], { store: first.store });
    expect(second.pending()[0]).toMatchObject({ id, held: { roll: { dice: [6, 5, 3, 3] } } });
    expect(await second.session.keepRoll(id)).toEqual({ ok: true });
    await second.session.whenIdle();
    expect(second.inputs.at(-1)).toContain("SUCCESS");
  });

  it("can be skipped like any other roll, and spends nothing", async () => {
    const t = await table([3, 3, 3, 3]);
    const id = await t.request("kira");
    expect(await t.session.submitRoll(id, { mode: "app", hold: true })).toEqual({ ok: true });
    expect(t.pending()[0]!.held).toBeDefined();
    expect(await t.session.cancelRoll(id)).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("cannot be rolled again once counted", async () => {
    const t = await table([3, 3, 3, 3]);
    const id = await t.request("kira");
    expect(await t.session.submitRoll(id, { mode: "app", hold: true })).toEqual({ ok: true });
    expect(await t.session.submitRoll(id, { mode: "app" })).toEqual({ ok: false, error: "That roll is already counted. Keep it, or spend Edge on it." });
  });
});

describe("spending Edge on a held roll", () => {
  const held = async (dice = "3 3 3 3", who = "kira", faces: number[] = [], over: object = {}) => {
    const t = await table(faces);
    const id = await t.request(who, over);
    await t.session.submitRoll(id, { mode: "physical", dice, hold: true });
    return { ...t, id };
  };

  it("rerolls dice with the app's dice for 1 Edge each, and the new results stand", async () => {
    const t = await held("3 3 3 3", "kira", [6, 5]);
    expect(await t.session.spendEdge(t.id, { boost: "reroll", targets: [{ side: "mine", index: 0 }, { side: "mine", index: 1 }] })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("Kira rolled 4 dice (dice at the table): 6 5 3 3 = 2 hits.");
    expect(t.inputs.at(-1)).toContain("EDGE. Kira spent 2 Edge and rerolled dice 1, 2 of their own roll (3 became 6; 3 became 5).");
    expect(t.inputs.at(-1)).toContain("SUCCESS");
    expect(t.edgeOf("kira")).toMatchObject({ points: 1, spentThisRound: false });
  });

  it("rerolls with dice rolled by hand when the player gives the new values", async () => {
    const t = await held("3 3 3 3");
    await t.session.spendEdge(t.id, { boost: "reroll", targets: [{ side: "mine", index: 2 }], dice: "6" });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("3 3 6 3 = 1 hit");
    expect(t.inputs.at(-1)).toContain("(3 became 6)");
  });

  it("rerolls the opponent's dice too, rolled by hand or by the app", async () => {
    // The opposition's 4 dice are rolled by the system when Kira's roll is held: 6 6 3 3, two hits.
    const t = await table([6, 6, 3, 3]);
    const id = await t.request("kira", { threshold: undefined, opposed: { by: "Guard", pool: 4, role: "acting" } });
    await t.session.submitRoll(id, { mode: "physical", dice: "6 5 3 3", hold: true });
    expect(t.pending()[0]!.held!.opponent).toMatchObject({ dice: [6, 6, 3, 3], hits: 2 });
    await t.session.spendEdge(id, { boost: "reroll", targets: [{ side: "theirs", index: 0 }, { side: "theirs", index: 1 }], dice: "1 2" });
    await t.session.whenIdle();
    const text = t.inputs.at(-1)!;
    expect(text).toContain("rerolled dice 1, 2 of the opposing roll (6 became 1; 6 became 2)");
    expect(text).toContain("Opposed by Guard, 4 dice rolled by the system: 1 2 3 3 = 0 hits.");
    expect(text).toContain("SUCCESS by 2 net hits");
  });

  it("refuses a reroll of the opponent when there is no opposing roll", async () => {
    const t = await held();
    expect(await t.session.spendEdge(t.id, { boost: "reroll", targets: [{ side: "theirs", index: 0 }] })).toEqual({ ok: false, error: "There is no opposing roll to reroll." });
    expect(t.edgeOf("kira").points).toBe(3);
    expect(t.pending()[0]!.held).toBeDefined();
  });

  it("refuses new values that do not match the dice being rerolled", async () => {
    const t = await held();
    const ack = await t.session.spendEdge(t.id, { boost: "reroll", targets: [{ side: "mine", index: 0 }, { side: "mine", index: 1 }], dice: "6" });
    expect(ack).toMatchObject({ ok: false, error: expect.stringContaining("rerolls 2 dice; you gave 1 new value") });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("adds 1 to a die for 2 Edge, which can turn a 4 into a hit, but not past 6", async () => {
    const t = await held("4 6 3 3");
    expect(await t.session.spendEdge(t.id, { boost: "bump", targets: [{ side: "mine", index: 1 }] })).toMatchObject({ ok: false, error: "A 6 cannot be raised" });
    expect(await t.session.spendEdge(t.id, { boost: "bump", targets: [{ side: "theirs", index: 0 }] })).toEqual({ ok: false, error: "Only your own dice can be raised." });
    expect(await t.session.spendEdge(t.id, { boost: "bump", targets: [{ side: "mine", index: 0 }] })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("4 became 5");
    expect(t.inputs.at(-1)).toContain("5 6 3 3 = 2 hits");
    expect(t.edgeOf("kira").points).toBe(1);
  });

  it("buys a hit for 3 Edge, which is an extra hit and not a success", async () => {
    const t = await held("6 3 3 3");
    expect(await t.session.spendEdge(t.id, { boost: "buy_hit", times: 2 })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 6." });
    expect(await t.session.spendEdge(t.id, { boost: "buy_hit" })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("(+1 bought hit) = 2 hits");
    expect(t.inputs.at(-1)).toContain("bought 1 hit");
    expect(t.edgeOf("kira").points).toBe(0);
  });

  it("buys several hits at once for 3 Edge each, for a character with the Edge to afford them", async () => {
    const rich = party.map((m) => (m.id === "kira" ? { ...m, attributes: { ...m.attributes, edge: 7 } } : m));
    const t = await table([], { party: rich });
    const id = await t.request("kira");
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    expect(await t.session.spendEdge(id, { boost: "buy_hit", times: 2 })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("(+2 bought hits) = 2 hits");
    expect(t.inputs.at(-1)).toContain("bought 2 hits");
    expect(t.edgeOf("kira").points).toBe(1);
  });

  it("rerolls every die that missed for 4 Edge, with the app's dice or the player's", async () => {
    const app = await held("6 3 3 3", "doc", [5, 5, 1]);
    await app.session.spendEdge(app.id, { boost: "reroll_failed" });
    await app.session.whenIdle();
    expect(app.inputs.at(-1)).toContain("6 5 5 1 = 3 hits");
    expect(app.inputs.at(-1)).toContain("rerolled the 3 dice that missed (1 hits became 3)");
    expect(app.edgeOf("doc").points).toBe(0);

    const hand = await held("6 3 3 3", "doc");
    expect(await hand.session.spendEdge(hand.id, { boost: "reroll_failed", dice: "5 5" })).toMatchObject({ ok: false, error: expect.stringContaining("3 dice are not hits") });
    await hand.session.spendEdge(hand.id, { boost: "reroll_failed", dice: "5 5 6" });
    await hand.session.whenIdle();
    expect(hand.inputs.at(-1)).toContain("6 5 5 6 = 4 hits");
  });

  it("refuses rerolling failed dice after a glitch, and charges nothing", async () => {
    const t = await held("1 1 1 6", "doc");
    expect(await t.session.spendEdge(t.id, { boost: "reroll_failed" })).toMatchObject({ ok: false, error: "Failed dice cannot be rerolled after a glitch" });
    expect(t.edgeOf("doc").points).toBe(4);
  });

  it("refuses to spend more than the player has, naming the cost", async () => {
    const t = await held("3 3 3 3");
    const four = [0, 1, 2, 3].map((index) => ({ side: "mine" as const, index }));
    expect(await t.session.spendEdge(t.id, { boost: "reroll", targets: four })).toEqual({ ok: false, error: "Kira has 3 Edge and this costs 4." });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("refuses a die that is not there, and charges nothing", async () => {
    const t = await held("3 3 3 3");
    expect(await t.session.spendEdge(t.id, { boost: "reroll", targets: [{ side: "mine", index: 9 }] })).toMatchObject({ ok: false, error: "No die at position 9" });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("is refused for a roll that is not held, or does not exist", async () => {
    const t = await table();
    const id = await t.request("kira");
    expect(await t.session.spendEdge(id, { boost: "buy_hit" })).toMatchObject({ ok: false, error: expect.stringContaining("not been counted yet") });
    expect(await t.session.spendEdge("nope", { boost: "buy_hit" })).toMatchObject({ ok: false });
    expect(await t.session.keepRoll(id)).toMatchObject({ ok: false });
  });
});

describe("one expenditure of Edge per round", () => {
  /** Starts a fight so there are rounds, then asks the same character for rolls. */
  async function fight(faces: number[] = []) {
    const t = await table(faces);
    await t.gm((tools) => tools.startCombat({ participants: [{ who: { kind: "pc", id: "doc" } }, { who: { kind: "pc", id: "kira" } }] }));
    return t;
  }

  it("lets a character spend Edge once in a round, and again after the next round begins", async () => {
    const t = await fight([1, 1, 6, 5, 4, 3, 3]);
    const first = await t.request("doc");
    await t.session.submitRoll(first, { mode: "physical", dice: "3 3 3 3", hold: true });
    await t.session.spendEdge(first, { boost: "reroll", targets: [{ side: "mine", index: 0 }] });
    expect(t.edgeOf("doc")).toMatchObject({ points: 3, spentThisRound: true });

    const second = await t.request("doc");
    expect(await t.session.submitRoll(second, { mode: "app", hold: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Doc has already spent Edge this round. Only one expenditure of Edge is allowed per round."),
    });
    expect(await t.session.submitRoll(second, { mode: "app", edge: "dice" })).toMatchObject({ ok: false, error: expect.stringContaining("already spent Edge this round") });

    // The GM takes no turn while a roll waits, so skip it, let the GM start the next round, and ask again.
    t.later((tools) => tools.nextRound());
    await t.session.cancelRoll(second);
    await t.session.whenIdle();
    expect(t.edgeOf("doc").spentThisRound).toBe(false);
    const third = await t.request("doc");
    expect(await t.session.submitRoll(third, { mode: "physical", dice: "3 3 3 3", hold: true })).toEqual({ ok: true });
  });

  it("is shown to the other players as it happens", async () => {
    const t = await fight([1, 1, 6]);
    const id = await t.request("doc");
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    await t.session.spendEdge(id, { boost: "reroll", targets: [{ side: "mine", index: 0 }] });
    expect(t.events.filter((e) => e.type === "edge.updated").at(-1)).toMatchObject({ edge: { id: "doc", points: 3 } });
  });

  it("gives everyone their expenditure back when the fight ends", async () => {
    const t = await fight([1, 1, 6]);
    const id = await t.request("doc");
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    await t.session.spendEdge(id, { boost: "reroll", targets: [{ side: "mine", index: 0 }] });
    await t.gm((tools) => tools.endCombat());
    expect(t.edgeOf("doc")).toMatchObject({ points: 3, spentThisRound: false });
  });

  it("is one expenditure per roll outside a fight, since there are no rounds", async () => {
    const t = await table([6, 6]);
    for (const faces of ["3 3 3 3", "3 3 3 3"]) {
      const id = await t.request("doc");
      await t.session.submitRoll(id, { mode: "physical", dice: faces, hold: true });
      expect(await t.session.spendEdge(id, { boost: "reroll", targets: [{ side: "mine", index: 0 }] })).toEqual({ ok: true });
    }
    expect(t.edgeOf("doc").points).toBe(2);
  });
});

describe("Edge on the rolls that follow from an attack", () => {
  const colt = { name: "Colt America L36", damageValue: 3, damageType: "physical" };
  const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };

  it("is reported with the attack, and decides whether it lands", async () => {
    // Ganger defends with 4 dice, none hits; Kira's held roll has 0 hits until she buys one.
    const t = await table([3, 3, 3, 3, 3, 3, 3]);
    await t.gm((tools) =>
      tools.attack({ label: "Kira shoots", attacker: { kind: "pc", id: "kira" }, defender: ganger, weapon: colt, attackPool: { total: 4, breakdown: "x" }, defensePool: { total: 4, breakdown: "x" }, attackRating: 6, defenseRating: 4, stakes: "A shot." }),
    );
    const id = t.pending()[0]!.id;
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3", hold: true });
    await t.session.spendEdge(id, { boost: "buy_hit" });
    await t.session.whenIdle();
    const text = t.inputs.at(-1)!;
    expect(text).toContain("EDGE. Kira spent 3 Edge and bought 1 hit.");
    expect(text).toContain("HIT by 1 net hit. Damage Value 3 + 1 = 4 physical");
  });

  it("is reported with the damage when a player spends it on resisting", async () => {
    const t = await table();
    await t.gm((tools) => tools.dealDamage({ label: "Fall", target: { kind: "pc", id: "kira" }, damageValue: 6, damageType: "physical" }));
    const id = t.pending()[0]!.id;
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3 3", hold: true });
    await t.session.spendEdge(id, { boost: "buy_hit" });
    await t.session.whenIdle();
    const text = t.inputs.at(-1)!;
    expect(text).toContain("EDGE. Kira spent 3 Edge and bought 1 hit.");
    expect(text).toContain("so 5 physical damage got through");
  });
});
