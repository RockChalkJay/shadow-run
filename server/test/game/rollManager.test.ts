import { describe, expect, it } from "vitest";
import { MAX_PENDING_ROLLS, RollManager } from "../../src/game/rollManager.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { rollInput } from "../helpers.js";

const manager = (faces: number[] = []) => {
  let n = 0;
  return new RollManager({ knownCharacter: (id) => id === "kira" || id === "doc", d6: scriptedD6(faces), newId: () => `r${++n}` });
};

describe("creating a roll", () => {
  it("keeps a valid request, gives it an id, and defaults a plain roll to a threshold of 1", () => {
    const m = manager();
    const { threshold: _drop, ...noThreshold } = rollInput();
    const created = m.create(noThreshold);
    expect(created).toMatchObject({ ok: true, request: { id: "r1", threshold: 1, characterId: "kira" } });
    expect(m.list()).toHaveLength(1);
  });

  it("defaults an opposed roll's role to acting and drops the threshold", () => {
    const { threshold: _drop, ...rest } = rollInput();
    const created = manager().create({ ...rest, opposed: { by: "Guard", pool: 5 } });
    expect(created).toMatchObject({ ok: true, request: { opposed: { by: "Guard", pool: 5, role: "acting" } } });
    expect((created as { request: { threshold?: number } }).request.threshold).toBeUndefined();
  });

  it("refuses a character who is not at the table", () => {
    const created = manager().create(rollInput({ characterId: "nobody" }));
    expect(created).toEqual({ ok: false, error: 'There is no character "nobody" at the table.' });
  });

  it("refuses a roll that has both a threshold and an opponent", () => {
    const created = manager().create({ ...rollInput(), opposed: { by: "Guard", pool: 5, role: "acting" } });
    expect(created).toMatchObject({ ok: false, error: expect.stringContaining("either against a threshold or opposed") });
  });

  it.each([
    ["a threshold of 0", { threshold: 0 }],
    ["a pool of 0 dice", { pool: { total: 0, breakdown: "x" } }],
    ["a pool over the limit", { pool: { total: 101, breakdown: "x" } }],
    ["an opposing pool over the limit", { threshold: undefined, opposed: { by: "x", pool: 101, role: "acting" as const } }],
  ])("refuses %s, naming the problem for the GM", (_name, override) => {
    const created = manager().create({ ...rollInput(), ...override });
    expect(created).toMatchObject({ ok: false, error: expect.stringContaining("not valid") });
  });

  it("stops taking requests when too many are already waiting for dice", () => {
    const m = manager();
    for (let i = 0; i < MAX_PENDING_ROLLS; i++) expect(m.create(rollInput())).toMatchObject({ ok: true });
    expect(m.create(rollInput())).toMatchObject({ ok: false, error: expect.stringContaining("Stop asking") });
    m.cancel("r1");
    expect(m.create(rollInput())).toMatchObject({ ok: true });
  });

  it("refuses something that is not a roll request at all", () => {
    expect(manager().create("roll the dice")).toMatchObject({ ok: false });
    expect(manager().create(null)).toMatchObject({ ok: false });
  });
});

describe("wounds", () => {
  const hurtManager = (penalty: number, refusal: string | null = null) =>
    new RollManager({ knownCharacter: () => true, woundPenalty: () => penalty, canAct: () => refusal, newId: () => "r1" });

  it("takes dice off the pool, says so on the card, and records the penalty", () => {
    const created = hurtManager(2).create(rollInput({ pool: { total: 6, breakdown: "Agility 4 + Stealth 2" } }));
    expect(created).toMatchObject({
      ok: true,
      request: { pool: { total: 4, breakdown: "Agility 4 + Stealth 2, minus 2 for wounds" }, woundPenalty: 2 },
    });
  });

  it("asks for exactly the reduced number of dice", () => {
    const m = hurtManager(2);
    m.create(rollInput({ pool: { total: 6, breakdown: "x" } }));
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 3 1 1 1" })).toEqual({ ok: false, error: "This roll is 4 dice; you entered 6." });
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 3 1" })).toMatchObject({ ok: true });
  });

  it("leaves the pool alone for someone who is unhurt", () => {
    const created = hurtManager(0).create(rollInput());
    expect(created).toMatchObject({ ok: true, request: { pool: { total: 4, breakdown: "Agility 3 + Sneaking 1" } } });
    expect((created as { request: object }).request).not.toHaveProperty("woundPenalty");
  });

  it("refuses a roll that wounds leave with no dice, telling the GM to narrate the failure", () => {
    const created = hurtManager(4).create(rollInput());
    expect(created).toMatchObject({ ok: false, error: expect.stringContaining("leave this roll with none") });
  });

  it("refuses a roll for someone who cannot act, with the reason", () => {
    const created = hurtManager(0, "Kira is unconscious and cannot act until healed.").create(rollInput());
    expect(created).toEqual({ ok: false, error: "Kira is unconscious and cannot act until healed. Narrate what happens instead of asking for a roll." });
  });

  it("does not apply wounds to a roll the system asks for itself, such as resisting damage", () => {
    const m = hurtManager(3);
    const request = m.createInternal({ ...rollInput({ pool: { total: 5, breakdown: "Body 5" } }), threshold: 1 });
    expect(request.pool).toEqual({ total: 5, breakdown: "Body 5" });
    expect(request).not.toHaveProperty("woundPenalty");
    expect(m.list()).toHaveLength(1);
  });
});

describe("rolling with the app", () => {
  it("rolls the pool, counts it, and clears the request", () => {
    const m = manager([6, 5, 3, 1]);
    m.create(rollInput());
    const result = m.resolve("r1", { mode: "app" });
    expect(result).toMatchObject({
      ok: true,
      resolved: { source: "app", roll: { dice: [6, 5, 3, 1], hits: 2 }, outcome: { success: true, netHits: 0, consequence: "Kira slips through." } },
    });
    expect(m.list()).toHaveLength(0);
  });

  it("fails below the threshold with the failure consequence", () => {
    const m = manager([6, 3, 3, 2]);
    m.create(rollInput());
    expect(m.resolve("r1", { mode: "app" })).toMatchObject({
      resolved: { outcome: { success: false, consequence: "The guard challenges her." } },
    });
  });

  it("will not roll the same request twice", () => {
    const m = manager([6, 5, 3, 1]);
    m.create(rollInput());
    m.resolve("r1", { mode: "app" });
    expect(m.resolve("r1", { mode: "app" })).toMatchObject({ ok: false, error: expect.stringContaining("not waiting") });
  });
});

describe("dice rolled at the table", () => {
  it("counts the dice the player reports", () => {
    const m = manager();
    m.create(rollInput());
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 5 1" })).toMatchObject({
      ok: true,
      resolved: { source: "physical", roll: { dice: [6, 5, 5, 1], hits: 3 }, outcome: { success: true, netHits: 1 } },
    });
  });

  it("insists on exactly the number of dice in the pool, and keeps the roll pending", () => {
    const m = manager();
    m.create(rollInput());
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 5" })).toEqual({ ok: false, error: "This roll is 4 dice; you entered 3." });
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 5 1 1" })).toMatchObject({ ok: false });
    expect(m.list()).toHaveLength(1);
  });

  it("refuses dice that are not faces of a d6", () => {
    const m = manager();
    m.create(rollInput());
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 7 1" })).toMatchObject({ ok: false });
    expect(m.resolve("r1", { mode: "physical", dice: "" })).toMatchObject({ ok: false });
    expect(m.list()).toHaveLength(1);
  });
});

describe("opposed rolls", () => {
  const opposed = (role: "acting" | "defending") => {
    const { threshold: _drop, ...rest } = rollInput();
    return { ...rest, opposed: { by: "Guard", pool: 4, role } };
  };

  it("rolls the opposition itself and compares hits", () => {
    const m = manager([6, 2, 2, 2]);
    m.create(opposed("acting"));
    const result = m.resolve("r1", { mode: "physical", dice: "6 5 5 1" });
    expect(result).toMatchObject({
      ok: true,
      resolved: {
        opposed: { by: "Guard", pool: 4, roll: { dice: [6, 2, 2, 2], hits: 1 } },
        outcome: { success: true, netHits: 2 },
      },
    });
  });

  it("gives a tie to the roller when the roller is acting", () => {
    const m = manager([6, 5, 2, 2]);
    m.create(opposed("acting"));
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 3 1" })).toMatchObject({ resolved: { outcome: { success: true, netHits: 0 } } });
  });

  it("gives a tie to the opponent when the roller is defending", () => {
    const m = manager([6, 5, 2, 2]);
    m.create(opposed("defending"));
    expect(m.resolve("r1", { mode: "physical", dice: "6 5 3 1" })).toMatchObject({
      resolved: { outcome: { success: false, netHits: 0, consequence: "The guard challenges her." } },
    });
  });

  it("lets a defender win with more hits than the opponent", () => {
    const m = manager([6, 2, 2, 2]);
    m.create(opposed("defending"));
    expect(m.resolve("r1", { mode: "physical", dice: "6 6 6 1" })).toMatchObject({ resolved: { outcome: { success: true, netHits: 2 } } });
  });
});

describe("glitches", () => {
  it("adds the glitch consequence to the roll's result", () => {
    const m = manager();
    m.create(rollInput({ pool: { total: 5, breakdown: "x" } }));
    expect(m.resolve("r1", { mode: "physical", dice: "6 6 1 1 1" })).toMatchObject({
      resolved: { roll: { glitch: true, criticalGlitch: false }, outcome: { success: true, glitchConsequence: "A tile creaks." } },
    });
  });

  it("adds the critical glitch consequence when a glitch has no hits", () => {
    const m = manager();
    m.create(rollInput());
    expect(m.resolve("r1", { mode: "physical", dice: "1 1 1 2" })).toMatchObject({
      resolved: { roll: { criticalGlitch: true }, outcome: { success: false, glitchConsequence: "The alarm goes off." } },
    });
  });

  it("leaves out the glitch consequence when there was no glitch", () => {
    const m = manager();
    m.create(rollInput());
    const result = m.resolve("r1", { mode: "physical", dice: "6 5 3 1" });
    expect((result as { resolved: { outcome: object } }).resolved.outcome).not.toHaveProperty("glitchConsequence");
  });
});

describe("after a restart", () => {
  it("can roll a request it was handed back", () => {
    const first = manager();
    const created = first.create(rollInput());
    if (!created.ok) throw new Error("setup failed");
    const second = new RollManager({ knownCharacter: () => true }, first.list());
    expect(second.list()).toEqual([created.request]);
    expect(second.resolve(created.request.id, { mode: "physical", dice: "6 5 3 1" })).toMatchObject({ ok: true });
  });
});

describe("skipping a roll", () => {
  it("returns the request and removes it", () => {
    const m = manager();
    m.create(rollInput());
    expect(m.cancel("r1")).toMatchObject({ id: "r1", label: "Sneak past the guard" });
    expect(m.list()).toHaveLength(0);
    expect(m.cancel("r1")).toBeUndefined();
  });
});
