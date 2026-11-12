import type { GmStatus } from "@shadow-run/shared";
import { useEffect, useRef, useState } from "react";
import { useTable } from "./connection";
import { Rail } from "./Rail";
import { RulesContext, TestModeContext } from "./rules";
import { RollCard } from "./RollCard";
import { Story } from "./Story";
import { MissionBox, SessionOver, type SessionMarker, SessionPill, WrapUpDialog, wrapUpBlock } from "./WrapUp";

function gmPill(gm: GmStatus) {
  switch (gm.phase) {
    case "thinking": return <span className="pill think">GM ● thinking…</span>;
    case "waiting_for_rolls": return <span className="pill think">GM ● waiting for rolls</span>;
    case "resting": return <span className="pill think">GM ● resting</span>;
    case "error": return <span className="pill bad">GM ● problem</span>;
    default: return <span className="pill">GM ● ready</span>;
  }
}

export function App({ url }: { url: string }) {
  const { state, send } = useTable(url);
  const [speaker, setSpeaker] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [begun, setBegun] = useState(false);
  const [mission, setMission] = useState("");
  const [asking, setAsking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const sayBox = useRef<HTMLInputElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const { session } = state;

  const who = speaker ?? state.party[0]?.id;
  const nameOf = (id: string) => state.party.find((p) => p.id === id)?.name ?? id;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [state.transcript.length, state.pending.length, state.streaming, session.phase]);
  useEffect(() => {
    if (session.phase !== "open") setAsking(false);
  }, [session.phase]);

  if (!state.ready) {
    return (
      <div className="app">
        <Top state={state} send={send} pill={pill} asking={asking} onAsk={() => setAsking(true)} />
        <div className="center"><p className="dim">{state.connected ? "Waiting for the table…" : "Looking for the table…"}</p></div>
      </div>
    );
  }

  const begin = (seed: string) => {
    setBegun(true);
    const trimmed = seed.trim();
    send({ type: "session.start", ...(trimmed !== "" && { mission: trimmed }) });
  };

  const notStarted = !begun && state.transcript.length === 0 && state.gm.phase === "idle";
  if (notStarted) {
    return (
      <div className="app">
        <Top state={state} send={send} pill={pill} asking={asking} onAsk={() => setAsking(true)} />
        <div className="center">
          <div>
            <h1>SHADOW RUN</h1>
            <p className="dim">Party: {state.party.map((p) => `${p.name} (${p.metatype})`).join(" · ")}</p>
            <div className="first"><MissionBox number={session.number + 1} value={mission} onChange={setMission} onSubmit={() => begin(mission)} /></div>
            <p><button className="pri big" disabled={!state.connected} onClick={() => begin(mission)}>Begin the session</button></p>
          </div>
        </div>
      </div>
    );
  }

  const typingOff = session.phase === "wrapping" || session.phase === "ended";
  const endMarker = session.phase === "ended" ? state.transcript.findLast((e): e is SessionMarker => e.kind === "session" && e.event === "end" && e.number === session.number) : undefined;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: "player.say", ...(who !== undefined && { characterId: who }), text: trimmed });
    setText("");
  };

  return (
    <RulesContext.Provider value={state.rules}>
      <TestModeContext.Provider value={state.testMode}>
      <div className="app">
        <a className="skip" href="#say" onClick={(e) => { e.preventDefault(); sayBox.current?.focus(); }}>Skip to the typing box</a>
        <Top state={state} send={send} pill={pill} asking={asking} onAsk={() => setAsking(true)} />
        <div className="main">
          <div className="story">
            <Story transcript={state.transcript} streaming={state.streaming?.blocks ?? []} fresh={state.fresh} nameOf={nameOf} summaryInCard={session.phase === "ended" ? session.number : undefined} />
            {state.pending.map((request) => (
              <RollCard key={request.id} request={request} name={nameOf(request.characterId)} character={state.characters.find((c) => c.kind === "pc" && c.id === request.characterId)} edge={state.edge.find((e) => e.id === request.characterId)} error={state.error} send={send} />
            ))}
            {session.phase === "ended" && <SessionOver number={session.number} marker={endMarker} connected={state.connected} onBegin={begin} />}
            <div ref={end} />
          </div>
          <Rail party={state.party} characters={state.characters} edge={state.edge} combat={state.combat} speaking={who} onSpeak={setSpeaker} send={send} pending={state.pending} error={state.error} />
        </div>
        <form className={`input${typingOff ? " off" : ""}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <select aria-label="Speaking as" disabled={typingOff} value={who} onChange={(e) => setSpeaker(e.target.value)}>
            {state.party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input id="say" ref={sayBox} aria-label="Say or do something" disabled={typingOff} placeholder={session.phase === "wrapping" ? "The GM is wrapping up the session…" : session.phase === "ended" ? "The session is over. Begin the next one above." : "Say or do something…"} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="pri" type="submit" disabled={typingOff || !state.connected || text.trim() === ""}>Send</button>
        </form>
        {asking && (
          <WrapUpDialog number={session.number} error={state.error} connected={state.connected} onConfirm={() => send({ type: "session.wrapup" })} onClose={() => setAsking(false)} />
        )}
      </div>
      </TestModeContext.Provider>
    </RulesContext.Provider>
  );
}

function Top({ state, send, pill, asking, onAsk }: { state: ReturnType<typeof useTable>["state"]; send: ReturnType<typeof useTable>["send"]; pill: React.RefObject<HTMLButtonElement | null>; asking: boolean; onAsk: () => void }) {
  const { gm, session } = state;
  return (
    <>
      <header className="top">
        <span className="logo">SHADOW RUN</span>
        <span className="sp" />
        <SessionPill session={session} block={wrapUpBlock(state.connected, gm, state.pending.length)} expanded={asking} onAsk={onAsk} buttonRef={pill} />
        {gmPill(gm)}
        {gm.phase === "thinking" && <button onClick={() => send({ type: "turn.cancel" })}>Stop</button>}
        <span className={`pill ${state.connected ? "on" : "bad"}`}>{state.connected ? "● online" : "● offline"}</span>
      </header>
      {!state.connected && <div className="banner warn" role="status">⚠ Lost the table. Reconnecting… (attempt {Math.max(1, state.attempt)}){state.attempt > 1 && <> Is <code>npm run dev:server</code> running?</>}</div>}
      {gm.phase === "error" && (
        <div className="banner err" role="alert">⚠ The GM hit a problem: {gm.message} <button onClick={() => send({ type: "turn.retry" })}>Retry</button></div>
      )}
      {session.phase === "wrapping" && <div className="banner info" role="status">● Wrapping up session {session.number}. The GM is closing the scene and writing it up.</div>}
      {gm.phase === "resting" && <div className="banner warn" role="status">⚠ {gm.message}</div>}
      {state.pending.length > 0 && gm.phase !== "thinking" && (
        <div className="banner info" role="status">● Waiting on {state.pending.length} {state.pending.length === 1 ? "roll" : "rolls"} before the GM continues</div>
      )}
    </>
  );
}
