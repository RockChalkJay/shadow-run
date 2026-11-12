import { SKILL_NAMES, type CharacterSheet, type Skill, type WeaponDamage } from "@shadow-run/shared";

const ATTRIBUTES = ["body", "agility", "reaction", "strength", "willpower", "logic", "intuition", "charisma"] as const;
const cap = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** The most entries of one list the GM is told about; the rest are counted, so a long list cannot swamp the prompt. */
const MAX_TOLD = 15;

/** The longest backstory the GM is told, and how many of the latest runs. */
const MAX_BACKSTORY = 600;
const RECENT_RUNS = 5;

/** The longest a note is when the GM is told it, so a sheet full of long notes cannot swamp the prompt. */
const MAX_NOTE = 120;
const short = (text: string) => (text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1)}…` : text);

/** Ends a line with one full stop, whether or not what was written already did. */
const sentence = (text: string) => `${text.replace(/\.+$/, "")}.`;

/** "Label: a, b, c." for a list, or nothing when it is empty or missing. */
function listed<T>(label: string, items: readonly T[] | undefined, show: (item: T) => string): string[] {
  if (!items || items.length === 0) return [];
  const shown = items.slice(0, MAX_TOLD).map(show).join("; ");
  const more = items.length > MAX_TOLD ? `; and ${items.length - MAX_TOLD} more` : "";
  return [sentence(`${label}: ${shown}${more}`)];
}

/** A name with its rating and notes: "Name 3 (notes)". */
const named = (item: { name: string; rating?: number | undefined; notes?: string | undefined }) =>
  `${item.name}${item.rating !== undefined ? ` ${item.rating}` : ""}${item.notes ? ` (${short(item.notes)})` : ""}`;

const damage = (d: WeaponDamage) => `DV ${d.value}${d.type === "physical" ? "P" : "S"}`;

/** The Attack Rating at each range a weapon reaches, closest first: "close 10, near 9". */
const ranges = (r: Record<string, number | undefined>) =>
  Object.entries(r)
    .filter(([, rating]) => rating !== undefined)
    .map(([range, rating]) => `${range} ${rating}`)
    .join(", ");

/** What the GM is told about a character, written from the sheet so that the numbers it reads are the sheet's own. */
export function describeCharacter(sheet: CharacterSheet): string {
  const a = sheet.attributes;
  const numbers = [...ATTRIBUTES.map((name) => `${cap(name)} ${a[name]}`), `Edge ${a.edge}`, `Essence ${a.essence}`];
  if (a.magic > 0) numbers.push(`Magic ${a.magic}`);
  if (a.resonance > 0) numbers.push(`Resonance ${a.resonance}`);

  const skills = (Object.keys(SKILL_NAMES) as Skill[])
    .filter((skill) => sheet.skills[skill] !== undefined)
    .map((skill) => `${SKILL_NAMES[skill]} ${sheet.skills[skill]}`);
  const specializations = sheet.specializations.map((s) => `${s.name} (${SKILL_NAMES[s.skill]}, ${s.expertise ? "expertise +3" : "+2"})`);

  const parts = [
    `${cap(sheet.metatype)}.`,
    `${numbers.join(", ")}.`,
    `Initiative: Reaction + Intuition = ${a.reaction + a.intuition}, plus ${sheet.initiativeDice}D6.`,
    skills.length > 0 ? `Skills: ${skills.join(", ")}.` : "No skills.",
  ];
  if (specializations.length > 0) parts.push(`Specializations: ${specializations.join(", ")}.`);
  if (typeof sheet.gear === "string") {
    if (sheet.gear) parts.push(`Gear: ${sheet.gear}`);
  } else {
    parts.push(...listed("Gear", sheet.gear, named));
  }
  if (typeof sheet.qualities === "string") {
    if (sheet.qualities) parts.push(`Qualities: ${sheet.qualities}`);
  } else {
    parts.push(...listed("Qualities", sheet.qualities, (q) => `${named(q)}${q.type ? ` [${q.type}]` : ""}`));
  }
  parts.push(...personal(sheet));
  parts.push(...listed("Knowledge and languages", sheet.knowledge, (k) => `${k.name} ${k.rating}${k.type === "language" ? " (language)" : ""}`));
  parts.push(...listed("Ranged weapons", sheet.rangedWeapons, (w) => [`${w.name}${w.primary ? " (primary)" : ""} ${damage(w.damage)}`, w.mode, w.ranges ? `Attack Rating ${ranges(w.ranges)}` : undefined, w.ammo ? `ammo ${w.ammo}` : undefined, w.notes ? short(w.notes) : undefined].filter(Boolean).join(", ")));
  parts.push(...listed("Melee weapons", sheet.meleeWeapons, (w) => [`${w.name}${w.primary ? " (primary)" : ""} ${damage(w.damage)}`, w.close !== undefined ? `Attack Rating ${w.close}` : undefined, w.notes ? short(w.notes) : undefined].filter(Boolean).join(", ")));
  parts.push(...listed("Armor", sheet.armor, (a) => `${a.name}${a.primary ? " (primary)" : ""} ${a.rating}${a.notes ? ` (${short(a.notes)})` : ""}`));
  parts.push(...listed("Augmentations", sheet.augmentations, (a) => `${named(a)}${a.essence !== undefined ? `, Essence ${a.essence}` : ""}`));
  parts.push(...listed("Spells and complex forms", sheet.spells, (sp) => `${sp.name} (${[sp.kind, sp.typeTarget, sp.range, sp.duration, sp.drain ? `drain ${sp.drain}` : undefined].filter(Boolean).join(", ")})`));
  parts.push(...listed("Abilities", sheet.abilities, (a) => `${a.name}${a.level !== undefined ? ` ${a.level}` : ""}${a.notes ? ` (${short(a.notes)})` : ""}`));
  parts.push(...matrix(sheet));
  parts.push(...listed("Vehicles", sheet.vehicles, (v) => `${v.name} (${[["Handling", v.handling], ["Speed", v.topSpeed], ["Body", v.body], ["Armor", v.armor], ["Pilot", v.pilot], ["Seats", v.seats]].filter(([, value]) => value).map(([stat, value]) => `${stat} ${value}`).join(", ")})`));
  parts.push(...listed("Contacts", sheet.contacts, (c) => `${c.name} (Loyalty ${c.loyalty}, Connection ${c.connection})${c.notes ? `: ${short(c.notes)}` : ""}`));
  parts.push(...lifestyle(sheet));
  parts.push(...backstory(sheet));
  parts.push(...history(sheet));
  if (sheet.notes) parts.push(sheet.notes);
  return parts.join(" ");
}

function personal(sheet: CharacterSheet): string[] {
  const p = sheet.personal;
  if (!p) return [];
  const fields = [
    ["ethnicity", p.ethnicity], ["age", p.age], ["sex", p.sex], ["height", p.height], ["weight", p.weight],
    ["reputation", p.reputation], ["heat", p.heat], ["karma", p.karma], ["total karma", p.totalKarma], ["", p.misc],
  ] as const;
  const told = fields.filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => (name ? `${name} ${short(String(value))}` : short(String(value))));
  return told.length > 0 ? [sentence(`Personal: ${told.join(", ")}`)] : [];
}

function matrix(sheet: CharacterSheet): string[] {
  const m = sheet.matrix;
  if (!m) return [];
  const ratings = [["Attack", m.attack], ["Sleaze", m.sleaze], ["Data Processing", m.dataProcessing], ["Firewall", m.firewall]]
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name} ${value}`);
  const devices = (m.devices ?? []).slice(0, MAX_TOLD).map(named);
  const programs = (m.programs ?? []).slice(0, MAX_TOLD);
  const told = [ratings.join(", "), devices.length > 0 ? `devices ${devices.join(", ")}` : "", programs.length > 0 ? `programs ${programs.join(", ")}` : ""].filter(Boolean);
  return told.length > 0 ? [sentence(`Matrix: ${told.join("; ")}`)] : [];
}

function lifestyle(sheet: CharacterSheet): string[] {
  const l = sheet.lifestyle;
  if (!l) return [];
  const told = [l.primary ? `${l.primary} lifestyle` : "", l.nuyen !== undefined ? `${l.nuyen} nuyen` : "", l.licenses ? `licenses: ${short(l.licenses)}` : "", l.fakeIds && l.fakeIds.length > 0 ? `fake IDs: ${l.fakeIds.slice(0, MAX_TOLD).map(short).join("; ")}` : ""].filter(Boolean);
  return told.length > 0 ? [sentence(`Money and IDs: ${told.join(", ")}`)] : [];
}

function backstory(sheet: CharacterSheet): string[] {
  const text = sheet.backstory?.trim();
  if (!text) return [];
  return [sentence(`Backstory: ${text.length > MAX_BACKSTORY ? `${text.slice(0, MAX_BACKSTORY - 1)}…` : text}`)];
}

/** The latest runs, oldest first, one line each, and how many earlier ones there are. */
function history(sheet: CharacterSheet): string[] {
  // By run number, so the latest are the highest numbers whatever order the list was written in.
  const runs = [...(sheet.history ?? [])].sort((a, b) => a.run - b.run);
  if (runs.length === 0) return [];
  const latest = runs.slice(-RECENT_RUNS).map((r) => `Run ${r.run}${r.campaign ? ` in ${r.campaign}` : ""} (${r.date}): ${short(r.summary)}${r.consequences ? ` Came of it: ${short(r.consequences)}` : ""}`);
  const earlier = runs.length > RECENT_RUNS ? `; ${runs.length - RECENT_RUNS} earlier ${runs.length - RECENT_RUNS === 1 ? "run" : "runs"} not shown` : "";
  return [sentence(`Previous runs: ${latest.join("; ")}${earlier}`)];
}
