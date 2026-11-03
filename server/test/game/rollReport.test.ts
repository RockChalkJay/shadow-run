import type { ResolvedRoll } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { formatAttackForGm, formatCancelledForGm, formatHealForGm, formatHealingOffer, formatNpcRoll, formatRollForGm, showDice } from "../../src/game/rollReport.js";
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
        "Kira rolled 4 dice (dice at the table): 6 5 5 1 = 3 hits.",
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
      "ROLL SKIPPED. The table skipped Kira's roll (Sneak past the guard). Apply no consequence from it; carry on from the situation as it stood before the roll.",
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

describe("formatAttackForGm", () => {
  const weapon = { name: "Ares Predator VI", damageValue: 3, damageType: "physical" as const };
  const attack = (attackDice: string, defenseDice: string, over: object = {}) => ({
    label: "Kira shoots the ganger",
    attacker: "Kira",
    defender: "Ganger",
    weapon,
    attackRoll: evaluate(attackDice.split(" ").map(Number)),
    attackDice: attackDice.split(" ").length,
    attackedBy: "physical" as const,
    defenseRoll: evaluate(defenseDice.split(" ").map(Number)),
    defenseDice: defenseDice.split(" ").length,
    defendedBy: "system" as const,
    hit: true,
    damageValue: 7,
    ...over,
  });

  it("reports a hit with the sum that makes the Damage Value", () => {
    expect(formatAttackForGm(attack("6 6 6 5 3 3", "3 3 3 3"))).toBe(
      [
        "ATTACK RESULT. Kira shoots the ganger.",
        "Kira attacked with Ares Predator VI (3P), 6 dice (dice at the table): 6 6 6 5 3 3 = 4 hits.",
        "Ganger defended, 4 dice (the system's dice): 3 3 3 3 = 0 hits.",
        "HIT by 4 net hits. Damage Value 3 + 4 = 7 physical, before Ganger resists.",
      ].join("\n"),
    );
  });

  it("says a hit on a tie is for the base Damage Value", () => {
    expect(formatAttackForGm(attack("6 5 3", "6 5 3", { damageValue: 3 }))).toContain("HIT on a tie. Damage Value 3 physical, before Ganger resists.");
  });

  it("says why a miss missed", () => {
    expect(formatAttackForGm(attack("6 3 3", "6 5 3", { hit: false, damageValue: 0 }))).toContain("MISS. Ganger had more hits.");
    expect(formatAttackForGm(attack("3 3 3", "3 3 3", { hit: false, damageValue: 0 }))).toContain("MISS. Kira had no hits, so the attack cannot land.");
  });

  it("notes a glitch on either side, and keeps it from being fatal", () => {
    const text = formatAttackForGm(attack("1 1 1 6", "1 1 1", { hit: false, damageValue: 0 }));
    expect(text).toContain("Kira: GLITCH. The GM decides what goes wrong, keeping it inconvenient, not disastrous.");
    expect(text).toContain("Ganger: CRITICAL GLITCH. The GM decides what goes wrong, keeping it serious but not fatal.");
  });
});

describe("healing reports", () => {
  it("offers the hits of a healing roll with the rate for its kind, and its roll id", () => {
    expect(formatHealingOffer({ healer: "Doc", patient: "Kira", method: "first_aid", hits: 4, rollId: "r-9" })).toBe(
      [
        "HEALING AVAILABLE. Doc's First Aid on Kira: 4 hits to spend. Roll id: r-9",
        "Spend them with the heal tool, giving that roll id, in this turn; hits you do not spend are lost. First Aid heals 1 stun box per hit, or 1 physical or overflow box per 2 hits. Overflow damage heals first.",
      ].join("\n"),
    );
    expect(formatHealingOffer({ healer: "Kira", patient: "Kira", method: "natural_stun", hits: 1, rollId: "r" })).toContain("Kira's natural recovery from stun: 1 hit to spend.");
  });

  it("says how many hits are left after a heal", () => {
    const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 4, stun: 0, overflow: 0 };
    const after = { id: "kira", kind: "pc" as const, name: "Kira", monitor, status: "active" as const, woundModifier: 1 };
    expect(formatHealForGm({ reason: "Doc's First Aid on Kira", type: "physical", healed: 2, after, left: 1 })).toBe(
      "HEAL. Doc's First Aid on Kira: Kira heals 2 physical.\nKira: Physical 4/11, Stun 0/10, Overflow 0/10. Wound penalty: -1 dice on everything but damage resistance.\n1 hit left on this healing roll.",
    );
  });
});
