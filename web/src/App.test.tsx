import type { ServerEvent } from "@shadow-run/shared";
import { act, render, screen } from "@testing-library/react";
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
const snapshot = (over: object = {}): ServerEvent => ({ type: "snapshot", party: [sheet("kira", "Kira"), sheet("doc", "Doc")], characters: [], pendingRolls: [], edge: [{ id: "kira", points: 3, rank: 3, spentThisRound: false }], combat: null, transcript: [], gm: { phase: "idle" }, usage: null, ...over }) as ServerEvent;
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
});
