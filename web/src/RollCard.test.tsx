import type { ClientMessage, RollRequest } from "@shadow-run/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { cannotSkip, cannotSmackdown, facesFrom, RollCard } from "./RollCard";

const base: RollRequest = {
  id: "r1",
  characterId: "kira",
  label: "Sneak past the guard",
  pool: { total: 4, breakdown: "Agility 3 + Sneaking 1" },
  threshold: 2,
  stakes: "Reach the door unseen.",
  goodRoll: "Two or more hits.",
  badRoll: "Fewer than two hits.",
  consequences: { success: "Kira slips through.", failure: "The guard challenges her.", glitch: "A tile creaks.", criticalGlitch: "The alarm goes off." },
  edgeAdvice: "Hold it for a reroll.",
};
const edge = { id: "kira", points: 3, rank: 3, spentThisRound: false };

function setup(request: RollRequest = base, error: string | null = null) {
  const send = vi.fn<(m: ClientMessage) => void>();
  render(<RollCard request={request} name="Kira" edge={edge} error={error} send={send} />);
  return { send, user: userEvent.setup() };
}

describe("the roll card", () => {
  it("starts collapsed: stakes and pool show, the consequences and Edge advice do not", () => {
    setup();
    expect(screen.getByText("Reach the door unseen.")).toBeTruthy();
    expect(screen.getByText(/4 dice · Agility 3 \+ Sneaking 1/)).toBeTruthy();
    expect(screen.queryByText("The alarm goes off.")).toBeNull();
    expect(screen.queryByText("Hold it for a reroll.")).toBeNull();
  });

  it("opens What happens and Edge advice on click", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: /What happens/ }));
    await user.click(screen.getByRole("button", { name: /Edge advice/ }));
    expect(screen.getByText("The alarm goes off.")).toBeTruthy();
    expect(screen.getByText("The guard challenges her.")).toBeTruthy();
    expect(screen.getByText("Hold it for a reroll.")).toBeTruthy();
  });

  it("rolls with the app", async () => {
    const { send, user } = setup();
    await user.click(screen.getByRole("button", { name: /Roll with the app/ }));
    expect(send).toHaveBeenCalledWith({ type: "roll.app", requestId: "r1" });
  });

  it("reports dice rolled by hand, one box per die, and fills them from one pasted string", async () => {
    const { send, user } = setup();
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
    await user.click(screen.getByLabelText("die 1"));
    await user.paste("6 5 3 1");
    await user.click(screen.getByRole("button", { name: "Count these dice" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.physical", requestId: "r1", dice: "6 5 3 1" });
  });

  it("says so, and sends nothing, when a die is missing", async () => {
    const { send, user } = setup();
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    await user.type(screen.getByLabelText("die 1"), "6");
    await user.click(screen.getByRole("button", { name: "Count these dice" }));
    expect(screen.getByRole("alert").textContent).toBe("This roll is 4 dice; you entered 1.");
    expect(send).not.toHaveBeenCalled();
  });

  it("shows what the server refused", async () => {
    setup(base, "This roll is 4 dice; you entered 3.");
    expect(screen.getByRole("alert").textContent).toContain("you entered 3");
  });

  it("skips a roll, but not one that resists damage or defends", async () => {
    const { send, user } = setup();
    await user.click(screen.getByRole("button", { name: "Skip roll" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.cancel", requestId: "r1" });
    expect(cannotSkip({ ...base, soak: { damageValue: 5, damageType: "physical", source: "A fall" } })).toMatch(/resists damage/);
    expect(cannotSkip({ ...base, attack: { role: "defender", weapon: { name: "x", damageValue: 3, damageType: "physical" }, other: { kind: "npc", id: "g", name: "G" } } })).toMatch(/defends/);
    expect(cannotSkip(base)).toBeNull();
  });

  it("asks before burning Edge, says what it costs, and sends nothing if cancelled", async () => {
    const { send, user } = setup();
    await user.click(screen.getByRole("button", { name: /Burn Edge: Smackdown/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("(3 → 2)");
    expect(dialog.textContent).toContain("3 Edge points");
    expect(dialog.textContent).toContain("It cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(send).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Burn Edge: Smackdown/ }));
    await user.click(screen.getByRole("button", { name: "Burn it" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.smackdown", requestId: "r1" });
  });

  it("refuses Smackdown where the server would", () => {
    expect(cannotSmackdown({ ...base, soak: { damageValue: 5, damageType: "physical", source: "x" } }, edge)).toMatch(/resist damage/);
    expect(cannotSmackdown({ ...base, healing: { method: "first_aid", patient: { kind: "pc", id: "kira", name: "Kira" }, essence: 6, threshold: 1, autoHit: false } }, edge)).toMatch(/healing/);
    expect(cannotSmackdown(base, { ...edge, rank: 0 })).toMatch(/No Edge rank/);
    expect(cannotSmackdown(base, edge)).toBeNull();
  });

  it("shows a declared Edge Action and that it takes the round's Edge", () => {
    setup({ ...base, edgeAction: { id: "bring_the_drama", name: "Bring the Drama", cost: 2, summary: "s" } });
    expect(screen.getByText(/Bring the Drama · 2 Edge · paid when the roll counts/)).toBeTruthy();
  });

  it("shows an opposed roll's opposition, and a threshold otherwise", () => {
    setup({ ...base, threshold: undefined, opposed: { by: "Guard", pool: 6, role: "acting" } });
    expect(screen.getByText(/Guard, 6 dice, rolled by the system/)).toBeTruthy();
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
