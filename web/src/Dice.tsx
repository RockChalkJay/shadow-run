import type { RollResult } from "@shadow-run/shared";
import { useEffect, useState } from "react";
import { useRules } from "./rules";

/** How long the app's dice tumble before the faces are shown. The server has already rolled them. */
export const TUMBLE_MS = 900;

export function Die({ face, small = false, rolling = false }: { face: number; small?: boolean; rolling?: boolean }) {
  const { hitMinimum } = useRules();
  const kind = rolling ? "roll" : face >= hitMinimum ? "hit" : face === 1 ? "one" : "";
  return <span className={`die ${kind} ${small ? "small" : ""}`}>{rolling ? "" : face}</span>;
}

/** A roll's dice, and any extra dice for exploding 6s or hits bought with Edge. With `tumble` they spin first. */
export function Dice({ roll, small = false, tumble = false }: { roll: RollResult; small?: boolean; tumble?: boolean }) {
  const [rolling, setRolling] = useState(tumble);
  useEffect(() => {
    if (!tumble) return;
    const timer = setTimeout(() => setRolling(false), TUMBLE_MS);
    return () => clearTimeout(timer);
  }, [tumble]);

  const all = [...roll.dice, ...(roll.explosions ?? [])];
  return (
    <span className="dice" aria-label={rolling ? "rolling" : `dice ${all.join(" ")}`}>
      {roll.dice.map((face, i) => <Die key={i} face={face} small={small} rolling={rolling} />)}
      {!rolling && (roll.explosions ?? []).map((face, i) => <Die key={`x${i}`} face={face} small={small} />)}
      {!rolling && roll.bonusHits ? <span className="bought">+{roll.bonusHits} bought {roll.bonusHits === 1 ? "hit" : "hits"}</span> : null}
    </span>
  );
}
