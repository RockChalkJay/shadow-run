import type { TranscriptEntry } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { formatRecap } from "../../src/game/recap.js";
import { RollManager } from "../../src/game/rollManager.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { rollInput } from "../helpers.js";

const nameOf = (id: string) => ({ kira: "Kira", doc: "Doc" })[id] ?? id;
let id = 0;
const entry = (e: object) => ({ ...e, id: ++id, ts: "t" }) as unknown as TranscriptEntry;

function resolvedRoll(dice: string, opposed = false): TranscriptEntry {
  const m = new RollManager({ knownCharacter: () => true, d6: scriptedD6([2, 2, 2, 2]), newId: () => "r1" });
  const { threshold: _t, ...rest } = rollInput();
  m.create(opposed ? { ...rest, opposed: { by: "Guard", pool: 4, role: "acting" } } : rollInput());
  const result = m.resolve("r1", { mode: "physical", dice });
  if (!result.ok) throw new Error(result.error);
  return entry({ kind: "roll", resolved: result.resolved });
}

describe("formatRecap", () => {
  it("turns the transcript into plain lines, leaving out system notices", () => {
    const text = formatRecap(
      [
        entry({ kind: "say", characterId: "kira", name: "Kira", text: "I open the door." }),
        entry({ kind: "gm", text: "It creaks." }),
        entry({ kind: "system", text: "The GM's turn failed: boom" }),
        entry({ kind: "roll_cancelled", requestId: "r", characterId: "doc", label: "Spot the camera" }),
        entry({ kind: "npc", label: "Ganger fires", pool: 4, roll: { dice: [6, 5, 1, 1], hits: 2, ones: 2, glitch: false, criticalGlitch: false }, threshold: 2, success: true }),
      ],
      nameOf,
    );
    expect(text).toBe(
      [
        "Kira: I open the door.",
        "GM: It creaks.",
        "[Roll skipped] Doc, Spot the camera.",
        "[NPC roll] Ganger fires: 2 hits, success.",
      ].join("\n"),
    );
  });

  it("reports damage and healing, and who is down", () => {
    const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 6, stun: 0, overflow: 0 };
    const after = (status: "active" | "unconscious" | "dead") => ({ id: "kira", kind: "pc" as const, name: "Kira", monitor, status, woundModifier: 2 });
    const resistance = { dice: [6, 5, 1], hits: 2, ones: 1, glitch: false, criticalGlitch: false };
    const text = formatRecap(
      [
        entry({ kind: "damage", label: "Ganger's pistol", damageType: "physical", damageValue: 8, resistance, resistedBy: "physical", taken: 6, after: after("active") }),
        entry({ kind: "damage", label: "Shock baton", damageType: "stun", damageValue: 12, resistance, resistedBy: "app", taken: 10, after: after("unconscious") }),
        entry({ kind: "heal", reason: "Doc's First Aid", type: "stun", healed: 2, after: after("active") }),
      ],
      nameOf,
    );
    expect(text).toBe(
      [
        "[Damage] Kira took 6 physical from Ganger's pistol.",
        "[Damage] Kira took 10 stun from Shock baton. Kira is unconscious.",
        "[Heal] Kira healed 2 stun: Doc's First Aid.",
      ].join("\n"),
    );
  });

  it("summarizes a roll with its verdict and declared consequence", () => {
    expect(formatRecap([resolvedRoll("6 5 3 1")], nameOf)).toBe("[Roll] Kira, Sneak past the guard: success (2 hits). Kira slips through.");
    expect(formatRecap([resolvedRoll("6 5 3 1", true)], nameOf)).toContain("success (2 hits against Guard (0 hits))");
    expect(formatRecap([resolvedRoll("1 1 1 2")], nameOf)).toContain("failure (0 hits, critical glitch)");
  });

  it("keeps the newest lines when it has to cut, never half a line", () => {
    const entries = Array.from({ length: 400 }, (_, i) => entry({ kind: "gm", text: `line ${i} ${"x".repeat(60)}` }));
    const text = formatRecap(entries, nameOf);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.split("\n").at(-1)).toContain("line 399");
    expect(text.split("\n")[0]).toMatch(/^GM: line \d+ x+$/);
  });

  it("is empty when nothing has been said", () => {
    expect(formatRecap([], nameOf)).toBe("");
  });
});
