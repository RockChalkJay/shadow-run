import type { ServerEvent } from "@shadow-run/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  /** False models a table that is down: the socket never opens. */
  static autoOpen = true;
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    if (FakeSocket.autoOpen) queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
  push(event: ServerEvent) { act(() => this.onmessage?.({ data: JSON.stringify(event) })); }
}

const sheet = (id: string, name: string) => ({ id, name, metatype: "human" }) as never;
const snapshot = (over: object = {}): ServerEvent => ({ type: "snapshot", party: [sheet("kira", "Kira"), sheet("doc", "Doc")], characters: [], pendingRolls: [], edge: [{ id: "kira", points: 3, rank: 3, spentThisRound: false }], combat: null, transcript: [], gm: { phase: "idle" }, usage: null, rules: { hitMinimum: 5, stunOverflowPerPhysical: 1 }, testMode: false, session: { number: 0, phase: "idle" }, ...over }) as ServerEvent;
const socket = () => FakeSocket.all.at(-1)!;

beforeEach(() => {
  FakeSocket.all = [];
  FakeSocket.autoOpen = true;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the table screen", () => {
  it("shows the start screen before anything has happened, and starts the session", async () => {
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot());
    expect(screen.getByText(/Party: Kira \(human\) · Doc \(human\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Begin the session" }));
    expect(socket().sent).toContainEqual({ type: "session.start" });
  });

  it("shows the story, a pending roll, and what the GM is saying as it streams", async () => {
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot({
      transcript: [{ id: 1, ts: "t", kind: "gm", text: "Rain hammers the dock." }, { id: 2, ts: "t", kind: "say", name: "Kira", text: "I duck." }],
      pendingRolls: [{ id: "r1", characterId: "kira", label: "Sneak", pool: { total: 4, breakdown: "x" }, threshold: 2, stakes: "Reach the door.", goodRoll: "g", badRoll: "b", consequences: { success: "s", failure: "f", glitch: "g", criticalGlitch: "c" }, edgeAdvice: "e" }],
      gm: { phase: "waiting_for_rolls" },
    }));
    expect(screen.getByText("Rain hammers the dock.")).toBeTruthy();
    expect(screen.getByText("I duck.")).toBeTruthy();
    expect(screen.getByText("Reach the door.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Waiting on 1 roll before the GM continues");
    socket().push({ type: "roll.cancelled", requestId: "r1" });
    socket().push({ type: "gm.block", turnId: 1 });
    socket().push({ type: "gm.text", turnId: 1, text: "A guard turns" });
    expect(screen.getByText("A guard turns")).toBeTruthy();
  });

  it("offers Roll again on a held roll only when the server says it is in test mode, and asks for it over the connection", async () => {
    const roll = (dice: number[]) => ({ dice, hits: 0, ones: 0, glitch: false, criticalGlitch: false });
    const request = { id: "r1", characterId: "kira", label: "Sneak", pool: { total: 4, breakdown: "x" }, threshold: 2, stakes: "Reach the door.", goodRoll: "g", badRoll: "b", consequences: { success: "s", failure: "f", glitch: "g", criticalGlitch: "c" }, edgeAdvice: "e", held: { source: "physical", roll: roll([1, 2, 3, 4]) } };
    render(<App url="ws://x" />);
    await act(async () => {});
    const begun = { transcript: [{ id: 1, ts: "t", kind: "gm", text: "Rain falls." }], pendingRolls: [request] };
    socket().push(snapshot(begun));
    expect(screen.getByRole("button", { name: "Keep it as it stands" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Roll again/ })).toBeNull();

    socket().push(snapshot({ ...begun, testMode: true }));
    await userEvent.click(screen.getByRole("button", { name: /Roll again/ }));
    expect(socket().sent).toContainEqual({ type: "roll.redo", requestId: "r1" });
  });

  it("has a link at the top that jumps to the typing box", async () => {
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot({ transcript: [{ id: 1, ts: "t", kind: "gm", text: "Hi" }] }));
    await userEvent.click(screen.getByRole("link", { name: "Skip to the typing box" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Say or do something"));
  });

  it("sends what a player says, as the character they chose", async () => {
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot({ transcript: [{ id: 1, ts: "t", kind: "gm", text: "Hi" }] }));
    await userEvent.selectOptions(screen.getByLabelText("Speaking as"), "doc");
    await userEvent.type(screen.getByLabelText("Say or do something"), "I check the door");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(socket().sent).toContainEqual({ type: "player.say", characterId: "doc", text: "I check the door" });
  });

  it("offers Stop while the GM thinks and Retry when its turn failed", async () => {
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot({ transcript: [{ id: 1, ts: "t", kind: "gm", text: "Hi" }], gm: { phase: "thinking", turnId: 1 } }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(socket().sent).toContainEqual({ type: "turn.cancel" });
    socket().push({ type: "gm.status", status: { phase: "error", message: "its turn timed out" } });
    expect(screen.getByRole("alert").textContent).toContain("its turn timed out");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(socket().sent).toContainEqual({ type: "turn.retry" });
  });

  it("says when the table is lost, and reconnects", async () => {
    vi.useFakeTimers();
    render(<App url="ws://x" />);
    await act(async () => {});
    socket().push(snapshot({ transcript: [{ id: 1, ts: "t", kind: "gm", text: "Hi" }] }));
    FakeSocket.autoOpen = false;
    act(() => socket().close());
    expect(screen.getByRole("status").textContent).toContain("Lost the table. Reconnecting… (attempt 1)");
    expect(screen.getByRole("status").textContent).not.toContain("npm run dev:server");
    await act(async () => void vi.advanceTimersByTime(600));
    expect(FakeSocket.all).toHaveLength(2);
    act(() => socket().close());
    expect(screen.getByRole("status").textContent).toContain("(attempt 2) Is npm run dev:server running?");
    vi.useRealTimers();
  });

  describe("sessions", () => {
    const say = { id: 1, ts: "t", kind: "say", name: "Kira", text: "I wait." };
    const open = async (over: object = {}) => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot({ transcript: [say], session: { number: 2, phase: "open" }, ...over }));
    };

    it("starts the first session with the mission typed on the start screen, and with none when it is left empty", async () => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot());
      await userEvent.type(screen.getByLabelText(/What should session 1 be about/), "  Meet Mr. Smith.  ");
      await userEvent.click(screen.getByRole("button", { name: "Begin the session" }));
      expect(socket().sent).toEqual([{ type: "session.start", mission: "Meet Mr. Smith." }]);
    });

    it("wraps a session up through the pill and the question, and shows the wrap-up while it happens", async () => {
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Session 2" }));
      expect(screen.getByRole("dialog", { name: "WRAP UP SESSION 2?" })).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Wrap up" }));
      expect(socket().sent).toEqual([{ type: "session.wrapup" }]);
      socket().push({ type: "session.updated", session: { number: 2, phase: "wrapping" } });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText("Session 2 · wrapping up…")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain("Wrapping up session 2. The GM is closing the scene and writing it up.");
      const box = screen.getByLabelText("Say or do something") as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.placeholder).toBe("The GM is wrapping up the session…");
      expect((screen.getByLabelText("Speaking as") as HTMLSelectElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    });

    it("does not open the question while rolls are waiting, and says why", async () => {
      await open({
        pendingRolls: [{ id: "r1", characterId: "kira", label: "Sneak", pool: { total: 4, breakdown: "x" }, threshold: 2, stakes: "s", goodRoll: "g", badRoll: "b", consequences: { success: "s", failure: "f", glitch: "g", criticalGlitch: "c" }, edgeAdvice: "e" }],
        gm: { phase: "waiting_for_rolls" },
      });
      const pill = screen.getByRole("button", { name: "Session 2" });
      expect(pill.getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(pill);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.getElementById(pill.getAttribute("aria-describedby")!)?.textContent).toBe("Answer or skip the waiting rolls first.");
    });

    it("shows the server's refusal in the question and keeps it open", async () => {
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Session 2" }));
      await userEvent.click(screen.getByRole("button", { name: "Wrap up" }));
      socket().push({ type: "error", message: "The GM is in the middle of a turn." });
      expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("The GM is in the middle of a turn.");
    });

    it("puts focus back on the pill when the question is dismissed with Escape", async () => {
      await open();
      const pill = screen.getByRole("button", { name: "Session 2" });
      await userEvent.click(pill);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(pill);
    });

    it("does not reopen the question when the next session opens", async () => {
      await open();
      await userEvent.click(screen.getByRole("button", { name: "Session 2" }));
      socket().push({ type: "session.updated", session: { number: 2, phase: "ended" } });
      socket().push({ type: "session.updated", session: { number: 3, phase: "open" } });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows the session-over card, closes the typing box, and begins the next session with a mission", async () => {
      const marker = { id: 5, ts: "t", kind: "session", event: "end", number: 2, summary: "The case changed hands.", changes: [{ name: "Kira", changes: ["Karma 0 → 4"] }] };
      await open({ transcript: [say, marker], session: { number: 2, phase: "ended" } });
      expect(screen.getByText("Session 2 · over")).toBeTruthy();
      expect(screen.getAllByText("The case changed hands.")).toHaveLength(1);
      expect(screen.getByText("Karma 0 → 4")).toBeTruthy();
      expect((screen.getByLabelText("Say or do something") as HTMLInputElement).placeholder).toBe("The session is over. Begin the next one above.");
      expect((screen.getByLabelText("Say or do something") as HTMLInputElement).disabled).toBe(true);
      await userEvent.type(screen.getByLabelText(/What should session 3 be about/), "Follow Mr. Smith.");
      await userEvent.click(screen.getByRole("button", { name: "Begin session 3" }));
      expect(socket().sent).toEqual([{ type: "session.start", mission: "Follow Mr. Smith." }]);
    });

    it("lets the first session begin with Ctrl+Enter from the mission box", async () => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot());
      await userEvent.type(screen.getByLabelText(/What should session 1 be about/), "Heist{Control>}{Enter}{/Control}");
      expect(socket().sent).toEqual([{ type: "session.start", mission: "Heist" }]);
    });

    it("shows the card only for an ended session, from that session's own end marker, and keeps Send shut even with text waiting in the box", async () => {
      const end = (number: number, summary: string) => ({ id: number, ts: "t", kind: "session", event: "end", number, summary });
      await open({ transcript: [end(1, "First night."), say] });
      expect(screen.queryByRole("region", { name: "Session over" })).toBeNull();
      expect(screen.getByText("First night.")).toBeTruthy();
      await userEvent.type(screen.getByLabelText("Say or do something"), "one more thing");
      socket().push({ type: "snapshot", ...(snapshot({ transcript: [end(1, "First night."), say, end(2, "Second night.")], session: { number: 2, phase: "ended" } }) as object) } as never);
      const card = screen.getByRole("region", { name: "Session over" });
      expect(within(card).getByText("Second night.")).toBeTruthy();
      expect(screen.getByText("First night.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    });

    it("shows the write-up in the story while the session is still wrapping up, before the card is up", async () => {
      const marker = { id: 5, ts: "t", kind: "session", event: "end", number: 2, summary: "The case changed hands." };
      await open({ transcript: [say, marker], session: { number: 2, phase: "wrapping" } });
      expect(screen.getAllByText("The case changed hands.")).toHaveLength(1);
      expect(screen.queryByRole("region", { name: "Session over" })).toBeNull();
    });

    it("does not show an earlier session's write-up on the card of one that has none", async () => {
      await open({ transcript: [{ id: 1, ts: "t", kind: "session", event: "end", number: 1, summary: "First night." }, say], session: { number: 2, phase: "ended" } });
      const card = screen.getByRole("region", { name: "Session over" });
      expect(within(card).queryByText("First night.")).toBeNull();
      expect(within(card).getByRole("button", { name: "Begin session 3" })).toBeTruthy();
    });

    it("marks the pill expanded while the question is open", async () => {
      await open();
      const pill = screen.getByRole("button", { name: "Session 2" });
      expect(pill.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(pill);
      expect(pill.getAttribute("aria-expanded")).toBe("true");
    });

    it("scrolls to the end when the session moves to over", async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        await open();
        scroll.mockClear();
        socket().push({ type: "session.updated", session: { number: 2, phase: "ended" } });
        expect(scroll).toHaveBeenCalled();
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });

    it("keeps the typing box working in an open session", async () => {
      await open();
      await userEvent.type(screen.getByLabelText("Say or do something"), "I look around");
      await userEvent.keyboard("{Enter}");
      expect(socket().sent).toEqual([{ type: "player.say", characterId: "kira", text: "I look around" }]);
    });
  });
});
