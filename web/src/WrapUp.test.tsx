import type { TranscriptEntry } from "@shadow-run/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionOver, SessionPill, WrapUpDialog, wrapUpBlock } from "./WrapUp";

const pill = (session: { number: number; phase: "idle" | "open" | "wrapping" | "ended" }, block: string | null = null, onAsk = vi.fn()) =>
  render(<SessionPill session={session} block={block} expanded={false} onAsk={onAsk} buttonRef={createRef()} />);

describe("wrapUpBlock", () => {
  const idle = { phase: "idle" } as const;
  it("says why wrap-up cannot start, in the order that is easiest to fix", () => {
    expect(wrapUpBlock(true, idle, 0)).toBeNull();
    expect(wrapUpBlock(false, { phase: "thinking", turnId: 1 }, 2)).toMatch(/Reconnecting/);
    expect(wrapUpBlock(true, { phase: "waiting_for_rolls" }, 2)).toBe("Answer or skip the waiting rolls first.");
    expect(wrapUpBlock(true, { phase: "thinking", turnId: 1 }, 0)).toBe("The GM is in the middle of a turn. Wrap up when it has finished.");
  });
});

describe("the session pill", () => {
  it("is absent before a session begins", () => {
    const { container } = pill({ number: 0, phase: "idle" });
    expect(container.firstChild).toBeNull();
  });

  it("is a button that asks to wrap up while the session is open", async () => {
    const onAsk = vi.fn();
    pill({ number: 2, phase: "open" }, null, onAsk);
    const button = screen.getByRole("button", { name: "Session 2" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("tooltip").textContent).toBe("Wrap up this session.");
    await userEvent.click(button);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("stays focusable but does nothing when wrap-up is blocked, and gives the reason on focus and on click", async () => {
    const onAsk = vi.fn();
    pill({ number: 2, phase: "open" }, "Answer or skip the waiting rolls first.", onAsk);
    const button = screen.getByRole("button", { name: "Session 2" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const reason = screen.getByRole("tooltip");
    expect(reason.textContent).toBe("Answer or skip the waiting rolls first.");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.className).not.toContain("open");
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    expect(reason.className).toContain("open");
    await userEvent.keyboard("{Escape}");
    expect(reason.className).not.toContain("open");
    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    expect(onAsk).not.toHaveBeenCalled();
    expect(reason.className).toContain("open");
  });

  it("says when the question is open", () => {
    render(<SessionPill session={{ number: 2, phase: "open" }} block={null} expanded onAsk={vi.fn()} buttonRef={createRef()} />);
    expect(screen.getByRole("button", { name: "Session 2" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("has one tab stop, not two", async () => {
    pill({ number: 2, phase: "open" });
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it("is plain text, not a tab stop, while wrapping up and when over", () => {
    const { rerender } = pill({ number: 2, phase: "wrapping" });
    expect(screen.getByText("Session 2 · wrapping up…").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<SessionPill session={{ number: 2, phase: "ended" }} block={null} expanded={false} onAsk={vi.fn()} buttonRef={createRef()} />);
    expect(screen.getByText("Session 2 · over").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the wrap-up question", () => {
  const open = (over: Partial<Parameters<typeof WrapUpDialog>[0]> = {}) => {
    const props = { number: 2, error: null, connected: true, onConfirm: vi.fn(), onClose: vi.fn(), ...over };
    const view = render(
      <div>
        <button>Behind</button>
        <WrapUpDialog {...props} />
      </div>,
    );
    return { ...props, ...view };
  };

  it("is a labelled modal dialog that starts on the safe answer", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "WRAP UP SESSION 2?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep playing" }));
    expect(screen.getByText(/copy of the old sheet kept first/)).toBeTruthy();
  });

  it("makes the page behind inert while it is open, and gives it back and returns focus after", () => {
    const outer = document.createElement("button");
    document.body.append(outer);
    outer.focus();
    const { unmount, container } = open();
    const behind = container.querySelector("button")!;
    expect(behind.hasAttribute("inert")).toBe(true);
    unmount();
    expect(document.activeElement).toBe(outer);
    outer.remove();
  });

  it("gives the page back when it closes", () => {
    const view = (show: boolean) => (
      <div>
        <button>Behind</button>
        {show && <WrapUpDialog number={2} error={null} connected onConfirm={vi.fn()} onClose={vi.fn()} />}
      </div>
    );
    const { rerender } = render(view(true));
    expect(screen.getByText("Behind").hasAttribute("inert")).toBe(true);
    rerender(view(false));
    expect(screen.getByText("Behind").hasAttribute("inert")).toBe(false);
  });

  it("closes on Escape and on Keep playing, and wraps up only on Wrap up", async () => {
    const a = open();
    await userEvent.keyboard("{Escape}");
    expect(a.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Keep playing" }));
    expect(a.onClose).toHaveBeenCalledTimes(2);
    expect(a.onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Wrap up" }));
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside, both ways round", async () => {
    open();
    const wrap = screen.getByRole("button", { name: "Wrap up" });
    const keep = screen.getByRole("button", { name: "Keep playing" });
    expect(document.activeElement).toBe(keep);
    await userEvent.tab();
    expect(document.activeElement).toBe(wrap);
    await userEvent.tab();
    expect(document.activeElement).toBe(keep);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(wrap);
  });

  it("waits for the server after Wrap up, and shows a refusal and lets the table try again", async () => {
    const props = { number: 2, error: null as string | null, connected: true, onConfirm: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<WrapUpDialog {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Wrap up" }));
    expect(screen.getByRole("button", { name: "Wrap up" }).hasAttribute("disabled")).toBe(true);
    rerender(<WrapUpDialog {...props} error="Answer or skip the waiting rolls first." />);
    expect(screen.getByRole("alert").textContent).toBe("Answer or skip the waiting rolls first.");
    expect(screen.getByRole("button", { name: "Wrap up" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not show an old error that was there before Wrap up was clicked", () => {
    open({ error: "Some earlier problem" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cannot wrap up while offline", () => {
    open({ connected: false });
    expect(screen.getByRole("button", { name: "Wrap up" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the session-over card", () => {
  const end = (over: object = {}): Extract<TranscriptEntry, { kind: "session" }> => ({
    id: 9, ts: "t", kind: "session", event: "end", number: 2,
    summary: "The case changed hands.",
    fictionDate: "Tue 14 Mar 2081, night",
    changes: [{ name: "Kira", changes: ["Karma 0 → 4", "Nuyen 0 → 3,000"] }, { name: "Doc", changes: ["History: run 1 added"] }],
    ...over,
  });

  it("shows the write-up, the in-story date and what changed on each sheet", () => {
    render(<SessionOver number={2} marker={end()} connected onBegin={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Session over" })).toBeTruthy();
    expect(screen.getByText("The case changed hands.")).toBeTruthy();
    expect(screen.getByText(/Tue 14 Mar 2081, night · written to the campaign log as Session 2/)).toBeTruthy();
    expect(screen.getByText("Kira").nextSibling?.textContent).toBe("Karma 0 → 4 · Nuyen 0 → 3,000");
    expect(screen.getByText("Doc")).toBeTruthy();
  });

  it("leaves out the changes list when no sheet changed", () => {
    render(<SessionOver number={2} marker={end({ changes: [] })} connected onBegin={vi.fn()} />);
    expect(screen.queryByText("WHAT CHANGED")).toBeNull();
  });

  it("keeps the new line out of the mission when it is sent with Ctrl+Enter", () => {
    render(<SessionOver number={2} marker={end()} connected onBegin={vi.fn()} />);
    const box = screen.getByLabelText(/What should session 3 be about/);
    expect(fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
  });

  it("still lets the table go on when the end marker is missing or bare", () => {
    render(<SessionOver number={2} marker={end({ summary: undefined, fictionDate: undefined, changes: undefined })} connected onBegin={vi.fn()} />);
    expect(screen.getByText("SESSION 2 IS OVER")).toBeTruthy();
    expect(screen.queryByText("WHAT CHANGED")).toBeNull();
    expect(screen.getByRole("button", { name: "Begin session 3" })).toBeTruthy();
  });

  it("begins the next session with the trimmed mission, or none", async () => {
    const onBegin = vi.fn();
    render(<SessionOver number={2} marker={end()} connected onBegin={onBegin} />);
    await userEvent.click(screen.getByRole("button", { name: "Begin session 3" }));
    expect(onBegin).toHaveBeenLastCalledWith("");
    await userEvent.type(screen.getByLabelText(/What should session 3 be about/), "  Follow Mr. Smith.  ");
    await userEvent.click(screen.getByRole("button", { name: "Begin session 3" }));
    expect(onBegin).toHaveBeenLastCalledWith("Follow Mr. Smith.");
  });

  it("begins on Ctrl+Enter and Cmd+Enter but not on plain Enter", async () => {
    const onBegin = vi.fn();
    render(<SessionOver number={2} marker={end()} connected onBegin={onBegin} />);
    await userEvent.type(screen.getByLabelText(/What should session 3 be about/), "Heist{Enter}");
    expect(onBegin).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onBegin).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onBegin).toHaveBeenCalledTimes(2);
  });

  it("limits the mission and counts it", async () => {
    render(<SessionOver number={2} marker={end()} connected onBegin={vi.fn()} />);
    const box = screen.getByLabelText(/What should session 3 be about/) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    await userEvent.type(box, "abc");
    expect(screen.getByText("3 / 1000")).toBeTruthy();
  });

  it("cannot begin while offline, by button or by keyboard", async () => {
    const onBegin = vi.fn();
    render(<SessionOver number={2} marker={end()} connected={false} onBegin={onBegin} />);
    expect(screen.getByRole("button", { name: "Begin session 3" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText(/What should session 3 be about/), "x{Control>}{Enter}{/Control}");
    expect(onBegin).not.toHaveBeenCalled();
  });
});
