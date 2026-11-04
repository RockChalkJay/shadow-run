import type { CharacterSheet, CharacterView, CombatState } from "@shadow-run/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FightPanel, NpcPanel, PartyPanel } from "./Rail";

const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };
const view = (over: Partial<CharacterView> & { id: string; name: string }): CharacterView => ({ kind: "pc", monitor, status: "active", woundModifier: 0, ...over });
const sheet = (id: string, name: string, metatype = "human") => ({ id, name, metatype }) as CharacterSheet;
const party = [sheet("kira", "Kira"), sheet("doc", "Doc", "elf")];

describe("the party", () => {
  it("shows each character's tracks and how full they are", () => {
    render(<PartyPanel party={party} characters={[view({ id: "kira", name: "Kira", monitor: { ...monitor, physical: 4, stun: 2 } }), view({ id: "doc", name: "Doc" })]} speaking="kira" />);
    expect(screen.getAllByLabelText("Physical 4 of 11")).toHaveLength(1);
    expect(screen.getByLabelText("Stun 2 of 10")).toBeTruthy();
    expect(screen.getByLabelText("Physical 0 of 11")).toBeTruthy();
    expect(screen.queryByLabelText(/Overflow/)).toBeNull();
    expect(screen.getByText("elf")).toBeTruthy();
  });

  it("shows overflow only once there is some, and the wound penalty", () => {
    render(<PartyPanel party={party} characters={[view({ id: "kira", name: "Kira", status: "unconscious", woundModifier: 3, monitor: { ...monitor, physical: 11, overflow: 2 } })]} speaking={undefined} />);
    expect(screen.getByLabelText("Overflow 2 of 10")).toBeTruthy();
    expect(screen.getByText(/−3 dice on every roll but resisting damage/)).toBeTruthy();
    expect(screen.getByText(/UNCONSCIOUS/)).toBeTruthy();
  });

  it("marks the dead and the character who is speaking", () => {
    const { container } = render(<PartyPanel party={party} characters={[view({ id: "kira", name: "Kira", status: "dead" }), view({ id: "doc", name: "Doc" })]} speaking="doc" />);
    expect(screen.getByText("DEAD")).toBeTruthy();
    expect(container.querySelector(".member.speaking")?.textContent).toContain("Doc");
  });
});

describe("non-player characters", () => {
  const ganger = view({ id: "g1", kind: "npc", name: "Ganger", monitor: { ...monitor, physical: 3, stun: 1 } });
  const grunt = view({ id: "g2", kind: "npc", name: "Guard", grunt: { professionalRating: 3, lieutenant: true, lastDamage: "physical" }, monitor: { ...monitor, physicalBoxes: 9, physical: 4 } });

  it("shows nothing when nobody is there", () => {
    const { container } = render(<NpcPanel characters={[view({ id: "kira", name: "Kira" })]} />);
    expect(container.textContent).toBe("");
  });

  it("lists each on one line, opening to their boxes, with a grunt's single track and rating", async () => {
    render(<NpcPanel characters={[ganger, grunt]} />);
    expect(screen.getByText(/grunt · rating 3 · lieutenant/)).toBeTruthy();
    expect(screen.queryByLabelText(/Physical/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Ganger/ }));
    expect(screen.getByLabelText("Physical 3 of 11")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Guard/ }));
    expect(screen.getByLabelText("Damage 4 of 9")).toBeTruthy();
    expect(screen.queryByLabelText("Stun 0 of 10")).toBeNull();
  });

  it("summarizes how hurt each is by the track that is further along", () => {
    render(<NpcPanel characters={[ganger, { ...ganger, id: "g3", name: "Thug", monitor: { ...monitor, physical: 1, stun: 8 } }, grunt]} />);
    expect(screen.getByRole("button", { name: /Ganger/ }).textContent).toContain("physical 3/11");
    expect(screen.getByRole("button", { name: /Thug/ }).textContent).toContain("stun 8/10");
    expect(screen.getByRole("button", { name: /Guard/ }).textContent).toContain("4/9");
  });

  it("says when one is out of it", () => {
    render(<NpcPanel characters={[{ ...ganger, status: "dead" }]} />);
    expect(screen.getByText("DEAD")).toBeTruthy();
  });
});

describe("the fight", () => {
  const entry = (score: number, names: string[], extra: object = {}) => ({ members: names.map((name, i) => ({ kind: "npc" as const, id: `${name}${i}`, name })), score, reaction: 1, intuition: 1, dice: 1, rolls: [1], edge: 0, coin: 0.5, major: 1, minor: 1, ...extra });
  const combat = { round: 2, order: [entry(14, ["Kira"], { members: [{ kind: "pc", id: "kira", name: "Kira" }] }), entry(11, ["Guard A", "Guard B"], { group: "guards" }), entry(9, ["Ganger"], { bonus: 3 })] } as CombatState;

  it("shows nothing outside a fight", () => {
    const { container } = render(<FightPanel combat={null} characters={[]} />);
    expect(container.textContent).toBe("");
  });

  it("shows the round and the order, with groups and Edge-bought bonuses", () => {
    render(<FightPanel combat={combat} characters={[]} />);
    expect(screen.getByText("FIGHT · ROUND 2")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["14Kira", "11Guard A, Guard B (acting together)", "9Ganger (+3 next round)"]);
  });

  it("strikes out those who are down", () => {
    const down = [view({ id: "Ganger0", kind: "npc", name: "Ganger", status: "unconscious" })];
    const { container } = render(<FightPanel combat={combat} characters={down} />);
    expect(container.querySelectorAll("li.down")).toHaveLength(1);
    expect(container.querySelector("li.down")?.textContent).toContain("Ganger");
  });
});
