import type { CharacterSheet, CharacterView, CombatState } from "@shadow-run/shared";
import { useState } from "react";

/** One track of condition boxes, filled boxes lit. */
export function Track({ label, filled, boxes }: { label: string; filled: number; boxes: number }) {
  return (
    <div className="track" role="img" aria-label={`${label} ${filled} of ${boxes}`}>
      <span className="track-label">{label}</span>
      <span className="boxes">
        {Array.from({ length: boxes }, (_, i) => <i key={i} className={i < filled ? "f" : ""} />)}
      </span>
      <span className="track-count">{filled}/{boxes}</span>
    </div>
  );
}

function statusNote(c: CharacterView): string | null {
  if (c.status === "dead") return "DEAD";
  if (c.status === "unconscious") return c.grunt ? "UNCONSCIOUS" : "UNCONSCIOUS · dying if overflow fills";
  return null;
}

/** A character's health: the tracks a named character has, or the single track of a grunt. */
export function Health({ character }: { character: CharacterView }) {
  const { monitor: m, grunt } = character;
  return (
    <div className="health">
      {grunt ? <Track label="Damage" filled={m.physical} boxes={m.physicalBoxes} /> : (
        <>
          <Track label="Physical" filled={m.physical} boxes={m.physicalBoxes} />
          <Track label="Stun" filled={m.stun} boxes={m.stunBoxes} />
          {m.overflow > 0 && <Track label="Overflow" filled={m.overflow} boxes={m.overflowBoxes} />}
        </>
      )}
      {character.woundModifier > 0 && <div className="wound">−{character.woundModifier} {character.woundModifier === 1 ? "die" : "dice"} on every roll but resisting damage</div>}
    </div>
  );
}

export function PartyPanel({ party, characters, speaking }: { party: CharacterSheet[]; characters: CharacterView[]; speaking: string | undefined }) {
  return (
    <div>
      <h4>PARTY</h4>
      {party.map((sheet) => {
        const view = characters.find((c) => c.kind === "pc" && c.id === sheet.id);
        const note = view && statusNote(view);
        return (
          <div key={sheet.id} className={`member ${view?.status ?? ""} ${speaking === sheet.id ? "speaking" : ""}`}>
            <div className="member-name"><b>{sheet.name}</b> <span className="dim">{sheet.metatype}</span>{note && <span className="status">{note}</span>}</div>
            {view && <Health character={view} />}
          </div>
        );
      })}
    </div>
  );
}

/** The non-player characters the GM has put on the table: one line each, opening to their boxes. */
export function NpcPanel({ characters }: { characters: CharacterView[] }) {
  const npcs = characters.filter((c) => c.kind === "npc");
  const [open, setOpen] = useState<string[]>([]);
  if (npcs.length === 0) return null;
  return (
    <div>
      <h4>ON THE TABLE</h4>
      {npcs.map((c) => {
        const shown = open.includes(c.id);
        const tag = c.grunt ? `grunt · rating ${c.grunt.professionalRating}${c.grunt.lieutenant ? " · lieutenant" : ""}` : null;
        return (
          <div key={c.id} className={`npc ${c.status}`}>
            <button className="tog inline" aria-expanded={shown} onClick={() => setOpen((o) => (shown ? o.filter((x) => x !== c.id) : [...o, c.id]))}>
              {shown ? "▾" : "▸"} <b>{c.name}</b> {tag && <span className="dim">{tag}</span>}
              <span className="status">{c.status === "active" ? `${c.monitor.physical + (c.grunt ? 0 : c.monitor.stun)} hurt` : c.status.toUpperCase()}</span>
            </button>
            {shown && <Health character={c} />}
          </div>
        );
      })}
    </div>
  );
}

/** The fight's order, highest first, while one is on. */
export function FightPanel({ combat, characters }: { combat: CombatState | null; characters: CharacterView[] }) {
  if (!combat) return null;
  const statusOf = (m: { kind: "pc" | "npc"; id: string }) => characters.find((c) => c.kind === m.kind && c.id === m.id)?.status;
  return (
    <div>
      <h4>FIGHT · ROUND {combat.round}</h4>
      <ol className="order">
        {combat.order.map((entry, i) => {
          const allDown = entry.members.every((m) => (statusOf(m) ?? "active") !== "active");
          return (
            <li key={i} className={allDown ? "down" : ""}>
              <span className="score">{entry.score}</span>
              <span>
                {entry.members.map((m) => m.name).join(", ")}
                {entry.group !== undefined && <span className="dim"> (acting together)</span>}
                {entry.bonus ? <span className="dim"> (+{entry.bonus} next round)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
