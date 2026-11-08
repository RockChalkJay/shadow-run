import { describe, expect, it } from "vitest";
import { damageAfterResistance, wouldKill } from "./damage";

// Kira: 11 physical, 10 stun, 10 overflow.
const m = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };

describe("damage after resistance", () => {
  it("takes a point off for each hit, never below none", () => {
    expect(damageAfterResistance(8, 3)).toBe(5);
    expect(damageAfterResistance(3, 5)).toBe(0);
  });
});

describe("whether a blow would kill", () => {
  it("is not lethal while the physical track and overflow have room", () => {
    expect(wouldKill(m, "physical", 20)).toBe(false);
    expect(wouldKill(m, "physical", 21)).toBe(true);
  });
  it("counts what is already filled", () => {
    expect(wouldKill({ ...m, physical: 11, overflow: 8 }, "physical", 1)).toBe(false);
    expect(wouldKill({ ...m, physical: 11, overflow: 8 }, "physical", 2)).toBe(true);
    expect(wouldKill({ ...m, physical: 5 }, "physical", 15)).toBe(false);
    expect(wouldKill({ ...m, physical: 5 }, "physical", 16)).toBe(true);
  });
  it("carries stun past the last stun box into physical, and then overflow", () => {
    expect(wouldKill(m, "stun", 10 + 11 + 9)).toBe(false);
    expect(wouldKill(m, "stun", 10 + 11 + 10)).toBe(true);
    expect(wouldKill({ ...m, stun: 4 }, "stun", 6 + 11 + 10)).toBe(true);
  });
  it("carries stun at the rate the ruleset gives, which the server sends", () => {
    // Two stun per box of physical: 10 stun fills the track, and 22 past it makes 11 physical, which is not yet overflow.
    expect(wouldKill(m, "stun", 10 + 22 + 18, { hitMinimum: 5, stunOverflowPerPhysical: 2 })).toBe(false);
    expect(wouldKill(m, "stun", 10 + 22 + 20, { hitMinimum: 5, stunOverflowPerPhysical: 2 })).toBe(true);
    // At the default rate that same blow kills long before.
    expect(wouldKill(m, "stun", 10 + 22 + 18)).toBe(true);
  });

  it("does nothing for no damage", () => {
    expect(wouldKill(m, "physical", 0)).toBe(false);
  });
});
