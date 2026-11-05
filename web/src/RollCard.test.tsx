import type { ClientMessage, RollRequest } from "@shadow-run/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { cannotSkip, cannotSmackdown, RollCard } from "./RollCard";

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

describe("Edge before the roll", () => {
  const edge3 = { id: "kira", points: 3, rank: 3, spentThisRound: false };
  const rich = { id: "kira", points: 5, rank: 3, spentThisRound: false };
  const card = (request: RollRequest, e = rich) => {
    const send = vi.fn<(m: ClientMessage) => void>();
    render(<RollCard request={request} name="Kira" edge={e} error={null} send={send} />);
    return { send, user: userEvent.setup() };
  };

  it("rolls with the Edge dice, which cost 4, and the app is told", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Edge dice · 4 Edge/));
    await user.click(screen.getByRole("button", { name: /Roll with the app/ }));
    expect(send).toHaveBeenCalledWith({ type: "roll.app", requestId: "r1", edge: "dice" });
  });

  it("asks for the Edge attribute's worth of extra dice by hand, and the extra dice for 6s", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Edge dice · 4 Edge/));
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    expect(screen.getAllByRole("textbox").filter((b) => b.getAttribute("aria-label")?.startsWith("die "))).toHaveLength(7);
    expect(screen.getByText(/7 dice \(4 plus 3 Edge dice\)/)).toBeTruthy();
    await user.click(screen.getByLabelText("die 1"));
    await user.paste("6 6 5 3 1 2 3");
    await user.type(screen.getByLabelText("extra dice for 6s"), "5 3");
    await user.click(screen.getByRole("button", { name: "Count these dice" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.physical", requestId: "r1", dice: "6 6 5 3 1 2 3", explosions: "5 3", edge: "dice" });
  });

  it("leaves the extra dice out when none were typed, so the app rolls them", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Edge dice · 4 Edge/));
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    await user.click(screen.getByLabelText("die 1"));
    await user.paste("6 5 3 1 1 2 3");
    await user.click(screen.getByRole("button", { name: "Count these dice" }));
    expect(send.mock.calls[0]![0]).not.toHaveProperty("explosions");
  });

  it("does not send extra dice typed for Edge dice after the player goes back and drops the Edge dice", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Edge dice · 4 Edge/));
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    await user.type(screen.getByLabelText("extra dice for 6s"), "5 3");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByLabelText("No Edge before the roll"));
    await user.click(screen.getByRole("button", { name: /Enter my dice/ }));
    await user.click(screen.getByLabelText("die 1"));
    await user.paste("6 5 3 1");
    await user.click(screen.getByRole("button", { name: "Count these dice" }));
    expect(send).toHaveBeenCalledWith({ type: "roll.physical", requestId: "r1", dice: "6 5 3 1" });
  });

  it("offers the glitch widener, which costs 5, only against an opposition", async () => {
    const { send, user } = card({ ...base, threshold: undefined, opposed: { by: "Guard", pool: 6, role: "acting" } });
    await user.click(screen.getByLabelText(/Make 2s count against them · 5 Edge/));
    await user.click(screen.getByRole("button", { name: /Roll with the app/ }));
    expect(send).toHaveBeenCalledWith({ type: "roll.app", requestId: "r1", edge: "widen_glitch" });
  });

  it("does not offer the widener without an opposition", () => {
    card(base);
    expect(screen.queryByLabelText(/Make 2s count/)).toBeNull();
  });

  it("holds the roll to decide after seeing the dice", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Decide on Edge after seeing the dice/));
    await user.click(screen.getByRole("button", { name: /Roll with the app/ }));
    expect(send).toHaveBeenCalledWith({ type: "roll.app", requestId: "r1", hold: true });
  });

  it("will not hold a roll that has Edge spent before it, nor the reverse", async () => {
    const { send, user } = card(base);
    await user.click(screen.getByLabelText(/Decide on Edge after seeing the dice/));
    await user.click(screen.getByLabelText(/Edge dice · 4 Edge/));
    expect((screen.getByLabelText(/Decide on Edge after seeing the dice/) as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Roll with the app/ }));
    expect(send.mock.calls[0]![0]).not.toHaveProperty("hold");
  });

  it("says why an option cannot be chosen: too little Edge, or already spent this round", () => {
    card(base, edge3);
    expect((screen.getByLabelText(/Edge dice · 4 Edge/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Needs 4 Edge; 3 on hand.")).toBeTruthy();
  });

  it("takes every Edge option away from a roll with a declared Edge Action the player can pay for", () => {
    card({ ...base, edgeAction: { id: "bring_the_drama", name: "Bring the Drama", cost: 2, summary: "s" } });
    expect((screen.getByLabelText(/Edge dice · 4 Edge/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Decide on Edge after seeing the dice/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(/Bring the Drama is declared and is this round's one expenditure of Edge\./).length).toBeGreaterThan(0);
  });

  it("leaves the Edge open when the player cannot pay for the declared action", () => {
    card({ ...base, edgeAction: { id: "called_shot_vitals", name: "Called Shot: Vitals", cost: 5, summary: "s" } }, { ...rich, points: 4, rank: 3 });
    expect((screen.getByLabelText(/Edge dice · 4 Edge/) as HTMLInputElement).disabled).toBe(false);
  });
});
