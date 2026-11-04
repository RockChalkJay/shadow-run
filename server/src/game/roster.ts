import type { CharacterRef, CharacterView, ConditionMonitor, DamageType, HealType, CharacterSheet } from "@shadow-run/shared";
import { applyDamage, defaultRuleset, gruntBoxes, gruntStatus, gruntWoundModifier, healDamage, newMonitor, statusOf, woundModifier, type Ruleset, type Treatment } from "../rules/index.js";
import type { Fail } from "./rollManager.js";

/** Most non-player characters the table will track at once; more than that is the GM losing count. */
export const MAX_NPCS = 60;

/** What a grunt has beyond other non-player characters. Their single track lives in the entry's `monitor.physical`. */
export interface GruntState {
  professionalRating: number;
  lieutenant: boolean;
  charisma: number;
  /** The damage that hit last, which decides whether a full track is dead or unconscious. */
  last: DamageType | null;
}

interface Entry {
  name: string;
  body: number;
  willpower: number;
  monitor: ConditionMonitor;
  grunt?: GruntState;
  /** The treatments this character has had for their current injuries; they start over when the character is next hurt. */
  treated: Set<Treatment>;
}

export interface SavedRoster {
  pcs: Array<{ id: string; monitor: ConditionMonitor; treated: Treatment[] }>;
  npcs: Array<{ id: string; name: string; body: number; willpower: number; monitor: ConditionMonitor; treated: Treatment[]; grunt?: GruntState }>;
}

/** A roster as saved before treatments were tracked: everyone starts untreated. */
type OlderSavedRoster = {
  [K in keyof SavedRoster]: Array<Omit<SavedRoster[K][number], "treated"> & { treated?: Treatment[] }>;
};

export type Target = { ok: true; kind: "pc" | "npc"; id: string; name: string; body: number } | Fail;

/** Brings a saved monitor in line with the character's attributes as they are now, keeping the damage already taken. */
function reconcile(saved: ConditionMonitor | undefined, fresh: ConditionMonitor): ConditionMonitor {
  if (!saved) return fresh;
  return {
    ...fresh,
    physical: Math.min(saved.physical, fresh.physicalBoxes),
    stun: Math.min(saved.stun, fresh.stunBoxes),
    overflow: Math.min(saved.overflow, fresh.overflowBoxes),
  };
}

/** Everyone on the table and how hurt they are. Damage and healing are applied here and nowhere else. */
export class Roster {
  private readonly pcs = new Map<string, Entry>();
  private readonly npcs = new Map<string, Entry>();

  constructor(
    party: readonly CharacterSheet[],
    saved: SavedRoster | OlderSavedRoster | undefined,
    private readonly rules: Ruleset = defaultRuleset,
  ) {
    for (const member of party) {
      const fresh = newMonitor(member.attributes.body, member.attributes.willpower, rules);
      const before = saved?.pcs.find((p) => p.id === member.id);
      this.pcs.set(member.id, {
        name: member.name,
        body: member.attributes.body,
        willpower: member.attributes.willpower,
        monitor: reconcile(before?.monitor, fresh),
        treated: new Set(before?.treated),
      });
    }
    for (const npc of saved?.npcs ?? []) {
      this.npcs.set(npc.id, {
        name: npc.name,
        body: npc.body,
        willpower: npc.willpower,
        monitor: npc.monitor,
        treated: new Set(npc.treated),
        ...(npc.grunt && { grunt: { ...npc.grunt } }),
      });
    }
  }

  private entry(kind: "pc" | "npc", id: string): Entry | undefined {
    return (kind === "pc" ? this.pcs : this.npcs).get(id);
  }

  view(kind: "pc" | "npc", id: string): CharacterView | undefined {
    const entry = this.entry(kind, id);
    if (!entry) return undefined;
    const { grunt } = entry;
    if (grunt) {
      // A grunt has one track, so the damage that hit last decides whether a full one is dead or unconscious.
      return {
        id,
        kind,
        name: entry.name,
        monitor: { ...entry.monitor },
        status: gruntStatus(entry.monitor.physical, entry.monitor.physicalBoxes, grunt.last),
        woundModifier: gruntWoundModifier(entry.monitor.physical, this.rules),
        grunt: { professionalRating: grunt.professionalRating, lieutenant: grunt.lieutenant, lastDamage: grunt.last },
      };
    }
    return { id, kind, name: entry.name, monitor: { ...entry.monitor }, status: statusOf(entry.monitor), woundModifier: woundModifier(entry.monitor, this.rules) };
  }

  views(): CharacterView[] {
    return [
      ...[...this.pcs.keys()].map((id) => this.view("pc", id)!),
      ...[...this.npcs.keys()].map((id) => this.view("npc", id)!),
    ];
  }

  /** Why a player character cannot act right now, or null if they can. */
  canAct(id: string): string | null {
    const entry = this.pcs.get(id);
    if (!entry) return null;
    const status = statusOf(entry.monitor);
    if (status === "dead") return `${entry.name} is dead and cannot act.`;
    if (status === "unconscious") return `${entry.name} is unconscious and cannot act until healed.`;
    return null;
  }

  /** Dice a player character loses on every test but damage resistance. */
  woundPenalty(id: string): number {
    const entry = this.pcs.get(id);
    return entry ? woundModifier(entry.monitor, this.rules) : 0;
  }

  /**
   * Finds who the GM means, adding a new non-player character the first time one is named. That first
   * mention has to give a name and attributes; after it, the id is enough.
   */
  resolve(ref: CharacterRef, options: { create?: boolean } = {}): Target {
    if (ref.kind === "pc") {
      const entry = this.pcs.get(ref.id);
      return entry ? { ok: true, kind: "pc", id: ref.id, name: entry.name, body: entry.body } : { ok: false, error: `There is no player character "${ref.id}" at the table.` };
    }
    const known = this.npcs.get(ref.id);
    if (known) return { ok: true, kind: "npc", id: ref.id, name: known.name, body: known.body };
    if (this.pcs.has(ref.id)) return { ok: false, error: `"${ref.id}" is a player character. Use kind "pc" for them.` };
    if (options.create === false) return { ok: false, error: `There is no non-player character "${ref.id}" on the table.` };
    if (ref.name === undefined || ref.body === undefined || ref.willpower === undefined) {
      return { ok: false, error: `"${ref.id}" is new to the table. Give the NPC's name, body and willpower the first time you mention them.` };
    }
    if (this.npcs.size >= MAX_NPCS) return { ok: false, error: `The table is already tracking ${MAX_NPCS} non-player characters.` };
    if (ref.professionalRating !== undefined) {
      if (ref.charisma === undefined) return { ok: false, error: `"${ref.id}" is a new grunt. Give their charisma too, for their Composure test.` };
      const grunt = { professionalRating: ref.professionalRating, lieutenant: ref.lieutenant ?? false, charisma: ref.charisma, last: null };
      const boxes = gruntBoxes(ref.body, ref.willpower, grunt, this.rules);
      const monitor = { physicalBoxes: boxes, physical: 0, stunBoxes: 1, stun: 0, overflowBoxes: 1, overflow: 0 };
      this.npcs.set(ref.id, { name: ref.name, body: ref.body, willpower: ref.willpower, monitor, treated: new Set(), grunt });
      return { ok: true, kind: "npc", id: ref.id, name: ref.name, body: ref.body };
    }
    this.npcs.set(ref.id, { name: ref.name, body: ref.body, willpower: ref.willpower, monitor: newMonitor(ref.body, ref.willpower, this.rules), treated: new Set() });
    return { ok: true, kind: "npc", id: ref.id, name: ref.name, body: ref.body };
  }

  /** Whether this much damage, already resisted, would kill a player character as they stand. */
  wouldKill(kind: "pc" | "npc", id: string, type: DamageType, amount: number): boolean {
    const entry = this.entry(kind, id);
    return entry !== undefined && !entry.grunt && statusOf(applyDamage(entry.monitor, type, amount, this.rules)) === "dead";
  }

  /**
   * Marks damage that has already been resisted; returns how they stand now. With `surviveDeath`, damage that would
   * kill leaves them dying instead.
   */
  damage(kind: "pc" | "npc", id: string, type: DamageType, amount: number, options: { surviveDeath?: boolean } = {}): CharacterView {
    const entry = this.entry(kind, id);
    if (!entry) throw new Error(`No ${kind} "${id}" to hurt.`);
    if (entry.grunt) {
      // One track for everything; damage past the last box is not counted, and what hit last decides the rest.
      entry.monitor = { ...entry.monitor, physical: Math.min(entry.monitor.physicalBoxes, entry.monitor.physical + amount) };
      if (amount > 0) entry.grunt.last = type;
    } else {
      entry.monitor = applyDamage(entry.monitor, type, amount, this.rules, options);
    }
    // New injuries are a new set of injuries, which can be treated again.
    if (amount > 0) entry.treated.clear();
    return this.view(kind, id)!;
  }

  /** Clears up to `boxes` from one track; says how many boxes it really cleared. */
  heal(kind: "pc" | "npc", id: string, type: HealType, boxes: number): { after: CharacterView; healed: number } {
    const entry = this.entry(kind, id);
    if (!entry) throw new Error(`No ${kind} "${id}" to heal.`);
    if (entry.grunt) throw new Error(`"${id}" is a grunt, who cannot be healed.`);
    const healed = Math.min(boxes, entry.monitor[type]);
    entry.monitor = healDamage(entry.monitor, type, healed);
    return { after: this.view(kind, id)!, healed };
  }

  /** Dice for a grunt's Composure test, or undefined for anyone who is not a grunt. */
  composurePool(id: string): number | undefined {
    const entry = this.npcs.get(id);
    return entry?.grunt ? entry.willpower + entry.grunt.charisma : undefined;
  }

  hasBeenTreated(kind: "pc" | "npc", id: string, treatment: Treatment): boolean {
    return this.entry(kind, id)?.treated.has(treatment) ?? false;
  }

  markTreated(kind: "pc" | "npc", id: string, treatment: Treatment): void {
    this.entry(kind, id)?.treated.add(treatment);
  }

  toSaved(): SavedRoster {
    return {
      pcs: [...this.pcs].map(([id, e]) => ({ id, monitor: e.monitor, treated: [...e.treated] })),
      npcs: [...this.npcs].map(([id, e]) => ({ id, name: e.name, body: e.body, willpower: e.willpower, monitor: e.monitor, treated: [...e.treated], ...(e.grunt && { grunt: { ...e.grunt } }) })),
    };
  }
}
