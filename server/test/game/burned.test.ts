import { describe, expect, it } from "vitest";
import { withBurnedEdge } from "../../src/game/burned.js";
import { party } from "../helpers.js";

// Kira has Edge 3 and Doc Edge 4.
describe("withBurnedEdge", () => {
  const edgeOf = (sheets: typeof party, id: string) => sheets.find((s) => s.id === id)!.attributes.edge;

  it("takes the burned rank off the sheet, leaving everyone else alone", () => {
    const played = withBurnedEdge(party, { kira: 2 });
    expect(edgeOf(played, "kira")).toBe(1);
    expect(edgeOf(played, "doc")).toBe(4);
  });

  it("never goes below zero, even if the sheet was lowered by hand since", () => {
    expect(edgeOf(withBurnedEdge(party, { kira: 7 }), "kira")).toBe(0);
  });

  it("leaves the sheets it was given untouched", () => {
    withBurnedEdge(party, { kira: 2 });
    expect(edgeOf(party, "kira")).toBe(3);
  });

  it("ignores a character who is not at the table", () => {
    expect(withBurnedEdge(party, { nobody: 3 })).toEqual(party);
  });
});
