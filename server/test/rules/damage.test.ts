import { describe, expect, it } from "vitest";
import {
  applyDamage,
  damageAfterResistance,
  damageResistancePool,
  defaultRuleset,
  newMonitor,
  resolveDamageType,
  statusOf,
  woundModifier,
} from "../../src/rules/index.js";

describe("newMonitor", () => {
  it("gives 8 boxes plus half the attribute, rounded up", () => {
    expect(newMonitor(5, 3)).toMatchObject({ physicalBoxes: 11, stunBoxes: 10, body: 5 });
    expect(newMonitor(4, 4)).toMatchObject({ physicalBoxes: 10, stunBoxes: 10 });
  });
});

describe("applyDamage", () => {
  it("marks physical damage until the track is full, then reports dying", () => {
    const hurt = applyDamage(newMonitor(5, 3), "physical", 5);
    expect(hurt).toMatchObject({ physical: 5, overflow: 0 });
    expect(statusOf(hurt)).toBe("active");

    const down = applyDamage(hurt, "physical", 6);
    expect(down).toMatchObject({ physical: 11, overflow: 0 });
    expect(statusOf(down)).toBe("dying");
  });

  it("lets overflow reach Body while dying and kills past it", () => {
    const full = applyDamage(newMonitor(5, 3), "physical", 11);
    expect(statusOf(applyDamage(full, "physical", 5))).toBe("dying");
    const dead = applyDamage(full, "physical", 6);
    expect(dead.overflow).toBe(6);
    expect(statusOf(dead)).toBe("dead");
  });

  it("knocks a character out when the stun track fills", () => {
    const out = applyDamage(newMonitor(4, 4), "stun", 10);
    expect(out).toMatchObject({ stun: 10, physical: 0 });
    expect(statusOf(out)).toBe("unconscious");
  });

  it("carries excess stun into physical at the configured rate, rounding down", () => {
    const carried = applyDamage(newMonitor(4, 4), "stun", 14);
    expect(carried).toMatchObject({ stun: 10, physical: 2 });
    expect(applyDamage(newMonitor(4, 4), "stun", 11)).toMatchObject({ stun: 10, physical: 0 });
  });

  it("does not change the monitor it was given", () => {
    const before = newMonitor(5, 3);
    applyDamage(before, "physical", 4);
    expect(before.physical).toBe(0);
  });

  it("rejects negative or fractional damage", () => {
    expect(() => applyDamage(newMonitor(5, 3), "physical", -1)).toThrow(RangeError);
    expect(() => applyDamage(newMonitor(5, 3), "stun", 1.5)).toThrow(RangeError);
  });
});

describe("woundModifier", () => {
  it("costs a die for every 3 boxes filled across both tracks", () => {
    const monitor = { ...newMonitor(5, 5), physical: 3, stun: 3 };
    expect(woundModifier(monitor)).toBe(2);
    expect(woundModifier({ ...monitor, physical: 1, stun: 1 })).toBe(0);
  });
});

describe("damage resistance", () => {
  it("rolls Body plus armor unless the ruleset says Body alone", () => {
    expect(damageResistancePool(4, 3)).toBe(7);
    expect(damageResistancePool(4, 3, { ...defaultRuleset, damageResistance: { pool: "body" } })).toBe(4);
  });

  it("removes a point of damage per hit, never going below zero", () => {
    expect(damageAfterResistance(8, 3)).toBe(5);
    expect(damageAfterResistance(3, 5)).toBe(0);
  });

  it("turns physical damage into stun unless it beats the armor", () => {
    expect(resolveDamageType("physical", 5, 6)).toBe("stun");
    expect(resolveDamageType("physical", 6, 6)).toBe("stun");
    expect(resolveDamageType("physical", 7, 6)).toBe("physical");
    expect(resolveDamageType("stun", 9, 2)).toBe("stun");
  });
});
