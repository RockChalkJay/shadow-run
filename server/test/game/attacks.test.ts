import { describe, expect, it } from "vitest";
import { MAX_PENDING_ROLLS } from "../../src/game/rollManager.js";
import type { GmDriver, GmTools } from "../../src/gm/driver.js";
import { ScriptedGmDriver } from "../../src/gm/scriptedDriver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, party, rollInput, toolRunner } from "../helpers.js";

// Kira: Body 5, Willpower 3 -> Physical 11, Stun 10, Overflow 10. Doc: Body 3, Willpower 5.
// An NPC with Body 3 and Willpower 3 has Physical 10, Stun 10, Overflow 6; with Body 2 and Willpower 2, 9, 9 and 4.
const kira = { kind: "pc", id: "kira" };
const doc = { kind: "pc", id: "doc" };
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const thug = { kind: "npc", id: "thug-1", name: "Thug", body: 2, willpower: 2 };
const predator = { name: "Ares Predator VI", damageValue: 3, damageType: "physical" };
const colt = { name: "Colt America L36", damageValue: 3, damageType: "physical" };

const pool = (total: number, breakdown = "a pool") => ({ total, breakdown });

/** Kira shoots the ganger with 6 dice against his 4. */
const kiraShoots = (over: object = {}) => ({
  label: "Kira shoots the ganger",
  attacker: kira,
  defender: ganger,
  weapon: predator,
  attackPool: pool(6, "Agility 5 + Firearms 1"),
  defensePool: pool(4, "Reaction 2 + Intuition 2"),
  stakes: "A ganger on the stairs has a gun on her.",
  ...over,
});

/** The ganger shoots Kira with 5 dice against her 4. */
const gangerShoots = (over: object = {}) => ({
  label: "Ganger shoots Kira",
  attacker: ganger,
  defender: kira,
  weapon: colt,
  attackPool: pool(5, "Agility 3 + Firearms 2"),
  defensePool: pool(4, "Reaction 2 + Intuition 2"),
  stakes: "The ganger has the drop on her.",
  ...over,
});

const requestedId = (events: Array<{ type: string }>) =>
  (events.find((e) => e.type === "roll.requested") as unknown as { request: { id: string } }).request.id;

/** A session where the GM's first turn makes these attacks and its next speaks; `faces` are the system's dice, in order. */
async function fight(attacks: object[], faces: number[]) {
  const driver = new ScriptedGmDriver([{ attacks }, { say: ["It happens."] }]);
  const made = await newSession(driver, { d6: scriptedD6(faces) });
  await made.session.start();
  await made.session.whenIdle();
  return { driver, ...made };
}

const standing = (made: { session: { snapshot(): { characters: Array<{ id: string }> } } }, id: string) =>
  made.session.snapshot().characters.find((c) => c.id === id);

describe("a player character attacks a non-player character", () => {
  it("puts the attack on the players' screen with the defender's pool, and holds the GM", async () => {
    const t = await fight([kiraShoots()], []);
    const [request] = t.session.snapshot().pendingRolls;
    expect(request).toMatchObject({
      characterId: "kira",
      label: "Kira shoots the ganger",
      pool: { total: 6, breakdown: "Agility 5 + Firearms 1" },
      opposed: { by: "Ganger", pool: 4, role: "acting" },
      attack: { role: "attacker", weapon: predator, other: { kind: "npc", id: "ganger-1", name: "Ganger" } },
    });
    expect(request?.goodRoll).toContain("Ares Predator VI");
    expect(t.driver.inputs).toHaveLength(1);
    expect(t.session.snapshot().gm).toEqual({ phase: "waiting_for_rolls" });
  });

  it("adds the net hits to the Damage Value, has the NPC resist with Body, and tells the GM everything at once", async () => {
    // The system rolls the ganger's 4 defense dice (no hits), then his Body 3 (2 hits).
    const t = await fight([kiraShoots()], [3, 3, 3, 3, 6, 5, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 6 6 5 3 3" });
    await t.session.whenIdle();

    expect(t.driver.inputs[1]?.text).toBe(
      [
        "ATTACK RESULT. Kira shoots the ganger.",
        "Kira attacked with Ares Predator VI (3P), 6 dice (dice at the table): 6 6 6 5 3 3 = 4 hits.",
        "Ganger defended, 4 dice (the system's dice): 3 3 3 3 = 0 hits.",
        "HIT by 4 net hits. Damage Value 3 + 4 = 7 physical, before Ganger resists.",
        "DAMAGE RESULT. Kira's Ares Predator VI: 7 physical damage to Ganger.",
        "Ganger resisted with Body 3 (the system's dice): 6 5 3 = 2 hits, so 5 physical damage got through.",
        "Ganger: Physical 5/10, Stun 0/10, Overflow 0/6. Wound penalty: -1 dice on everything but damage resistance.",
      ].join("\n"),
    );
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 5 } });
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
  });

  it("hits for the base Damage Value on a tie in which the attacker has hits", async () => {
    const t = await fight([kiraShoots()], [6, 5, 3, 3, 3, 3, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 5 3 3 3 3" });
    await t.session.whenIdle();
    const text = t.driver.inputs[1]?.text ?? "";
    expect(text).toContain("HIT on a tie. Damage Value 3 physical, before Ganger resists.");
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 3 } });
  });

  it("misses when the defender has more hits, and the NPC takes nothing", async () => {
    const t = await fight([kiraShoots()], [6, 5, 3, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 3 3 3 3 3" });
    await t.session.whenIdle();
    const text = t.driver.inputs[1]?.text ?? "";
    expect(text).toContain("MISS. Ganger had more hits.");
    expect(text).not.toContain("DAMAGE RESULT");
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 0, stun: 0 } });
  });

  it("misses when neither side has a hit: an attacker with no hits cannot land one", async () => {
    const t = await fight([kiraShoots()], [3, 3, 3, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "3 3 3 3 3 3" });
    await t.session.whenIdle();
    const text = t.driver.inputs[1]?.text ?? "";
    expect(text).toContain("MISS. Kira had no hits, so the attack cannot land.");
    expect(text).not.toContain("DAMAGE RESULT");
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 0 } });
  });

  it("leaves a target who died while the attack waited dead, and says so", async () => {
    // In one turn the GM starts Kira's attack and then kills the ganger some other way.
    const runner = toolRunner();
    // The grenade meets the ganger's Body 3 (3 dice), and later his 4 defense dice; none of them hit.
    const inputs: string[] = [];
    const driver: GmDriver = { takeTurn: (input, ctx) => (inputs.push(input.text), runner.driver.takeTurn(input, ctx)) };
    const t = await newSession(driver, { d6: scriptedD6([3, 3, 3, 3, 3, 3, 3]) });
    await runner.run(t.session, async (ctx) => {
      await ctx.tools.attack(kiraShoots());
      return ctx.tools.dealDamage({ label: "Grenade", target: ganger, damageValue: 40, damageType: "physical" });
    });
    // The grenade left 30 in the overflow track beyond its boxes; the attack that follows must not add to it.
    expect(standing(t, "ganger-1")).toMatchObject({ status: "dead", monitor: { overflow: 30 } });
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 6 6 5 3 3" });
    await t.session.whenIdle();
    expect(standing(t, "ganger-1")).toMatchObject({ status: "dead", monitor: { physical: 10, overflow: 30 } });
    const text = inputs.at(-1) ?? "";
    expect(text).toContain("HIT by 4 net hits.");
    expect(text).toContain("Ganger is already dead.");
    expect(text).not.toContain("DAMAGE RESULT. Kira's");
  });

  it("deals stun when the weapon does stun", async () => {
    const baton = { name: "Stun baton", damageValue: 5, damageType: "stun" };
    const t = await fight([kiraShoots({ weapon: baton })], [3, 3, 3, 3, 3, 3, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 6 3 3 3 3" });
    await t.session.whenIdle();
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 0, stun: 7 } });
  });

  it("lets the player skip their own attack, which tells the GM nothing happened", async () => {
    const t = await fight([kiraShoots()], []);
    expect(await t.session.cancelRoll(requestedId(t.events))).toEqual({ ok: true });
    await t.session.whenIdle();
    expect(t.driver.inputs[1]?.text).toContain("ROLL SKIPPED");
    expect(standing(t, "ganger-1")).toMatchObject({ monitor: { physical: 0 } });
  });
});

describe("a non-player character attacks a player character", () => {
  it("asks the player to defend, then asks for the Body resistance, and tells the GM once both are in", async () => {
    // The system rolls the ganger's 5 attack dice (3 hits) when Kira defends.
    const t = await fight([gangerShoots()], [6, 6, 5, 3, 3]);
    const [defense] = t.session.snapshot().pendingRolls;
    expect(defense).toMatchObject({
      characterId: "kira",
      pool: { total: 4 },
      opposed: { by: "Ganger", pool: 5, role: "defending" },
      attack: { role: "defender", weapon: colt, other: { kind: "npc", id: "ganger-1", name: "Ganger" } },
    });

    await t.session.submitRoll(defense!.id, { mode: "physical", dice: "3 3 3 3" });
    await t.session.whenIdle();
    const [resist] = t.session.snapshot().pendingRolls;
    expect(resist).toMatchObject({ characterId: "kira", soak: { damageValue: 6, damageType: "physical", source: "Ganger's Colt America L36" } });
    expect(t.driver.inputs).toHaveLength(1);

    await t.session.submitRoll(resist!.id, { mode: "physical", dice: "6 5 3 1 1" });
    await t.session.whenIdle();
    expect(t.driver.inputs[1]?.text).toBe(
      [
        "ATTACK RESULT. Ganger shoots Kira.",
        "Ganger attacked with Colt America L36 (3P), 5 dice (the system's dice): 6 6 5 3 3 = 3 hits.",
        "Kira defended, 4 dice (dice at the table): 3 3 3 3 = 0 hits.",
        "HIT by 3 net hits. Damage Value 3 + 3 = 6 physical, before Kira resists.",
        "",
        "DAMAGE RESULT. Ganger's Colt America L36: 6 physical damage to Kira.",
        "Kira resisted with Body 5 (dice at the table): 6 5 3 1 1 = 2 hits, so 4 physical damage got through.",
        "Kira: Physical 4/11, Stun 0/10, Overflow 0/10. Wound penalty: -1 dice on everything but damage resistance.",
      ].join("\n"),
    );
    expect(standing(t, "kira")).toMatchObject({ monitor: { physical: 4 } });
  });

  it("asks for no resistance when the player's defense wins", async () => {
    const t = await fight([gangerShoots()], [6, 5, 3, 3, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 6 5 3" });
    await t.session.whenIdle();
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
    const text = t.driver.inputs[1]?.text ?? "";
    expect(text).toContain("MISS. Kira had more hits.");
    expect(text).not.toContain("DAMAGE RESULT");
    expect(standing(t, "kira")).toMatchObject({ monitor: { physical: 0 } });
  });

  it("does not let the player skip the defense, which would dodge the shot", async () => {
    const t = await fight([gangerShoots()], []);
    const id = requestedId(t.events);
    expect(await t.session.cancelRoll(id)).toEqual({
      ok: false,
      error: "That roll defends against an attack that is already coming, so it cannot be skipped. Roll it with the app or with dice.",
    });
    expect(t.session.snapshot().pendingRolls).toHaveLength(1);
  });

  it("takes the player's wounds off their defense", async () => {
    // Kira with 3 boxes of physical damage defends with one die fewer.
    const runner = toolRunner();
    const hurt = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3, 3, 3]) });
    await runner.run(hurt.session, (ctx) => ctx.tools.dealDamage({ label: "Fall", target: kira, damageValue: 3, damageType: "physical" }));
    await hurt.session.submitRoll(requestedId(hurt.events), { mode: "physical", dice: "1 1 1 1 1" });
    await hurt.session.whenIdle();
    expect(standing(hurt, "kira")).toMatchObject({ woundModifier: 1 });
    await runner.run(hurt.session, (ctx) => ctx.tools.attack(gangerShoots()));
    const defense = hurt.session.snapshot().pendingRolls[0];
    expect(defense).toMatchObject({ pool: { total: 3 }, woundPenalty: 1 });
  });
});

describe("attacks between non-player characters", () => {
  it("rolls everything at once, applies the damage, and answers the GM straight away", async () => {
    // Attack 5 dice (3 hits), defense 3 dice (no hits), then the thug's Body 2 (no hits).
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([6, 6, 5, 3, 3, 3, 3, 3, 3, 3]) });
    const chain = { name: "Bike chain", damageValue: 4, damageType: "physical" };
    const reply = await runner.run(t.session, (ctx) =>
      ctx.tools.attack({ label: "Ganger clubs the thug", attacker: ganger, defender: thug, weapon: chain, attackPool: pool(5), defensePool: pool(3), stakes: "A brawl." }),
    );
    expect(reply).toEqual({
      ok: true,
      text: [
        "ATTACK RESULT. Ganger clubs the thug.",
        "Ganger attacked with Bike chain (4P), 5 dice (the system's dice): 6 6 5 3 3 = 3 hits.",
        "Thug defended, 3 dice (the system's dice): 3 3 3 = 0 hits.",
        "HIT by 3 net hits. Damage Value 4 + 3 = 7 physical, before Thug resists.",
        "DAMAGE RESULT. Ganger's Bike chain: 7 physical damage to Thug.",
        "Thug resisted with Body 2 (the system's dice): 3 3 = 0 hits, so 7 physical damage got through.",
        "Thug: Physical 7/9, Stun 0/9, Overflow 0/4. Wound penalty: -2 dice on everything but damage resistance.",
      ].join("\n"),
    });
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
  });

  it("takes an NPC's wounds off their pool", async () => {
    // The ganger takes 3 physical (no resisting hits), which costs him a die.
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3]) });
    await runner.run(t.session, async (ctx) => {
      await ctx.tools.dealDamage({ label: "Fall", target: ganger, damageValue: 3, damageType: "physical" });
      return ctx.tools.attack(gangerShoots());
    });
    expect(t.session.snapshot().pendingRolls[0]).toMatchObject({ opposed: { by: "Ganger", pool: 4, role: "defending" } });
  });

  it("takes the defending NPC's wounds off their defense when a player attacks", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3]) });
    await runner.run(t.session, async (ctx) => {
      await ctx.tools.dealDamage({ label: "Fall", target: ganger, damageValue: 3, damageType: "physical" });
      return ctx.tools.attack(kiraShoots());
    });
    expect(t.session.snapshot().pendingRolls[0]).toMatchObject({ opposed: { by: "Ganger", pool: 3, role: "acting" } });
  });

  it("leaves a player character with no defense when they are down, so the attacker needs only a hit", async () => {
    const runner = toolRunner();
    // Kira takes 12 stun with no hits to resist it, which fills her stun track and puts her down.
    const t = await newSession(runner.driver, { d6: scriptedD6([6, 5, 3, 3, 3]) });
    await runner.run(t.session, (ctx) => ctx.tools.dealDamage({ label: "Gas", target: kira, damageValue: 12, damageType: "stun" }));
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "1 1 1 1 1" });
    await t.session.whenIdle();
    expect(standing(t, "kira")).toMatchObject({ status: "unconscious" });

    const reply = (await runner.run(t.session, (ctx) => ctx.tools.attack(gangerShoots()))) as { ok: boolean; text: string };
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain("Kira defended, 0 dice (the system's dice): no dice = 0 hits.");
    expect(reply.text).toContain("HIT by 2 net hits. Damage Value 3 + 2 = 5 physical, before Kira resists.");
    expect(reply.text).toContain("Kira must roll Body to resist 5 physical damage. The roll card is on the table's screen. End your turn now and wait for the result.");
    expect(t.session.snapshot().pendingRolls[0]).toMatchObject({ soak: { damageValue: 5 } });
  });
});

describe("attacks the system refuses", () => {
  const refused = async (call: (tools: GmTools) => Promise<unknown>, faces: number[] = []) => {
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6(faces) });
    const reply = (await runner.run(t.session, (ctx) => call(ctx.tools))) as { ok: boolean; text: string };
    return { reply, ...t };
  };

  it("will not have two player characters fight yet", async () => {
    const { reply } = await refused((tools) => tools.attack(gangerShoots({ attacker: kira, defender: doc })));
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining("between two player characters are not handled yet") });
  });

  it("will not have someone attack themselves", async () => {
    const { reply } = await refused((tools) => tools.attack(gangerShoots({ attacker: ganger, defender: { kind: "npc", id: "ganger-1" } })));
    expect(reply).toEqual({ ok: false, text: "Ganger cannot attack themselves." });
  });

  it("asks for an NPC's details the first time they are named", async () => {
    const { reply } = await refused((tools) => tools.attack(gangerShoots({ attacker: { kind: "npc", id: "nobody" } })));
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining('"nobody" is new to the table') });
  });

  it("will not attack a character who is already dead, or let a dead one attack", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3]) });
    const [killed, shot, shooting] = (await runner.run(t.session, async (ctx) => [
      await ctx.tools.dealDamage({ label: "Grenade", target: ganger, damageValue: 40, damageType: "physical" }),
      await ctx.tools.attack(kiraShoots()),
      await ctx.tools.attack(gangerShoots()),
    ])) as Array<{ ok: boolean; text: string }>;
    expect(killed?.text).toContain("Ganger is DEAD.");
    expect(shot).toEqual({ ok: false, text: "Ganger is already dead." });
    expect(shooting).toEqual({ ok: false, text: "Ganger is dead and cannot attack." });
  });

  it("will not take an attack with no dice in a pool", async () => {
    const { reply } = await refused((tools) => tools.attack(kiraShoots({ attackPool: pool(0) })));
    expect(reply.ok).toBe(false);
    expect(reply.text).toContain("The attack was not valid");
  });

  it("stops a GM stuck in a loop from filling the players' screen", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver);
    const replies = (await runner.run(t.session, async (ctx) => {
      for (let i = 0; i < MAX_PENDING_ROLLS; i++) await ctx.tools.requestRoll(rollInput());
      return [await ctx.tools.attack(kiraShoots()), await ctx.tools.attack(gangerShoots())];
    })) as Array<{ ok: boolean; text: string }>;
    for (const reply of replies) expect(reply).toMatchObject({ ok: false, text: expect.stringContaining(`There are already ${MAX_PENDING_ROLLS} rolls waiting`) });
  });

  it("will not hit a downed player character when no more rolls fit, since that adds a resistance roll", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([6, 5, 3, 3, 3]) });
    await runner.run(t.session, (ctx) => ctx.tools.dealDamage({ label: "Gas", target: kira, damageValue: 12, damageType: "stun" }));
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "1 1 1 1 1" });
    await t.session.whenIdle();
    const reply = await runner.run(t.session, async (ctx) => {
      for (let i = 0; i < MAX_PENDING_ROLLS; i++) await ctx.tools.requestRoll(rollInput({ characterId: "doc" }));
      return ctx.tools.attack(gangerShoots());
    });
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining(`There are already ${MAX_PENDING_ROLLS} rolls waiting`) });
    expect(t.session.snapshot().pendingRolls).toHaveLength(MAX_PENDING_ROLLS);
  });

  it("does nothing once the GM's turn is over", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver);
    const tools = await runner.run(t.session, async (ctx) => ctx.tools);
    expect(await tools.attack(kiraShoots())).toEqual({ ok: false, text: "That turn is over, so nothing was done. Do not call tools now." });
    expect(t.session.snapshot().pendingRolls).toHaveLength(0);
  });
});

describe("an attack that is waiting when the server restarts", () => {
  it("is still there afterwards, and still settles when it is answered", async () => {
    const first = await fight([kiraShoots()], []);
    await first.session.close();

    const driver = new ScriptedGmDriver([{ say: ["Back again."] }]);
    const second = await newSession(driver, { store: first.store, d6: scriptedD6([3, 3, 3, 3, 3, 3, 3]) });
    const [request] = second.session.snapshot().pendingRolls;
    expect(request).toMatchObject({ attack: { role: "attacker", other: { id: "ganger-1" } } });

    await second.session.submitRoll(request!.id, { mode: "physical", dice: "6 6 3 3 3 3" });
    await second.session.whenIdle();
    expect(driver.inputs[0]?.text).toContain("ATTACK RESULT. Kira shoots the ganger.");
    expect(standing(second, "ganger-1")).toMatchObject({ monitor: { physical: 5 } });
  });
});

describe("what the table reads afterwards", () => {
  it("records the attack in the transcript, and the damage after it", async () => {
    const t = await fight([kiraShoots()], [3, 3, 3, 3, 6, 5, 3]);
    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 6 6 5 3 3" });
    await t.session.whenIdle();
    const kinds = (await t.store.recentEntries(20)).map((e) => e.kind);
    expect(kinds.filter((k) => k !== "gm")).toEqual(["roll", "attack", "damage"]);
    const attack = (await t.store.recentEntries(20)).find((e) => e.kind === "attack");
    expect(attack).toMatchObject({ attacker: "Kira", defender: "Ganger", hit: true, damageValue: 7, attackedBy: "physical", defendedBy: "system" });
  });
});
