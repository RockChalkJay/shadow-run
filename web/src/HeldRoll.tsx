import type { ClientMessage, EdgeView, RollRequest, RollResult } from "@shadow-run/shared";
import { useState } from "react";
import { HIT } from "./Dice";
import { cannotSpend, COST } from "./edge";

type Tool = "reroll" | "bump" | "buy" | "missed";

const key = (side: "mine" | "theirs", index: number) => `${side}:${index}`;

function PickableDice({ roll, side, on, toggle }: { roll: RollResult; side: "mine" | "theirs"; on: Set<string>; toggle: ((side: "mine" | "theirs", i: number) => void) | null }) {
  return (
    <span className="dice" role="group" aria-label={side === "mine" ? "your dice" : "their dice"}>
      {roll.dice.map((face, i) => {
        const kind = face >= HIT ? "hit" : face === 1 ? "one" : "";
        const picked = on.has(key(side, i));
        return toggle ? (
          <button key={i} className={`die pick ${kind} ${picked ? "on" : ""} ${side === "theirs" ? "small" : ""}`} aria-pressed={picked} aria-label={`${side === "mine" ? "your" : "their"} die ${i + 1}, showing ${face}`} onClick={() => toggle(side, i)}>{face}</button>
        ) : (
          <span key={i} className={`die ${kind} ${side === "theirs" ? "small" : ""}`}>{face}</span>
        );
      })}
      {(roll.explosions ?? []).map((face, i) => <span key={`x${i}`} className={`die ${face >= HIT ? "hit" : ""} ${side === "theirs" ? "small" : ""}`}>{face}</span>)}
      {roll.bonusHits ? <span className="bought">+{roll.bonusHits} bought</span> : null}
    </span>
  );
}

/** A roll the player has counted but not committed: its dice, and what Edge can do to them. */
export function HeldRoll({ request, edge, error, send }: { request: RollRequest; edge: EdgeView | undefined; error: string | null; send: (m: ClientMessage) => void }) {
  const held = request.held!;
  const [tool, setTool] = useState<Tool>("reroll");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [times, setTimes] = useState(1);
  const [byHand, setByHand] = useState(false);
  const [typed, setTyped] = useState("");

  const mine = [...picked].filter((k) => k.startsWith("mine:")).map((k) => Number(k.slice(5)));
  const theirs = [...picked].filter((k) => k.startsWith("theirs:")).map((k) => Number(k.slice(7)));
  const misses = held.roll.dice.filter((d) => d < HIT).length;

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
      : tool === "buy" ? null : picked.size === 0 ? "Pick the dice by clicking them." : tool === "bump" && mine.length === 0 ? "Only your own dice can be raised." : null;
  const poor = cannotSpend(edge, cost);
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

  const label = tool === "reroll" ? `Reroll ${picked.size} ${picked.size === 1 ? "die" : "dice"}` : tool === "bump" ? `Add 1 to ${mine.length} ${mine.length === 1 ? "die" : "dice"}` : tool === "buy" ? `Buy ${times} ${times === 1 ? "hit" : "hits"}` : `Reroll the ${misses} that missed`;
  const needsDice = tool === "reroll" || tool === "missed";

  return (
    <div className="held">
      <p className="hint">Counted, not committed: {held.roll.hits} {held.roll.hits === 1 ? "hit" : "hits"}{held.opponent ? ` against ${held.opponent.hits}` : ""}. Spend Edge on it, or keep it as it stands.</p>
      <PickableDice roll={held.roll} side="mine" on={picked} toggle={tool === "reroll" || tool === "bump" ? toggle : null} />
      {held.opponent && (
        <p className="dim">{request.opposed?.by ?? "Opposition"}: <PickableDice roll={held.opponent} side="theirs" on={picked} toggle={tool === "reroll" ? toggle : null} /> {held.opponent.hits} {held.opponent.hits === 1 ? "hit" : "hits"}</p>
      )}
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
      {needsDice && (
        <>
          <label className="inline"><input type="checkbox" checked={byHand} onChange={(e) => setByHand(e.target.checked)} /> I rolled the new dice myself</label>
          {byHand && <input className="wide" aria-label="new dice" placeholder={tool === "reroll" ? "New values in order: yours first, then theirs" : "New values for each die that missed, in order"} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </>
      )}
      {(reason ?? error) && <p className="problem" role="alert">{reason ?? error}</p>}
      <div className="btns">
        <button className="pri" disabled={reason !== null} onClick={confirm}>{label} · {cost} Edge</button>
        <button onClick={() => send({ type: "roll.keep", requestId: request.id })}>Keep it as it stands</button>
      </div>
    </div>
  );
}
