import type { ClientMessage, EdgeView, RollRequest } from "@shadow-run/shared";
import { useState } from "react";

interface Props {
  request: RollRequest;
  name: string;
  edge: EdgeView | undefined;
  /** What the server last refused, shown while the player is answering. */
  error: string | null;
  send: (message: ClientMessage) => void;
}

/** Why this roll cannot be skipped, or null if it can. */
export function cannotSkip(request: RollRequest): string | null {
  if (request.soak) return "This resists damage that is already coming.";
  if (request.attack?.role === "defender") return "This defends against an attack that is already coming.";
  return null;
}

/** Why this roll cannot be a Smackdown, or null if it can. */
export function cannotSmackdown(request: RollRequest, edge: EdgeView | undefined): string | null {
  if (request.soak) return "Smackdown cannot resist damage.";
  if (request.healing) return "A healing roll cannot be a Smackdown.";
  if (request.held) return "This roll is already counted.";
  if (edge && edge.rank === 0) return "No Edge rank left to burn.";
  return null;
}

const pluralDice = (n: number) => `${n} ${n === 1 ? "die" : "dice"}`;

/** Splits what was typed into faces: spaces, commas or nothing at all between single digits. */
export function facesFrom(text: string): number[] {
  return (text.match(/[1-6]/g) ?? []).map(Number);
}

export function RollCard({ request, name, edge, error, send }: Props) {
  const [open, setOpen] = useState<{ happens: boolean; edge: boolean }>({ happens: false, edge: false });
  const [mode, setMode] = useState<"choose" | "dice" | "burn">("choose");
  const size = request.pool.total;
  const [faces, setFaces] = useState<string[]>(() => Array(size).fill(""));
  const [local, setLocal] = useState<string | null>(null);

  const skip = cannotSkip(request);
  const smack = cannotSmackdown(request, edge);

  const setFace = (index: number, value: string) => {
    const typed = facesFrom(value);
    if (typed.length <= 1) {
      setFaces((f) => f.map((x, i) => (i === index ? (typed[0]?.toString() ?? "") : x)));
      return;
    }
    // Several dice typed or pasted into one box fill the boxes from there on.
    setFaces((f) => f.map((x, i) => (i >= index && typed[i - index] !== undefined ? String(typed[i - index]) : x)));
  };

  const count = () => {
    if (faces.some((f) => f === "")) return setLocal(`This roll is ${pluralDice(size)}; you entered ${faces.filter((f) => f !== "").length}.`);
    setLocal(null);
    send({ type: "roll.physical", requestId: request.id, dice: faces.join(" ") });
  };

  const { held } = request;
  return (
    <section className="card" aria-label={`Roll for ${name}`}>
      <h3>ROLL · {name.toUpperCase()} · {request.label.toUpperCase()}</h3>
      <Row label="AT STAKE">{request.stakes}</Row>
      <Row label="POOL">{pluralDice(size)} · {request.pool.breakdown}</Row>
      {request.soak ? (
        <Row label="RESISTING">{request.soak.damageValue} {request.soak.damageType} damage from {request.soak.source}: every hit removes one point of it</Row>
      ) : request.healing ? (
        <Row label="HEALING">{request.healing.method.replaceAll("_", " ")} on {request.healing.patient.name}, threshold {request.healing.threshold}</Row>
      ) : request.opposed ? (
        <Row label="AGAINST">{request.opposed.by}, {pluralDice(request.opposed.pool)}, rolled by the system</Row>
      ) : (
        <Row label="NEEDS">{request.threshold ?? 1} {(request.threshold ?? 1) === 1 ? "hit" : "hits"}</Row>
      )}
      {request.edgeAction && (
        <Row label="EDGE ACTION">
          {request.edgeAction.name} · {request.edgeAction.cost} Edge · paid when the roll counts · no other Edge can go on this roll
        </Row>
      )}

      <button className="tog" aria-expanded={open.happens} onClick={() => setOpen((o) => ({ ...o, happens: !o.happens }))}>
        {open.happens ? "▾" : "▸"} What happens
      </button>
      <button className="tog" aria-expanded={open.edge} onClick={() => setOpen((o) => ({ ...o, edge: !o.edge }))}>
        {open.edge ? "▾" : "▸"} Edge advice
      </button>
      {open.happens && (
        <div className="more">
          <Row label="GOOD">{request.goodRoll}</Row>
          <Row label="BAD">{request.badRoll}</Row>
          <Row label="✔ SUCCESS">{request.consequences.success}</Row>
          <Row label="✘ FAILURE">{request.consequences.failure}</Row>
          <Row label="⚠ GLITCH">{request.consequences.glitch}</Row>
          <Row label="☠ CRITICAL">{request.consequences.criticalGlitch}</Row>
        </div>
      )}
      {open.edge && <div className="more"><Row label="EDGE">{request.edgeAdvice}</Row></div>}

      {held ? (
        <p className="hint">The dice are counted and waiting on an Edge decision. Use the command-line client (<code>npm run play</code>) for that until the Edge screen arrives.</p>
      ) : mode === "dice" ? (
        <>
          <p className="hint">Your {pluralDice(size)}. Type each face, or type them all in the first box.</p>
          <div className="dice-entry">
            {faces.map((f, i) => (
              <input key={i} className="die-input" aria-label={`die ${i + 1}`} value={f} inputMode="numeric" onChange={(e) => setFace(i, e.target.value)} />
            ))}
          </div>
          {(local ?? error) && <p className="problem" role="alert">{local ?? error}</p>}
          <div className="btns">
            <button className="pri" onClick={count}>Count these dice</button>
            <button onClick={() => { setMode("choose"); setLocal(null); }}>Back</button>
          </div>
        </>
      ) : (
        <>
          {error && <p className="problem" role="alert">{error}</p>}
          <div className="btns">
            <button className="pri" onClick={() => send({ type: "roll.app", requestId: request.id })}>🎲 Roll with the app</button>
            <button onClick={() => setMode("dice")}>✎ Enter my dice</button>
            <button disabled={skip !== null} title={skip ?? undefined} onClick={() => send({ type: "roll.cancel", requestId: request.id })}>Skip roll</button>
            <button className="dng" disabled={smack !== null} title={smack ?? undefined} onClick={() => setMode("burn")}>🔥 Burn Edge: Smackdown</button>
          </div>
        </>
      )}

      {mode === "burn" && (
        <div className="modal" role="dialog" aria-label="Burn Edge for Smackdown">
          <div className="card burn">
            <h3>BURN EDGE FOR SMACKDOWN?</h3>
            <p>{name} skips the roll: an automatic success with 4 net hits.</p>
            <p>
              This costs a point of Edge rank <b>for good</b>
              {edge ? ` (${edge.rank} → ${edge.rank - 1}) and the ${edge.points} Edge ${edge.points === 1 ? "point" : "points"} ${name} holds now` : ""}. It cannot be undone.
            </p>
            <div className="btns">
              <button className="dng" onClick={() => { setMode("choose"); send({ type: "roll.smackdown", requestId: request.id }); }}>Burn it</button>
              <button className="pri" onClick={() => setMode("choose")}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}
