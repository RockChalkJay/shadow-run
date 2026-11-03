import { describe, expect, it } from "vitest";
import { MAX_PENDING_ROLLS } from "../../src/game/rollManager.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, rollInput, toolRunner } from "../helpers.js";

// A grunt with Body 2 and Willpower 2 has a track of 9 boxes. Kira has Body 5: Physical 11.
const kira = { kind: "pc", id: "kira" };
const guard = (n: number, over: object = {}) => ({ kind: "npc", id: `guard-${n}`, name: `Guard ${n}`, body: 2, willpower: 2, professionalRating: 1, charisma: 2, ...over });
const hurt = (target: object, damageValue: number, damageType = "physical") => ({ label: "Test harm", target, damageValue, damageType });
const colt = { name: "Colt America L36", damageValue: 3, damageType: "physical" };
const pool = (total: number) => ({ total, breakdown: "a pool" });
const standing = (t: { session: { snapshot(): { characters: Array<{ id: string }> } } }, id: string) => t.session.snapshot().characters.find((c) => c.id === id) as any;

/** Runs these tool calls in one GM turn, with the system's dice scripted. */
async function turn(faces: number[], job: (tools: GmTools) => Promise<unknown>) {
  const runner = toolRunner();
  const t = await newSession(runner.driver, { d6: scriptedD6(faces) });
  const result = await runner.run(t.session, (ctx: GmTurnContext) => job(ctx.tools));
  return { ...t, runner, result };
}

describe("a grunt", () => {
  it("has one track of 8 plus half the higher of Body and Willpower, and a lieutenant adds their rating", async () => {
    const u = await turn([3, 3, 3, 3], async (tools) => [
      await tools.dealDamage(hurt(guard(1), 1)),
      await tools.dealDamage(hurt(guard(2, { professionalRating: 3, lieutenant: true }), 1)),
    ]);
    expect(standing(u, "guard-1").monitor).toMatchObject({ physicalBoxes: 9, physical: 1 });
    expect(standing(u, "guard-2").monitor).toMatchObject({ physicalBoxes: 12, physical: 1 });
    expect(standing(u, "guard-2").grunt).toMatchObject({ professionalRating: 3, lieutenant: true });
  });

  it("must be given a Charisma the first time, for its Composure test", async () => {
    const { result } = await turn([], (tools) => tools.dealDamage(hurt(guard(1, { charisma: undefined }), 1)));
    expect(result).toEqual({ ok: false, text: '"guard-1" is a new grunt. Give their charisma too, for their Composure test.' });
  });

  it("is reported with its one track and its wounds, a die lost every two boxes", async () => {
    const { result } = (await turn([3, 3], (tools) => tools.dealDamage(hurt(guard(1, { professionalRating: 5 }), 4)))) as { result: { text: string } };
    expect(result.text).toBe(
      [
        "DAMAGE RESULT. Test harm: 4 physical damage to Guard 1.",
        "Guard 1 resisted with Body 2 (the system's dice): 3 3 = 0 hits, so 4 physical damage got through.",
        "Guard 1 (grunt, Professional Rating 5): 4/9 boxes of damage. Wound penalty: -2 dice on everything but damage resistance.",
      ].join("\n"),
    );
  });

  it("is dead when the track fills with physical damage last, and only unconscious with stun last", async () => {
    const t = await turn([3, 3, 3, 3], async (tools) => [await tools.dealDamage(hurt(guard(1), 20)), await tools.dealDamage(hurt(guard(2), 20, "stun"))]);
    expect(standing(t, "guard-1")).toMatchObject({ status: "dead", monitor: { physical: 9 } });
    expect(standing(t, "guard-2")).toMatchObject({ status: "unconscious", monitor: { physical: 9 } });
    expect((t.result as Array<{ text: string }>)[1]!.text).toContain("Guard 2 (grunt, Professional Rating 1): 9/9 boxes of damage. Wound penalty: -4 dice on everything but damage resistance. Guard 2 is UNCONSCIOUS and out of the action.");
  });

  it("is killed by physical damage after being knocked out by stun, since the last damage decides", async () => {
    const t = await turn([3, 3, 3, 3], async (tools) => [await tools.dealDamage(hurt(guard(1), 20, "stun")), await tools.dealDamage(hurt(guard(1), 1))]);
    expect(standing(t, "guard-1").status).toBe("dead");
  });

  it("keeps its track and its rating after a restart", async () => {
    const first = await turn([3, 3], (tools) => tools.dealDamage(hurt(guard(1), 4)));
    await first.session.close();
    const second = await newSession(toolRunner().driver, { store: first.store });
    expect(standing(second, "guard-1")).toMatchObject({ monitor: { physical: 4, physicalBoxes: 9 }, grunt: { professionalRating: 1, lastDamage: "physical" } });
  });

  it("cannot be healed, since the rules give a single track no healing", async () => {
    const { result } = await turn([3, 3], async (tools) => {
      await tools.dealDamage(hurt(guard(1, { professionalRating: 9 }), 4));
      return tools.requestRoll({ ...rollInput({ characterId: "doc" }), healing: { method: "medkit", patient: { kind: "npc", id: "guard-1" }, essence: 6 } });
    });
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("Guard 1 is a grunt") });
  });
});

describe("a grunt's nerve", () => {
  it("is tested the first time damage takes them past their Professional Rating, and they hold on enough hits", async () => {
    // Body 2 resists with no hits, then Willpower 2 + Charisma 2 = 4 dice give 2 hits.
    const { result, store } = await turn([3, 3, 6, 5, 3, 3], (tools) => tools.dealDamage(hurt(guard(1), 4)));
    const text = (result as { text: string }).text;
    expect(text).toContain("COMPOSURE. Guard 1 is past their Professional Rating of 1, so the system tested their nerve with Willpower + Charisma, 4 dice (the system's dice): 6 5 3 3 = 2 hits against a threshold of 2. Guard 1 HOLDS and keeps fighting.");
    expect((await store.recentEntries(10)).find((e) => e.kind === "damage")).toMatchObject({ composure: { pool: 4, threshold: 2, held: true } });
  });

  it("makes the grunt bolt when the test fails, which the GM is told to carry out", async () => {
    const { result, store } = await turn([3, 3, 6, 3, 3, 3], (tools) => tools.dealDamage(hurt(guard(1), 4)));
    expect((result as { text: string }).text).toContain("Guard 1 BOLTS. They break now: they flee or surrender, and you carry that out in what you narrate.");
    expect((await store.recentEntries(10)).find((e) => e.kind === "damage")).toMatchObject({ composure: { held: false } });
  });

  it("is not tested again by a later hit", async () => {
    const { result } = await turn([3, 3, 6, 5, 3, 3, 3, 3], async (tools) => [await tools.dealDamage(hurt(guard(1), 4)), await tools.dealDamage(hurt(guard(1), 2))]);
    expect((result as Array<{ text: string }>)[0]!.text).toContain("COMPOSURE");
    expect((result as Array<{ text: string }>)[1]!.text).not.toContain("COMPOSURE");
  });

  it("is not tested while damage stays within their rating, or when it puts them down", async () => {
    const within = await turn([3, 3], (tools) => tools.dealDamage(hurt(guard(1, { professionalRating: 5 }), 4)));
    expect((within.result as { text: string }).text).not.toContain("COMPOSURE");
    const down = await turn([3, 3], (tools) => tools.dealDamage(hurt(guard(1), 20)));
    expect((down.result as { text: string }).text).not.toContain("COMPOSURE");
  });

  it("is tested on the first damage at all for an untrained grunt", async () => {
    const { result } = await turn([3, 3, 3, 3, 3, 3], (tools) => tools.dealDamage(hurt(guard(1, { professionalRating: 0 }), 1)));
    expect((result as { text: string }).text).toContain("COMPOSURE. Guard 1 is past their Professional Rating of 0");
  });

  it("is not tested for anyone who is not a grunt", async () => {
    const { result } = await turn([3, 3, 3], (tools) => tools.dealDamage(hurt({ kind: "npc", id: "boss", name: "Boss", body: 3, willpower: 3 }, 6)));
    expect((result as { text: string }).text).not.toContain("COMPOSURE");
  });

  it("appears in the recap as a grunt bolting", async () => {
    const t = await turn([3, 3, 6, 3, 3, 3], (tools) => tools.dealDamage(hurt(guard(1), 4)));
    const entries = await t.store.recentEntries(10);
    const { formatRecap } = await import("../../src/game/recap.js");
    expect(formatRecap(entries, (id) => id)).toContain("[Damage] Guard 1 took 4 physical from Test harm. Guard 1 bolted.");
  });
});

describe("a group attack", () => {
  const groupAttack = (size: number, over: object = {}) => ({
    label: "The guards open fire on Kira",
    attacker: guard(1),
    alongside: Array.from({ length: size - 1 }, (_, i) => guard(i + 2)),
    defender: kira,
    weapon: colt,
    attackPool: pool(5),
    defensePool: pool(4),
    stakes: "Three guards have her in their sights.",
    ...over,
  });

  it.each([
    [1, 5],
    [2, 5],
    [3, 6],
    [4, 6],
    [5, 7],
  ])("with %i grunts rolls %i dice: the highest pool plus a die for each odd-numbered member beyond the first", async (size, dice) => {
    const { session, result } = await turn([], (tools) => tools.attack(groupAttack(size)));
    expect(result).toMatchObject({ ok: true });
    expect(session.snapshot().pendingRolls[0]).toMatchObject({ opposed: { pool: dice, role: "defending" } });
  });

  it("names the whole group, and says so to the GM once the defense is rolled", async () => {
    const runner = toolRunner();
    const inputs: string[] = [];
    const driver: GmDriver = { takeTurn: (input, ctx) => (inputs.push(input.text), runner.driver.takeTurn(input, ctx)) };
    const t = await newSession(driver, { d6: scriptedD6([6, 6, 5, 3, 3, 3, 3, 3]) });
    await runner.run(t.session, (ctx) => ctx.tools.attack(groupAttack(3)));
    const [defense] = t.session.snapshot().pendingRolls;
    expect(defense).toMatchObject({ attack: { groupSize: 3, other: { name: "Guard 1, Guard 2 and Guard 3" } } });

    await t.session.submitRoll(defense!.id, { mode: "physical", dice: "3 3 3 3" });
    await t.session.whenIdle();
    const [resist] = t.session.snapshot().pendingRolls;
    expect(resist).toMatchObject({ soak: { source: "Colt America L36 (Guard 1, Guard 2 and Guard 3)" } });
    await t.session.submitRoll(resist!.id, { mode: "physical", dice: "3 3 3 3 3" });
    await t.session.whenIdle();
    expect(inputs.at(-1)).toContain("Guard 1, Guard 2 and Guard 3 attacked as a group of 3 with Colt America L36 (3P), 6 dice (the system's dice): 6 6 5 3 3 3 = 3 hits.");
  });

  it("is rolled at once against a non-player character, and recorded with the group's size", async () => {
    // Attack 6 dice (3 hits), defense 3 dice (none), then the thug's Body 2 (none).
    const thug = { kind: "npc", id: "thug-1", name: "Thug", body: 2, willpower: 2 };
    const { result, store } = (await turn([6, 6, 5, 3, 3, 3, 3, 3, 3, 3, 3], (tools) => tools.attack(groupAttack(3, { defender: thug, defensePool: pool(3) })))) as { result: { text: string }; store: any };
    expect(result.text).toContain("attacked as a group of 3 with Colt America L36 (3P), 6 dice");
    expect(result.text).toContain("DAMAGE RESULT. Colt America L36 (Guard 1, Guard 2 and Guard 3): 6 physical damage to Thug.");
    expect((await store.recentEntries(10)).find((e: { kind: string }) => e.kind === "attack")).toMatchObject({ attacker: "Guard 1, Guard 2 and Guard 3", groupSize: 3 });
  });

  it("takes the lead attacker's wounds off the pool before adding the group's dice", async () => {
    // Guard 1 takes 4 boxes (no resisting hits): a wound penalty of 2.
    const { session } = await turn([3, 3, 6, 5, 3, 3], async (tools) => {
      await tools.dealDamage(hurt(guard(1), 4));
      return tools.attack(groupAttack(3));
    });
    expect(session.snapshot().pendingRolls[0]).toMatchObject({ opposed: { pool: 4 } });
  });

  it.each([
    ["more than five grunts", () => groupAttack(5, { alongside: [2, 3, 4, 5, 6].map((n) => guard(n)) }), /at most 5 grunts/],
    ["an attacker who is not a grunt", () => groupAttack(3, { attacker: { kind: "npc", id: "boss", name: "Boss", body: 3, willpower: 3 } }), /Boss is not a grunt/],
    ["a member who is not a grunt", () => groupAttack(2, { alongside: [{ kind: "npc", id: "boss", name: "Boss", body: 3, willpower: 3 }] }), /Boss is not a grunt/],
    ["the same grunt twice", () => groupAttack(2, { alongside: [guard(1)] }), /Guard 1 is already in this group attack/],
    ["the target as a member", () => groupAttack(2, { defender: guard(9), alongside: [guard(9)] }), /Guard 9 is the target/],
    ["a player character in the group", () => groupAttack(2, { alongside: [kira], defender: guard(9) }), /Kira is not a grunt/],
  ])("is refused for %s", async (_name, make, message) => {
    const { result } = await turn([], (tools) => tools.attack(make()));
    expect(result).toMatchObject({ ok: false, text: expect.stringMatching(message) });
  });

  it("is refused for a member who is down", async () => {
    const { result } = await turn([3, 3], async (tools) => {
      await tools.dealDamage(hurt(guard(2), 20, "stun"));
      return tools.attack(groupAttack(2));
    });
    expect(result).toEqual({ ok: false, text: "Guard 2 is unconscious and cannot attack." });
  });

  it("is refused for a player character attacking with others alongside", async () => {
    const { result } = await turn([], (tools) =>
      tools.attack({ ...groupAttack(2), attacker: kira, defender: guard(9), alongside: [guard(2)] }),
    );
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("Kira is not a grunt") });
  });

  it("still stops when too many rolls are waiting", async () => {
    const { result } = await turn([], async (tools) => {
      for (let i = 0; i < MAX_PENDING_ROLLS; i++) await tools.requestRoll(rollInput());
      return tools.attack(groupAttack(3));
    });
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining(`There are already ${MAX_PENDING_ROLLS} rolls waiting`) });
  });
});

describe("a player character attacking a grunt", () => {
  it("is settled like any attack, and the damage lands on the grunt's one track", async () => {
    // The system rolls the grunt's 4 defense dice (none), then his Body 2 (none).
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3, 3, 3, 3]) });
    await runner.run(t.session, (ctx) =>
      ctx.tools.attack({
        label: "Kira shoots Guard 1",
        attacker: kira,
        defender: guard(1, { professionalRating: 9 }),
        weapon: colt,
        attackPool: pool(6),
        defensePool: pool(4),
        stakes: "A guard in the doorway.",
      }),
    );
    await t.session.submitRoll(t.session.snapshot().pendingRolls[0]!.id, { mode: "physical", dice: "6 6 6 5 3 3" });
    await t.session.whenIdle();
    expect(standing(t, "guard-1")).toMatchObject({ monitor: { physical: 7 }, status: "active" });
  });
});
