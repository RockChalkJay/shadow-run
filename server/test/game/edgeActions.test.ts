import { describe, expect, it } from "vitest";
import { GameSession } from "../../src/game/session.js";
import { formatRecap } from "../../src/game/recap.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party, rollInput } from "../helpers.js";

// Kira has Edge 3 and Doc Edge 4, so Called Shot (5) needs more. Costs: Wrest and Bring the Drama 2, Tumble 1, Big Speech 4, Called Shot 5.
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
const gangerShoots = (over: object = {}) => ({
  label: "Ganger shoots Kira",
  attacker: ganger,
  defender: kira,
  weapon: predator,
  attackPool: pool(5),
  defensePool: pool(4),
  attackRating: 6,
  defenseRating: 4,
  stakes: "The ganger has the drop.",
  ...over,
});

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
  const made = await newSession(driver, { d6: scriptedD6([...faces, ...Array(60).fill(3)]), flip: () => 0.5, ...extra });
  const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1);
  };
  const edgeOf = (id: string) => made.session.snapshot().edge.find((e) => e.id === id)!;
  const characterOf = (id: string) => made.session.snapshot().characters.find((c) => c.id === id)!;
  const waiting = () => made.session.snapshot().pendingRolls[0]!;
  /** Answers the roll on the screen with these physical dice. */
  const roll = async (dice: string, more: object = {}) => {
    const answered = await made.session.submitRoll(waiting().id, { mode: "physical", dice, ...more });
    await made.session.whenIdle();
    return answered;
  };
  const startFight = () => gm((tools) => tools.startCombat({ participants: [{ who: kira }, { who: ganger, initiative: { reaction: 3, intuition: 3, dice: 1 } }] }));
  return { ...made, inputs, gm, edgeOf, characterOf, waiting, roll, startFight };
}

describe("declaring an Edge Action on a roll", () => {
  it("puts it on the roll card and tells the GM what it will cost, charging nothing yet", async () => {
    const t = await table();
    const reply = await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    expect(text(reply)).toContain("Kira will pay 2 Edge for Bring the Drama when the roll counts.");
    expect(t.waiting().edgeAction).toMatchObject({ id: "bring_the_drama", name: "Bring the Drama", cost: 2, requires: "Use Skill (Con)" });
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, spentThisRound: false });
  });

  it("charges the Edge when the roll counts, tells the GM it is theirs to carry out, and records it", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    expect(t.edgeOf("kira").points).toBe(3);
    expect(await t.roll("6 5 5 3")).toEqual({ ok: true });
    expect(t.edgeOf("kira")).toMatchObject({ points: 1, spentThisRound: true });
    const told = t.inputs.at(-1)!;
    expect(told).toContain("EDGE. Kira spent 2 Edge and used the Edge Action Bring the Drama: Add dramatic flair to a con.");
    expect(told).toContain("The system does not apply this one: it is for you to carry out as the book describes, in what you narrate.");
    const entry = (await t.store.recentEntries(30)).find((e) => e.kind === "roll");
    expect(entry).toMatchObject({ resolved: { edge: { spent: 2, action: "bring_the_drama" } } });
    expect(t.events).toContainEqual({ type: "edge.updated", edge: expect.objectContaining({ id: "kira", points: 1 }) });
  });

  it("costs nothing if the roll is skipped", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    expect(await t.session.cancelRoll(t.waiting().id)).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("uses the round's one expenditure, so no other Edge can go on that roll, and the player may roll without it", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "tumble" }));
    const refusal = { ok: false, error: "Kira declared Tumble, which is this round's one expenditure of Edge, so no other Edge can be spent on this roll. Roll without it." };
    expect(await t.session.submitRoll(t.waiting().id, { mode: "app", edge: "dice" })).toEqual(refusal);
    expect(await t.session.submitRoll(t.waiting().id, { mode: "app", hold: true })).toEqual(refusal);
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, spentThisRound: false });
    expect(t.session.snapshot().pendingRolls).toHaveLength(1);
    expect(await t.roll("5 5 3 3")).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(2);
  });

  it("goes ahead without the action, and says so, when the Edge can no longer be paid", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    // Meanwhile Kira spends Edge on her initiative, which is the round's one expenditure.
    expect(await t.session.useEdge("kira", { use: "initiative" })).toEqual({ ok: true });
    expect(await t.roll("6 5 5 3")).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(2);
    const told = t.inputs.at(-1)!;
    expect(told).toContain("EDGE. Kira could not pay 2 Edge for Bring the Drama when the roll was made, so it did not happen and nothing was spent. Do not narrate it.");
    expect(told).not.toContain("used the Edge Action");
    expect(told).toContain("ROLL RESULT");
  });

  it("charges the first of two rolls that declare actions, and lets the second go ahead without, held if the player likes", async () => {
    const t = await table();
    // The GM can ask for both in one turn; it is held back while either is pending.
    await t.gm(async (tools) => {
      await tools.requestRoll({ ...rollInput({ label: "First con" }), edgeAction: "bring_the_drama" });
      await tools.requestRoll({ ...rollInput({ label: "Second con" }), edgeAction: "bring_the_drama" });
    });
    const [first, second] = t.session.snapshot().pendingRolls;
    expect(await t.session.submitRoll(first!.id, { mode: "physical", dice: "6 5 5 3" })).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(1);
    // Edge is a round's worth per roll outside a fight, so only the points stop the second, and she can still hold it for 1.
    expect(await t.session.submitRoll(second!.id, { mode: "physical", dice: "6 5 5 3", hold: true })).toEqual({ ok: true });
    expect(await t.session.keepRoll(second!.id)).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.edgeOf("kira").points).toBe(1);
    expect(t.inputs.at(-1)).toContain("EDGE. Kira could not pay 2 Edge for Bring the Drama when the roll was made, so it did not happen and nothing was spent.");
  });
});

describe("refusing an Edge Action", () => {
  const refused = async (t: Awaited<ReturnType<typeof table>>, input: object) => {
    const reply = await t.gm((tools) => tools.requestRoll(input));
    expect((reply as { ok: boolean }).ok).toBe(false);
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
    return text(reply);
  };

  it("names the real ones when the id is not an Edge Action", async () => {
    const t = await table();
    const said = await refused(t, { ...rollInput(), edgeAction: "mega_punch" });
    expect(said).toContain('"mega_punch" is not an Edge Action. They are: ');
    expect(said).toContain("big_speech");
    expect(said).toContain("called_shot_vitals");
    expect(said).not.toContain("smackdown");
  });

  it("says burning Edge is not handled yet", async () => {
    const t = await table();
    expect(await refused(t, { ...rollInput(), edgeAction: "smackdown" })).toBe("Smackdown is burning Edge, which the system does not handle yet. Narrate around it.");
  });

  it("refuses an action the player cannot afford, without putting a roll on the screen", async () => {
    const t = await table();
    expect(await refused(t, { ...rollInput(), edgeAction: "big_speech" })).toBe("Kira has 3 Edge and this costs 4. Big Speech cannot be used now: ask for the roll without it, or tell the players it is not possible yet.");
  });

  it("refuses one when the player has already spent Edge this round", async () => {
    const t = await table();
    await t.startFight();
    await t.session.useEdge("kira", { use: "initiative" });
    expect(await refused(t, { ...rollInput(), edgeAction: "tumble" })).toContain("Kira has already spent Edge this round.");
  });

  it("refuses a Called Shot on a plain roll, since it works on the damage of an attack", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    expect(await refused(t, { ...rollInput(), edgeAction: "called_shot_vitals" })).toContain("goes only on the attack tool, with the player character as the attacker");
  });

  it("refuses an action on a healing roll", async () => {
    const t = await table();
    const said = await refused(t, {
      ...rollInput({ threshold: undefined }),
      healing: { method: "natural_stun", patient: { kind: "pc", id: "kira" }, essence: 6 },
      edgeAction: "tumble",
    });
    expect(said).toBe("A healing roll cannot carry an Edge Action.");
  });

  it("leaves the complaint about an unknown character to the roll itself", async () => {
    const t = await table();
    expect(await refused(t, { ...rollInput({ characterId: "nobody" }), edgeAction: "tumble" })).toContain('There is no character "nobody" at the table.');
  });
});

describe("Called Shot: Vitals", () => {
  const vitals = { edgeAction: "called_shot_vitals" };

  it("adds 3 to the Damage Value of an attack that hits, which then goes to the defender to resist", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    const reply = await t.gm((tools) => tools.attack(kiraShoots(vitals)));
    expect(text(reply)).toContain("Kira will pay 5 Edge for Called Shot: Vitals when the roll counts.");
    // Three hits against none: Damage Value 3 + 3 net hits + 3 from the Called Shot.
    await t.roll("6 6 6 3 3 3");
    const told = t.inputs.at(-1)!;
    expect(told).toContain("EDGE. Kira spent 5 Edge and used Called Shot: Vitals, which adds 3 to the Damage Value if the attack hits.");
    expect(told).not.toContain("The system does not apply this one");
    expect(told).toContain("HIT by 3 net hits. Damage Value 3 + 3 + 3 (Called Shot: Vitals) = 9 physical, before Ganger resists.");
    expect(t.characterOf("ganger-1").monitor.physical).toBe(9);
    expect(t.edgeOf("kira").points).toBe(0);
    const attack = (await t.store.recentEntries(30)).find((e) => e.kind === "attack");
    expect(attack).toMatchObject({ hit: true, damageValue: 9, edgeAction: "Called Shot: Vitals" });
  });

  it("adds the 3 to a hit on a tie as well", async () => {
    // Two dice for initiative, then the ganger's four defense dice with one hit among them to match Kira's one.
    const t = await table({ party: withEdge("kira", 5) }, [4, 5, 5, 3, 3, 3]);
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots(vitals)));
    await t.roll("5 3 3 3 3 3");
    expect(t.inputs.at(-1)).toContain("HIT on a tie. Damage Value 3 + 3 (Called Shot: Vitals) = 6 physical");
    expect(t.characterOf("ganger-1").monitor.physical).toBe(6);
  });

  it("is spent even when the attack misses, and adds nothing", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots(vitals)));
    await t.roll("1 2 3 3 3 3");
    expect(t.inputs.at(-1)).toContain("MISS. Kira had no hits, so the attack cannot land.");
    expect(t.inputs.at(-1)).toContain("EDGE. Kira spent 5 Edge");
    expect(t.characterOf("ganger-1").monitor.physical).toBe(0);
    expect(t.edgeOf("kira").points).toBe(0);
    expect((await t.store.recentEntries(30)).find((e) => e.kind === "attack")).toMatchObject({ hit: false, damageValue: 0, edgeAction: "Called Shot: Vitals" });
  });

  it("shows in the recap", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots(vitals)));
    await t.roll("6 6 6 3 3 3");
    const recap = formatRecap(await t.store.recentEntries(30), (id) => id);
    expect(recap).toContain("[Attack] Kira hit Ganger with Ares Predator VI, using Called Shot: Vitals.");
  });

  it("is refused for a player who is defending, since it changes only their own attack", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    const reply = await t.gm((tools) => tools.attack(gangerShoots(vitals)));
    expect(text(reply)).toContain("goes only on the attack tool, with the player character as the attacker");
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
  });
});

describe("Called Shot: Disarm", () => {
  const disarm = { edgeAction: "called_shot_disarm" };

  it("makes a hit do no damage, knocks the weapon away, and spends the Edge", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots(disarm)));
    await t.roll("6 6 6 3 3 3");
    const told = t.inputs.at(-1)!;
    expect(told).toContain("HIT, and it is a disarm (Called Shot: Disarm). It does no damage, and Ganger's weapon is knocked from their hands.");
    expect(told).not.toContain("DAMAGE RESULT");
    expect(told).not.toContain("Damage Value 3 +");
    expect(t.characterOf("ganger-1").monitor.physical).toBe(0);
    expect(t.edgeOf("kira").points).toBe(0);
    const entries = await t.store.recentEntries(30);
    expect(entries.find((e) => e.kind === "attack")).toMatchObject({ hit: true, damageValue: 0, edgeAction: "Called Shot: Disarm" });
    expect(entries.some((e) => e.kind === "damage")).toBe(false);
  });

  it("does nothing on a miss, but the Edge is spent", async () => {
    const t = await table({ party: withEdge("kira", 5) });
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots(disarm)));
    await t.roll("1 1 3 3 3 3");
    expect(t.inputs.at(-1)).toContain("MISS.");
    expect(t.inputs.at(-1)).not.toContain("disarm");
    expect(t.edgeOf("kira").points).toBe(0);
  });
});

describe("other Edge Actions on an attack", () => {
  it("go on a player's attack or defense, are charged, and are left to the GM to carry out", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.attack(kiraShoots({ edgeAction: "tumble" })));
    expect(t.waiting().edgeAction).toMatchObject({ id: "tumble", cost: 1 });
    await t.roll("6 6 3 3 3 3");
    expect(t.inputs.at(-1)).toContain("EDGE. Kira spent 1 Edge and used the Edge Action Tumble:");
    expect(t.inputs.at(-1)).toContain("The system does not apply this one");
    expect(t.inputs.at(-1)).toContain("HIT by 2 net hits. Damage Value 3 + 2 = 5 physical");
    expect((await t.store.recentEntries(30)).find((e) => e.kind === "attack")).not.toHaveProperty("edgeAction");
    expect(t.edgeOf("kira").points).toBe(2);
  });

  it("go on a player's defense as well", async () => {
    const t = await table();
    await t.startFight();
    await t.gm((tools) => tools.attack(gangerShoots({ edgeAction: "wrest" })));
    expect(t.waiting().edgeAction).toMatchObject({ id: "wrest", cost: 2 });
    await t.roll("6 6 6 3");
    expect(t.inputs.at(-1)).toContain("EDGE. Kira spent 2 Edge and used the Edge Action Wrest:");
    expect(t.edgeOf("kira").points).toBe(1);
  });

  it("are refused when no player character has dice to roll, since non-player characters do not use Edge", async () => {
    const t = await table();
    await t.startFight();
    const reply = await t.gm((tools) =>
      tools.attack({ ...gangerShoots({ edgeAction: "tumble" }), attacker: { ...ganger, id: "ganger-2", name: "Ganger 2" }, defender: { ...ganger, id: "ganger-3", name: "Ganger 3" } }),
    );
    expect(text(reply)).toBe("No player character has dice to roll in this attack, so there is no Edge Action to use: non-player characters do not use Edge.");
    expect((await t.store.recentEntries(30)).some((e) => e.kind === "attack")).toBe(false);
  });

  it("are refused when the player cannot pay, and the attack is not made", async () => {
    const t = await table();
    const reply = await t.gm((tools) => tools.attack(kiraShoots({ edgeAction: "called_shot_vitals" })));
    expect(text(reply)).toBe("Kira has 3 Edge and this costs 5. Called Shot: Vitals cannot be used now: ask for the roll without it, or tell the players it is not possible yet.");
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
  });
});

describe("an Edge Action that waits for dice", () => {
  it("survives a restart, and is paid for when the roll is answered afterwards", async () => {
    const t = await table();
    await t.gm((tools) => tools.requestRoll({ ...rollInput(), edgeAction: "bring_the_drama" }));
    const driver: GmDriver = { async takeTurn() {} };
    const again = await GameSession.create({ store: t.store, driver, party, emit: () => {}, d6: scriptedD6(Array(20).fill(3)) });
    const waiting = again.snapshot().pendingRolls[0]!;
    expect(waiting.edgeAction).toMatchObject({ id: "bring_the_drama", cost: 2 });
    expect(await again.submitRoll(waiting.id, { mode: "physical", dice: "6 5 5 3" })).toEqual({ ok: true });
    expect(again.snapshot().edge.find((e) => e.id === "kira")!.points).toBe(1);
    await again.close();
  });
});
