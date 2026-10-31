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

  it("cites a rulebook page for every setting, and only for settings", () => {
    const { pages, rulesInCode, unverified, ...settings } = defaultRuleset;
    const paths = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => paths(inner, prefix ? `${prefix}.${key}` : key))
        : [prefix];
    expect(Object.keys(pages).sort()).toEqual(paths(settings).sort());
    for (const [setting, page] of Object.entries(pages)) expect(page, setting).toMatch(/^\d+(, \d+)*$/);
  });

  it("cites a page for each rule it applies in code", () => {
    expect(Object.keys(defaultRuleset.rulesInCode).length).toBeGreaterThan(0);
    for (const [rule, page] of Object.entries(defaultRuleset.rulesInCode)) expect(page, rule).toMatch(/^\d+(, \d+)*$/);
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
