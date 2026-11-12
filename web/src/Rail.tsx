import type { CharacterSheet, CharacterView, ClientMessage, CombatState, ConditionMonitor, EdgeView, RollRequest } from "@shadow-run/shared";
import { useEffect, useId, useRef, useState } from "react";
import { EdgeMenu, EdgeTableContext } from "./EdgeMenu";

// ---- small pieces ----------------------------------------------------------------------------

/**
 * A word or chip that explains itself on hover, keyboard focus or tap. The text is always in the page, so a screen reader reads it with the chip.
 * Around something that is already focusable (a button), pass `focusable={false}` so there is one tab stop, and `id` so the button can point at the text with aria-describedby.
 */
export function Tip({ text, children, className = "", focusable = true, id }: { text: string; children: React.ReactNode; className?: string; focusable?: boolean; id?: string }) {
  const generated = useId();
  const textId = id ?? generated;
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`tip ${className}`}
      {...(focusable && { tabIndex: 0, "aria-describedby": textId })}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      {children}
      <span id={textId} role="tooltip" className={`tip-text ${open ? "open" : ""}`}>{text}</span>
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

// ---- cards -----------------------------------------------------------------------------------

/** Where a side stands in the acting order, and the initiative that put it there. */
export interface Place {
  n: number;
  score: number;
  /** Initiative bought with Edge, which counts from the next round. */
  bonus?: number | undefined;
}

function PlaceBadge({ place }: { place: Place }) {
  return (
    <Tip className="place" text={`Acts ${ordinal(place.n)} each round. Initiative ${place.score}: Reaction + Intuition + dice; ties go to Edge, then Reaction, then Intuition.`}>
      {place.n}
    </Tip>
  );
}

function BonusTag({ place }: { place: Place | undefined }) {
  if (!place?.bonus) return null;
  return <Tip className="tag edge" text="Edge bought extra initiative, which counts from the next round.">+{place.bonus} initiative next round</Tip>;
}

export function PartyCard({ sheet, view, edge, speaking, onSpeak, place }: { sheet: CharacterSheet; view: CharacterView | undefined; edge: EdgeView | undefined; speaking: boolean; onSpeak: (id: string) => void; place?: Place | undefined }) {
  const status = view?.status ?? "active";
  return (
    <div className={`pcard ${status} ${speaking ? "speaking" : ""}`}>
      <div className="head">
        {place && <PlaceBadge place={place} />}
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
        <BonusTag place={place} />
        {edge?.spentThisRound && <Tip className="tag" text="Edge is already spent this round: only one expenditure a round.">spent this round</Tip>}
      </div>
      <EdgeMenu sheet={sheet} view={view} edge={edge} />
    </div>
  );
}

const gruntHelp = (rating: number, lieutenant = false) =>
  `Nameless opposition with one condition track. Professional Rating ${rating} decides when they test their nerve.${lieutenant ? " A lieutenant has a longer track." : ""}`;

/** A non-player character: a named one with their tracks, a grunt on their own with theirs. */
export function NpcCard({ character, place }: { character: CharacterView; place?: Place | undefined }) {
  const c = character;
  return (
    <div className={`pcard npc ${c.status}`}>
      <div className="head">
        {place && <PlaceBadge place={place} />}
        <span className="name-plain">{c.name}</span>
        {c.grunt && (
          <Tip className="tag" text={gruntHelp(c.grunt.professionalRating, c.grunt.lieutenant)}>
            grunt · rating {c.grunt.professionalRating}{c.grunt.lieutenant ? " · lieutenant" : ""}
          </Tip>
        )}
        <StatusChip status={c.status} />
      </div>
      {c.status !== "dead" && <Tracks character={c} />}
      <div className="tags"><BonusTag place={place} /></div>
    </div>
  );
}

function GruntRow({ character }: { character: CharacterView }) {
  return (
    <div className={`mem ${character.status !== "active" ? "out" : ""}`}>
      <span className="mem-name">{character.name}</span>
      <Tracks character={character} />
    </div>
  );
}

/** Grunts who act together: one row saying how many and how many are down, opening to each. */
export function GroupRow({ label, members, place }: { label: string; members: CharacterView[]; place?: Place | undefined }) {
  const down = members.filter((m) => m.status !== "active").length;
  const rating = members[0]?.grunt?.professionalRating;
  return (
    <details className="grp">
      <summary>
        {place && <PlaceBadge place={place} />}
        <span className="name-plain">{label}</span>
        {rating !== undefined && <Tip className="tag" text={gruntHelp(rating)}>grunts · rating {rating}</Tip>}
        <Tip className="count" text="How many are in this group, and how many are down.">×{members.length}{down > 0 ? ` · ${down} down` : ""}</Tip>
        <BonusTag place={place} />
      </summary>
      {members.map((m) => <GruntRow key={m.id} character={m} />)}
    </details>
  );
}

// ---- out of a fight --------------------------------------------------------------------------

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

export function OppositionPanel({ characters }: { characters: CharacterView[] }) {
  const npcs = characters.filter((c) => c.kind === "npc");
  if (npcs.length === 0) return null;
  return (
    <section aria-label="Opposition">
      <h4>OPPOSITION</h4>
      {npcs.map((c) => <NpcCard key={c.id} character={c} />)}
    </section>
  );
}

// ---- in a fight ------------------------------------------------------------------------------

type Props = { party: CharacterSheet[]; characters: CharacterView[]; edge: EdgeView[]; speaking: string | undefined; onSpeak: (id: string) => void };

/**
 * A fight is one list in acting order: each side's card, or a group of grunts as one row, with its place on it. Anyone
 * the GM has put on the table who is not in the order follows.
 */
export function FightList({ combat, party, characters, edge, speaking, onSpeak }: Props & { combat: CombatState }) {
  const find = (m: { kind: "pc" | "npc"; id: string }) => characters.find((c) => c.kind === m.kind && c.id === m.id);
  const inOrder = new Set(combat.order.flatMap((e) => e.members.map((m) => `${m.kind}:${m.id}`)));
  const sheetCard = (id: string, place?: Place) => {
    const sheet = party.find((p) => p.id === id);
    return sheet && <PartyCard key={`pc:${id}`} sheet={sheet} view={find({ kind: "pc", id })} edge={edge.find((e) => e.id === id)} speaking={speaking === id} onSpeak={onSpeak} place={place} />;
  };

  return (
    <section aria-label={`Fight, round ${combat.round}`}>
      <header className="fight-head">
        <h4>FIGHT</h4>
        <span className="round">ROUND {combat.round}</span>
      </header>
      <ol className="acting">
        {combat.order.map((entry, i) => {
          const place: Place = { n: i + 1, score: entry.score, bonus: entry.bonus };
          const views = entry.members.map(find).filter((c): c is CharacterView => c !== undefined);
          const out = views.length > 0 && views.every((c) => c.status !== "active");
          const [only] = entry.members;
          return (
            <li key={i} className={out ? "out" : ""}>
              {entry.group !== undefined && entry.members.length > 1 ? (
                <GroupRow label={entry.group} members={views} place={place} />
              ) : only?.kind === "pc" ? (
                sheetCard(only.id, place)
              ) : views[0] ? (
                <NpcCard character={views[0]} place={place} />
              ) : null}
            </li>
          );
        })}
      </ol>
      {(party.some((p) => !inOrder.has(`pc:${p.id}`)) || characters.some((c) => c.kind === "npc" && !inOrder.has(`npc:${c.id}`))) && (
        <div className="bystanders">
          <h4>NOT IN THE FIGHT</h4>
          {party.filter((p) => !inOrder.has(`pc:${p.id}`)).map((p) => sheetCard(p.id))}
          {characters.filter((c) => c.kind === "npc" && !inOrder.has(`npc:${c.id}`)).map((c) => <NpcCard key={c.id} character={c} />)}
        </div>
      )}
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

export function Rail({ combat, send = () => {}, pending = [], error = null, ...props }: Props & { combat: CombatState | null; send?: (message: ClientMessage) => void; pending?: RollRequest[]; error?: string | null }) {
  return (
    <EdgeTableContext.Provider value={{ party: props.party, characters: props.characters, edge: props.edge, combat, pending, error, send }}>
    <aside className="rail" aria-label="The table's status">
      {combat ? (
        <FightList combat={combat} {...props} />
      ) : (
        <>
          <PartyPanel {...props} />
          <OppositionPanel characters={props.characters} />
        </>
      )}
      <Announcer characters={props.characters} />
    </aside>
    </EdgeTableContext.Provider>
  );
}
