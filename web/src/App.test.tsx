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
    const saved = (number: number, summary: string) => ({ id: 10 + number, ts: "t", kind: "session", event: "end", number, summary });
    const open = async (over: object = {}) => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot({ transcript: [say], session: { number: 2, phase: "open" }, ...over }));
    };
    const savePill = () => screen.getByRole("button", { name: "Save progress" });

    it("starts the first session with the mission typed on the start screen, and with none when it is left empty", async () => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot());
      await userEvent.type(screen.getByLabelText(/What should this first session be about/), "  Meet Mr. Smith.  ");
      await userEvent.click(screen.getByRole("button", { name: "Begin the session" }));
      expect(socket().sent).toEqual([{ type: "session.start", mission: "Meet Mr. Smith." }]);
    });

    it("lets the first session begin with Ctrl+Enter from the mission box", async () => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot());
      await userEvent.type(screen.getByLabelText(/What should this first session be about/), "Heist{Control>}{Enter}{/Control}");
      expect(socket().sent).toEqual([{ type: "session.start", mission: "Heist" }]);
    });

    it("saves progress through the pill and the question, and shows the saving while it happens", async () => {
      await open();
      await userEvent.click(savePill());
      expect(screen.getByRole("dialog", { name: "SAVE PROGRESS?" })).toBeTruthy();
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save progress" }));
      expect(socket().sent).toEqual([{ type: "session.wrapup" }]);
      socket().push({ type: "session.updated", session: { number: 2, phase: "wrapping" } });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByText("Saving…")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain("Saving your progress. The GM is writing the story so far into the campaign log.");
      const box = screen.getByLabelText("Say or do something") as HTMLInputElement;
      expect(box.disabled).toBe(true);
      expect(box.placeholder).toBe("The GM is saving the story so far…");
      expect((screen.getByLabelText("Speaking as") as HTMLSelectElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    });

    it("does not open the question while rolls are waiting, and says why", async () => {
      await open({
        pendingRolls: [{ id: "r1", characterId: "kira", label: "Sneak", pool: { total: 4, breakdown: "x" }, threshold: 2, stakes: "s", goodRoll: "g", badRoll: "b", consequences: { success: "s", failure: "f", glitch: "g", criticalGlitch: "c" }, edgeAdvice: "e" }],
        gm: { phase: "waiting_for_rolls" },
      });
      const pill = savePill();
      expect(pill.getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(pill);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.getElementById(pill.getAttribute("aria-describedby")!)?.textContent).toBe("Answer or skip the waiting rolls first.");
    });

    it("shows the server's refusal in the question and keeps it open", async () => {
      await open();
      await userEvent.click(savePill());
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save progress" }));
      socket().push({ type: "error", message: "The GM is in the middle of a turn." });
      expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toBe("The GM is in the middle of a turn.");
    });

    it("puts focus back on the pill when the question is dismissed with Escape, and marks the pill while it is open", async () => {
      await open();
      const pill = savePill();
      expect(pill.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(pill);
      expect(pill.getAttribute("aria-expanded")).toBe("true");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(pill);
    });

    it("does not reopen the question when the story carries on into the next session", async () => {
      await open();
      await userEvent.click(savePill());
      socket().push({ type: "session.updated", session: { number: 2, phase: "ended" } });
      socket().push({ type: "session.updated", session: { number: 3, phase: "open" } });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows the saved note after a save, keeps the typing box open, and sends the note with the next words only", async () => {
      await open({ transcript: [say, { ...saved(2, "The case changed hands."), changes: [{ name: "Kira", changes: ["Karma 0 → 4"] }] }], session: { number: 2, phase: "ended" } });
      expect(screen.getByText("Saved")).toBeTruthy();
      expect(screen.getAllByText("The case changed hands.")).toHaveLength(1);
      expect(screen.getByText("Karma 0 → 4")).toBeTruthy();
      const box = screen.getByLabelText("Say or do something") as HTMLInputElement;
      expect(box.disabled).toBe(false);
      expect(box.placeholder).toBe("Pick up where you left off…");
      await userEvent.type(screen.getByLabelText(/What should the story pick up with/), "  Follow Mr. Smith.  ");
      await userEvent.type(box, "I order noodles.{Enter}");
      expect(socket().sent).toEqual([{ type: "player.say", characterId: "kira", text: "I order noodles.", mission: "Follow Mr. Smith." }]);
      socket().push({ type: "session.updated", session: { number: 3, phase: "open" } });
      await userEvent.type(box, "Then I wait.{Enter}");
      expect(socket().sent.at(-1)).toEqual({ type: "player.say", characterId: "kira", text: "Then I wait." });
    });

    it("sends no mission when the note is empty or blank, and forgets one left over from the start screen", async () => {
      render(<App url="ws://x" />);
      await act(async () => {});
      socket().push(snapshot());
      await userEvent.type(screen.getByLabelText(/What should this first session be about/), "Heist");
      await userEvent.click(screen.getByRole("button", { name: "Begin the session" }));
      socket().push(snapshot({ transcript: [say, saved(1, "Done.")], session: { number: 1, phase: "ended" } }));
      expect((screen.getByLabelText(/What should the story pick up with/) as HTMLTextAreaElement).value).toBe("");
      await userEvent.type(screen.getByLabelText(/What should the story pick up with/), "   ");
      await userEvent.type(screen.getByLabelText("Say or do something"), "Go.{Enter}");
      expect(socket().sent.at(-1)).toEqual({ type: "player.say", characterId: "kira", text: "Go." });
    });

    it("shows the note only for a saved session, and from that session's own end marker", async () => {
      await open({ transcript: [saved(1, "First night."), say] });
      expect(screen.queryByRole("region", { name: "Progress saved" })).toBeNull();
      expect(screen.getByText("First night.")).toBeTruthy();
      socket().push({ type: "snapshot", ...(snapshot({ transcript: [saved(1, "First night."), say, saved(2, "Second night.")], session: { number: 2, phase: "ended" } }) as object) } as never);
      const card = screen.getByRole("region", { name: "Progress saved" });
      expect(within(card).getByText("Second night.")).toBeTruthy();
      expect(screen.getByText("First night.")).toBeTruthy();
    });

    it("does not show an earlier session's write-up in the note of one that has none", async () => {
      await open({ transcript: [saved(1, "First night."), say], session: { number: 2, phase: "ended" } });
      expect(within(screen.getByRole("region", { name: "Progress saved" })).queryByText("First night.")).toBeNull();
    });

    it("shows the write-up in the story while the save is still being written, before the note is up", async () => {
      await open({ transcript: [say, saved(2, "The case changed hands.")], session: { number: 2, phase: "wrapping" } });
      expect(screen.getAllByText("The case changed hands.")).toHaveLength(1);
      expect(screen.queryByRole("region", { name: "Progress saved" })).toBeNull();
    });

    it("scrolls to the end when the session moves to saved", async () => {
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
