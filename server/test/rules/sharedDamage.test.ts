import { applyDamage, damageAfterResistance, statusOf, wouldKill } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { applyDamage as serverApplyDamage, defaultRuleset } from "../../src/rules/index.js";

// The damage arithmetic lives in the shared package so the server and the screen run the same code. Kira: 11 physical, 10 stun, 10 overflow.
const m = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };
const one = { stunOverflowPerPhysical: 1 };
const two = { stunOverflowPerPhysical: 2 };

describe("damage after resistance", () => {
  it("takes a point off for each hit, never below none", () => {
    expect(damageAfterResistance(8, 3)).toBe(5);
    expect(damageAfterResistance(3, 5)).toBe(0);
  });
});

describe("whether a blow would kill", () => {
  it("is not lethal while the physical track and overflow have room", () => {
    expect(wouldKill(m, "physical", 20, one)).toBe(false);
    expect(wouldKill(m, "physical", 21, one)).toBe(true);
  });
  it("counts what is already filled", () => {
    expect(wouldKill({ ...m, physical: 11, overflow: 8 }, "physical", 1, one)).toBe(false);
    expect(wouldKill({ ...m, physical: 11, overflow: 8 }, "physical", 2, one)).toBe(true);
    expect(wouldKill({ ...m, physical: 5 }, "physical", 15, one)).toBe(false);
    expect(wouldKill({ ...m, physical: 5 }, "physical", 16, one)).toBe(true);
  });
  it("carries stun past the last stun box into physical, and then overflow, at the rate it is given", () => {
    expect(wouldKill(m, "stun", 10 + 11 + 9, one)).toBe(false);
    expect(wouldKill(m, "stun", 10 + 11 + 10, one)).toBe(true);
    expect(wouldKill({ ...m, stun: 4 }, "stun", 6 + 11 + 10, one)).toBe(true);
    // Two stun to a box of physical: 22 past the track makes 11, which is not yet overflow.
    expect(wouldKill(m, "stun", 10 + 22 + 18, two)).toBe(false);
    expect(wouldKill(m, "stun", 10 + 22 + 20, two)).toBe(true);
  });
  it("does nothing for no damage", () => {
    expect(wouldKill(m, "physical", 0, one)).toBe(false);
  });
});

describe("one implementation for the server and the screen", () => {
  it("is what the server applies damage with: for any blow, the server's result is the shared one, and 'would kill' is whether that result is dead", () => {
    const rate = { stunOverflowPerPhysical: defaultRuleset.conditionMonitor.stunOverflowPerPhysical };
    for (const type of ["physical", "stun"] as const) {
      for (const before of [m, { ...m, physical: 11, stun: 10, overflow: 6 }, { ...m, stun: 7, physical: 3 }]) {
        for (let amount = 0; amount <= 45; amount++) {
          const shared = applyDamage(before, type, amount, rate);
          expect(serverApplyDamage(before, type, amount)).toEqual(shared);
          expect(wouldKill(before, type, amount, rate)).toBe(statusOf(shared) === "dead");
        }
      }
    }
  });

  it("gives the shared code the carry-over rate of the ruleset the server is running", () => {
    const rules = { ...defaultRuleset, conditionMonitor: { ...defaultRuleset.conditionMonitor, stunOverflowPerPhysical: 2 } };
    // 10 fills the stun track; the 22 past it make 11 physical at two a box.
    expect(serverApplyDamage(m, "stun", 32, rules)).toMatchObject({ stun: 10, physical: 11, overflow: 0 });
    // At the default rate of one, the same 22 make 22 physical: 11 fill the track and 11 go to overflow.
    expect(serverApplyDamage(m, "stun", 32)).toMatchObject({ stun: 10, physical: 11, overflow: 11 });
  });

  it("stops one box short of death for a blow that would kill, when asked", () => {
    expect(applyDamage(m, "physical", 40, one, { surviveDeath: true })).toMatchObject({ physical: 11, overflow: 9 });
    expect(statusOf(applyDamage(m, "physical", 40, one))).toBe("dead");
  });

  it("refuses damage that is not a whole number", () => {
    expect(() => applyDamage(m, "physical", 1.5, one)).toThrow(RangeError);
  });
});
