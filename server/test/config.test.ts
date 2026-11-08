import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("plays Claude as the GM on Sonnet unless told otherwise", () => {
    expect(loadConfig({})).toMatchObject({ gm: "claude", gmModel: "sonnet", port: 8787, devPort: 5173, campaign: "default" });
    expect(loadConfig({})).not.toHaveProperty("gmEffort");
    expect(loadConfig({})).not.toHaveProperty("claudeBin");
    expect(loadConfig({})).not.toHaveProperty("dice");
  });

  it("reads the scripted dice in the forms a player can type", () => {
    for (const text of ["6,6,1,3", "6 6 1 3", "6613"]) expect(loadConfig({ SHADOWRUN_DICE: text }).dice).toEqual([6, 6, 1, 3]);
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
    [{ SHADOWRUN_DICE: "" }, /SHADOWRUN_DICE: No dice/],
    [{ SHADOWRUN_DICE: "6,7" }, /SHADOWRUN_DICE: Dice must be digits 1 to 6/],
    [{ PORT: "0" }, /PORT must be a port number/],
    [{ PORT: "eighty" }, /PORT must be a port number/],
    [{ WEB_PORT: "70000" }, /WEB_PORT must be a port number/],
  ])("refuses %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
