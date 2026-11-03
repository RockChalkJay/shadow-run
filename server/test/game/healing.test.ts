import { describe, expect, it } from "vitest";
import type { GmDriver, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, rollInput } from "../helpers.js";

// Kira: Body 5, Willpower 3 -> Physical 11, Stun 10, Overflow 10. Doc, her healer, has Body 3 and Willpower 5.
const kira = { kind: "pc", id: "kira" };
const ganger = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
const hurt = (target: object, damageValue: number, damageType = "physical") => ({ label: "Test harm", target, damageValue, damageType });

type Job = (ctx: GmTurnContext) => Promise<unknown>;

/** A session whose GM does whatever job it is next given, one job per turn, and a few helpers around it. */
async function clinic(faces: number[] = [], extra: Parameters<typeof newSession>[1] = {}) {
  const inputs: string[] = [];
  const jobs: Job[] = [];
  const results: unknown[] = [];
  const driver: GmDriver = {
    async takeTurn(input, ctx) {
      inputs.push(input.text);
      const job = jobs.shift();
      if (job) results.push(await job(ctx));
    },
  };
  const made = await newSession(driver, { d6: scriptedD6(faces), ...extra });
  const pending = () => made.session.snapshot().pendingRolls;
  const character = (id: string) => made.session.snapshot().characters.find((c) => c.id === id)!;

  /** The GM takes a turn doing `job` and its answer comes back. */
  const gm = async <T>(job: (ctx: GmTurnContext) => Promise<T>): Promise<T> => {
    jobs.push(job);
    await made.session.say("kira", "go");
    await made.session.whenIdle();
    return results.at(-1) as T;
  };
  /** A player answers the only roll waiting with these dice; if `then` is given the GM does it next. */
  const answer = async (dice: string, then?: Job) => {
    if (then) jobs.push(then);
    await made.session.submitRoll(pending()[0]!.id, { mode: "physical", dice });
    await made.session.whenIdle();
    return then ? results.at(-1) : undefined;
  };
  /** Kira takes this damage and fails every die of her resistance. */
  const hurtKira = async (damageValue: number, damageType = "physical") => {
    await gm((ctx) => ctx.tools.dealDamage(hurt(kira, damageValue, damageType)));
    await answer("1 1 1 1 1");
  };
  /** Doc rolls a healing attempt. */
  const attempt = (method: string, patient: object = kira, essence = 6, over: object = {}) =>
    gm((ctx) =>
      ctx.tools.requestRoll({
        ...rollInput({ characterId: "doc", label: "Doc patches Kira up", pool: { total: 9, breakdown: "Biotech 5 + Logic 4" } }),
        healing: { method, patient, essence },
        ...over,
      }),
    );
  const heal = (rollId: string, type: string, boxes: number, reason = "Doc's treatment") => (ctx: GmTurnContext) => ctx.tools.heal({ rollId, type, boxes, reason });
  return { ...made, inputs, jobs, results, pending, character, gm, answer, hurtKira, attempt, heal };
}

const NINE = (hits: number) => "6 ".repeat(hits) + "3 ".repeat(9 - hits).trim();

describe("a healing roll", () => {
  it("asks the system for the difficulty: 5 minus Essence, with a free hit for a fully natural patient", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    expect(await t.attempt("first_aid", kira, 6)).toMatchObject({ ok: true });
    expect(t.pending()[0]).toMatchObject({ healing: { method: "first_aid", threshold: 0, autoHit: true, essence: 6, patient: { kind: "pc", id: "kira", name: "Kira" } } });
  });

  it("sets the threshold from Essence whatever the GM asks for", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("first_aid", kira, 3, { threshold: 1 });
    expect(t.pending()[0]).toMatchObject({ threshold: 2, healing: { threshold: 2, autoHit: false } });
  });

  it("is a simple test, not an opposed one", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    const reply = await t.attempt("first_aid", kira, 6, { opposed: { by: "Fate", pool: 4, role: "acting" }, threshold: undefined });
    expect(reply).toMatchObject({ ok: false, text: expect.stringContaining("simple test") });
  });
});

describe("First Aid", () => {
  it("heals a physical box per 2 hits, counts the free hit, and refuses to spend more than the roll earned", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("first_aid", kira, 6);
    const id = t.pending()[0]!.id;
    const [first, second] = (await t.answer(NINE(3), async (ctx) => [await t.heal(id, "physical", 2)(ctx), await t.heal(id, "physical", 1)(ctx)])) as Array<{ ok: boolean; text: string }>;

    expect(t.inputs.at(-1)).toContain(`HEALING AVAILABLE. Doc's First Aid on Kira: 4 hits to spend. Roll id: ${id}`);
    expect(t.inputs.at(-1)).toContain("Healing threshold 0, with a free hit for a fully natural patient.");
    expect(first).toMatchObject({ ok: true, text: expect.stringContaining("Kira heals 2 physical") });
    expect(first?.text).toContain("0 hits left on this healing roll.");
    expect(second).toEqual({ ok: false, text: "That would cost 2 hits (2 per physical box) and the roll has 0 left, enough for 0 physical boxes." });
    expect(t.character("kira").monitor.physical).toBe(4);
  });

  it("heals a stun box per hit", async () => {
    const t = await clinic();
    await t.hurtKira(5, "stun");
    await t.attempt("first_aid", kira, 6);
    const id = t.pending()[0]!.id;
    await t.answer(NINE(3), t.heal(id, "stun", 4));
    expect(t.character("kira").monitor.stun).toBe(1);
  });

  it("follows the book's example: Essence 3, 4 hits against a threshold of 2 heals one overflow box", async () => {
    const t = await clinic();
    await t.hurtKira(13);
    expect(t.character("kira").monitor).toMatchObject({ physical: 11, overflow: 2 });
    await t.attempt("first_aid", kira, 3);
    const id = t.pending()[0]!.id;
    const [one, more] = (await t.answer("6 5 5 6 3 3 3 3 3", async (ctx) => [await t.heal(id, "overflow", 1)(ctx), await t.heal(id, "overflow", 1)(ctx)])) as Array<{ ok: boolean }>;
    expect(t.inputs.at(-1)).toContain("2 hits to spend");
    expect(one?.ok).toBe(true);
    expect(more?.ok).toBe(false);
    expect(t.character("kira").monitor.overflow).toBe(1);
  });
});

describe("a medkit and healing magic", () => {
  it("heal a box per hit on any track", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("medkit", kira, 6);
    const id = t.pending()[0]!.id;
    await t.answer(NINE(3), t.heal(id, "physical", 4));
    expect(t.character("kira").monitor.physical).toBe(2);
  });

  it("get no free hit from healing magic", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("magic", kira, 6);
    const id = t.pending()[0]!.id;
    const [spent, over] = (await t.answer(NINE(3), async (ctx) => [await t.heal(id, "physical", 3)(ctx), await t.heal(id, "physical", 1)(ctx)])) as Array<{ ok: boolean }>;
    expect(t.inputs.at(-1)).toContain("3 hits to spend");
    expect(spent?.ok).toBe(true);
    expect(over?.ok).toBe(false);
  });
});

describe("overflow", () => {
  it("heals before any other track", async () => {
    const t = await clinic();
    await t.hurtKira(13);
    await t.attempt("medkit", kira, 6);
    const id = t.pending()[0]!.id;
    const [early, overflow, physical] = (await t.answer(NINE(4), async (ctx) => [
      await t.heal(id, "physical", 1)(ctx),
      await t.heal(id, "overflow", 2)(ctx),
      await t.heal(id, "physical", 3)(ctx),
    ])) as Array<{ ok: boolean; text: string }>;
    expect(early).toEqual({ ok: false, text: "Kira has overflow damage, which heals first. Heal overflow before physical." });
    expect(overflow?.ok).toBe(true);
    expect(physical?.ok).toBe(true);
    expect(t.character("kira").monitor).toMatchObject({ overflow: 0, physical: 8 });
  });
});

describe("natural recovery", () => {
  it("is the patient's own roll, and heals a box of its track per hit", async () => {
    const t = await clinic();
    await t.hurtKira(5, "stun");
    await t.gm((ctx) =>
      ctx.tools.requestRoll({ ...rollInput({ characterId: "kira", pool: { total: 8, breakdown: "Body 5 + Willpower 3" } }), healing: { method: "natural_stun", patient: kira } }),
    );
    // Five boxes of stun cost Kira a die: one complete row of three.
    expect(t.pending()[0]).toMatchObject({ pool: { total: 7 }, woundPenalty: 1, healing: { threshold: 0, autoHit: false } });
    const id = t.pending()[0]!.id;
    const [wrongTrack, right] = (await t.answer("6 6 5 3 3 3 3", async (ctx) => [await t.heal(id, "physical", 1)(ctx), await t.heal(id, "stun", 3)(ctx)])) as Array<{ ok: boolean; text: string }>;
    expect(wrongTrack).toEqual({ ok: false, text: "natural recovery from stun cannot heal physical damage." });
    expect(right?.ok).toBe(true);
    expect(t.character("kira").monitor.stun).toBe(2);
  });

  it("cannot be asked for from someone else, or when there is nothing to recover from", async () => {
    const t = await clinic();
    await t.hurtKira(5, "stun");
    const other = await t.gm((ctx) => ctx.tools.requestRoll({ ...rollInput({ characterId: "doc" }), healing: { method: "natural_stun", patient: kira } }));
    expect(other).toMatchObject({ ok: false, text: expect.stringContaining("the patient's own roll") });
    const nothing = await t.gm((ctx) =>
      ctx.tools.requestRoll({ ...rollInput({ characterId: "kira" }), healing: { method: "natural_physical", patient: kira } }),
    );
    expect(nothing).toEqual({ ok: false, text: "Kira has no physical damage to recover from." });
  });
});

describe("treatments that can be received once", () => {
  it("are used up by an attempt even if it heals nothing, until the patient is hurt again", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("first_aid", kira, 3);
    await t.answer("3 3 3 3 3 3 3 3 3");
    expect(t.inputs.at(-1)).not.toContain("HEALING AVAILABLE");

    const again = await t.attempt("first_aid", kira, 3);
    expect(again).toEqual({ ok: false, text: "Kira has already had First Aid for these injuries. It can be received only once until they are hurt again." });
    expect(await t.attempt("medkit", kira, 3)).toMatchObject({ ok: true });
    await t.answer("3 3 3 3 3 3 3 3 3");

    await t.hurtKira(3);
    expect(await t.attempt("first_aid", kira, 3)).toMatchObject({ ok: true });
  });

  it("are remembered after a restart", async () => {
    const first = await clinic();
    await first.hurtKira(6);
    await first.attempt("magic", kira, 6);
    await first.answer("3 3 3 3 3 3 3 3 3");
    await first.session.close();

    const second = await clinic([], { store: first.store });
    expect(await second.attempt("magic", kira, 6)).toMatchObject({ ok: false, text: expect.stringContaining("already had healing magic") });
  });
});

describe("healing that cannot be asked for", () => {
  it("someone with no damage, someone who is dead, or someone who is not there", async () => {
    const t = await clinic([2, 2, 2]);
    expect(await t.attempt("first_aid", kira, 6)).toEqual({ ok: false, text: "Kira has no damage to heal." });
    expect(await t.attempt("first_aid", { kind: "npc", id: "ghost" })).toMatchObject({ ok: false, text: expect.stringContaining('"ghost"') });

    await t.gm((ctx) => ctx.tools.dealDamage(hurt(ganger, 30)));
    expect(await t.attempt("first_aid", { kind: "npc", id: "ganger-1" })).toEqual({ ok: false, text: "Ganger is dead, beyond the reach of any healing." });
  });

  it("works on a non-player character patient", async () => {
    const t = await clinic([2, 2, 2]);
    await t.gm((ctx) => ctx.tools.dealDamage(hurt(ganger, 6)));
    await t.attempt("medkit", { kind: "npc", id: "ganger-1" }, 6);
    const id = t.pending()[0]!.id;
    await t.answer(NINE(3), t.heal(id, "physical", 4));
    expect(t.character("ganger-1").monitor.physical).toBe(2);
  });
});

describe("spending a healing roll", () => {
  it("is refused for a roll id that earned nothing this turn, or that was spent in an earlier turn", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("medkit", kira, 6);
    const id = t.pending()[0]!.id;
    await t.answer(NINE(3), t.heal(id, "physical", 1));
    const later = await t.gm(t.heal(id, "physical", 1));
    expect(later).toEqual({ ok: false, text: "No healing roll with that id has hits to spend this turn. Ask for a healing roll with request_roll and heal only from its result, in the turn you are told it." });
    expect(await t.gm(t.heal("made-up", "physical", 1))).toMatchObject({ ok: false });
  });

  it("keeps what a failed turn already spent, so the retry does not grant it again", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("first_aid", kira, 6);
    const id = t.pending()[0]!.id;
    await t.answer(NINE(3), async (ctx) => {
      await t.heal(id, "physical", 1)(ctx);
      throw new Error("the GM fell over");
    });
    expect(t.session.snapshot().gm).toMatchObject({ phase: "error" });

    t.jobs.push(async (ctx) => [await t.heal(id, "physical", 1)(ctx), await t.heal(id, "physical", 1)(ctx)]);
    t.session.retry();
    await t.session.whenIdle();
    expect(t.inputs.at(-1)).toContain("2 hits to spend");
    const [again, extra] = t.results.at(-1) as Array<{ ok: boolean }>;
    expect(again?.ok).toBe(true);
    expect(extra?.ok).toBe(false);
    expect(t.character("kira").monitor.physical).toBe(4);
  });
});

describe("the verdict kept with a healing roll", () => {
  it("counts the free hit, so a roll with none still succeeds for a fully natural patient", async () => {
    const t = await clinic();
    await t.hurtKira(6);
    await t.attempt("medkit", kira, 6);
    await t.answer("3 3 3 3 3 3 3 3 3");
    const entry = (await t.store.recentEntries(30)).find((e) => e.kind === "roll" && e.resolved.request.healing);
    expect(entry).toMatchObject({ resolved: { outcome: { success: true, netHits: 1 } } });
  });
});

describe("bringing someone round", () => {
  it("lets a healed character act again once a full track is cleared", async () => {
    const t = await clinic();
    await t.hurtKira(10, "stun");
    expect(t.character("kira").status).toBe("unconscious");
    await t.attempt("first_aid", kira, 6);
    const id = t.pending()[0]!.id;
    await t.answer("3 3 3 3 3 3 3 3 3", t.heal(id, "stun", 1));
    expect(t.character("kira")).toMatchObject({ status: "active", monitor: { stun: 9 } });
    expect(await t.gm((ctx) => ctx.tools.requestRoll(rollInput({ pool: { total: 6, breakdown: "x" } })))).toMatchObject({ ok: true });
  });
});
