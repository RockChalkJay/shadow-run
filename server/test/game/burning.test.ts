import { describe, expect, it } from "vitest";
import { formatRecap } from "../../src/game/recap.js";
import { GameSession } from "../../src/game/session.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party, rollInput } from "../helpers.js";

// Kira has Edge 3 (Body 5: Physical 11, Overflow 10) and Doc Edge 4. Smackdown gives 4 net hits.
const kira = { kind: "pc", id: "kira" };
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const predator = { name: "Ares Predator VI", damageValue: 3, damageType: "physical" };
const pool = (total: number) => ({ total, breakdown: "a pool" });
const withEdge = (id: string, edge: number) => party.map((m) => (m.id === id ? { ...m, attributes: { ...m.attributes, edge } } : m));
const text = (r: unknown) => (r as { text: string }).text;

const kiraShoots = (over: object = {}) => ({
  label: "Kira shoots the ganger",
  attacker: kira,
  defender: ganger,
  weapon: predator,
  attackPool: pool(6),
  defensePool: pool(4),
  attackRating: 6,
  defenseRating: 4,
  stakes: "A ganger on the stairs.",
  ...over,
});
const gangerShoots = (over: object = {}) => ({ ...kiraShoots(), label: "Ganger shoots Kira", attacker: ganger, defender: kira, attackPool: pool(5), defensePool: pool(4), ...over });

/** A game whose GM does whatever job it is next given, and remembers what it was told. The dice after the scripted ones are all 3s. */
async function table(extra: Parameters<typeof newSession>[1] = {}, faces: number[] = [4, 5]) {
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
  const made = await newSession(driver, { d6: scriptedD6([...faces, ...Array(80).fill(3)]), flip: () => 0.5, ...extra });
  const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1);
  };
  const edgeOf = (id: string) => made.session.snapshot().edge.find((e) => e.id === id)!;
  const characterOf = (id: string) => made.session.snapshot().characters.find((c) => c.id === id)!;
  const waiting = () => made.session.snapshot().pendingRolls[0]!;
  const smackdown = async () => {
    const answered = await made.session.submitRoll(waiting().id, { mode: "smackdown" });
    await made.session.whenIdle();
    return answered;
  };
  const startFight = () => gm((tools) => tools.startCombat({ participants: [{ who: kira }, { who: ganger, initiative: { reaction: 3, intuition: 3, dice: 1 } }] }));
  return { ...made, inputs, gm, edgeOf, characterOf, waiting, smackdown, startFight };
}

describe("Smackdown on a roll", () => {
  it("is an automatic success with four net hits instead of a roll, and costs a point of Edge rank and every Edge point", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    expect(await t.smackdown()).toEqual({ ok: true });
    expect(t.edgeOf("kira")).toMatchObject({ points: 0, rank: 2 });

    const told = t.inputs.at(-1)!;
    expect(told).toContain("Kira did not roll: they burned Edge for Smackdown.");
    expect(told).toContain("Threshold 2.");
    expect(told).toContain("EDGE BURNED. Kira burned Edge for Smackdown, so this was an automatic success with 4 net hits instead of a roll. They permanently lose 1 point of Edge rank (it is now 2) and the 3 Edge points they held.");
    expect(told).toContain("SUCCESS by 4 net hits.");
    expect(told).toContain("Apply this consequence, as you declared it: Kira slips through.");
    expect(told).not.toContain("rolled");
    expect(told).not.toContain("GLITCH");
  });

  it("is recorded in the transcript and the recap, and announced to the table", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    await t.smackdown();
    const entries = await t.store.recentEntries(30);
    expect(entries.find((e) => e.kind === "roll")).toMatchObject({ resolved: { source: "smackdown", roll: { dice: [], hits: 6 }, burn: { kind: "smackdown", lost: 3, rank: 2 }, outcome: { success: true, netHits: 4 } } });
    expect(entries.find((e) => e.kind === "edge_burn")).toMatchObject({ characterId: "kira", burn: "smackdown", lost: 3, rank: 2 });
    const recap = formatRecap(entries, (id) => id);
    expect(recap).toContain("[Edge] Kira burned Edge for Smackdown and lost a point of Edge rank for good (now 2).");
    expect(recap).toContain("[Roll] kira, Sneak past the guard: success (Smackdown, no roll). Kira slips through.");
    expect(recap).not.toContain("6 hits");
    expect(t.events).toContainEqual({ type: "edge.updated", edge: expect.objectContaining({ id: "kira", points: 0, rank: 2 }) });
  });

  it("beats the opposition by four net hits, whether the roller acts or defends", async () => {
    const acting = await table({}, [5, 5, 3, 3]);
    await acting.gm((tools) => tools.requestRoll(rollInput({ threshold: undefined, opposed: { by: "Guard", pool: 4, role: "acting" } })));
    await acting.smackdown();
    expect(acting.inputs.at(-1)).toContain("Opposed by Guard, 4 dice rolled by the system: 5 5 3 3 = 2 hits.");
    expect(acting.inputs.at(-1)).toContain("SUCCESS by 4 net hits.");

    const defending = await table({}, [5, 5, 3, 3]);
    await defending.gm((tools) => tools.requestRoll(rollInput({ threshold: undefined, opposed: { by: "Guard", pool: 4, role: "defending" } })));
    await defending.smackdown();
    expect(defending.inputs.at(-1)).toContain("SUCCESS by 4 net hits.");
  });

  it("makes an attack land with four extra damage, whatever the defender rolls", async () => {
    // The ganger's four defense dice give him 2 hits, so Kira's automatic success has 6 and 4 net hits: Damage Value 3 + 4.
    const t = await table({}, [5, 5, 3, 3]);
    await t.gm((tools) => tools.attack(kiraShoots()));
    await t.smackdown();
    const told = t.inputs.at(-1)!;
    expect(told).toContain("Kira attacked with Ares Predator VI (3P) and burned Edge for Smackdown instead of rolling.");
    expect(told).toContain("Ganger defended, 4 dice (the system's dice): 5 5 3 3 = 2 hits.");
    expect(told).toContain("HIT by 4 net hits. Damage Value 3 + 4 = 7 physical, before Ganger resists.");
    expect(t.characterOf("ganger-1").monitor.physical).toBe(7);
    expect((await t.store.recentEntries(30)).find((e) => e.kind === "attack")).toMatchObject({ attackedBy: "smackdown", defendedBy: "system", hit: true, damageValue: 7 });
  });

  it("makes a defense beat the attack, which then misses, so there is nothing to resist", async () => {
    const t = await table({}, [5, 5, 5, 5, 5]);
    await t.gm((tools) => tools.attack(gangerShoots()));
    await t.smackdown();
    const told = t.inputs.at(-1)!;
    expect(told).toContain("Kira burned Edge for Smackdown instead of defending.");
    expect(told).toContain("MISS. Kira had more hits.");
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
    expect(t.characterOf("kira").monitor.physical).toBe(0);
  });

  it("works in a round Edge was already spent", async () => {
    const t = await table();
    await t.startFight();
    expect(await t.session.useEdge("kira", { use: "initiative" })).toEqual({ ok: true });
    expect(t.edgeOf("kira")).toMatchObject({ points: 2, spentThisRound: true });
    await t.gm((tools) => tools.requestRoll(rollInput()));
    expect(await t.smackdown()).toEqual({ ok: true });
    expect(t.edgeOf("kira")).toMatchObject({ points: 0, rank: 2 });
    expect(t.inputs.at(-1)).toContain("the 2 Edge points they held");
  });

  it("can be done until the rank runs out, and then it is refused", async () => {
    const t = await table();
    for (let rank = 2; rank >= 0; rank--) {
      await t.gm((tools) => tools.requestRoll(rollInput()));
      expect(await t.smackdown()).toEqual({ ok: true });
      expect(t.edgeOf("kira").rank).toBe(rank);
    }
    await t.gm((tools) => tools.requestRoll(rollInput()));
    expect(await t.smackdown()).toEqual({ ok: false, error: "Kira has no Edge rank left to burn." });
    expect(t.session.snapshot().pendingRolls).toHaveLength(1);
    expect((await t.store.loadState())!.burned).toEqual({ kira: 3 });
  });
});

describe("a roll where Smackdown is refused", () => {
  it("cannot resist damage, which is for Not Dead Yet", async () => {
    const t = await table();
    await t.gm((tools) => tools.dealDamage({ label: "A fall", target: kira, damageValue: 5, damageType: "physical" }));
    expect(await t.smackdown()).toEqual({ ok: false, error: "Smackdown cannot resist damage. If the blow would kill Kira, hold this roll and burn Not Dead Yet once the dice are counted." });
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, rank: 3 });
  });

  it("cannot heal", async () => {
    const t = await table();
    await t.gm((tools) => tools.dealDamage({ label: "A shock", target: kira, damageValue: 4, damageType: "stun" }));
    await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "1 1 1 1 1" });
    await t.session.whenIdle();
    await t.gm((tools) => tools.requestRoll({ ...rollInput({ threshold: undefined }), healing: { method: "natural_stun", patient: { kind: "pc", id: "kira" }, essence: 6 } }));
    expect(await t.smackdown()).toEqual({ ok: false, error: "A healing roll cannot be a Smackdown." });
    expect(t.edgeOf("kira").rank).toBe(3);
  });

  it("cannot come after the dice are counted, since it replaces the roll", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "3 3 3 3", hold: true });
    expect(await t.smackdown()).toEqual({ ok: false, error: "That roll is already counted. Smackdown replaces the roll, so it has to come before the dice." });
    expect(t.edgeOf("kira").rank).toBe(3);
  });

  it("cannot go with an Edge Action the player can pay for, since burning spends all their Edge", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    expect(await t.smackdown()).toEqual({ ok: false, error: "Kira declared Bring the Drama, and burning Edge spends all their Edge, so the two cannot go together. Roll without Smackdown." });
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, rank: 3 });
    expect(t.session.snapshot().pendingRolls).toHaveLength(1);
  });

  it("is allowed with an Edge Action the player can no longer pay for, which then does not happen", async () => {
    const t = await table();
    await t.gm(async (tools) => {
      await tools.requestRoll({ ...rollInput({ label: "First con" }), edgeAction: "bring_the_drama" });
      await tools.requestRoll({ ...rollInput({ label: "Second con" }), edgeAction: "bring_the_drama" });
    });
    const [first, second] = t.session.snapshot().pendingRolls;
    await t.session.submitRoll(first!.id, { mode: "physical", dice: "6 5 5 3" });
    expect(t.edgeOf("kira").points).toBe(1);
    expect(await t.session.submitRoll(second!.id, { mode: "smackdown" })).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("EDGE. Kira could not pay 2 Edge for Bring the Drama when the roll was made, so it did not happen");
    expect(t.inputs.at(-1)).toContain("EDGE BURNED. Kira burned Edge for Smackdown");
    expect(t.edgeOf("kira")).toMatchObject({ points: 0, rank: 2 });
  });

  it("needs an Edge rank to burn, and a roll that is waiting", async () => {
    const poor = await table({ party: withEdge("kira", 0) });
    await poor.gm((tools) => tools.requestRoll(rollInput()));
    expect(await poor.smackdown()).toEqual({ ok: false, error: "Kira has no Edge rank left to burn." });
    expect(poor.session.snapshot().pendingRolls).toHaveLength(1);
    expect(await poor.session.submitRoll("nope", { mode: "smackdown" })).toEqual({ ok: false, error: "That roll is not waiting for dice; it may already have been rolled or skipped." });
  });
});

describe("burned Edge", () => {
  it("is saved with the game and taken off the sheet whenever it is loaded", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    await t.smackdown();
    expect((await t.store.loadState())!.burned).toEqual({ kira: 1 });
    expect(t.session.party.find((m) => m.id === "kira")!.attributes.edge).toBe(2);
    expect(t.session.snapshot().party.find((m) => m.id === "kira")!.attributes.edge).toBe(2);

    // Loading the campaign again gives the lower rank to the table and, through the same party, to the GM.
    const { party: loaded } = await t.store.loadOrCreateParty(party);
    expect(loaded.find((m) => m.id === "kira")!.attributes.edge).toBe(2);
    const driver: GmDriver = { async takeTurn() {} };
    const again = await GameSession.create({ store: t.store, driver, party: loaded, emit: () => {}, d6: scriptedD6(Array(20).fill(3)) });
    expect(again.snapshot().edge.find((e) => e.id === "kira")).toMatchObject({ points: 2, rank: 2 });
    expect(again.snapshot().edge.find((e) => e.id === "doc")).toMatchObject({ points: 4, rank: 4 });
    await again.close();
  });

  it("lowers the cap on the Edge a fight leaves a player with", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    await t.smackdown();
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A decisive move" }));
    expect(t.edgeOf("kira")).toMatchObject({ points: 1, rank: 2 });
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "Another one" }));
    await t.gm((tools) => tools.endCombat());
    expect(t.edgeOf("kira")).toMatchObject({ points: 2, rank: 2 });
  });
});

describe("Not Dead Yet", () => {
  /** Kira takes a blow that kills, and rolls Body to resist it without a hit, holding the roll. */
  const struck = async (t: Awaited<ReturnType<typeof table>>, damageValue = 40, damageType = "physical", dice = "1 1 1 1 1") => {
    await t.gm((tools) => tools.dealDamage({ label: "A fall from the roof", target: kira, damageValue, damageType }));
    expect(await t.session.submitRoll(t.waiting().id, { mode: "physical", dice, hold: true })).toEqual({ ok: true });
  };
  const nde = (t: Awaited<ReturnType<typeof table>>) => t.session.spendEdge(t.waiting().id, { boost: "not_dead_yet" });

  it("lets a character survive a killing blow, dying and unconscious, for a point of Edge rank and every Edge point", async () => {
    const t = await table();
    await struck(t);
    expect(await nde(t)).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.characterOf("kira")).toMatchObject({ status: "unconscious", monitor: { physical: 11, overflow: 9, overflowBoxes: 10 } });
    expect(t.edgeOf("kira")).toMatchObject({ points: 0, rank: 2 });

    const told = t.inputs.at(-1)!;
    expect(told).toContain("EDGE BURNED. Kira burned Edge for Not Dead Yet: the blow would have killed them, and they survive it instead, unconscious and dying. It does not take them out of the danger they are in. They permanently lose 1 point of Edge rank (it is now 2) and the 3 Edge points they held.");
    expect(told).toContain("Kira: Physical 11/11, Stun 0/10, Overflow 9/10.");
    expect(told).toContain("Kira is UNCONSCIOUS");
    expect(told).not.toContain("DEAD");
    expect((await t.store.recentEntries(30)).find((e) => e.kind === "edge_burn")).toMatchObject({ burn: "not_dead_yet", lost: 3, rank: 2 });
  });

  it("is a choice: a held roll that is kept lets the blow kill", async () => {
    const t = await table();
    await struck(t);
    expect(await t.session.keepRoll(t.waiting().id)).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.characterOf("kira").status).toBe("dead");
    expect(t.edgeOf("kira").rank).toBe(3);
  });

  it("works for stun that carries over into death as well", async () => {
    const t = await table();
    await struck(t, 40, "stun");
    expect(await nde(t)).toEqual({ ok: true });
    expect(t.characterOf("kira")).toMatchObject({ status: "unconscious", monitor: { stun: 10, physical: 11, overflow: 9 } });
  });

  it("is refused if the blow would not kill, and the roll stays held", async () => {
    const t = await table();
    await struck(t, 5);
    expect(await nde(t)).toEqual({ ok: false, error: "Kira would survive this as the roll stands, so there is no killing blow for Not Dead Yet to save them from." });
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, rank: 3 });
    expect(await t.session.keepRoll(t.waiting().id)).toEqual({ ok: true });
  });

  it("counts the hits on the held roll, so a blow the dice turn aside is not a killing one", async () => {
    // 25 damage would kill Kira, but five hits leave 20: her 11 boxes and 9 of her 10 overflow.
    const t = await table();
    await struck(t, 25, "physical", "6 6 6 6 6");
    expect(await nde(t)).toEqual({ ok: false, error: "Kira would survive this as the roll stands, so there is no killing blow for Not Dead Yet to save them from." });
    expect(await t.session.keepRoll(t.waiting().id)).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.characterOf("kira")).toMatchObject({ status: "unconscious", monitor: { overflow: 9 } });
  });

  it("shows in the recap", async () => {
    const t = await table();
    await struck(t);
    await nde(t);
    expect(formatRecap(await t.store.recentEntries(30), (id) => id)).toContain("[Edge] Kira burned Edge for Not Dead Yet and lost a point of Edge rank for good (now 2).");
  });

  it("is refused on a roll that is not resisting damage, or has not been counted", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll(rollInput()));
    await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "3 3 3 3", hold: true });
    expect(await nde(t)).toEqual({ ok: false, error: "Not Dead Yet saves a character from a killing blow, so only a held roll to resist damage can use it." });

    const u = await table();
    await u.gm((tools) => tools.dealDamage({ label: "A fall", target: kira, damageValue: 40, damageType: "physical" }));
    expect(await nde(u)).toEqual({ ok: false, error: "That roll has not been counted yet, so there is nothing to spend Edge on. Roll it with hold first." });
  });

  it("can be burned in a round Edge was spent, and the roll may be held with no Edge to spend", async () => {
    const t = await table();
    await t.startFight();
    await t.session.useEdge("kira", { use: "initiative" });
    expect(t.edgeOf("kira").spentThisRound).toBe(true);
    // A plain roll cannot be held now, but a roll to resist damage can, for the burn.
    await t.gm((tools) => tools.dealDamage({ label: "A fall", target: kira, damageValue: 40, damageType: "physical" }));
    expect(await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "1 1 1 1 1", hold: true })).toEqual({ ok: true });
    expect(await nde(t)).toEqual({ ok: true });
    expect(t.characterOf("kira").status).toBe("unconscious");
  });

  it("cannot be held to burn by someone with no rank left", async () => {
    const t = await table({ party: withEdge("kira", 0) });
    await t.gm((tools) => tools.dealDamage({ label: "A fall", target: kira, damageValue: 40, damageType: "physical" }));
    expect(await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "1 1 1 1 1", hold: true })).toEqual({ ok: false, error: "Kira has 0 Edge and this costs 1. Roll without holding." });
  });

  it("does not make a plain roll holdable with no Edge to spend", async () => {
    const t = await table();
    await t.startFight();
    await t.session.useEdge("kira", { use: "initiative" });
    await t.gm((tools) => tools.requestRoll(rollInput()));
    expect(await t.session.submitRoll(t.waiting().id, { mode: "physical", dice: "3 3 3 3", hold: true })).toMatchObject({ ok: false, error: expect.stringContaining("Roll without holding.") });
  });
});
