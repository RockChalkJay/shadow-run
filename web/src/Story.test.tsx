import type { TranscriptEntry } from "@shadow-run/shared";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUMBLE_MS } from "./Dice";
import { Story } from "./Story";

const request = { id: "r1", characterId: "kira", label: "Sneak past the guard", pool: { total: 4, breakdown: "x" } } as never;
const entry = (source: "app" | "smackdown"): TranscriptEntry => ({
  id: 3,
  ts: "t",
  kind: "roll",
  resolved: {
    request,
    source,
    roll: { dice: source === "app" ? [6, 5, 3, 1] : [], hits: source === "app" ? 2 : 6, ones: 1, glitch: false, criticalGlitch: false },
    opposed: { by: "Guard", pool: 2, role: "acting", roll: { dice: [5, 1], hits: 1, ones: 1, glitch: false, criticalGlitch: false } },
    outcome: { success: true, netHits: 1, glitch: false, criticalGlitch: false, consequence: "Kira slips through." },
    ...(source === "smackdown" && { burn: { kind: "smackdown", lost: 3, rank: 2 } }),
  },
} as TranscriptEntry);
const nameOf = () => "Kira";

afterEach(() => vi.useRealTimers());

describe("a finished roll in the story", () => {
  it("is one line until opened", async () => {
    render(<Story transcript={[entry("app")]} streaming={[]} fresh={[]} nameOf={nameOf} />);
    expect(screen.getByText(/Kira · Sneak past the guard · 2 hits vs 1 · SUCCESS/)).toBeTruthy();
    expect(screen.queryByLabelText(/dice 6 5 3 1/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /show dice/ }));
    expect(screen.getByLabelText("dice 6 5 3 1")).toBeTruthy();
    expect(screen.getByText(/Kira slips through\./)).toBeTruthy();
  });

  it("opens by itself when it has just arrived, tumbles, then shows the faces", () => {
    vi.useFakeTimers();
    render(<Story transcript={[entry("app")]} streaming={[]} fresh={[3]} nameOf={nameOf} />);
    expect(screen.getAllByLabelText("rolling").length).toBeGreaterThan(0);
    act(() => void vi.advanceTimersByTime(TUMBLE_MS + 10));
    expect(screen.getByLabelText("dice 6 5 3 1")).toBeTruthy();
    expect(screen.getByText(/SUCCESS by 1 net hit/)).toBeTruthy();
  });

  it("says a Smackdown had no dice", () => {
    render(<Story transcript={[entry("smackdown")]} streaming={[]} fresh={[3]} nameOf={nameOf} />);
    expect(screen.getByText(/No dice: Kira burned Edge for Smackdown/)).toBeTruthy();
    expect(screen.queryByLabelText("rolling")).toBeNull();
  });

  it("shows where a session begins, with its mission, and where it ends", () => {
    const marker = (id: number, event: "start" | "end", mission?: string): TranscriptEntry => ({ id, ts: "t", kind: "session", event, number: 2, ...(mission && { mission }) });
    render(<Story transcript={[marker(1, "start", "Steal the courier."), marker(2, "end")]} streaming={[]} fresh={[]} nameOf={(id) => id} />);
    expect(screen.getByText("Session 2 begins: Steal the courier.")).toBeTruthy();
    expect(screen.getByText("Session 2 is over")).toBeTruthy();
  });

  it("shows narration as it streams", () => {
    render(<Story transcript={[]} streaming={["Rain falls.", "A door"]} fresh={[]} nameOf={nameOf} />);
    expect(screen.getByText("Rain falls.")).toBeTruthy();
    expect(screen.getByText("A door")).toBeTruthy();
  });
});
