import type { ResolvedRoll } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { formatCancelledForGm, formatNpcRoll, formatRollForGm, showDice } from "../../src/game/rollReport.js";
import { RollManager } from "../../src/game/rollManager.js";
import { evaluate, scriptedD6 } from "../../src/rules/index.js";
import { rollInput } from "../helpers.js";

function resolved(input: unknown, dice: string, opponentFaces: number[] = []): ResolvedRoll {
  const m = new RollManager({ knownCharacter: () => true, d6: scriptedD6(opponentFaces), newId: () => "r1" });
  const created = m.create(input);
  if (!created.ok) throw new Error(created.error);
  const result = m.resolve("r1", { mode: "physical", dice });
  if (!result.ok) throw new Error(result.error);
  return result.resolved;
}

describe("formatRollForGm", () => {
  it("reports a threshold roll with the dice, the verdict and the declared consequence", () => {
    expect(formatRollForGm(resolved(rollInput(), "6 5 5 1"), "Kira")).toBe(
      [
        "ROLL RESULT. Kira: Sneak past the guard.",
        "Kira rolled 4 dice (physical dice): 6 5 5 1 = 3 hits.",
        "Threshold 2.",
        "SUCCESS by 1 net hit.",
        "Apply this consequence, as you declared it: Kira slips through.",
      ].join("\n"),
    );
  });

  it("reports an opposed roll, who rolled the opposition, and who a tie favors", () => {
    const { threshold: _t, ...rest } = rollInput();
    const text = formatRollForGm(
      resolved({ ...rest, opposed: { by: "Guard", pool: 3, role: "acting" } }, "6 5 3 1", [6, 5, 2]),
      "Kira",
    );
    expect(text).toContain("Opposed by Guard, 3 dice rolled by the system: 6 5 2 = 2 hits.");
    expect(text).toContain("SUCCESS.");
    expect(text).toContain("(Kira is acting, so a tie goes to Kira.)");

    const defending = formatRollForGm(
      resolved({ ...rest, opposed: { by: "Guard", pool: 3, role: "defending" } }, "6 5 3 1", [6, 5, 2]),
      "Kira",
    );
    expect(defending).toContain("FAILURE.");
    expect(defending).toContain("(Guard is acting, so a tie goes to Guard.)");
  });

  it("flags a glitch and a critical glitch with the matching consequence", () => {
    const glitch = formatRollForGm(resolved(rollInput({ pool: { total: 5, breakdown: "x" } }), "6 6 1 1 1"), "Kira");
    expect(glitch).toContain("GLITCH. Also apply: A tile creaks.");
    const crit = formatRollForGm(resolved(rollInput(), "1 1 1 2"), "Kira");
    expect(crit).toContain("FAILURE.");
    expect(crit).toContain("CRITICAL GLITCH. Also apply: The alarm goes off.");
  });

  it("says a single die is a die", () => {
    expect(formatRollForGm(resolved(rollInput({ pool: { total: 1, breakdown: "x" }, threshold: 1 }), "6"), "Kira")).toContain("rolled 1 die ");
  });
});

describe("showDice", () => {
  it("shows exploded dice and bought hits", () => {
    const roll = evaluate([6, 2], undefined, { explosions: [5], bonusHits: 1 });
    expect(showDice(roll)).toBe("6 2 (exploded: 5) (+1 bought hit)");
  });

  it("copes with an empty pool", () => {
    expect(showDice(evaluate([]))).toBe("no dice");
  });
});

describe("formatCancelledForGm", () => {
  it("tells the GM to apply nothing", () => {
    const r = resolved(rollInput(), "6 5 3 1").request;
    expect(formatCancelledForGm(r, "Kira")).toBe(
      "ROLL SKIPPED. The players skipped Kira's roll (Sneak past the guard). Apply no consequence from it; carry on from the situation as it stood before the roll.",
    );
  });
});

describe("formatNpcRoll", () => {
  it("reports an NPC roll against a threshold", () => {
    expect(formatNpcRoll({ label: "Ganger sprays the door", pool: 6, roll: evaluate([6, 5, 5, 2, 1, 3]), threshold: 3, success: true })).toBe(
      "NPC ROLL. Ganger sprays the door: 6 dice: 6 5 5 2 1 3 = 3 hits.\nThreshold 3: SUCCESS.",
    );
  });

  it("asks the GM to keep a glitch in proportion", () => {
    expect(formatNpcRoll({ label: "x", pool: 4, roll: evaluate([1, 1, 1, 2]) })).toContain("serious but not fatal");
  });
});
