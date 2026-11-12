import type { TranscriptEntry } from "@shadow-run/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { SavedNote, SessionPill, WrapUpDialog, wrapUpBlock } from "./WrapUp";

const pill = (session: { number: number; phase: "idle" | "open" | "wrapping" | "ended" }, block: string | null = null, onAsk = vi.fn()) =>
  render(<SessionPill session={session} block={block} expanded={false} onAsk={onAsk} buttonRef={createRef()} />);

describe("wrapUpBlock", () => {
  const idle = { phase: "idle" } as const;
  it("says why wrap-up cannot start, in the order that is easiest to fix", () => {
    expect(wrapUpBlock(true, idle, 0)).toBeNull();
    expect(wrapUpBlock(false, { phase: "thinking", turnId: 1 }, 2)).toMatch(/Reconnecting/);
    expect(wrapUpBlock(true, { phase: "waiting_for_rolls" }, 2)).toBe("Answer or skip the waiting rolls first.");
    expect(wrapUpBlock(true, { phase: "thinking", turnId: 1 }, 0)).toBe("The GM is in the middle of a turn. Save when it has finished.");
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
    const button = screen.getByRole("button", { name: "Save progress" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("tooltip").textContent).toBe("Save the story so far in the campaign log and on the sheets.");
    await userEvent.click(button);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("stays focusable but does nothing when wrap-up is blocked, and gives the reason on focus and on click", async () => {
    const onAsk = vi.fn();
    pill({ number: 2, phase: "open" }, "Answer or skip the waiting rolls first.", onAsk);
    const button = screen.getByRole("button", { name: "Save progress" });
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
    expect(screen.getByRole("button", { name: "Save progress" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the reason on a click even where a click does not focus a button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<SessionPill session={{ number: 2, phase: "open" }} block="Answer or skip the waiting rolls first." expanded={false} onAsk={vi.fn()} buttonRef={ref} />);
    fireEvent.click(screen.getByRole("button", { name: "Save progress" }));
    expect(document.activeElement).toBe(ref.current);
    expect(screen.getByRole("tooltip").className).toContain("open");
  });

  it("has one tab stop, not two", async () => {
    pill({ number: 2, phase: "open" });
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(document.body);
  });

  it("is plain text, not a tab stop, while wrapping up and when over", () => {
    const { rerender } = pill({ number: 2, phase: "wrapping" });
    expect(screen.getByText("Saving…").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<SessionPill session={{ number: 2, phase: "ended" }} block={null} expanded={false} onAsk={vi.fn()} buttonRef={createRef()} />);
    expect(screen.getByText("Saved").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the wrap-up question", () => {
  const open = (over: Partial<Parameters<typeof WrapUpDialog>[0]> = {}) => {
    const props = { error: null, connected: true, onConfirm: vi.fn(), onClose: vi.fn(), ...over };
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
    const dialog = screen.getByRole("dialog", { name: "SAVE PROGRESS?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/copy of the old sheet kept first/)).toBeTruthy();
    expect(screen.getByText(/Everyone's Edge refreshes when it does/)).toBeTruthy();
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
        {show && <WrapUpDialog error={null} connected onConfirm={vi.fn()} onClose={vi.fn()} />}
      </div>
    );
    const { rerender } = render(view(true));
    expect(screen.getByText("Behind").hasAttribute("inert")).toBe(true);
    rerender(view(false));
    expect(screen.getByText("Behind").hasAttribute("inert")).toBe(false);
  });

  it("closes on Escape and on Cancel, and saves only on Save progress", async () => {
    const a = open();
    await userEvent.keyboard("{Escape}");
    expect(a.onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(a.onClose).toHaveBeenCalledTimes(2);
    expect(a.onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save progress" }));
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside, both ways round", async () => {
    open();
    const wrap = screen.getByRole("button", { name: "Save progress" });
    const keep = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(keep);
    await userEvent.tab();
    expect(document.activeElement).toBe(wrap);
    await userEvent.tab();
    expect(document.activeElement).toBe(keep);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(wrap);
  });

  it("waits for the server after Save progress, and shows a refusal and lets the table try again", async () => {
    const props = { error: null as string | null, connected: true, onConfirm: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<WrapUpDialog {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Save progress" }));
    expect(screen.getByRole("button", { name: "Save progress" }).hasAttribute("disabled")).toBe(true);
    rerender(<WrapUpDialog {...props} error="Answer or skip the waiting rolls first." />);
    expect(screen.getByRole("alert").textContent).toBe("Answer or skip the waiting rolls first.");
    expect(screen.getByRole("button", { name: "Save progress" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not show an old error that was there before Save progress was clicked", () => {
    open({ error: "Some earlier problem" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cannot save while offline", () => {
    open({ connected: false });
    expect(screen.getByRole("button", { name: "Save progress" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the saved note", () => {
  const end = (over: object = {}): Extract<TranscriptEntry, { kind: "session" }> => ({
    id: 9, ts: "t", kind: "session", event: "end", number: 2,
    summary: "The case changed hands.",
    fictionDate: "Tue 14 Mar 2081, night",
    changes: [{ name: "Kira", changes: ["Karma 0 → 4", "Nuyen 0 → 3,000"] }, { name: "Doc", changes: ["History: run 1 added"] }],
    ...over,
  });
  const note = (marker = end(), mission = "", onMission = vi.fn()) => render(<SavedNote marker={marker} mission={mission} onMission={onMission} />);

  it("shows the write-up, the date in the story and what changed on each sheet", () => {
    note();
    expect(screen.getByRole("region", { name: "Progress saved" })).toBeTruthy();
    expect(screen.getByText("The case changed hands.")).toBeTruthy();
    expect(screen.getByText("In the story: Tue 14 Mar 2081, night")).toBeTruthy();
    expect(screen.getByText("Kira").nextSibling?.textContent).toBe("Karma 0 → 4 · Nuyen 0 → 3,000");
    expect(screen.getByText("Doc")).toBeTruthy();
  });

  it("leaves out the changes list when no sheet changed", () => {
    note(end({ changes: [] }));
    expect(screen.queryByText("WHAT CHANGED")).toBeNull();
  });

  it("still shows the note when the end marker is missing or bare", () => {
    note(end({ summary: undefined, fictionDate: undefined, changes: undefined }));
    expect(screen.getByText("PROGRESS SAVED")).toBeTruthy();
    expect(screen.queryByText("WHAT CHANGED")).toBeNull();
    expect(screen.queryByText(/In the story/)).toBeNull();
    expect(screen.getByLabelText(/What should the story pick up with/)).toBeTruthy();
  });

  it("has no begin button: the story carries on when someone types", () => {
    note();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Type to carry on from here/)).toBeTruthy();
  });

  it("hands what is typed in the note up as it is typed, limited and counted", async () => {
    const onMission = vi.fn();
    note(end(), "", onMission);
    const box = screen.getByLabelText(/What should the story pick up with/) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    await userEvent.type(box, "Hi");
    expect(onMission).toHaveBeenLastCalledWith("i");
  });

  it("shows the note's text and its count", () => {
    note(end(), "Follow Mr. Smith.");
    expect((screen.getByLabelText(/What should the story pick up with/) as HTMLTextAreaElement).value).toBe("Follow Mr. Smith.");
    expect(screen.getByText("17 / 1000")).toBeTruthy();
  });

  it("does not begin anything on Ctrl+Enter", async () => {
    const onMission = vi.fn();
    note(end(), "", onMission);
    const box = screen.getByLabelText(/What should the story pick up with/);
    expect(fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })).toBe(true);
  });
});
