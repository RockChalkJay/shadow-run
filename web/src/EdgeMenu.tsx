import type { CharacterSheet, CharacterView, ClientMessage, CombatState, EdgeView, RollRequest } from "@shadow-run/shared";
import { createContext, useContext, useEffect, useState } from "react";
import { actionTakesTheEdge, cannotSpend } from "./edge";

/** What every Edge menu on the side panel needs to know about the table. */
export interface EdgeTable {
  party: CharacterSheet[];
  characters: CharacterView[];
  edge: EdgeView[];
  combat: CombatState | null;
  pending: RollRequest[];
  /** What the server last refused. */
  error: string | null;
  send: (message: ClientMessage) => void;
}

export const EdgeTableContext = createContext<EdgeTable | null>(null);

/** What each way of spending Edge off a roll costs in the core rules (PDF pp. 47-48). The server charges and checks. */
export const USE_COST = { giveAlly: 2, healStun: 3, healPhysical: 4, initiative: 1, specialEffect: 5 } as const;

export const MIN_EFFECT = 5;

type Use = "give_ally" | "heal_stun" | "heal_physical" | "initiative" | "special_effect";

/** Why this use cannot be made now, or null if it can. Anything that stops the character spending Edge at all comes first. */
export function cannotUse(use: Use, who: { view: CharacterView | undefined; edge: EdgeView | undefined; combat: CombatState | null; id: string; allies: number }, effect = ""): string | null {
  const { view, edge, combat, id } = who;
  if (view?.status === "dead") return "Dead.";
  const cost = { give_ally: USE_COST.giveAlly, heal_stun: USE_COST.healStun, heal_physical: USE_COST.healPhysical, initiative: USE_COST.initiative, special_effect: USE_COST.specialEffect }[use];
  const poor = cannotSpend(edge, cost);
  if (use === "give_ally") {
    if (!combat) return "Edge is gained only in a fight, so it can be given only in one.";
    if (who.allies === 0) return "No one else who is on their feet can gain Edge.";
  }
  if (use === "heal_stun" && view && view.monitor.stun === 0) return "No stun damage to heal.";
  if (use === "heal_physical" && view && view.monitor.physical === 0) return "No physical damage to heal.";
  if (use === "initiative") {
    if (!combat) return "Not in a fight.";
    if (!combat.order.some((e) => e.members.some((m) => m.kind === "pc" && m.id === id))) return "Not in this fight.";
  }
  if (use === "special_effect" && effect.trim().length < MIN_EFFECT) return poor ?? `Describe it first, in at least ${MIN_EFFECT} characters.`;
  return poor;
}

/** The Edge menu on a party card: the ways to spend Edge that are not on a roll. */
export function EdgeMenu({ sheet, view, edge }: { sheet: CharacterSheet; view: CharacterView | undefined; edge: EdgeView | undefined }) {
  const table = useContext(EdgeTableContext);
  const [open, setOpen] = useState(false);
  const [ally, setAlly] = useState("");
  const [effect, setEffect] = useState("");
  const [sent, setSent] = useState(false);

  // A use that went through spends Edge, so the menu closes on its own; one that was refused stays to show why.
  const points = edge?.points;
  const spent = edge?.spentThisRound;
  useEffect(() => {
    setOpen(false);
    setSent(false);
    setEffect("");
  }, [points, spent]);

  if (!table || !edge) return null;
  const { send, combat } = table;
  const allies = table.party.filter((p) => p.id !== sheet.id && table.characters.find((c) => c.kind === "pc" && c.id === p.id)?.status === "active" && table.edge.some((e) => e.id === p.id));
  const target = allies.some((a) => a.id === ally) ? ally : (allies[0]?.id ?? "");
  const who = { view, edge, combat, id: sheet.id, allies: allies.length };
  const waiting = table.pending.find((r) => r.characterId === sheet.id && actionTakesTheEdge(r, edge) !== null);

  const use = (kind: Use, extra: Partial<Extract<ClientMessage, { type: "edge.use" }>> = {}) => {
    setSent(true);
    send({ type: "edge.use", characterId: sheet.id, use: kind, ...extra });
  };
  const rows: Array<{ kind: Use; label: string; cost: number; detail?: string; extra?: Partial<Extract<ClientMessage, { type: "edge.use" }>> }> = [
    { kind: "give_ally", label: "Give an ally 1 Edge", cost: USE_COST.giveAlly, extra: { allyId: target } },
    { kind: "heal_stun", label: "Clear a box of stun damage", cost: USE_COST.healStun },
    { kind: "heal_physical", label: "Clear a box of physical damage", cost: USE_COST.healPhysical },
    { kind: "initiative", label: "Add 3 to initiative from the next round", cost: USE_COST.initiative },
    { kind: "special_effect", label: "Create a special effect", cost: USE_COST.specialEffect, detail: "Something fortuitous happens; the GM decides what.", extra: { description: effect.trim() } },
  ];

  return (
    <div className="edge-menu">
      <button className="tog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} Spend Edge</button>
      {open && (
        <div className="more">
          {waiting?.edgeAction && <p className="problem">{waiting.edgeAction.name} is declared on a roll that is waiting, and uses this round's Edge. Spending Edge here makes it fail.</p>}
          {rows.map((row) => {
            const reason = cannotUse(row.kind, who, effect);
            return (
              <div key={row.kind} className={`use ${reason ? "off" : ""}`}>
                <div className="use-main">
                  <span>{row.label} · {row.cost} Edge</span>
                  <button className="pri" disabled={reason !== null} title={reason ?? undefined} onClick={() => use(row.kind, row.extra)}>Spend</button>
                </div>
                {row.kind === "give_ally" && allies.length > 0 && (
                  <label className="inline">To <select aria-label="Give Edge to" value={target} onChange={(e) => setAlly(e.target.value)} className="num">{allies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                )}
                {row.kind === "special_effect" && <input className="wide" aria-label="Describe the special effect" placeholder="What does the player have in mind?" maxLength={300} value={effect} onChange={(e) => setEffect(e.target.value)} />}
                <small>{reason ?? row.detail ?? ""}</small>
              </div>
            );
          })}
          {sent && table.error && <p className="problem" role="alert">{table.error}</p>}
        </div>
      )}
    </div>
  );
}
