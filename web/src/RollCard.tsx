import type { CharacterView, ClientMessage, EdgeView, RollRequest } from "@shadow-run/shared";
import { useState } from "react";
import { actionTakesTheEdge, cannotSpend, COST, facesFrom, shouldKeepBack } from "./edge";
import { HeldRoll } from "./HeldRoll";
import { useTestMode } from "./rules";

export { facesFrom };

interface Props {
  request: RollRequest;
  name: string;
  edge: EdgeView | undefined;
  /** The character rolling, for how hurt they are. */
  character?: CharacterView | undefined;
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

export function RollCard({ request, name, character, edge, error, send }: Props) {
  const [open, setOpen] = useState<{ happens: boolean; edge: boolean }>({ happens: false, edge: false });
  const [mode, setMode] = useState<"choose" | "dice" | "burn">("choose");
  const size = request.pool.total;
  const [faces, setFaces] = useState<string[]>([]);
  const [local, setLocal] = useState<string | null>(null);
  const testMode = useTestMode();

  const skip = cannotSkip(request);
  const smack = cannotSmackdown(request, edge);

  const { held } = request;
  const [before, setBefore] = useState<"none" | "dice" | "widen">("none");
  const [extra, setExtra] = useState("");
  const taken = actionTakesTheEdge(request, edge);
  const diceReason = taken ?? cannotSpend(edge, COST.dice) ?? (edge && edge.rank === 0 ? "No Edge attribute to add to the pool." : null);
  const widenReason = taken ?? (request.opposed ? cannotSpend(edge, COST.widen) : "There is no opposing roll to make glitch.");
  const withEdge = before === "dice" ? (edge?.rank ?? 0) : 0;
  const total = size + withEdge;

  const chosen = held ? null : before === "dice" ? "Edge dice chosen" : before === "widen" ? "2s count against them" : null;
  const face = (i: number) => faces[i] ?? "";
  const setFace = (index: number, value: string) => {
    const typed = facesFrom(value);
    const grow = (f: string[]) => Array.from({ length: Math.max(f.length, total) }, (_, i) => f[i] ?? "");
    if (typed.length <= 1) {
      setFaces((f) => grow(f).map((x, i) => (i === index ? (typed[0]?.toString() ?? "") : x)));
      return;
    }
    // Several dice typed or pasted into one box fill the boxes from there on.
    setFaces((f) => grow(f).map((x, i) => (i >= index && typed[i - index] !== undefined ? String(typed[i - index]) : x)));
  };

  const edgeFields = () => ({
    ...(before === "dice" && { edge: "dice" as const }),
    ...(before === "widen" && { edge: "widen_glitch" as const }),
    ...(shouldKeepBack(request, edge, before, testMode) && { hold: true }),
  });
  const count = () => {
    const entered = Array.from({ length: total }, (_, i) => face(i));
    if (entered.some((f) => f === "")) return setLocal(`This roll is ${pluralDice(total)}${withEdge > 0 ? ` (${size} plus ${withEdge} Edge ${withEdge === 1 ? "die" : "dice"})` : ""}; you entered ${entered.filter((f) => f !== "").length}.`);
    setLocal(null);
    send({ type: "roll.physical", requestId: request.id, dice: entered.join(" "), ...(before === "dice" && extra.trim() !== "" && { explosions: extra.trim() }), ...edgeFields() });
  };

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
        {open.edge ? "▾" : "▸"} Edge{chosen && <>{" · "}<span className="chosen">{chosen}</span></>}
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
      {open.edge && (
        <div className="more edge-panel">
          <Row label="ADVICE">{request.edgeAdvice}</Row>
          {!held && (
            <fieldset className="edge-opts">
              <legend>Edge on this roll</legend>
              <EdgeOption checked={before === "none"} onChange={() => setBefore("none")} label="No Edge before the roll" />
              <EdgeOption checked={before === "dice"} onChange={() => { setBefore("dice"); }} reason={diceReason} label={`Edge dice · ${COST.dice} Edge`} detail="Adds your Edge attribute to the pool, and 6s explode." />
              {request.opposed && <EdgeOption checked={before === "widen"} onChange={() => { setBefore("widen"); }} reason={widenReason} label={`Make 2s count against them · ${COST.widen} Edge`} detail="2s as well as 1s count toward the opposition's glitch." />}
              {taken && <p className="hint">{taken} No other Edge can go on this roll.</p>}
              <div className="smack">
                <button className="dng" disabled={smack !== null} title={smack ?? undefined} onClick={() => setMode("burn")}>🔥 Burn Edge: Smackdown</button>
                <small>{smack ?? "Skip the roll: an automatic success with 4 net hits. Costs a point of Edge rank for good."}</small>
              </div>
            </fieldset>
          )}
        </div>
      )}

      {held ? (
        <HeldRoll request={request} name={name} character={character} edge={edge} error={error} send={send} onRedo={() => { setMode("choose"); setFaces([]); setLocal(null); send({ type: "roll.redo", requestId: request.id }); }} />
      ) : mode === "dice" ? (
        <>
          <p className="hint">Your {pluralDice(total)}{withEdge > 0 ? ` (${size} plus ${withEdge} Edge ${withEdge === 1 ? "die" : "dice"})` : ""}. Type each face, or type them all in the first box.</p>
          <div className="dice-entry">
            {Array.from({ length: total }, (_, i) => (
              <input key={i} className="die-input" aria-label={`die ${i + 1}`} value={face(i)} inputMode="numeric" onChange={(e) => setFace(i, e.target.value)} />
            ))}
          </div>
          {before === "dice" && (
            <label className="inline">Extra dice for 6s, if rolled by hand <input className="wide" aria-label="extra dice for 6s" placeholder="Leave empty to let the app roll them" value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
          )}
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
            <button className="pri" onClick={() => send({ type: "roll.app", requestId: request.id, ...edgeFields() })}>🎲 Roll with the app</button>
            <button onClick={() => setMode("dice")}>✎ Enter my dice</button>
            <button disabled={skip !== null} title={skip ?? undefined} onClick={() => send({ type: "roll.cancel", requestId: request.id })}>Skip roll</button>
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

function EdgeOption({ checked, onChange, label, detail, reason }: { checked: boolean; onChange: () => void; label: string; detail?: string; reason?: string | null }) {
  return (
    <label className={`opt ${reason ? "off" : ""}`}>
      <input type="radio" name="before" checked={checked} disabled={Boolean(reason)} onChange={onChange} />
      <span>{label}{(reason ?? detail) && <small>{reason ?? detail}</small>}</span>
    </label>
  );
}
