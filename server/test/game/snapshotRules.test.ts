import { DEFAULT_SCREEN_RULES } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { defaultRuleset, screenRules } from "../../src/rules/index.js";
import type { GmDriver } from "../../src/gm/driver.js";
import { newSession } from "../helpers.js";

const idle: GmDriver = { async takeTurn() {} };

describe("the rules the snapshot carries for the screen", () => {
  it("are the ruleset's hit minimum and stun carry-over rate", async () => {
    const { session } = await newSession(idle);
    expect(session.snapshot().rules).toEqual({ hitMinimum: defaultRuleset.hitMinimum, stunOverflowPerPhysical: defaultRuleset.conditionMonitor.stunOverflowPerPhysical });
  });

  it("follow an edited ruleset", async () => {
    const rules = { ...defaultRuleset, hitMinimum: 4, conditionMonitor: { ...defaultRuleset.conditionMonitor, stunOverflowPerPhysical: 2 } };
    const { session } = await newSession(idle, { rules });
    expect(session.snapshot().rules).toEqual({ hitMinimum: 4, stunOverflowPerPhysical: 2 });
  });

  it("come from one function that names every value the screen reads, so one added to the type cannot be forgotten", () => {
    const rules: Record<keyof ReturnType<typeof screenRules>, true> = { hitMinimum: true, stunOverflowPerPhysical: true };
    expect(Object.keys(screenRules()).sort()).toEqual(Object.keys(rules).sort());
    expect(Object.keys(DEFAULT_SCREEN_RULES).sort()).toEqual(Object.keys(screenRules()).sort());
  });

  it("match what the screen assumes before it hears from the server, so the two cannot drift apart unnoticed", () => {
    expect(DEFAULT_SCREEN_RULES).toEqual(screenRules(defaultRuleset));
  });
});
