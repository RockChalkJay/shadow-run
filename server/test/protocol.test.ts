import { ClientMessage, MAX_POOL, MAX_SAY, CharacterSheet, Party, RollRequestInput } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { demoParty } from "../src/game/demoParty.js";
import { rollInput } from "./helpers.js";

describe("ClientMessage", () => {
  it.each([
    { type: "session.start" },
    { type: "player.say", text: "I check the door" },
    { type: "player.say", characterId: "kira", text: "  hello  " },
    { type: "roll.app", requestId: "r1" },
    { type: "roll.physical", requestId: "r1", dice: "6 5 3 1" },
    { type: "roll.cancel", requestId: "r1" },
    { type: "turn.cancel" },
    { type: "turn.retry" },
  ])("accepts %j", (message) => {
    expect(ClientMessage.safeParse(message).success).toBe(true);
  });

  it("trims what a player says", () => {
    expect(ClientMessage.parse({ type: "player.say", text: "  hello  " })).toMatchObject({ text: "hello" });
  });

  it.each([
    [{}],
    [{ type: "nope" }],
    [{ type: "player.say" }],
    [{ type: "player.say", text: "   " }],
    [{ type: "player.say", text: "x".repeat(MAX_SAY + 1) }],
    [{ type: "roll.app" }],
    [{ type: "roll.physical", requestId: "r1" }],
    [{ type: "roll.physical", requestId: "r1", dice: "x".repeat(401) }],
    ["a string"],
    [null],
  ])("rejects %j", (message) => {
    expect(ClientMessage.safeParse(message).success).toBe(false);
  });
});

describe("RollRequestInput", () => {
  it("accepts the roll the tests use", () => {
    expect(RollRequestInput.safeParse(rollInput()).success).toBe(true);
  });

  it("requires a threshold of at least 1 and a pool within the limit", () => {
    expect(RollRequestInput.safeParse({ ...rollInput(), threshold: 0 }).success).toBe(false);
    expect(RollRequestInput.safeParse({ ...rollInput(), pool: { total: MAX_POOL + 1, breakdown: "x" } }).success).toBe(false);
    expect(RollRequestInput.safeParse({ ...rollInput(), pool: { total: MAX_POOL, breakdown: "x" } }).success).toBe(true);
  });
});

describe("CharacterSheet", () => {
  const kira = demoParty[0]!;
  const withAttribute = (override: object) => ({ ...kira, attributes: { ...kira.attributes, ...override } });

  it("accepts the demo party", () => {
    expect(Party.safeParse(demoParty).success).toBe(true);
  });

  it.each([
    ["an id with capitals", { ...kira, id: "Kira" }],
    ["no body", withAttribute({ body: 0 })],
    ["a fractional willpower", withAttribute({ willpower: 2.5 })],
    ["edge over 7", withAttribute({ edge: 8 })],
    ["essence over 6", withAttribute({ essence: 6.5 })],
    ["an attribute that does not exist", withAttribute({ luck: 3 })],
    ["a field that does not exist", { ...kira, willpower: 3 }],
    ["a skill that does not exist", { ...kira, skills: { flying: 3 } }],
    ["a skill rating of zero", { ...kira, skills: { firearms: 0 } }],
    ["a metatype that does not exist", { ...kira, metatype: "dragon" }],
    ["no initiative dice", { ...kira, initiativeDice: 0 }],
    ["a specialization in a skill that does not exist", { ...kira, specializations: [{ skill: "flying", name: "Gliding" }] }],
  ])("rejects %s", (_name, sheet) => {
    expect(CharacterSheet.safeParse(sheet).success).toBe(false);
  });

  it("accepts a magical character, a decker and a specialization", () => {
    expect(CharacterSheet.safeParse(demoParty[1]).success).toBe(true);
    expect(CharacterSheet.safeParse({ ...kira, attributes: { ...kira.attributes, resonance: 4 }, specializations: [{ skill: "firearms", name: "Pistols" }] }).success).toBe(true);
  });

  it("rejects an empty party", () => {
    expect(Party.safeParse([]).success).toBe(false);
  });
});
