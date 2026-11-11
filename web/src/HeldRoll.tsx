import { damageAfterResistance, wouldKill, type CharacterView, type ClientMessage, type EdgeView, type RollRequest, type RollResult } from "@shadow-run/shared";
import { useEffect, useState } from "react";
import { Dice, TUMBLE_MS } from "./Dice";
import { cannotSpend, COST } from "./edge";
import { useRules, useTestMode } from "./rules";

type Tool = "reroll" | "bump" | "buy" | "missed";

const key = (side: "mine" | "theirs", index: number) => `${side}:${index}`;

function PickableDice({ roll, side, on, toggle }: { roll: RollResult; side: "mine" | "theirs"; on: Set<string>; toggle: ((side: "mine" | "theirs", i: number) => void) | null }) {
  const { hitMinimum } = useRules();
  return (
    <span className="dice" role="group" aria-label={side === "mine" ? "your dice" : "their dice"}>
      {roll.dice.map((face, i) => {
        const kind = face >= hitMinimum ? "hit" : face === 1 ? "one" : "";
        const picked = on.has(key(side, i));
        return toggle ? (
          <button key={i} className={`die pick ${kind} ${picked ? "on" : ""} ${side === "theirs" ? "small" : ""}`} aria-pressed={picked} aria-label={`${side === "mine" ? "your" : "their"} die ${i + 1}, showing ${face}`} onClick={() => toggle(side, i)}>{face}</button>
        ) : (
          <span key={i} className={`die ${kind} ${side === "theirs" ? "small" : ""}`}>{face}</span>
        );
      })}
      {(roll.explosions ?? []).map((face, i) => <span key={`x${i}`} className={`die ${face >= hitMinimum ? "hit" : ""} ${side === "theirs" ? "small" : ""}`}>{face}</span>)}
      {roll.bonusHits ? <span className="bought">+{roll.bonusHits} bought</span> : null}
    </span>
  );
}

/** A roll the player has counted but not committed: its dice, and what Edge can do to them. */
export function HeldRoll({ request, name, character, edge, error, send, onRedo }: { request: RollRequest; name: string; character?: CharacterView | undefined; edge: EdgeView | undefined; error: string | null; send: (m: ClientMessage) => void; onRedo: () => void }) {
  const held = request.held!;
  const rules = useRules();
  const testMode = useTestMode();
  const [burning, setBurning] = useState(false);
  // A roll to resist damage that, as the dice stand, would kill: the one moment Not Dead Yet can be burned.
  const lethal = request.soak !== undefined && character !== undefined && wouldKill(character.monitor, request.soak.damageType, damageAfterResistance(request.soak.damageValue, held.roll.hits), rules);
  // The app's dice tumble when they first show. The screen cannot tell a fresh roll from one restored after a reload, so a reload plays it again.
  const [tumbling, setTumbling] = useState(held.source === "app");
  useEffect(() => {
    if (!tumbling) return;
    const timer = setTimeout(() => setTumbling(false), TUMBLE_MS);
    return () => clearTimeout(timer);
  }, [tumbling]);
  const [tool, setTool] = useState<Tool>("reroll");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [times, setTimes] = useState(1);
  const [byHand, setByHand] = useState(false);
  const [typed, setTyped] = useState("");

  const mine = [...picked].filter((k) => k.startsWith("mine:")).map((k) => Number(k.slice(5)));
  const theirs = [...picked].filter((k) => k.startsWith("theirs:")).map((k) => Number(k.slice(7)));
  const misses = held.roll.dice.filter((d) => d < rules.hitMinimum).length;

  const toggle = (side: "mine" | "theirs", i: number) => {
    setPicked((p) => {
      const next = new Set(p);
      next.has(key(side, i)) ? next.delete(key(side, i)) : next.add(key(side, i));
      return next;
    });
  };
  const choose = (t: Tool) => {
    setTool(t);
    setPicked(new Set());
  };

  const cost = tool === "reroll" ? COST.reroll * picked.size : tool === "bump" ? COST.bump * mine.length : tool === "buy" ? COST.buyHit * times : COST.rerollMissed;
  const blocked =
    tool === "missed"
      ? held.roll.glitch ? "Rerolling the misses cannot be done after a glitch." : misses === 0 ? "Every die is a hit." : null
      : tool === "buy" ? null : tool === "bump" && mine.length === 0 ? "Only your own dice can be raised." : tool === "bump" && mine.some((i) => held.roll.dice[i] === 6) ? "A 6 cannot be raised." : null;
  const needsPick = (tool === "reroll" || tool === "bump") && picked.size === 0;
  const poor = needsPick ? null : cannotSpend(edge, cost);
  const reason = blocked ?? poor;
  const diceText = byHand && typed.trim() !== "" ? typed.trim() : undefined;

  const confirm = () => {
    const base = { type: "roll.edge" as const, requestId: request.id };
    const targets = [...mine.map((index) => ({ side: "mine" as const, index })), ...theirs.map((index) => ({ side: "theirs" as const, index }))];
    if (tool === "reroll") send({ ...base, boost: "reroll", targets, ...(diceText !== undefined && { dice: diceText }) });
    else if (tool === "bump") send({ ...base, boost: "bump", targets: mine.map((index) => ({ side: "mine" as const, index })) });
    else if (tool === "buy") send({ ...base, boost: "buy_hit", times });
    else send({ ...base, boost: "reroll_failed", ...(diceText !== undefined && { dice: diceText }) });
  };

  const label =
    tool === "reroll" ? (picked.size === 0 ? "Reroll dice" : `Reroll ${picked.size} ${picked.size === 1 ? "die" : "dice"}`)
    : tool === "bump" ? (mine.length === 0 ? "Add 1 to a die" : `Add 1 to ${mine.length} ${mine.length === 1 ? "die" : "dice"}`)
    : tool === "buy" ? `Buy ${times} ${times === 1 ? "hit" : "hits"}`
    : `Reroll the ${misses} that missed`;
  const priced = needsPick ? "" : ` · ${cost} Edge`;
  const needsDice = tool === "reroll" || tool === "missed";

  return (
    <div className="held">
      <p className="hint">Your roll: {held.roll.hits} {held.roll.hits === 1 ? "hit" : "hits"}{held.opponent ? ` against ${held.opponent.hits}` : ""}. Keep it, or spend Edge on it.</p>
      {tumbling ? <Dice roll={held.roll} tumble /> : <PickableDice roll={held.roll} side="mine" on={picked} toggle={tool === "reroll" || tool === "bump" ? toggle : null} />}
      {held.opponent && !tumbling && (
        <p className="dim">{request.opposed?.by ?? "Opposition"}: <PickableDice roll={held.opponent} side="theirs" on={picked} toggle={tool === "reroll" ? toggle : null} /> {held.opponent.hits} {held.opponent.hits === 1 ? "hit" : "hits"}</p>
      )}
      <div className="btns">
        <button className="pri" onClick={() => send({ type: "roll.keep", requestId: request.id })}>Keep it as it stands</button>
        {testMode && <button className="redo" title="For testing: throw these dice away and roll again. It costs nothing." onClick={onRedo}>↺ Roll again <small>test</small></button>}
      </div>
      {lethal && (
        <div className="nde">
          <p className="problem">As it stands, this blow kills {name}.</p>
          {edge && edge.rank > 0 ? (
            <>
              <button className="dng" onClick={() => setBurning(true)}>🔥 Burn Edge: Not Dead Yet</button>
              <small>They survive it, unconscious and dying. It costs a point of Edge rank for good and all their Edge.</small>
            </>
          ) : (
            <small>No Edge rank is left to burn.</small>
          )}
        </div>
      )}
      <h4 className="spend">Or spend Edge on it</h4>
      <div className="tools" role="radiogroup" aria-label="What to spend Edge on">
        {([["reroll", `Reroll dice · ${COST.reroll} each`], ["bump", `Add 1 to a die · ${COST.bump} each`], ["buy", `Buy a hit · ${COST.buyHit} each`], ["missed", `Reroll the misses · ${COST.rerollMissed}`]] as [Tool, string][]).map(([t, text]) => (
          <button key={t} role="radio" aria-checked={tool === t} className={tool === t ? "pri" : ""} onClick={() => choose(t)}>{text}</button>
        ))}
      </div>
      {tool === "buy" && (
        <label className="inline">
          How many <select value={times} onChange={(e) => setTimes(Number(e.target.value))} className="num">{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
      )}
      {needsPick && <p className="hint">Pick the dice above by clicking them.</p>}
      {needsDice && (
        <>
          <label className="inline"><input type="checkbox" checked={byHand} onChange={(e) => setByHand(e.target.checked)} /> I rolled the new dice myself</label>
          {byHand && <input className="wide" aria-label="new dice" placeholder={tool === "reroll" ? "New values in order: yours first, then theirs" : "New values for each die that missed, in order"} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </>
      )}
      {(reason ?? error) && <p className="problem" role="alert">{reason ?? error}</p>}
      <div className="btns">
        <button disabled={reason !== null || needsPick} onClick={confirm}>{label}{priced}</button>
      </div>
      {burning && (
        <div className="modal" role="dialog" aria-label="Burn Edge for Not Dead Yet">
          <div className="card burn">
            <h3>BURN EDGE FOR NOT DEAD YET?</h3>
            <p>The blow still lands, but {name} survives it: unconscious and dying, one box short of dead. It does not take them out of the danger they are in.</p>
            <p>
              This costs a point of Edge rank <b>for good</b>
              {edge ? ` (${edge.rank} → ${edge.rank - 1}) and the ${edge.points} Edge ${edge.points === 1 ? "point" : "points"} ${name} holds now` : ""}. It cannot be undone.
            </p>
            <div className="btns">
              <button className="dng" onClick={() => { setBurning(false); send({ type: "roll.edge", requestId: request.id, boost: "not_dead_yet" }); }}>Burn it</button>
              <button className="pri" onClick={() => setBurning(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
