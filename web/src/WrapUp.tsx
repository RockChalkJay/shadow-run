import type { GmStatus, SessionInfo, TranscriptEntry } from "@shadow-run/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Tip } from "./Rail";

export type SessionMarker = Extract<TranscriptEntry, { kind: "session" }>;

/** The most a mission seed may be; the server enforces the same limit. */
export const MAX_MISSION = 1000;

/** Why the wrap-up control cannot be used right now, or null when it can. */
export function wrapUpBlock(connected: boolean, gm: GmStatus, waitingRolls: number): string | null {
  if (!connected) return "Reconnecting to the table. Wrap up when it is back.";
  if (waitingRolls > 0) return "Answer or skip the waiting rolls first.";
  if (gm.phase === "thinking") return "The GM is in the middle of a turn. Wrap up when it has finished.";
  return null;
}

/**
 * The session in the header. While the session is open it is the wrap-up button; when wrap-up cannot start it stays focusable with
 * aria-disabled, so the reason can be reached by keyboard and by touch. While wrapping up, and once over, it is plain text.
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
  if (session.phase === "wrapping") return <span className="pill session">Session {session.number} · wrapping up…</span>;
  if (session.phase === "ended") return <span className="pill session">Session {session.number} · over</span>;
  return (
    <Tip className="pilltip" focusable={false} id={tipId} text={block ?? "Wrap up this session."}>
      <button
        ref={buttonRef}
        type="button"
        className="pill session btn"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-disabled={block !== null}
        aria-describedby={tipId}
        onClick={() => { if (block === null) onAsk(); }}
      >
        Session {session.number}
        <svg className="caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </Tip>
  );
}

const FOCUSABLE = "button:not(:disabled)";

/**
 * The question before a session is wrapped up. Focus starts on "Keep playing" (the safe answer), Tab stays inside, Esc closes, and the page behind is
 * inert while it is open. The dialog stays up after "Wrap up" until the server moves the session on, so a refusal can be shown here.
 */
export function WrapUpDialog({ number, error, connected, onConfirm, onClose }: {
  number: number;
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
        <h3 id={titleId}>WRAP UP SESSION {number}?</h3>
        <p>The GM closes the scene in a short beat and writes the session up in the campaign log.</p>
        <p className="dim small">What the session earned is saved to each character's sheet, with a copy of the old sheet kept first. A fight in progress carries over.</p>
        {refused && <p className="problem" role="alert">{refused}</p>}
        <div className="btns">
          <button className="pri" disabled={!connected || waiting} onClick={() => { setAsked(true); onConfirm(); }}>Wrap up</button>
          <button ref={keep} onClick={onClose}>Keep playing</button>
        </div>
      </div>
    </div>
  );
}

/** The optional note about what the next session should be about. Ctrl or Cmd+Enter submits. */
export function MissionBox({ number, value, onChange, onSubmit }: { number: number; value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  const id = useId();
  const hint = useId();
  return (
    <div className="next">
      <label htmlFor={id}>What should session {number} be about? <span className="dim" id={hint}>(optional; leave it empty and the GM follows the open threads)</span></label>
      <textarea
        id={id}
        aria-describedby={hint}
        maxLength={MAX_MISSION}
        placeholder="e.g. Follow the courier's employer. Or: a quiet night, downtime and a favor for Mama Rose."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); } }}
      />
      <div className="count" aria-hidden="true">{value.length} / {MAX_MISSION}</div>
    </div>
  );
}

/** What the table sees once a session has been written up: the summary, what changed on each sheet, and the box to begin the next one. */
export function SessionOver({ number, marker, connected, onBegin }: { number: number; marker: SessionMarker | undefined; connected: boolean; onBegin: (mission: string) => void }) {
  const [mission, setMission] = useState("");
  const begin = () => { if (connected) onBegin(mission.trim()); };
  return (
    <section className="card over" aria-label="Session over">
      <h3>SESSION {number} IS OVER</h3>
      {marker?.summary && <p className="summary">{marker.summary}</p>}
      {marker?.fictionDate && <div className="dim small">{marker.fictionDate} · written to the campaign log as Session {number}</div>}
      {marker?.changes && marker.changes.length > 0 && (
        <>
          <h4>WHAT CHANGED</h4>
          {marker.changes.map((c) => (
            <div className="change" key={c.name}><b>{c.name}</b><span>{c.changes.join(" · ")}</span></div>
          ))}
        </>
      )}
      <MissionBox number={number + 1} value={mission} onChange={setMission} onSubmit={begin} />
      <div className="btns"><button className="pri big" disabled={!connected} onClick={begin}>Begin session {number + 1}</button></div>
    </section>
  );
}
