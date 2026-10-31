import { describe, expect, it } from "vitest";
import { actionsFor, rollInitiative, scriptedD6, turnOrder } from "../../src/rules/index.js";

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
  it("puts the highest score first and keeps the order of equal scores", () => {
    const order = turnOrder([
      { name: "a", score: 10 },
      { name: "b", score: 15 },
      { name: "c", score: 10 },
    ]);
    expect(order.map((e) => e.name)).toEqual(["b", "a", "c"]);
  });
});
