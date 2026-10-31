import { describe, expect, it } from "vitest";
import {
  applyDamage,
  damageAfterResistance,
  damageResistancePool,
  healDamage,
  newMonitor,
  statusOf,
  woundModifier,
} from "../../src/rules/index.js";

describe("newMonitor", () => {
  it("gives 8 boxes plus half the attribute, rounded up, and Body x 2 overflow boxes", () => {
    expect(newMonitor(5, 3)).toMatchObject({ physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10 });
    expect(newMonitor(4, 4)).toMatchObject({ physicalBoxes: 10, stunBoxes: 10, overflowBoxes: 8 });
  });
});

describe("applyDamage", () => {
  it("marks physical damage, and past the last box it overflows", () => {
    const hurt = applyDamage(newMonitor(5, 3), "physical", 5);
    expect(hurt).toMatchObject({ physical: 5, overflow: 0 });
    expect(statusOf(hurt)).toBe("active");

    const over = applyDamage(hurt, "physical", 8);
    expect(over).toMatchObject({ physical: 11, overflow: 2 });
  });

  it("carries stun past the last stun box into physical, one for one", () => {
    const carried = applyDamage(newMonitor(4, 4), "stun", 14);
    expect(carried).toMatchObject({ stun: 10, physical: 4, overflow: 0 });
    expect(applyDamage(newMonitor(4, 4), "stun", 11)).toMatchObject({ stun: 10, physical: 1 });
  });

  it("carries a full stun track's extra into overflow once physical is full too", () => {
    const full = applyDamage(newMonitor(4, 4), "physical", 10);
    expect(applyDamage(full, "stun", 13)).toMatchObject({ stun: 10, physical: 10, overflow: 3 });
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

describe("statusOf", () => {
  it("knocks a character out when either monitor fills", () => {
    expect(statusOf(applyDamage(newMonitor(4, 4), "stun", 10))).toBe("unconscious");
    expect(statusOf(applyDamage(newMonitor(4, 4), "physical", 10))).toBe("unconscious");
  });

  it("matches the rulebook's example: 10 Stun, 11 Physical and 2 Overflow is unconscious, not dead", () => {
    const monitor = { ...newMonitor(5, 4), stun: 10, physical: 11, overflow: 2 };
    expect(statusOf(monitor)).toBe("unconscious");
  });

  it("kills a character whose overflow reaches Body x 2", () => {
    const full = applyDamage(newMonitor(5, 3), "physical", 11);
    expect(statusOf(applyDamage(full, "physical", 9))).toBe("unconscious");
    expect(statusOf(applyDamage(full, "physical", 10))).toBe("dead");
  });
});

describe("woundModifier", () => {
  it("costs a die for each complete row of 3 boxes on either monitor, added together", () => {
    expect(woundModifier({ ...newMonitor(5, 5), physical: 3, stun: 3 })).toBe(2);
    expect(woundModifier({ ...newMonitor(5, 5), physical: 7 })).toBe(2);
  });

  it("does not combine boxes across the two monitors into rows", () => {
    expect(woundModifier({ ...newMonitor(5, 5), physical: 2, stun: 2 })).toBe(0);
  });
});

describe("damage resistance", () => {
  it("rolls Body alone", () => {
    expect(damageResistancePool(4)).toBe(4);
  });

  it("removes a point of damage per hit, never going below zero", () => {
    expect(damageAfterResistance(8, 3)).toBe(5);
    expect(damageAfterResistance(3, 5)).toBe(0);
  });
});

describe("healDamage", () => {
  const hurt = { ...newMonitor(5, 4), stun: 5, physical: 6, overflow: 2 };

  it("clears boxes from the chosen track", () => {
    expect(healDamage(hurt, "stun", 1).stun).toBe(4);
    expect(healDamage(hurt, "physical", 2).physical).toBe(4);
    expect(healDamage(hurt, "overflow", 1).overflow).toBe(1);
  });

  it("never goes below zero and rejects a bad amount", () => {
    expect(healDamage(hurt, "overflow", 9).overflow).toBe(0);
    expect(() => healDamage(hurt, "stun", -1)).toThrow(RangeError);
  });

  it("follows the rulebook's attack: Body 3 takes 7 on a 10-box monitor and has 3 boxes left", () => {
    const leader = newMonitor(3, 3);
    expect(leader.physicalBoxes).toBe(10);
    const hit = applyDamage(leader, "physical", damageAfterResistance(8, 1));
    expect(hit.physicalBoxes - hit.physical).toBe(3);
  });
});
