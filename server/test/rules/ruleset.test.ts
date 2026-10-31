import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultRuleset, evaluate, loadRuleset, Ruleset } from "../../src/rules/index.js";

describe("the shipped ruleset", () => {
  it("is valid and names the rules still to check against the rulebook", () => {
    expect(Ruleset.safeParse(defaultRuleset).success).toBe(true);
    expect(defaultRuleset.unverified.length).toBeGreaterThan(0);
  });
});

describe("loadRuleset", () => {
  it("lets a table change a rule by editing the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-rules-"));
    const file = join(dir, "ruleset.json");
    await writeFile(file, JSON.stringify({ ...defaultRuleset, glitch: { rule: "more_than_half" } }));

    const edited = loadRuleset(pathToFileURL(file));
    expect(evaluate([1, 1, 1, 6, 6, 6], defaultRuleset).glitch).toBe(true);
    expect(evaluate([1, 1, 1, 6, 6, 6], edited).glitch).toBe(false);
  });

  it("refuses a file with an impossible value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-rules-"));
    const file = join(dir, "ruleset.json");
    await writeFile(file, JSON.stringify({ ...defaultRuleset, hitMinimum: 7 }));
    expect(() => loadRuleset(pathToFileURL(file))).toThrow();
  });
});
