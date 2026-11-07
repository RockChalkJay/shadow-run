import type { CharacterSheet, CharacterView, ClientMessage, CombatState, EdgeView, RollRequest } from "@shadow-run/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { cannotUse } from "./EdgeMenu";
import { Rail } from "./Rail";

const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };
const view = (id: string, name: string, over: Partial<CharacterView> = {}): CharacterView => ({ id, kind: "pc", name, monitor, status: "active", woundModifier: 0, ...over });
const sheet = (id: string, name: string) => ({ id, name, metatype: "human" }) as CharacterSheet;
const party = [sheet("kira", "Kira"), sheet("doc", "Doc")];
const rich: EdgeView[] = [{ id: "kira", points: 5, rank: 3, spentThisRound: false }, { id: "doc", points: 4, rank: 4, spentThisRound: false }];
const fight = { round: 1, order: [{ members: [{ kind: "pc", id: "kira", name: "Kira" }, ], score: 12, reaction: 1, intuition: 1, dice: 1, rolls: [1], edge: 0, coin: 0.5, major: 1, minor: 1 }] } as CombatState;

function show(over: { characters?: CharacterView[]; edge?: EdgeView[]; combat?: CombatState | null; pending?: RollRequest[]; error?: string | null } = {}) {
  const send = vi.fn<(m: ClientMessage) => void>();
  const props = { party, characters: [view("kira", "Kira"), view("doc", "Doc")], edge: rich, combat: null, speaking: "kira", onSpeak: () => {}, send, pending: [] as RollRequest[], error: null, ...over };
  const result = render(<Rail {...props} />);
  return { send, user: userEvent.setup(), rerender: (next: typeof over) => result.rerender(<Rail {...props} {...next} />) };
}
/** Opens Kira's Edge menu, the first on the panel. */
const open = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getAllByRole("button", { name: /Spend Edge/ })[0]!);
const rowOf = (text: RegExp) => screen.getByText(text).closest(".use") as HTMLElement;

describe("the Edge menu on a party card", () => {
  it("starts closed, and lists the five uses with their costs when opened", async () => {
    const { user } = show();
    expect(screen.queryByText(/Give an ally 1 Edge/)).toBeNull();
    await open(user);
    for (const t of [/Give an ally 1 Edge · 2 Edge/, /Clear a box of stun damage · 3 Edge/, /Clear a box of physical damage · 4 Edge/, /Add 3 to initiative from the next round · 1 Edge/, /Create a special effect · 5 Edge/]) expect(screen.getByText(t)).toBeTruthy();
  });

  it("clears a box of stun, and says there is nothing to clear when there is none", async () => {
    const hurt = [view("kira", "Kira", { monitor: { ...monitor, stun: 3 } }), view("doc", "Doc")];
    const { send, user } = show({ characters: hurt });
    await open(user);
    expect(within(rowOf(/Clear a box of physical/)).getByText("No physical damage to heal.")).toBeTruthy();
    expect((within(rowOf(/Clear a box of physical/)).getByRole("button", { name: "Spend" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(rowOf(/Clear a box of stun/)).getByRole("button", { name: "Spend" }));
    expect(send).toHaveBeenCalledWith({ type: "edge.use", characterId: "kira", use: "heal_stun" });
  });

  it("clears a box of physical damage at 4 Edge", async () => {
    const { send, user } = show({ characters: [view("kira", "Kira", { monitor: { ...monitor, physical: 2 } }), view("doc", "Doc")] });
    await open(user);
    await user.click(within(rowOf(/Clear a box of physical/)).getByRole("button", { name: "Spend" }));
    expect(send).toHaveBeenCalledWith({ type: "edge.use", characterId: "kira", use: "heal_physical" });
  });

  it("gives an ally Edge only in a fight, to the ally chosen", async () => {
    const out = show();
    await open(out.user);
    expect(within(rowOf(/Give an ally/)).getByText("Edge is gained only in a fight, so it can be given only in one.")).toBeTruthy();
    expect((within(rowOf(/Give an ally/)).getByRole("button", { name: "Spend" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives the Edge to the ally picked when a fight is on", async () => {
    const { send, user } = show({ combat: fight });
    await open(user);
    expect((screen.getByLabelText("Give Edge to") as HTMLSelectElement).value).toBe("doc");
    await user.click(within(rowOf(/Give an ally/)).getByRole("button", { name: "Spend" }));
    expect(send).toHaveBeenCalledWith({ type: "edge.use", characterId: "kira", use: "give_ally", allyId: "doc" });
  });

  it("offers no ally who is not on their feet", async () => {
    const { user } = show({ combat: fight, characters: [view("kira", "Kira"), view("doc", "Doc", { status: "unconscious" })] });
    await open(user);
    expect(within(rowOf(/Give an ally/)).getByText("No one else who is on their feet can gain Edge.")).toBeTruthy();
  });

  it("adds 3 to initiative only for someone in the fight", async () => {
    const { send, user } = show({ combat: fight });
    await open(user);
    await user.click(within(rowOf(/Add 3 to initiative/)).getByRole("button", { name: "Spend" }));
    expect(send).toHaveBeenCalledWith({ type: "edge.use", characterId: "kira", use: "initiative" });
  });

  it("says there is no initiative to raise out of a fight, or when the character is not in it", async () => {
    const out = show();
    await open(out.user);
    expect(within(rowOf(/Add 3 to initiative/)).getByText("Not in a fight.")).toBeTruthy();
  });

  it("will not create a special effect until it is described, then sends the description", async () => {
    const { send, user } = show();
    await open(user);
    const spend = () => within(rowOf(/Create a special effect/)).getByRole("button", { name: "Spend" }) as HTMLButtonElement;
    expect(spend().disabled).toBe(true);
    expect(within(rowOf(/Create a special effect/)).getByText("Describe it first, in at least 5 characters.")).toBeTruthy();
    await user.type(screen.getByLabelText("Describe the special effect"), "  A fire alarm goes off ");
    expect(spend().disabled).toBe(false);
    await user.click(spend());
    expect(send).toHaveBeenCalledWith({ type: "edge.use", characterId: "kira", use: "special_effect", description: "A fire alarm goes off" });
  });

  it("disables what costs more than the character has, and everything once Edge is spent this round", async () => {
    const poor = show({ edge: [{ id: "kira", points: 2, rank: 3, spentThisRound: false }, rich[1]!], characters: [view("kira", "Kira", { monitor: { ...monitor, stun: 1, physical: 1 } }), view("doc", "Doc")] });
    await open(poor.user);
    expect(within(rowOf(/Clear a box of stun/)).getByText("Needs 3 Edge; 2 on hand.")).toBeTruthy();
  });

  it("says Edge is already spent this round, and shows it on the card", async () => {
    const out = show({ edge: [{ id: "kira", points: 5, rank: 3, spentThisRound: true }, rich[1]!], characters: [view("kira", "Kira", { monitor: { ...monitor, stun: 1 } }), view("doc", "Doc")] });
    expect(screen.getByText("spent this round")).toBeTruthy();
    await open(out.user);
    expect(within(rowOf(/Clear a box of stun/)).getByText("Edge is already spent this round: only one expenditure a round.")).toBeTruthy();
  });

  it("offers nothing to a dead character", async () => {
    const out = show({ characters: [view("kira", "Kira", { status: "dead", monitor: { ...monitor, stun: 2 } }), view("doc", "Doc")] });
    await open(out.user);
    expect(within(rowOf(/Clear a box of stun/)).getByText("Dead.")).toBeTruthy();
  });

  it("warns that spending Edge makes a declared Edge Action on a waiting roll fail", async () => {
    const roll = { id: "r1", characterId: "kira", label: "Con", edgeAction: { id: "bring_the_drama", name: "Bring the Drama", cost: 2, summary: "s" } } as RollRequest;
    const { user } = show({ pending: [roll] });
    await open(user);
    expect(screen.getByText(/Bring the Drama is declared on a roll that is waiting, and uses this round's Edge\. Spending Edge here makes it fail\./)).toBeTruthy();
  });

  it("does not warn when the action cannot be paid for anyway, or for someone else's roll", async () => {
    const dear = { id: "r1", characterId: "kira", label: "Shot", edgeAction: { id: "called_shot_vitals", name: "Called Shot: Vitals", cost: 6, summary: "s" } } as RollRequest;
    const theirs = { id: "r2", characterId: "doc", label: "Con", edgeAction: { id: "bring_the_drama", name: "Bring the Drama", cost: 2, summary: "s" } } as RollRequest;
    const { user } = show({ pending: [dear, theirs] });
    await open(user);
    expect(screen.queryByText(/is declared on a roll that is waiting/)).toBeNull();
  });

  it("shows what the server refused, but only in the menu that sent the request", async () => {
    const { user, rerender } = show({ characters: [view("kira", "Kira", { monitor: { ...monitor, stun: 1 } }), view("doc", "Doc")] });
    await open(user);
    await user.click(within(rowOf(/Clear a box of stun/)).getByRole("button", { name: "Spend" }));
    rerender({ error: "Kira has already spent Edge this round." });
    expect(screen.getByRole("alert").textContent).toBe("Kira has already spent Edge this round.");
    await user.click(screen.getAllByRole("button", { name: /Spend Edge/ })[1]!);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("closes itself once the Edge was spent", async () => {
    const hurt = [view("kira", "Kira", { monitor: { ...monitor, stun: 1 } }), view("doc", "Doc")];
    const { user, rerender } = show({ characters: hurt });
    await open(user);
    expect(screen.getByText(/Clear a box of stun/)).toBeTruthy();
    rerender({ edge: [{ id: "kira", points: 2, rank: 3, spentThisRound: true }, rich[1]!] });
    expect(screen.queryByText(/Clear a box of stun/)).toBeNull();
  });
});

describe("whether a use can be made", () => {
  const who = (over: object = {}) => ({ view: view("kira", "Kira"), edge: rich[0]!, combat: null as CombatState | null, id: "kira", allies: 1, ...over });
  it("needs enough Edge, an unspent round, and the thing to be there", () => {
    expect(cannotUse("heal_stun", who({ view: view("kira", "Kira", { monitor: { ...monitor, stun: 1 } }) }))).toBeNull();
    expect(cannotUse("heal_stun", who())).toBe("No stun damage to heal.");
    expect(cannotUse("initiative", who({ combat: fight }))).toBeNull();
    expect(cannotUse("initiative", who({ combat: { ...fight, order: [] } }))).toBe("Not in this fight.");
  });
});
