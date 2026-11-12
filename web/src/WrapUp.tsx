import { MAX_MISSION, type GmStatus, type SessionInfo, type TranscriptEntry } from "@shadow-run/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Tip } from "./Rail";

export type SessionMarker = Extract<TranscriptEntry, { kind: "session" }>;

/** Why the wrap-up control cannot be used right now, or null when it can. */
export function wrapUpBlock(connected: boolean, gm: GmStatus, waitingRolls: number): string | null {
  if (!connected) return "Reconnecting to the table. Save when it is back.";
  if (waitingRolls > 0) return "Answer or skip the waiting rolls first.";
  if (gm.phase === "thinking") return "The GM is in the middle of a turn. Save when it has finished.";
  return null;
}

/**
 * The save control in the header. While a session is open it is the "Save progress" button; when saving cannot start it stays focusable with
 * aria-disabled, so the reason can be reached by keyboard and by touch. While the GM writes the session up, and after it is saved, it is plain text.
 * (Saving wraps the session up on the server; the story carries on with the next message.)
 */
export function SessionPill({ session, block, expanded, onAsk, buttonRef }: {
  session: SessionInfo;
  block: string | null;
  expanded: boolean;
  onAsk: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const tipId = useId();
  if (session.phase === "idle") return null;
  if (session.phase === "wrapping") return <span className="pill session">Saving…</span>;
  if (session.phase === "ended") return <span className="pill session">Saved</span>;
  return (
    <Tip className="pilltip" focusable={false} id={tipId} text={block ?? "Save the story so far in the campaign log and on the sheets."}>
      <button
        ref={buttonRef}
        type="button"
        className="pill session btn"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-disabled={block !== null}
        aria-describedby={tipId}
        onClick={() => { if (block === null) onAsk(); else buttonRef.current?.focus(); }}
      >
        Save progress
      </button>
    </Tip>
  );
}

const FOCUSABLE = "button:not(:disabled)";

/**
 * The question before the story is saved. Focus starts on "Cancel" (the safe answer), Tab stays inside, Esc closes, and the page behind is
 * inert while it is open. The dialog stays up after "Save progress" until the server moves the session on, so a refusal can be shown here.
 */
export function WrapUpDialog({ error, connected, onConfirm, onClose }: {
  error: string | null;
  connected: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [asked, setAsked] = useState(false);
  const titleId = useId();
  const refused = asked ? error : null;
  const waiting = asked && refused === null;

  useEffect(() => {
    const dialog = root.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const behind = [...(dialog?.parentElement?.children ?? [])].filter((el) => el !== dialog && !el.hasAttribute("inert"));
    for (const el of behind) el.setAttribute("inert", "");
    keep.current?.focus();
    return () => {
      for (const el of behind) el.removeAttribute("inert");
      if (before?.isConnected) before.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Tab") {
      const items = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  return (
    <div className="modal" ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="card wrap">
        <h3 id={titleId}>SAVE PROGRESS?</h3>
        <p>The GM writes the story so far into the campaign log, and what it earned is saved to each character's sheet, with a copy of the old sheet kept first.</p>
        <p className="dim small">Nothing stops: the scene stays where it is, a fight in progress carries on, and the story picks up with your next message. Everyone's Edge refreshes when it does.</p>
        {refused && <p className="problem" role="alert">{refused}</p>}
        <div className="btns">
          <button className="pri" disabled={!connected || waiting} onClick={() => { setAsked(true); onConfirm(); }}>Save progress</button>
          <button ref={keep} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** The optional note about what the story should be about next. When `onSubmit` is given, Ctrl or Cmd+Enter calls it. */
export function MissionBox({ label, value, onChange, onSubmit }: { label: string; value: string; onChange: (v: string) => void; onSubmit?: () => void }) {
  const id = useId();
  const hint = useId();
  return (
    <div className="next">
      <label htmlFor={id}>{label} <span className="dim" id={hint}>(optional; leave it empty and the GM follows the open threads)</span></label>
      <textarea
        id={id}
        aria-describedby={hint}
        maxLength={MAX_MISSION}
        placeholder="e.g. Follow the courier's employer. Or: a quiet night, downtime and a favor for Mama Rose."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (onSubmit && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); } }}
      />
      <div className="count" aria-hidden="true">{value.length} / {MAX_MISSION}</div>
    </div>
  );
}

/**
 * What the table sees once the story is saved: the write-up, what changed on each sheet, and an optional note about what to pick up with,
 * which goes with the next message. The typing box stays open: saving is not an ending.
 */
export function SavedNote({ marker, mission, onMission }: { marker: SessionMarker | undefined; mission: string; onMission: (v: string) => void }) {
  return (
    <section className="card over" aria-label="Progress saved">
      <h3>PROGRESS SAVED</h3>
      {marker?.summary && <p className="summary">{marker.summary}</p>}
      {marker?.fictionDate && <div className="dim small">In the story: {marker.fictionDate}</div>}
      {marker?.changes && marker.changes.length > 0 && (
        <>
          <h4>WHAT CHANGED</h4>
          {marker.changes.map((c) => (
            <div className="change" key={c.name}><b>{c.name}</b><span>{c.changes.join(" · ")}</span></div>
          ))}
        </>
      )}
      <MissionBox label="What should the story pick up with?" value={mission} onChange={onMission} />
      <p className="dim small">Type to carry on from here. A note above goes to the GM with your next message.</p>
    </section>
  );
}
