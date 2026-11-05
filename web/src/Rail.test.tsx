import type { CharacterSheet, CharacterView, CombatState, EdgeView } from "@shadow-run/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { announcements, OppositionPanel, PartyPanel, Rail, Tip, TurnStrip } from "./Rail";

const monitor = { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 };
const view = (over: Partial<CharacterView> & { id: string; name: string }): CharacterView => ({ kind: "pc", monitor, status: "active", woundModifier: 0, ...over });
const sheet = (id: string, name: string, metatype = "human") => ({ id, name, metatype }) as CharacterSheet;
const party = [sheet("kira", "Kira"), sheet("doc", "Doc", "elf")];
const edge: EdgeView[] = [{ id: "kira", points: 3, rank: 3, spentThisRound: false }, { id: "doc", points: 1, rank: 4, spentThisRound: true }];
const noop = () => {};

describe("a tooltip", () => {
  it("is linked to its chip, and opens on focus and closes on Escape", async () => {
    render(<Tip text="Explains itself">chip</Tip>);
    const chip = screen.getByText("chip", { selector: ".tip" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(chip.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.className).not.toContain("open");
    await userEvent.tab();
    expect(tip.className).toContain("open");
    await userEvent.keyboard("{Escape}");
    expect(tip.className).not.toContain("open");
  });

  it("opens on hover, and on tap, which focuses it", async () => {
    render(<Tip text="Explains itself">chip</Tip>);
    const tip = screen.getByRole("tooltip", { hidden: true });
    await userEvent.hover(screen.getByText("chip", { selector: ".tip" }));
    expect(tip.className).toContain("open");
    await userEvent.unhover(screen.getByText("chip", { selector: ".tip" }));
    expect(tip.className).not.toContain("open");
    await userEvent.click(screen.getByText("chip", { selector: ".tip" }));
    expect(tip.className).toContain("open");
  });
});

describe("the party", () => {
  const render1 = (characters: CharacterView[], speaking = "kira", onSpeak = noop) => render(<PartyPanel party={party} characters={characters} edge={edge} speaking={speaking} onSpeak={onSpeak} />);

  it("shows each character's tracks with their numbers, and their Edge", () => {
    render1([view({ id: "kira", name: "Kira", monitor: { ...monitor, physical: 4, stun: 2 } }), view({ id: "doc", name: "Doc" })]);
    expect(screen.getByLabelText("Physical 4 of 11")).toBeTruthy();
    expect(screen.getByLabelText("Stun 2 of 10")).toBeTruthy();
    expect(screen.getByText("4/11")).toBeTruthy();
    expect(screen.queryByLabelText(/Overflow/)).toBeNull();
    expect(screen.getByText(/Edge 3/)).toBeTruthy();
    expect(screen.getByText("elf")).toBeTruthy();
  });

  it("explains every chip: the status, a wound penalty and the Edge", () => {
    render1([view({ id: "kira", name: "Kira", status: "unconscious", woundModifier: 2 }), view({ id: "doc", name: "Doc" })]);
    const tips = screen.getAllByRole("tooltip", { hidden: true }).map((t) => t.textContent);
    expect(tips).toContain("Unconscious: out of the action until healed.");
    expect(tips).toContain("Wounds cost 2 dice on every roll except resisting damage.");
    expect(tips).toContain("3 Edge points on hand; Edge rank 3, which a session starts with.");
    expect(tips).toContain("1 Edge point on hand; Edge rank 4, which a session starts with. Edge is already spent this round.");
    expect(tips.some((t) => t?.startsWith("Physical damage."))).toBe(true);
  });

  it("shows overflow only once there is some, and no wound chip without a penalty", () => {
    render1([view({ id: "kira", name: "Kira", status: "unconscious", monitor: { ...monitor, physical: 11, overflow: 2 } })]);
    expect(screen.getByLabelText("Overflow 2 of 10")).toBeTruthy();
    expect(screen.queryByText(/−\d dice?/)).toBeNull();
  });

  it("speaks as the character whose name is clicked, and marks who is speaking", async () => {
    const onSpeak = vi.fn();
    render1([view({ id: "kira", name: "Kira" }), view({ id: "doc", name: "Doc" })], "doc", onSpeak);
    expect(screen.getByRole("button", { name: "Doc" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Kira" }).getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(screen.getByRole("button", { name: "Kira" }));
    expect(onSpeak).toHaveBeenCalledWith("kira");
  });
});

describe("the acting order", () => {
  const entry = (score: number, members: { kind: "pc" | "npc"; id: string; name: string }[], extra: object = {}) => ({ members, score, reaction: 1, intuition: 1, dice: 1, rolls: [1], edge: 0, coin: 0.5, major: 1, minor: 1, ...extra });
  const combat = {
    round: 2,
    order: [
      entry(14, [{ kind: "pc", id: "kira", name: "Kira" }]),
      entry(11, [{ kind: "npc", id: "g1", name: "Guard A" }, { kind: "npc", id: "g2", name: "Guard B" }], { group: "guards" }),
      entry(9, [{ kind: "npc", id: "ganger", name: "Ganger" }], { bonus: 3 }),
    ],
  } as CombatState;

  it("shows the round and each side's place, with no initiative score on the row", () => {
    render(<TurnStrip combat={combat} characters={[]} />);
    expect(screen.getByText("ROUND 2")).toBeTruthy();
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent?.replace(/Acts .*?each round\. .*?Intuition\./, "").trim());
    expect(rows).toEqual(["1Kira", "2Guard A, Guard Bact together", "3Ganger+3 initiative from next round"]);
    expect(screen.queryByText("14")).toBeNull();
  });

  it("keeps the initiative score and the tie rule in the tooltip on the place", () => {
    render(<TurnStrip combat={combat} characters={[]} />);
    const tips = screen.getAllByRole("tooltip", { hidden: true }).map((t) => t.textContent);
    expect(tips[0]).toBe("Acts 1st each round. Initiative 14: Reaction + Intuition + dice; ties go to Edge, then Reaction, then Intuition.");
    expect(tips[2]).toContain("Acts 3rd each round. Initiative 9");
  });

  it("strikes out and labels a side that is all down", () => {
    const { container } = render(<TurnStrip combat={combat} characters={[view({ id: "ganger", kind: "npc", name: "Ganger", status: "unconscious" })]} />);
    expect(container.querySelectorAll("li.out")).toHaveLength(1);
    expect(container.querySelector("li.out")?.textContent).toContain("out of the fight");
  });
});

describe("the opposition", () => {
  const m = { ...monitor, physicalBoxes: 9 };
  const grunt = (id: string, name: string, physical: number, status: CharacterView["status"] = "active") =>
    view({ id, kind: "npc", name, status, monitor: { ...m, physical }, grunt: { professionalRating: 3, lieutenant: false, lastDamage: "physical" } });
  const ganger = view({ id: "ganger", kind: "npc", name: "Ganger", monitor: { ...monitor, physical: 3 } });
  const order = (extra: object) => ({ round: 1, order: [{ members: [{ kind: "npc", id: "g1", name: "Guard A" }, { kind: "npc", id: "g2", name: "Guard B" }, { kind: "npc", id: "g3", name: "Guard C" }], group: "Guards", score: 11, reaction: 1, intuition: 1, dice: 1, rolls: [1], edge: 0, coin: 0.5, major: 1, minor: 1, ...extra }] }) as CombatState;
  const grunts = [grunt("g1", "Guard A", 9, "unconscious"), grunt("g2", "Guard B", 2), grunt("g3", "Guard C", 0)];

  it("shows nothing when nobody is there", () => {
    const { container } = render(<OppositionPanel characters={[view({ id: "kira", name: "Kira" })]} combat={null} />);
    expect(container.textContent).toBe("");
  });

  it("collapses a group of grunts into one row with how many there are and how many are down", () => {
    render(<OppositionPanel characters={grunts} combat={order({})} />);
    const summary = screen.getByText("Guards").closest("summary")!;
    expect(summary.textContent).toContain("grunts · rating 3");
    expect(summary.textContent).toContain("×3 · 1 down");
    const details = summary.parentElement!;
    expect(within(details).getByText("Guard A").closest(".mem")?.className).toContain("out");
    expect(within(details).getAllByLabelText(/Damage \d of 9/)).toHaveLength(3);
  });

  it("shows a named character as a card with their tracks, and a grunt on their own with their rating", () => {
    render(<OppositionPanel characters={[ganger, grunt("g9", "Thug", 4)]} combat={null} />);
    expect(screen.getByLabelText("Physical 3 of 11")).toBeTruthy();
    expect(screen.getByText(/grunt · rating 3/)).toBeTruthy();
    expect(screen.getByLabelText("Damage 4 of 9")).toBeTruthy();
  });

  it("shows a dead one as a name and a chip, without tracks", () => {
    render(<OppositionPanel characters={[{ ...ganger, status: "dead" }]} combat={null} />);
    expect(screen.getByText("DEAD")).toBeTruthy();
    expect(screen.queryByLabelText(/Physical/)).toBeNull();
  });
});

describe("what a screen reader is told", () => {
  const kira = view({ id: "kira", name: "Kira" });
  it("says who got hurt, and who went down or died", () => {
    expect(announcements([kira], [{ ...kira, monitor: { ...monitor, physical: 4 } }])).toEqual(["Kira is hurt: physical 4 of 11, stun 0 of 10."]);
    expect(announcements([kira], [{ ...kira, status: "unconscious" }])).toEqual(["Kira is down."]);
    expect(announcements([kira], [{ ...kira, status: "dead" }])).toEqual(["Kira is dead."]);
    expect(announcements([{ ...kira, status: "unconscious" }], [kira])).toEqual(["Kira is back on their feet."]);
  });

  it("says nothing when nothing got worse, and nothing about someone new", () => {
    expect(announcements([{ ...kira, monitor: { ...monitor, physical: 4 } }], [kira])).toEqual([]);
    expect(announcements([], [kira])).toEqual([]);
  });

  it("announces a change in a polite live region once the table is showing", () => {
    const props = { party, edge, combat: null, speaking: "kira", onSpeak: noop };
    const { rerender } = render(<Rail {...props} characters={[kira]} />);
    const live = () => document.querySelector("[aria-live]")!;
    expect(live().textContent).toBe("");
    rerender(<Rail {...props} characters={[{ ...kira, monitor: { ...monitor, physical: 5 } }]} />);
    expect(live().textContent).toContain("Kira is hurt: physical 5 of 11");
    expect(live().getAttribute("aria-live")).toBe("polite");
  });
});
