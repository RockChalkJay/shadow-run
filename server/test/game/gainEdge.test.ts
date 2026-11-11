import { describe, expect, it } from "vitest";
import { formatRecap } from "../../src/game/recap.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party } from "../helpers.js";

// Kira starts with 3 Edge points and the attribute 3; Doc with 4 and 4. At most 2 can be gained in a round and 7 held in all.
const kira = { kind: "pc", id: "kira" };
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const colt = { name: "Colt America L36", damageValue: 3, damageType: "physical" };
const pool = (total: number) => ({ total, breakdown: "a pool" });

const kiraShoots = (attackRating: number, defenseRating: number, over: object = {}) => ({
  label: "Kira shoots the ganger",
  attacker: kira,
  defender: ganger,
  weapon: colt,
  attackPool: pool(6),
  defensePool: pool(4),
  attackRating,
  defenseRating,
  stakes: "A ganger on the stairs.",
  ...over,
});
const gangerShoots = (attackRating: number, defenseRating: number, over: object = {}) => ({
  label: "Ganger shoots Kira",
  attacker: ganger,
  defender: kira,
  weapon: colt,
  attackPool: pool(5),
  defensePool: pool(4),
  attackRating,
  defenseRating,
  stakes: "The ganger has the drop.",
  ...over,
});
const guard = (n: number) => ({ kind: "npc", id: `guard-${n}`, name: `Guard ${n}`, body: 2, willpower: 2, professionalRating: 3, charisma: 2 });

/** A game with a fight on (Kira and the ganger), whose GM does whatever job it is next given. */
async function fight(extra: Parameters<typeof newSession>[1] = {}, begun = true) {
  const jobs: Array<(ctx: GmTurnContext) => Promise<unknown>> = [];
  const results: unknown[] = [];
  const driver: GmDriver = {
    async takeTurn(_input, ctx) {
      const job = jobs.shift();
      if (job) results.push(await job(ctx));
    },
  };
  const made = await newSession(driver, { d6: scriptedD6([4, 5, ...Array(40).fill(3)]), flip: () => 0.5, ...extra });
  const gm = async <T>(job: (tools: GmTools) => Promise<T>): Promise<T> => {
    jobs.push((ctx) => job(ctx.tools));
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1) as T;
  };
  const edgeOf = (id: string) => made.session.snapshot().edge.find((e) => e.id === id)!;
  if (begun) {
    await gm((tools) =>
      tools.startCombat({ participants: [{ who: kira }, { who: ganger, initiative: { reaction: 3, intuition: 3, dice: 1 } }] }),
    );
  }
  return { ...made, gm, edgeOf, jobs };
}
const text = (r: unknown) => (r as { text: string }).text;
/** Kira makes the attack that is waiting for her. */
const makeAttack = async (t: { session: { snapshot(): { pendingRolls: Array<{ id: string }> }; submitRoll(id: string, e: object): Promise<unknown>; whenIdle(): Promise<void> } }) => {
  await t.session.submitRoll(t.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "3 3 3 3 3 3" });
  await t.session.whenIdle();
};

describe("Edge from a gap between Attack Rating and Defense Rating", () => {
  it("goes to a player who attacks with a rating four or more above the target's, before the roll", async () => {
    const t = await fight();
    const reply = await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    expect(text(reply)).toContain("EDGE. Kira gains 1 Edge: Attack Rating 9 against Defense Rating 5.");
    expect(t.edgeOf("kira").points).toBe(4);
    expect((await t.store.recentEntries(20)).find((e) => e.kind === "edge")).toMatchObject({ characterId: "kira", gained: 1, source: "ratings" });
    expect(t.events).toContainEqual({ type: "edge.updated", edge: expect.objectContaining({ id: "kira", points: 4 }) });
  });

  it("is there to spend on that very roll", async () => {
    // Kira starts with 3 Edge, one short of the 4 that Edge dice cost; the gain makes it 4.
    const t = await fight();
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    const id = t.session.snapshot().pendingRolls[0]!.id;
    expect(await t.session.submitRoll(id, { mode: "physical", dice: "6 6 6 3 3 3 3 3 3", edge: "dice", explosions: "5 3 3" })).toEqual({ ok: true });
    expect(t.edgeOf("kira").points).toBe(0);
  });

  it("needs a gap of four, not three", async () => {
    const t = await fight();
    const reply = await t.gm((tools) => tools.attack(kiraShoots(8, 5)));
    expect(text(reply)).toContain("is waiting for dice");
    expect(text(reply)).not.toContain("EDGE.");
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("goes to a player defending when the target's Defense Rating is four or more above the attack's", async () => {
    const t = await fight();
    const reply = await t.gm((tools) => tools.attack(gangerShoots(5, 9)));
    expect(text(reply)).toContain("EDGE. Kira gains 1 Edge: Defense Rating 9 against Attack Rating 5.");
    expect(t.edgeOf("kira").points).toBe(4);
  });

  it("is dropped when it would go to an opponent, who does not use Edge", async () => {
    const attackerWide = await fight();
    const first = text(await attackerWide.gm((tools) => tools.attack(gangerShoots(12, 5))));
    expect(first).toContain("is waiting for dice");
    expect(first).not.toContain("EDGE.");
    expect(attackerWide.edgeOf("kira").points).toBe(3);
    const defenderWide = await fight();
    const second = text(await defenderWide.gm((tools) => tools.attack(kiraShoots(5, 12))));
    expect(second).toContain("is waiting for dice");
    expect(second).not.toContain("EDGE.");
    expect(defenderWide.edgeOf("kira").points).toBe(3);
  });

  it("is not gained when no confrontation is under way", async () => {
    const t = await fight({}, false);
    const reply = await t.gm((tools) => tools.attack(kiraShoots(12, 5, { defender: { ...ganger, initiative: undefined } })));
    expect(text(reply)).toContain("is waiting for dice");
    expect(text(reply)).not.toContain("EDGE.");
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("counts a group of grunts as one rating higher for each member beyond the first", async () => {
    // Three guards at Attack Rating 6 count as 8 against Kira's Defense Rating 10: a gap of 2, so no Edge for her.
    const group = (alongside: object[]) => ({ ...gangerShoots(6, 10), attacker: guard(1), alongside });
    const grouped = await fight();
    const groupReply = text(await grouped.gm((tools) => tools.attack(group([guard(2), guard(3)]))));
    expect(groupReply).toContain("is waiting for dice");
    expect(groupReply).not.toContain("EDGE.");
    expect(grouped.edgeOf("kira").points).toBe(3);
    // One guard alone: 6 against 10 is a gap of 4, which does earn it.
    const alone = await fight();
    expect(text(await alone.gm((tools) => tools.attack(group([]))))).toContain("EDGE. Kira gains 1 Edge: Defense Rating 10 against Attack Rating 6.");
  });
});

describe("Edge for an attack that is then skipped", () => {
  it("is taken back, and the GM is told", async () => {
    const t = await fight();
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    expect(t.edgeOf("kira").points).toBe(4);
    t.jobs.push(async () => undefined);
    await t.session.cancelRoll(t.session.snapshot().pendingRolls[0]!.id);
    await t.session.whenIdle();
    expect(t.edgeOf("kira").points).toBe(3);
    expect((await t.store.recentEntries(20)).filter((e) => e.kind === "edge").map((e) => (e as { gained: number }).gained)).toEqual([1, -1]);
    expect(formatRecap((await t.store.recentEntries(20)).filter((e) => e.kind === "edge"), (id) => id)).toBe(
      "[Edge] Kira gained 1 Edge: Attack Rating 9 against Defense Rating 5.\n[Edge] Kira lost 1 Edge: taken back because the attack was not made.",
    );
  });

  it("is still taken back when the attack is rolled, held and rolled again in test mode, and then skipped", async () => {
    const t = await fight({ testMode: true });
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    expect(t.edgeOf("kira").points).toBe(4);
    const id = t.session.snapshot().pendingRolls[0]!.id;
    await t.session.submitRoll(id, { mode: "physical", dice: "1 1 1 1 1 1", hold: true });
    await t.session.redoRoll(id);
    t.jobs.push(async () => undefined);
    await t.session.cancelRoll(id);
    await t.session.whenIdle();
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("cannot be used to farm Edge: skipping uses up the round's limit, and nothing is kept", async () => {
    const t = await fight();
    for (let i = 0; i < 2; i++) {
      await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
      await t.session.cancelRoll(t.session.snapshot().pendingRolls[0]!.id);
      await t.session.whenIdle();
    }
    expect(t.edgeOf("kira").points).toBe(3);
    const third = await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    expect(text(third)).toContain("has already gained the most allowed this round");
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("is kept once the attack is made, even if the player waits on Edge first", async () => {
    const t = await fight();
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    const id = t.session.snapshot().pendingRolls[0]!.id;
    await t.session.submitRoll(id, { mode: "physical", dice: "3 3 3 3 3 3", hold: true });
    await t.session.cancelRoll(id);
    await t.session.whenIdle();
    expect(t.edgeOf("kira").points).toBe(4);
  });

  it("is kept by a player who defends, since a defense cannot be skipped", async () => {
    const t = await fight();
    await t.gm((tools) => tools.attack(gangerShoots(5, 9)));
    const id = t.session.snapshot().pendingRolls[0]!.id;
    expect(await t.session.cancelRoll(id)).toMatchObject({ ok: false });
    expect(t.edgeOf("kira").points).toBe(4);
  });
});

describe("the limits on gaining Edge", () => {
  it("allows two points in a round and says so when a third would go over", async () => {
    const t = await fight();
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    await makeAttack(t);
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    await makeAttack(t);
    expect(t.edgeOf("kira").points).toBe(5);
    const third = await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    expect(text(third)).toContain("EDGE. Kira would gain Edge (Attack Rating 9 against Defense Rating 5) but has already gained the most allowed this round.");
    expect(t.edgeOf("kira").points).toBe(5);
  });

  it("starts over each round", async () => {
    const t = await fight();
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A clever distraction" }));
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A second clever move" }));
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A third clever move" })))).toContain("already gained the most allowed this round");
    await t.gm((tools) => tools.nextRound());
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A fourth clever move" })))).toContain("EDGE. Kira gains 1 Edge");
    expect(t.edgeOf("kira").points).toBe(6);
  });

  it("never lets anyone hold more than seven", async () => {
    const six = party.map((m) => (m.id === "kira" ? { ...m, attributes: { ...m.attributes, edge: 6 } } : m));
    const t = await fight({ party: six });
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A clever distraction" })))).toContain("Kira gains 1 Edge");
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "Another clever move" })))).toBe("EDGE. Kira would gain Edge (Another clever move) but already has the most allowed.");
    expect(t.edgeOf("kira").points).toBe(7);
  });

  it("takes Edge above the attribute away when the fight ends, and keeps what is below it", async () => {
    const t = await fight();
    await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A clever distraction" }));
    expect(t.edgeOf("kira").points).toBe(4);
    await t.gm((tools) => tools.endCombat());
    expect(t.edgeOf("kira")).toMatchObject({ points: 3, rank: 3 });
  });
});

describe("a GM award of Edge", () => {
  it("gives a point with the reason the players read, in the transcript and the recap", async () => {
    const t = await fight();
    const reply = await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "She talked the guard into leaving his post" }));
    expect(text(reply)).toBe("EDGE. Kira gains 1 Edge: She talked the guard into leaving his post.");
    const entry = (await t.store.recentEntries(20)).find((e) => e.kind === "edge");
    expect(entry).toMatchObject({ gained: 1, source: "gm", reason: "She talked the guard into leaving his post" });
    expect(formatRecap([entry!], (id) => id)).toBe("[Edge] Kira gained 1 Edge: She talked the guard into leaving his post.");
  });

  it("shares the round's limit with the Edge that rating gaps give", async () => {
    const t = await fight();
    await t.gm((tools) => tools.attack(kiraShoots(9, 5)));
    await makeAttack(t);
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "A clever distraction" })))).toContain("Kira gains 1 Edge");
    expect(text(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "Another clever move" })))).toContain("already gained the most allowed this round");
    expect(t.edgeOf("kira").points).toBe(5);
  });

  it.each([
    ["with no confrontation under way", "outside", { characterId: "kira", reason: "A clever distraction" }, "Edge is gained only in a confrontation. Start one with start_combat"],
    ["for someone who is not a player character here", "fight", { characterId: "nobody", reason: "A clever distraction" }, 'There is no player character "nobody" to award Edge.'],
    ["with no reason worth reading", "fight", { characterId: "kira", reason: "ok" }, "The award was not valid"],
  ])("is refused %s", async (_name, when, input, message) => {
    const t = await fight({}, when === "fight");
    const reply = await t.gm((tools) => tools.awardEdge(input));
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining(message) });
    expect(t.edgeOf("kira").points).toBe(3);
  });

  it("is refused for someone who is down", async () => {
    const t = await fight();
    const reply = await t.gm(async (tools) => {
      await tools.dealDamage({ label: "Gas", target: kira, damageValue: 12, damageType: "stun" });
      return tools.awardEdge({ characterId: "kira", reason: "A clever distraction" });
    });
    // The damage waits on Kira's resistance roll; the award is about someone still on their feet.
    expect(reply).toMatchObject({ ok: true });
    await t.session.submitRoll(t.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "1 1 1 1 1" });
    await t.session.whenIdle();
    expect(await t.gm((tools) => tools.awardEdge({ characterId: "kira", reason: "Another clever move" }))).toMatchObject({ ok: false, text: "Kira is unconscious and cannot gain Edge." });
  });
});
