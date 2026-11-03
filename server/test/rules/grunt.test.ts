import { describe, expect, it } from "vitest";
import { COMPOSURE_THRESHOLD, groupBonusDice, gruntBoxes, gruntStatus, gruntWoundModifier, passedRating } from "../../src/rules/index.js";

const grunt = { professionalRating: 1, lieutenant: false };
const lieutenant = (rating: number) => ({ professionalRating: rating, lieutenant: true });

describe("gruntBoxes", () => {
  it("is 8 plus half the higher of Body and Willpower, rounded up", () => {
    expect(gruntBoxes(2, 2, grunt)).toBe(9);
    expect(gruntBoxes(3, 2, grunt)).toBe(10);
    expect(gruntBoxes(2, 5, grunt)).toBe(11);
    expect(gruntBoxes(1, 1, grunt)).toBe(9);
  });

  it("adds the Professional Rating for a lieutenant and not for anyone else", () => {
    expect(gruntBoxes(2, 2, lieutenant(1))).toBe(10);
    expect(gruntBoxes(2, 2, { professionalRating: 5, lieutenant: false })).toBe(9);
  });

  it("matches the monitors printed in the book's sample grunts", () => {
    // Humanis Goon (Body 2, Willpower 2): 9. Lone Star Patrolman (3, 3): 10. Mafia Debt Collector, a rating 1 lieutenant (2, 2): 10.
    expect(gruntBoxes(2, 2, { professionalRating: 0, lieutenant: false })).toBe(9);
    expect(gruntBoxes(3, 3, { professionalRating: 3, lieutenant: false })).toBe(10);
    expect(gruntBoxes(2, 2, lieutenant(1))).toBe(10);
    // Cutters Data Harvester, a rating 2 lieutenant (Body 3, Willpower 4): 12. Minuteman Security Rigger, rating 3 (2, 4): 13.
    expect(gruntBoxes(3, 4, lieutenant(2))).toBe(12);
    expect(gruntBoxes(2, 4, lieutenant(3))).toBe(13);
    // Lone Star SWAT Officer, a rating 5 lieutenant (Body 4, Willpower 4): 15.
    expect(gruntBoxes(4, 4, lieutenant(5))).toBe(15);
  });
});

describe("gruntWoundModifier", () => {
  it("costs a die for every complete 2 boxes", () => {
    expect([0, 1, 2, 3, 4, 7].map((d) => gruntWoundModifier(d))).toEqual([0, 0, 1, 1, 2, 3]);
  });
});

describe("gruntStatus", () => {
  it("is active until the track is full", () => {
    expect(gruntStatus(8, 9, "physical")).toBe("active");
  });

  it("leaves a full track dead if physical damage hit last, and unconscious if stun did", () => {
    expect(gruntStatus(9, 9, "physical")).toBe("dead");
    expect(gruntStatus(9, 9, "stun")).toBe("unconscious");
  });
});

describe("passedRating", () => {
  it("is true only on the damage that first takes a standing grunt past their rating", () => {
    expect(passedRating(2, 3, 3, true)).toBe(false);
    expect(passedRating(3, 4, 3, true)).toBe(true);
    expect(passedRating(2, 5, 3, true)).toBe(true);
    expect(passedRating(0, 1, 0, true)).toBe(true);
    expect(passedRating(4, 6, 3, true)).toBe(false);
  });

  it("is false for a grunt who has been put down", () => {
    expect(passedRating(2, 9, 3, false)).toBe(false);
  });
});

describe("groupBonusDice", () => {
  it("adds a die for every odd-numbered member beyond the first, as the book's example does", () => {
    expect([1, 2, 3, 4, 5].map(groupBonusDice)).toEqual([0, 0, 1, 1, 2]);
    // Four Lone Star officers, the best with 6 dice: 6 + 1 = 7.
    expect(6 + groupBonusDice(4)).toBe(7);
  });
});

describe("COMPOSURE_THRESHOLD", () => {
  it("is the system's own ruling", () => {
    expect(COMPOSURE_THRESHOLD).toBe(2);
  });
});
