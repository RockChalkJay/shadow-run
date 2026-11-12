import type { TranscriptEntry } from "@shadow-run/shared";
import { useState } from "react";
import { Dice } from "./Dice";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A finished roll: one line, which opens to show the dice. A roll that has just arrived is open and its dice tumble. */
function RollEntry({ entry, fresh, nameOf }: { entry: Extract<TranscriptEntry, { kind: "roll" }>; fresh: boolean; nameOf: (id: string) => string }) {
  const [shown, setShown] = useState(false);
  const { resolved } = entry;
  const { request, roll, opposed, outcome } = resolved;
  const open = fresh || shown;
  const sideRoll = request.soak || request.attack;
  const who = nameOf(request.characterId);
  const verdict = resolved.burn?.kind === "smackdown" ? "SMACKDOWN" : outcome.success ? "SUCCESS" : "FAILURE";
  const summary = sideRoll
    ? `${who} · ${request.label} · ${plural(roll.hits, "hit")}`
    : `${who} · ${request.label} · ${plural(roll.hits, "hit")}${opposed ? ` vs ${opposed.roll.hits}` : ""} · ${verdict}`;

  return (
    <div className={`log ${outcome.success || sideRoll ? "good" : "bad"}`}>
      <button className="tog inline" aria-expanded={open} onClick={() => setShown((s) => !s)}>
        <b>{sideRoll ? "🎲" : outcome.success ? "✔" : "✘"}</b> {summary} <span className="dim">{open ? "▾ hide dice" : "▸ show dice"}</span>
      </button>
      {open && (
        <div className="result">
          {resolved.source === "smackdown" ? (
            <p>No dice: {who} burned Edge for Smackdown, an automatic success with 4 net hits.</p>
          ) : (
            <Dice roll={roll} tumble={fresh && resolved.source === "app"} />
          )}
          {opposed && (
            <p className="dim">
              Opposed by {opposed.by}: <Dice roll={opposed.roll} small /> {plural(opposed.roll.hits, "hit")}
            </p>
          )}
          {!sideRoll && (
            <p className={outcome.success ? "ok" : "bad"}>
              {verdict}{outcome.netHits > 0 ? ` by ${plural(outcome.netHits, "net hit")}` : ""}
              {roll.criticalGlitch ? " · CRITICAL GLITCH" : roll.glitch ? " · GLITCH" : ""}
              <span className="plain"> {outcome.consequence}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function plain(entry: TranscriptEntry): string | null {
  switch (entry.kind) {
    case "roll_cancelled": return `Roll skipped: ${entry.label}`;
    case "npc": return `${entry.label}: ${plural(entry.roll.hits, "hit")}${entry.success === undefined ? "" : entry.success ? ", success" : ", failure"}`;
    case "damage": return `${entry.after.name} resists ${entry.damageValue} ${entry.damageType} damage (${entry.label}) and takes ${entry.taken}${entry.after.status === "dead" ? ". DEAD" : entry.after.status === "unconscious" ? ". Unconscious" : ""}`;
    case "attack": return `${entry.attacker} ${entry.hit ? "hits" : "misses"} ${entry.defender} with ${entry.weapon.name}${entry.hit && entry.damageValue > 0 ? ` for Damage Value ${entry.damageValue}` : ""}${entry.edgeAction ? ` (${entry.edgeAction})` : ""}`;
    case "heal": return `${entry.reason}: ${entry.after.name} heals ${entry.healed} ${entry.type}`;
    case "edge": return entry.gained < 0 ? `${entry.name} loses ${-entry.gained} Edge: ${entry.reason}` : `${entry.name} gains ${entry.gained} Edge: ${entry.reason}`;
    case "edge_use": return `${entry.name} spends ${entry.cost} Edge and ${entry.detail}`;
    case "edge_burn": return `${entry.name} burns Edge for ${entry.burn === "smackdown" ? "Smackdown" : "Not Dead Yet"}: rank ${entry.rank} left`;
    case "combat": return entry.event === "end" ? "The fight is over" : `Fight ${entry.event === "start" ? "begins" : entry.event === "join" ? "gains" : "moves to"} round ${entry.round}: ${entry.names.join(", ")}`;
    case "session": return entry.event === "start" ? `Session ${entry.number} begins${entry.mission ? `: ${entry.mission}` : ""}` : `Session ${entry.number} is over`;
    case "system": return entry.text;
    default: return null;
  }
}

export function Story({ transcript, streaming, fresh, nameOf }: { transcript: TranscriptEntry[]; streaming: string[]; fresh: number[]; nameOf: (id: string) => string }) {
  return (
    <>
      {transcript.map((entry) => {
        switch (entry.kind) {
          case "say":
            return <div key={entry.id} className="say"><b>{entry.name}:</b> {entry.text}</div>;
          case "gm":
            return <div key={entry.id} className="gm"><div className="who">The GM</div>{entry.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>;
          case "roll":
            return <RollEntry key={entry.id} entry={entry} fresh={fresh.includes(entry.id)} nameOf={nameOf} />;
          default: {
            const text = plain(entry);
            return text ? <div key={entry.id} className="note">{text}</div> : null;
          }
        }
      })}
      {streaming.some((b) => b.length > 0) && (
        <div className="gm">
          <div className="who">The GM</div>
          {streaming.map((p, i) => <p key={i}>{p}{i === streaming.length - 1 && <span className="cur" />}</p>)}
        </div>
      )}
    </>
  );
}
