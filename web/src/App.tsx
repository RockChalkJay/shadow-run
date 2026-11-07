import type { GmStatus } from "@shadow-run/shared";
import { useEffect, useRef, useState } from "react";
import { useTable } from "./connection";
import { Rail } from "./Rail";
import { RollCard } from "./RollCard";
import { Story } from "./Story";

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
  const end = useRef<HTMLDivElement>(null);
  const sayBox = useRef<HTMLInputElement>(null);

  const who = speaker ?? state.party[0]?.id;
  const nameOf = (id: string) => state.party.find((p) => p.id === id)?.name ?? id;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [state.transcript.length, state.pending.length, state.streaming]);

  if (!state.ready) {
    return (
      <div className="app">
        <Top state={state} send={send} />
        <div className="center"><p className="dim">{state.connected ? "Waiting for the table…" : "Looking for the table…"}</p></div>
      </div>
    );
  }

  const notStarted = !begun && state.transcript.length === 0 && state.gm.phase === "idle";
  if (notStarted) {
    return (
      <div className="app">
        <Top state={state} send={send} />
        <div className="center">
          <div>
            <h1>SHADOW RUN</h1>
            <p className="dim">Party: {state.party.map((p) => `${p.name} (${p.metatype})`).join(" · ")}</p>
            <p><button className="pri big" disabled={!state.connected} onClick={() => { setBegun(true); send({ type: "session.start" }); }}>Begin the session</button></p>
          </div>
        </div>
      </div>
    );
  }

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: "player.say", ...(who !== undefined && { characterId: who }), text: trimmed });
    setText("");
  };

  return (
    <div className="app">
      <a className="skip" href="#say" onClick={(e) => { e.preventDefault(); sayBox.current?.focus(); }}>Skip to the typing box</a>
      <Top state={state} send={send} />
      <div className="main">
        <div className="story">
          <Story transcript={state.transcript} streaming={state.streaming?.blocks ?? []} fresh={state.fresh} nameOf={nameOf} />
          {state.pending.map((request) => (
            <RollCard key={request.id} request={request} name={nameOf(request.characterId)} edge={state.edge.find((e) => e.id === request.characterId)} error={state.error} send={send} />
          ))}
          <div ref={end} />
        </div>
        <Rail party={state.party} characters={state.characters} edge={state.edge} combat={state.combat} speaking={who} onSpeak={setSpeaker} />
      </div>
      <form className="input" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <select aria-label="Speaking as" value={who} onChange={(e) => setSpeaker(e.target.value)}>
          {state.party.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input id="say" ref={sayBox} aria-label="Say or do something" placeholder="Say or do something…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="pri" type="submit" disabled={!state.connected || text.trim() === ""}>Send</button>
      </form>
    </div>
  );
}

function Top({ state, send }: { state: ReturnType<typeof useTable>["state"]; send: ReturnType<typeof useTable>["send"] }) {
  const { gm } = state;
  return (
    <>
      <header className="top">
        <span className="logo">SHADOW RUN</span>
        <span className="sp" />
        {gmPill(gm)}
        {gm.phase === "thinking" && <button onClick={() => send({ type: "turn.cancel" })}>Stop</button>}
        <span className={`pill ${state.connected ? "on" : "bad"}`}>{state.connected ? "● online" : "● offline"}</span>
      </header>
      {!state.connected && <div className="banner warn" role="status">⚠ Lost the table. Reconnecting… (attempt {Math.max(1, state.attempt)}){state.attempt > 1 && <> Is <code>npm run dev:server</code> running?</>}</div>}
      {gm.phase === "error" && (
        <div className="banner err" role="alert">⚠ The GM hit a problem: {gm.message} <button onClick={() => send({ type: "turn.retry" })}>Retry</button></div>
      )}
      {gm.phase === "resting" && <div className="banner warn" role="status">⚠ {gm.message}</div>}
      {state.pending.length > 0 && gm.phase !== "thinking" && (
        <div className="banner info" role="status">● Waiting on {state.pending.length} {state.pending.length === 1 ? "roll" : "rolls"} before the GM continues</div>
      )}
    </>
  );
}
