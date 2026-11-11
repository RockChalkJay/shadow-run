import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("plays Claude as the GM on Sonnet unless told otherwise", () => {
    expect(loadConfig({})).toMatchObject({ gm: "claude", gmModel: "sonnet", port: 8787, devPort: 5173, campaign: "default" });
    expect(loadConfig({})).not.toHaveProperty("gmEffort");
    expect(loadConfig({})).not.toHaveProperty("claudeBin");
    expect(loadConfig({}).testMode).toBe(false);
  });

  it("is in test mode when asked, or when it starts from a scenario", () => {
    expect(loadConfig({ SHADOWRUN_TEST_MODE: "1" }).testMode).toBe(true);
    expect(loadConfig({ SHADOWRUN_TEST_MODE: "true" }).testMode).toBe(true);
    expect(loadConfig({ SHADOWRUN_TEST_MODE: "0" }).testMode).toBe(false);
    expect(loadConfig({ SHADOWRUN_TEST_MODE: "false" }).testMode).toBe(false);
    expect(loadConfig({ SHADOWRUN_SCENARIO: "ambush" }).testMode).toBe(true);
    // Said outright, the setting wins over the scenario's default.
    expect(loadConfig({ SHADOWRUN_SCENARIO: "ambush", SHADOWRUN_TEST_MODE: "0" }).testMode).toBe(false);
  });

  it("plays a scenario in a folder of its own, which no campaign shares", () => {
    expect(loadConfig({})).not.toHaveProperty("scenario");
    expect(loadConfig({ SHADOWRUN_SCENARIO: "ambush", SHADOWRUN_SCENARIOS: "/tmp/sc" })).toMatchObject({
      scenario: "ambush",
      campaign: "scenario-ambush",
      scenariosDir: "/tmp/sc",
    });
    expect(loadConfig({}).scenariosDir).toMatch(/scenarios$/);
  });

  it("reads each setting from the environment", () => {
    const config = loadConfig({
      SHADOWRUN_GM: "scripted",
      SHADOWRUN_GM_MODEL: "haiku",
      SHADOWRUN_GM_EFFORT: "high",
      SHADOWRUN_CAMPAIGN: "night-one",
      SHADOWRUN_CAMPAIGNS: "/tmp/camps",
      CLAUDE_BIN: "/opt/claude",
      PORT: "9000",
      WEB_PORT: "3000",
    });
    expect(config).toMatchObject({
      gm: "scripted",
      gmModel: "haiku",
      gmEffort: "high",
      campaign: "night-one",
      campaignsDir: "/tmp/camps",
      claudeBin: "/opt/claude",
      port: 9000,
      devPort: 3000,
    });
  });

  it.each([
    [{ SHADOWRUN_GM: "gpt" }, /SHADOWRUN_GM must be/],
    [{ SHADOWRUN_GM_EFFORT: "extreme" }, /SHADOWRUN_GM_EFFORT must be one of/],
    [{ SHADOWRUN_CAMPAIGN: "../etc" }, /SHADOWRUN_CAMPAIGN may use/],
    [{ SHADOWRUN_SCENARIO: "../x" }, /SHADOWRUN_SCENARIO may use/],
    [{ SHADOWRUN_SCENARIO: "ambush", SHADOWRUN_CAMPAIGN: "default" }, /cannot both be set/],
    [{ SHADOWRUN_TEST_MODE: "yes" }, /SHADOWRUN_TEST_MODE must be 1 or 0/],
    [{ PORT: "0" }, /PORT must be a port number/],
    [{ PORT: "eighty" }, /PORT must be a port number/],
    [{ WEB_PORT: "70000" }, /WEB_PORT must be a port number/],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
