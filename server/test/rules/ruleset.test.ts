import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultRuleset, evaluate, loadRuleset, Ruleset } from "../../src/rules/index.js";

describe("the shipped ruleset", () => {
  it("is valid and plays by the rulebook's values", () => {
    expect(Ruleset.safeParse(defaultRuleset).success).toBe(true);
    expect(defaultRuleset.glitch.rule).toBe("more_than_half");
    expect(defaultRuleset.conditionMonitor).toEqual({ baseBoxes: 8, stunOverflowPerPhysical: 1, overflowMultiplier: 2 });
    expect(defaultRuleset.edge).toEqual({ max: 7, maxGainPerRound: 2, ratingGapForEdge: 4 });
  });

  it("says where each setting is in the rulebook", () => {
    for (const key of ["hitMinimum", "glitch.rule", "edge.max", "conditionMonitor.overflowMultiplier", "woundModifier.boxesPerRow"]) {
      expect(defaultRuleset.pages[key], key).toMatch(/^\d/);
    }
  });

  it("lists only rulings the book is silent on", () => {
    expect(defaultRuleset.unverified.length).toBeGreaterThan(0);
    expect(defaultRuleset.unverified.join(" ")).not.toMatch(/sources? (split|disagree)/i);
  });
});

describe("loadRuleset", () => {
  it("lets a table change a rule by editing the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-rules-"));
    const file = join(dir, "ruleset.json");
    await writeFile(file, JSON.stringify({ ...defaultRuleset, glitch: { rule: "half_or_more" } }));

    const edited = loadRuleset(pathToFileURL(file));
    expect(evaluate([1, 1, 1, 6, 6, 6], defaultRuleset).glitch).toBe(false);
    expect(evaluate([1, 1, 1, 6, 6, 6], edited).glitch).toBe(true);
  });

  it("refuses a file with an impossible value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-rules-"));
    const file = join(dir, "ruleset.json");
    await writeFile(file, JSON.stringify({ ...defaultRuleset, hitMinimum: 7 }));
    expect(() => loadRuleset(pathToFileURL(file))).toThrow();
  });
});
