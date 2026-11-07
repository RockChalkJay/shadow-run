import type { CharacterView, ClientMessage, EdgeView, RollRequest } from "@shadow-run/shared";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUMBLE_MS } from "./Dice";
import { RollCard } from "./RollCard";

const roll = (dice: number[], extra: object = {}) => ({ dice, hits: dice.filter((d) => d >= 5).length, ones: dice.filter((d) => d === 1).length, glitch: false, criticalGlitch: false, ...extra });
const base = {
  id: "r1", characterId: "kira", label: "Sneak", pool: { total: 4, breakdown: "x" }, stakes: "s", goodRoll: "g", badRoll: "b", edgeAdvice: "e",
  consequences: { success: "s", failure: "f", glitch: "g", criticalGlitch: "c" },
} as RollRequest;
const held = (over: object = {}, opposed = false) => ({ ...base, ...(opposed && { opposed: { by: "Guard", pool: 4, role: "acting" as const } }), held: { source: "physical" as const, roll: roll([6, 3, 3, 1]), ...(opposed && { opponent: roll([5, 5, 2, 1]) }), ...over } }) as RollRequest;
const edge: EdgeView = { id: "kira", points: 4, rank: 3, spentThisRound: false };

function show(request: RollRequest, e: EdgeView | undefined = edge, error: string | null = null, character?: CharacterView) {
  const send = vi.fn<(m: ClientMessage) => void>();
  render(<RollCard request={request} name="Kira" character={character} edge={e} error={error} send={send} />);
  return { send, user: userEvent.setup() };
}
const die = (side: "your" | "their", n: number, face: number) => screen.getByRole("button", { name: `${side} die ${n}, showing ${face}` });

afterEach(() => vi.useRealTimers());

describe("a roll that is held", () => {
  it("tumbles the app's dice before showing the faces, and not dice rolled by hand", () => {
    vi.useFakeTimers();
    show(held({ source: "app" }));
    expect(screen.getAllByLabelText("rolling").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /your die/ })).toBeNull();
    act(() => void vi.advanceTimersByTime(TUMBLE_MS + 10));
    expect(screen.getByRole("button", { name: "your die 1, showing 6" })).toBeTruthy();
  });

  it("shows dice rolled by hand at once", () => {
    show(held());
    expect(screen.getByRole("button", { name: "your die 1, showing 6" })).toBeTruthy();
  });

  it("names what it will do, with no cost, until dice are picked", async () => {
    const { user } = show(held());
    expect(screen.getByRole("button", { name: "Reroll dice" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Add 1 to a die/ }));
    expect(screen.getByRole("button", { name: "Add 1 to a die" })).toBeTruthy();
    await user.click(die("your", 2, 3));
    expect(screen.getByRole("button", { name: "Add 1 to 1 die · 2 Edge" })).toBeTruthy();
  });

  it("shows the counted dice and the hits, and no longer offers to roll", () => {
    show(held());
    expect(screen.getByText(/Your roll: 1 hit/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "your dice" }).textContent).toBe("6331");
    expect(screen.queryByRole("button", { name: /Roll with the app/ })).toBeNull();
  });

  it("shows the opposition's dice and hits as well", () => {
    show(held({}, true));
    expect(screen.getByText(/1 hit against 2/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "their dice" })).toBeTruthy();
  });

  it("leads with keeping the roll, before any way to spend Edge, and mentions no holding", () => {
    show(held());
    const keep = screen.getByRole("button", { name: "Keep it as it stands" });
    const firstWayToSpend = screen.getByRole("radio", { name: /Reroll dice/ });
    expect(keep.compareDocumentPosition(firstWayToSpend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/hold|committed/i)).toBeNull();
  });

  it("keeps the roll as it stands", async () => {
    const { send, user } = show(held());
    await user.click(screen.getByRole("button", { name: "Keep it as it stands" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.keep", requestId: "r1" });
  });

  it("rerolls the dice picked, yours and theirs, at 1 Edge each", async () => {
    const { send, user } = show(held({}, true));
    await user.click(die("your", 2, 3));
    await user.click(die("their", 3, 2));
    expect(screen.getByRole("button", { name: "Reroll 2 dice · 2 Edge" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reroll 2 dice · 2 Edge" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "reroll", targets: [{ side: "mine", index: 1 }, { side: "theirs", index: 2 }] });
  });

  it("sends the new dice when they were rolled by hand", async () => {
    const { send, user } = show(held());
    await user.click(die("your", 2, 3));
    await user.click(screen.getByLabelText("I rolled the new dice myself"));
    await user.type(screen.getByLabelText("new dice"), "5");
    await user.click(screen.getByRole("button", { name: /Reroll 1 die/ }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "reroll", targets: [{ side: "mine", index: 1 }], dice: "5" });
  });

  it("adds 1 to the player's own dice only, at 2 Edge each", async () => {
    const { send, user } = show(held({}, true));
    await user.click(screen.getByRole("radio", { name: /Add 1 to a die/ }));
    await user.click(die("your", 2, 3));
    await user.click(screen.getByRole("button", { name: "Add 1 to 1 die · 2 Edge" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "bump", targets: [{ side: "mine", index: 1 }] });
    // Their dice cannot be picked for this.
    expect(screen.queryByRole("button", { name: /their die/ })).toBeNull();
  });

  it("will not add 1 to a 6, and says so before anything is sent", async () => {
    const { send, user } = show(held());
    await user.click(screen.getByRole("radio", { name: /Add 1 to a die/ }));
    await user.click(die("your", 1, 6));
    expect(screen.getByRole("alert").textContent).toBe("A 6 cannot be raised.");
    expect((screen.getByRole("button", { name: /Add 1 to 1 die/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("buys hits at 3 Edge each", async () => {
    const { send, user } = show(held(), { ...edge, points: 6 });
    await user.click(screen.getByRole("radio", { name: /Buy a hit/ }));
    await user.selectOptions(screen.getByLabelText("How many"), "2");
    await user.click(screen.getByRole("button", { name: "Buy 2 hits · 6 Edge" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "buy_hit", times: 2 });
  });

  it("rerolls the dice that missed, at 4 Edge", async () => {
    const { send, user } = show(held());
    await user.click(screen.getByRole("radio", { name: /Reroll the misses/ }));
    await user.click(screen.getByRole("button", { name: "Reroll the 3 that missed · 4 Edge" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "reroll_failed" });
  });

  it("will not spend what the player does not have, and says so, without sending", async () => {
    const { send, user } = show(held(), { ...edge, points: 2 });
    await user.click(screen.getByRole("radio", { name: /Buy a hit/ }));
    expect(screen.getByRole("alert").textContent).toBe("Needs 3 Edge; 2 on hand.");
    expect((screen.getByRole("button", { name: /Buy 1 hit/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("will not reroll the misses after a glitch, or when there are none", async () => {
    const { user } = show(held({ roll: roll([1, 1, 1, 6], { glitch: true }) }));
    await user.click(screen.getByRole("radio", { name: /Reroll the misses/ }));
    expect(screen.getByRole("alert").textContent).toBe("Rerolling the misses cannot be done after a glitch.");
  });

  it("will not reroll the misses when every die is a hit", async () => {
    const { user } = show(held({ roll: roll([6, 6, 5, 5]) }));
    await user.click(screen.getByRole("radio", { name: /Reroll the misses/ }));
    expect(screen.getByRole("alert").textContent).toBe("Every die is a hit.");
  });

  it("asks the player to pick dice before offering to spend anything on them", () => {
    show(held());
    expect(screen.getByText("Pick the dice by clicking them.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /^Reroll dice$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows what the server refused", () => {
    show(held(), edge, "Kira has already spent Edge this round.");
    expect(screen.getByRole("alert").textContent).toBe("Kira has already spent Edge this round.");
  });

  it("refuses to spend anything when Edge is already spent this round", async () => {
    const { user } = show(held(), { ...edge, spentThisRound: true });
    await user.click(screen.getByRole("radio", { name: /Buy a hit/ }));
    expect(screen.getByRole("alert").textContent).toBe("Edge is already spent this round: only one expenditure a round.");
  });
});


describe("Not Dead Yet", () => {
  const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };
  const kira = (over: object = {}): CharacterView => ({ id: "kira", kind: "pc", name: "Kira", monitor: { ...monitor, ...over }, status: "active", woundModifier: 0 });
  // 25 physical against Kira's 11 + 10 boxes leaves 4 over; hits take points off.
  const blow = (dice: number[], damageValue = 25) => ({ ...held({ roll: roll(dice) }), soak: { damageValue, damageType: "physical" as const, source: "A fall" } }) as RollRequest;
  const burn = (name = "Burn Edge: Not Dead Yet") => screen.getByRole("button", { name: new RegExp(name) });

  it("is offered when the blow, as the dice stand, would kill, and says what survives", () => {
    show(blow([1, 1, 1, 1, 1]), edge, null, kira());
    expect(screen.getByText("As it stands, this blow kills Kira.")).toBeTruthy();
    expect(burn()).toBeTruthy();
    expect(screen.getByText("They survive it, unconscious and dying. It costs a point of Edge rank for good and all their Edge.")).toBeTruthy();
  });

  it("is not offered for a blow that would not kill, including one the hits bring down", () => {
    // Nine hits leave 16 damage, which the track holds with room to spare.
    show(blow([6, 6, 6, 6, 6, 6, 6, 6, 6]), edge, null, kira());
    expect(screen.queryByRole("button", { name: /Not Dead Yet/ })).toBeNull();
    expect(screen.queryByText(/kills Kira/)).toBeNull();
  });

  it("counts how hurt the character already is", () => {
    show(blow([1, 1, 1, 1, 1], 8), edge, null, kira({ physical: 11, overflow: 4 }));
    expect(burn()).toBeTruthy();
  });

  it("is not offered on a roll that is not resisting damage", () => {
    show(held(), edge, null, kira());
    expect(screen.queryByRole("button", { name: /Not Dead Yet/ })).toBeNull();
  });

  it("says no Edge rank is left to burn, and offers nothing, when the rank is gone", () => {
    show(blow([1, 1, 1, 1, 1]), { ...edge, points: 0, rank: 0 }, null, kira());
    expect(screen.getByText("As it stands, this blow kills Kira.")).toBeTruthy();
    expect(screen.getByText("No Edge rank is left to burn.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Not Dead Yet/ })).toBeNull();
  });

  it("asks first, says the cost for good and that the blow still lands, and sends nothing if cancelled", async () => {
    const { send, user } = show(blow([1, 1, 1, 1, 1]), edge, null, kira());
    await user.click(burn());
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("The blow still lands, but Kira survives it");
    expect(dialog.textContent).toContain("(3 → 2) and the 4 Edge points Kira holds now");
    expect(dialog.textContent).toContain("It cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(send).not.toHaveBeenCalled();
    await user.click(burn());
    await user.click(screen.getByRole("button", { name: "Burn it" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "not_dead_yet" });
  });

  it("can be burned with no Edge points to spend, as long as there is rank", async () => {
    const { send, user } = show(blow([1, 1, 1, 1, 1]), { ...edge, points: 0, spentThisRound: true }, null, kira());
    await user.click(burn());
    await user.click(screen.getByRole("button", { name: "Burn it" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.edge", requestId: "r1", boost: "not_dead_yet" });
  });

  it("shows what the server refused", () => {
    show(blow([1, 1, 1, 1, 1]), edge, "Kira would survive this as the roll stands.", kira());
    expect(screen.getByRole("alert").textContent).toContain("would survive this");
  });
});
