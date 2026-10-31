import { describe, expect, it } from "vitest";
import { actionsFor, rollInitiative, scriptedD6, turnOrder, type TurnEntry } from "../../src/rules/index.js";

describe("rollInitiative", () => {
  it("adds Reaction, Intuition and the initiative dice", () => {
    expect(rollInitiative({ reaction: 4, intuition: 3, dice: 2 }, scriptedD6([5, 2]))).toEqual({
      score: 14,
      rolls: [5, 2],
    });
  });

  it("rejects fewer than one or more than the maximum initiative dice", () => {
    const d6 = scriptedD6([1, 1, 1, 1, 1, 1]);
    expect(() => rollInitiative({ reaction: 4, intuition: 3, dice: 0 }, d6)).toThrow(RangeError);
    expect(() => rollInitiative({ reaction: 4, intuition: 3, dice: 6 }, d6)).toThrow(RangeError);
  });
});

describe("actionsFor", () => {
  it("gives a major action and a minor action per initiative die on top of one", () => {
    expect(actionsFor(1)).toEqual({ major: 1, minor: 2 });
    expect(actionsFor(3)).toEqual({ major: 1, minor: 4 });
  });
});

describe("turnOrder", () => {
  const entry = (name: string, score: number, edge = 3, reaction = 4, intuition = 4): TurnEntry & { name: string } => ({
    name,
    score,
    edge,
    reaction,
    intuition,
  });
  const names = (list: { name: string }[]) => list.map((e) => e.name);
  const never = () => 0.5;

  it("puts the highest score first", () => {
    expect(names(turnOrder([entry("a", 10), entry("b", 15), entry("c", 8)], never))).toEqual(["b", "a", "c"]);
  });

  it("breaks a tie on Edge first, as in the rulebook's Oda example", () => {
    const order = turnOrder([entry("ganger", 10, 3), entry("oda", 10, 5)], never);
    expect(names(order)).toEqual(["oda", "ganger"]);
  });

  it("then Reaction, then Intuition", () => {
    expect(names(turnOrder([entry("a", 10, 3, 4), entry("b", 10, 3, 6)], never))).toEqual(["b", "a"]);
    expect(names(turnOrder([entry("a", 10, 3, 4, 4), entry("b", 10, 3, 4, 6)], never))).toEqual(["b", "a"]);
  });

  it("flips a coin when everything is equal", () => {
    const coins = [0.9, 0.1];
    const flip = () => coins.shift() ?? 0;
    expect(names(turnOrder([entry("a", 10), entry("b", 10)], flip))).toEqual(["b", "a"]);
  });

  it("does not change the list it was given", () => {
    const list = [entry("a", 5), entry("b", 9)];
    turnOrder(list, never);
    expect(names(list)).toEqual(["a", "b"]);
  });
});
