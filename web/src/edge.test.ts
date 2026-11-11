import type { EdgeView, RollRequest } from "@shadow-run/shared";
import { describe, expect, it } from "vitest";
import { actionTakesTheEdge, cannotSpend, facesFrom, shouldKeepBack } from "./edge";

const edge = (over: Partial<EdgeView> = {}): EdgeView => ({ id: "kira", points: 3, rank: 3, spentThisRound: false, ...over });

describe("whether Edge can be spent", () => {
  it("is fine with enough Edge that has not been spent this round", () => {
    expect(cannotSpend(edge(), 3)).toBeNull();
  });
  it("says why not: too little, already spent this round, or no Edge at all", () => {
    expect(cannotSpend(edge(), 4)).toBe("Needs 4 Edge; 3 on hand.");
    expect(cannotSpend(edge({ spentThisRound: true }), 1)).toBe("Edge is already spent this round: only one expenditure a round.");
    expect(cannotSpend(undefined, 1)).toBe("This character has no Edge to spend.");
  });
});

describe("a declared Edge Action", () => {
  const request = (cost: number) => ({ edgeAction: { id: "x", name: "Bring the Drama", cost, summary: "s" } }) as RollRequest;
  it("takes the round's Edge when the player can pay for it", () => {
    expect(actionTakesTheEdge(request(2), edge())).toBe("Bring the Drama is declared and is this round's one expenditure of Edge.");
  });
  it("leaves the Edge open when the player cannot pay, since the roll goes ahead without the action", () => {
    expect(actionTakesTheEdge(request(5), edge())).toBeNull();
    expect(actionTakesTheEdge(request(2), edge({ spentThisRound: true }))).toBeNull();
  });
  it("does nothing without one", () => {
    expect(actionTakesTheEdge({} as RollRequest, edge())).toBeNull();
  });
});

describe("facesFrom", () => {
  it("reads faces from spaces, commas or nothing, ignoring anything else", () => {
    expect(facesFrom("6 5 3 1")).toEqual([6, 5, 3, 1]);
    expect(facesFrom("6,5,3")).toEqual([6, 5, 3]);
    expect(facesFrom("6531")).toEqual([6, 5, 3, 1]);
    expect(facesFrom("x 7 0 9")).toEqual([]);
  });
});

describe("whether a roll is kept back to show its dice", () => {
  const soak = { soak: { damageValue: 5, damageType: "physical", source: "A fall" } } as RollRequest;
  it("is for any roll with Edge to spend, and not otherwise", () => {
    expect(shouldKeepBack({} as RollRequest, edge(), "none")).toBe(true);
    expect(shouldKeepBack({} as RollRequest, edge({ points: 0 }), "none")).toBe(false);
    expect(shouldKeepBack({} as RollRequest, edge({ spentThisRound: true }), "none")).toBe(false);
    expect(shouldKeepBack({} as RollRequest, edge(), "dice")).toBe(false);
  });
  it("is for every roll in test mode, so it can be rolled again, with Edge to spend or not", () => {
    expect(shouldKeepBack({} as RollRequest, edge({ points: 0 }), "none", true)).toBe(true);
    expect(shouldKeepBack({} as RollRequest, edge({ spentThisRound: true }), "none", true)).toBe(true);
    expect(shouldKeepBack({} as RollRequest, undefined, "none", true)).toBe(true);
    expect(shouldKeepBack({} as RollRequest, edge(), "none", false)).toBe(true);
    expect(shouldKeepBack({} as RollRequest, edge({ points: 0 }), "none", false)).toBe(false);
  });
  it("is not for a roll that spends Edge as it counts, even in test mode", () => {
    const action = (cost: number) => ({ edgeAction: { id: "x", name: "Called Shot", cost } }) as RollRequest;
    expect(shouldKeepBack({} as RollRequest, edge(), "dice", true)).toBe(false);
    expect(shouldKeepBack({} as RollRequest, edge(), "widen", true)).toBe(false);
    expect(shouldKeepBack(action(5), edge({ points: 7 }), "none", true)).toBe(false);
    // A player who cannot pay for the declared action rolls without it, so that roll can be held.
    expect(shouldKeepBack(action(5), edge({ points: 2 }), "none", true)).toBe(true);
  });
  it("is for a roll to resist damage with no Edge to spend, while there is rank to burn", () => {
    expect(shouldKeepBack(soak, edge({ points: 0, spentThisRound: true }), "none")).toBe(true);
    expect(shouldKeepBack(soak, edge({ points: 0, rank: 0 }), "none")).toBe(false);
    expect(shouldKeepBack(soak, edge(), "dice")).toBe(false);
  });
});
