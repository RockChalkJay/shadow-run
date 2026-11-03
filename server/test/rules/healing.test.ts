import { describe, expect, it } from "vitest";
import { healingAutoHit, healingHits, healingThreshold, hitsPerBox, isTreatment } from "../../src/rules/index.js";

describe("healingThreshold", () => {
  it("is 5 minus Essence, rounded up, never below 0", () => {
    expect(healingThreshold(3)).toBe(2);
    expect(healingThreshold(0)).toBe(5);
    expect(healingThreshold(4.9)).toBe(1);
    expect(healingThreshold(5)).toBe(0);
    expect(healingThreshold(6)).toBe(0);
  });
});

describe("healingAutoHit", () => {
  it("goes to first aid and medkits on a fully natural patient, and to nothing else", () => {
    expect(healingAutoHit("first_aid", 6)).toBe(true);
    expect(healingAutoHit("medkit", 6)).toBe(true);
    expect(healingAutoHit("magic", 6)).toBe(false);
    expect(healingAutoHit("first_aid", 5.9)).toBe(false);
    expect(healingAutoHit("natural_stun", 6)).toBe(false);
  });
});

describe("healingHits", () => {
  it("counts hits above the threshold, as the book's first aid example does: 4 hits against 2 leaves 2", () => {
    expect(healingHits({ method: "first_aid", threshold: 2, autoHit: false }, 4)).toBe(2);
  });

  it("adds the free hit for a fully natural patient", () => {
    expect(healingHits({ method: "medkit", threshold: 0, autoHit: true }, 3)).toBe(4);
    expect(healingHits({ method: "medkit", threshold: 0, autoHit: true }, 0)).toBe(1);
  });

  it("never goes below zero", () => {
    expect(healingHits({ method: "magic", threshold: 3, autoHit: false }, 1)).toBe(0);
  });

  it("gives natural recovery every hit, since it has no threshold", () => {
    expect(healingHits({ method: "natural_stun", threshold: 0, autoHit: false }, 3)).toBe(3);
  });
});

describe("hitsPerBox", () => {
  it("makes first aid cost 1 hit per stun box and 2 per physical or overflow box", () => {
    expect(hitsPerBox("first_aid", "stun")).toBe(1);
    expect(hitsPerBox("first_aid", "physical")).toBe(2);
    expect(hitsPerBox("first_aid", "overflow")).toBe(2);
  });

  it("makes a medkit and healing magic cost 1 hit per box on any track", () => {
    for (const method of ["medkit", "magic"] as const) for (const track of ["stun", "physical", "overflow"] as const) expect(hitsPerBox(method, track)).toBe(1);
  });

  it("lets natural recovery touch only its own track", () => {
    expect(hitsPerBox("natural_stun", "stun")).toBe(1);
    expect(hitsPerBox("natural_stun", "physical")).toBeNull();
    expect(hitsPerBox("natural_physical", "physical")).toBe(1);
    expect(hitsPerBox("natural_physical", "overflow")).toBeNull();
    expect(hitsPerBox("natural_overflow", "overflow")).toBe(1);
    expect(hitsPerBox("natural_overflow", "stun")).toBeNull();
  });

  it("matches the book's healing example: a medkit's 4 hits heal 1 overflow, 2 physical and 1 stun", () => {
    const hits = healingHits({ method: "medkit", threshold: 2, autoHit: false }, 6);
    expect(hits).toBe(4);
    expect(hits).toBe(1 * hitsPerBox("medkit", "overflow")! + 2 * hitsPerBox("medkit", "physical")! + 1 * hitsPerBox("medkit", "stun")!);
  });
});

describe("isTreatment", () => {
  it("is true for the three once-only treatments and false for natural recovery", () => {
    expect(["first_aid", "medkit", "magic"].every((m) => isTreatment(m as never))).toBe(true);
    expect(isTreatment("natural_stun")).toBe(false);
  });
});
