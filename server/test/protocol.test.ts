import { ClientMessage, MAX_POOL, MAX_SAY, Party, PartyMember, RollRequestInput } from "@shadow-run/shared";
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

describe("PartyMember", () => {
  it("accepts the demo party", () => {
    expect(Party.safeParse(demoParty).success).toBe(true);
  });

  it.each([
    ["an id with capitals", { id: "Kira" }],
    ["no body", { body: 0 }],
    ["a fractional willpower", { willpower: 2.5 }],
    ["edge over 7", { edge: 8 }],
  ])("rejects %s", (_name, override) => {
    expect(PartyMember.safeParse({ ...demoParty[0], ...override }).success).toBe(false);
  });

  it("rejects an empty party", () => {
    expect(Party.safeParse([]).success).toBe(false);
  });
});
