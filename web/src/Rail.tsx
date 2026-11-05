import type { CharacterSheet, CharacterView, CombatEntry, CombatState, ConditionMonitor, EdgeView } from "@shadow-run/shared";
import { useEffect, useId, useRef, useState } from "react";

// ---- small pieces ----------------------------------------------------------------------------

/** A word or chip that explains itself on hover, keyboard focus or tap. The text is always in the page, so a screen reader reads it with the chip. */
export function Tip({ text, children, className = "" }: { text: string; children: React.ReactNode; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`tip ${className}`}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      {children}
      <span id={id} role="tooltip" className={`tip-text ${open ? "open" : ""}`}>{text}</span>
    </span>
  );
}

const icon = {
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  warn: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>,
  skull: <><circle cx="12" cy="11" r="8" /><path d="M9 19v3h6v-3M9 11h.01M15 11h.01" /></>,
  ok: <path d="M5 12l5 5 9-10" />,
};
function Icon({ name }: { name: keyof typeof icon }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{icon[name]}</svg>;
}

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
const dice = (n: number) => `${n} ${n === 1 ? "die" : "dice"}`;

/** One condition track as a bar, with its numbers on it. */
export function Meter({ label, short, filled, boxes, kind, help }: { label: string; short: string; filled: number; boxes: number; kind: "phy" | "stn" | "ovf"; help: string }) {
  return (
    <div className="meter">
      <Tip text={help} className="meter-label">{short}</Tip>
      <div className="bar" role="img" aria-label={`${label} ${filled} of ${boxes}`}>
        <div className={`fill ${kind}`} style={{ width: `${(filled / boxes) * 100}%` }} />
      </div>
      <span className="meter-num">{filled}/{boxes}</span>
    </div>
  );
}

const PHY = "Physical damage. Each full row of filled boxes costs a die on every roll except resisting damage. When it is full they are out, and more damage goes to overflow.";
const STN = "Stun damage. Each full row of filled boxes costs a die on every roll except resisting damage. When it is full they fall unconscious.";
const OVF = "Damage past the last physical box. When this fills they are dead.";
const GRUNT = "A grunt has one track for all damage. When it is full they are dead if physical damage hit last, unconscious if stun did.";

/** The tracks a character has: three for a named character, one for a grunt. */
export function Tracks({ character }: { character: CharacterView }) {
  const m: ConditionMonitor = character.monitor;
  if (character.grunt) return <Meter label="Damage" short="DMG" filled={m.physical} boxes={m.physicalBoxes} kind="phy" help={GRUNT} />;
  return (
    <>
      <Meter label="Physical" short="PHY" filled={m.physical} boxes={m.physicalBoxes} kind="phy" help={PHY} />
      <Meter label="Stun" short="STN" filled={m.stun} boxes={m.stunBoxes} kind="stn" help={STN} />
      {m.overflow > 0 && <Meter label="Overflow" short="OVF" filled={m.overflow} boxes={m.overflowBoxes} kind="ovf" help={OVF} />}
    </>
  );
}

const STATUS = {
  active: { word: "OK", help: "Can act.", icon: "ok" },
  unconscious: { word: "DOWN", help: "Unconscious: out of the action until healed.", icon: "warn" },
  dead: { word: "DEAD", help: "Dead.", icon: "skull" },
} as const;

export function StatusChip({ status }: { status: CharacterView["status"] }) {
  const s = STATUS[status];
  return (
    <Tip text={s.help} className={`chip ${status}`}>
      <Icon name={s.icon} /> {s.word}
    </Tip>
  );
}

// ---- the party -------------------------------------------------------------------------------

export function PartyCard({ sheet, view, edge, speaking, onSpeak }: { sheet: CharacterSheet; view: CharacterView | undefined; edge: EdgeView | undefined; speaking: boolean; onSpeak: (id: string) => void }) {
  const status = view?.status ?? "active";
  return (
    <div className={`pcard ${status} ${speaking ? "speaking" : ""}`}>
      <div className="head">
        <button className="name" aria-pressed={speaking} title={`Speak as ${sheet.name}`} onClick={() => onSpeak(sheet.id)}>{sheet.name}</button>
        <span className="meta">{sheet.metatype}</span>
        {view && <StatusChip status={status} />}
      </div>
      {view && <Tracks character={view} />}
      <div className="tags">
        {view && view.woundModifier > 0 && (
          <Tip className="tag warn" text={`Wounds cost ${dice(view.woundModifier)} on every roll except resisting damage.`}>
            <Icon name="warn" /> −{dice(view.woundModifier)}
          </Tip>
        )}
        {edge && (
          <Tip className="tag edge" text={`${edge.points} Edge ${edge.points === 1 ? "point" : "points"} on hand; Edge rank ${edge.rank}, which a session starts with.${edge.spentThisRound ? " Edge is already spent this round." : ""}`}>
            <Icon name="bolt" /> Edge {edge.points}
          </Tip>
        )}
      </div>
    </div>
  );
}

export function PartyPanel({ party, characters, edge, speaking, onSpeak }: { party: CharacterSheet[]; characters: CharacterView[]; edge: EdgeView[]; speaking: string | undefined; onSpeak: (id: string) => void }) {
  return (
    <section aria-label="Party">
      <h4>PARTY</h4>
      {party.map((sheet) => (
        <PartyCard key={sheet.id} sheet={sheet} view={characters.find((c) => c.kind === "pc" && c.id === sheet.id)} edge={edge.find((e) => e.id === sheet.id)} speaking={speaking === sheet.id} onSpeak={onSpeak} />
      ))}
    </section>
  );
}

// ---- the fight -------------------------------------------------------------------------------

const statusOf = (characters: CharacterView[], m: { kind: "pc" | "npc"; id: string }) => characters.find((c) => c.kind === m.kind && c.id === m.id)?.status ?? "active";

/** Who acts first, second and so on each round. The initiative score that put them there is in a tooltip, not on the row. */
export function TurnStrip({ combat, characters }: { combat: CombatState; characters: CharacterView[] }) {
  return (
    <section className="turns" aria-label={`Acting order, round ${combat.round}`}>
      <header className="turns-head">
        <h4>ACTING ORDER</h4>
        <span className="round">ROUND {combat.round}</span>
      </header>
      <ol>
        {combat.order.map((entry, i) => {
          const out = entry.members.every((m) => statusOf(characters, m) !== "active");
          return (
            <li key={i} className={out ? "out" : ""}>
              <Tip className="place" text={`Acts ${ordinal(i + 1)} each round. Initiative ${entry.score}: Reaction + Intuition + dice; ties go to Edge, then Reaction, then Intuition.`}>{i + 1}</Tip>
              <span className="turn-who">
                <span className="turn-name">{entry.members.map((m) => m.name).join(", ")}</span>
                {entry.group !== undefined && <span className="sub">act together</span>}
                {entry.bonus ? <span className="sub">+{entry.bonus} initiative from next round</span> : null}
                {out && <span className="sub">out of the fight</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---- opposition ------------------------------------------------------------------------------

function groupsOf(combat: CombatState | null, npcs: CharacterView[]): { entry: CombatEntry; members: CharacterView[] }[] {
  if (!combat) return [];
  return combat.order
    .filter((e) => e.group !== undefined && e.members.length > 1)
    .map((entry) => ({ entry, members: entry.members.map((m) => npcs.find((c) => c.id === m.id)).filter((c): c is CharacterView => c !== undefined) }))
    .filter((g) => g.members.length > 1);
}

function GruntRow({ character }: { character: CharacterView }) {
  const out = character.status !== "active";
  return (
    <div className={`mem ${out ? "out" : ""}`}>
      <span className="mem-name">{character.name}</span>
      <Tracks character={character} />
    </div>
  );
}

export function OppositionPanel({ characters, combat }: { characters: CharacterView[]; combat: CombatState | null }) {
  const npcs = characters.filter((c) => c.kind === "npc");
  if (npcs.length === 0) return null;
  const groups = groupsOf(combat, npcs);
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const rest = npcs.filter((c) => !grouped.has(c.id));

  return (
    <section aria-label="Opposition">
      <h4>OPPOSITION</h4>
      {groups.map(({ entry, members }) => {
        const down = members.filter((m) => m.status !== "active").length;
        const rating = members[0]?.grunt?.professionalRating;
        return (
          <details key={entry.group} className="grp">
            <summary>
              <span className="name-plain">{entry.group}</span>
              {rating !== undefined && <Tip className="tag" text={`Nameless opposition with one condition track each. Professional Rating ${rating} decides when they test their nerve.`}>grunts · rating {rating}</Tip>}
              <Tip className="count" text="How many are in this group, and how many are down.">×{members.length}{down > 0 ? ` · ${down} down` : ""}</Tip>
            </summary>
            {members.map((m) => <GruntRow key={m.id} character={m} />)}
          </details>
        );
      })}
      {rest.map((c) => (
        <div key={c.id} className={`pcard npc ${c.status}`}>
          <div className="head">
            <span className="name-plain">{c.name}</span>
            {c.grunt && (
              <Tip className="tag" text={`Nameless opposition with one condition track. Professional Rating ${c.grunt.professionalRating} decides when they test their nerve.${c.grunt.lieutenant ? " A lieutenant has a longer track." : ""}`}>
                grunt · rating {c.grunt.professionalRating}{c.grunt.lieutenant ? " · lieutenant" : ""}
              </Tip>
            )}
            <StatusChip status={c.status} />
          </div>
          {c.status !== "dead" && <Tracks character={c} />}
        </div>
      ))}
    </section>
  );
}

// ---- announcements ---------------------------------------------------------------------------

/** What changed in how hurt people are, in words a screen reader can say. */
export function announcements(before: CharacterView[], after: CharacterView[]): string[] {
  const said: string[] = [];
  for (const c of after) {
    const was = before.find((b) => b.kind === c.kind && b.id === c.id);
    if (!was) continue;
    if (c.status !== was.status) {
      said.push(c.status === "dead" ? `${c.name} is dead.` : c.status === "unconscious" ? `${c.name} is down.` : `${c.name} is back on their feet.`);
    } else if (c.monitor.physical > was.monitor.physical || c.monitor.stun > was.monitor.stun || c.monitor.overflow > was.monitor.overflow) {
      said.push(`${c.name} is hurt: physical ${c.monitor.physical} of ${c.monitor.physicalBoxes}, stun ${c.monitor.stun} of ${c.monitor.stunBoxes}.`);
    }
  }
  return said;
}

function Announcer({ characters }: { characters: CharacterView[] }) {
  const before = useRef<CharacterView[] | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (before.current) {
      const said = announcements(before.current, characters);
      if (said.length > 0) setText(said.join(" "));
    }
    before.current = characters;
  }, [characters]);
  return <div className="sr-only" aria-live="polite">{text}</div>;
}

// ---- the whole rail --------------------------------------------------------------------------

export function Rail({ party, characters, edge, combat, speaking, onSpeak }: { party: CharacterSheet[]; characters: CharacterView[]; edge: EdgeView[]; combat: CombatState | null; speaking: string | undefined; onSpeak: (id: string) => void }) {
  return (
    <aside className="rail" aria-label="The table's status">
      {combat && <TurnStrip combat={combat} characters={characters} />}
      <PartyPanel party={party} characters={characters} edge={edge} speaking={speaking} onSpeak={onSpeak} />
      <OppositionPanel characters={characters} combat={combat} />
      <Announcer characters={characters} />
    </aside>
  );
}
