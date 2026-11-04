import type { CombatEntry } from "@shadow-run/shared";
import { actionsFor, rollInitiative, turnOrder, type D6, type Flip, type Ruleset } from "../rules/index.js";

/** Someone about to take their place in a fight, with the numbers their initiative is rolled from. */
export interface Candidate {
  member: { kind: "pc" | "npc"; id: string; name: string };
  reaction: number;
  intuition: number;
  dice: number;
  /** Breaks ties: a character's Edge, or a grunt's Professional Rating. */
  edge: number;
  /** Grunts with the same label roll once and act together, with the first one's numbers. */
  group?: string | undefined;
}

/** Rolls initiative once for each person and once for each group of grunts, in the order given; the entries come back unsorted. */
export function rollEntries(candidates: readonly Candidate[], d6: D6, flip: Flip, rules?: Ruleset): CombatEntry[] {
  const units: Candidate[][] = [];
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.group === undefined) {
      units.push([candidate]);
      continue;
    }
    const unit = groups.get(candidate.group);
    if (unit) {
      unit.push(candidate);
    } else {
      const fresh = [candidate];
      groups.set(candidate.group, fresh);
      units.push(fresh);
    }
  }

  return units.map((unit) => {
    const lead = unit[0]!;
    const { score, rolls } = rollInitiative({ reaction: lead.reaction, intuition: lead.intuition, dice: lead.dice }, d6, rules);
    const { major, minor } = actionsFor(lead.dice, rules);
    return {
      members: unit.map((c) => c.member),
      ...(lead.group !== undefined && { group: lead.group }),
      score,
      reaction: lead.reaction,
      intuition: lead.intuition,
      dice: lead.dice,
      rolls,
      edge: lead.edge,
      coin: flip(),
      major,
      minor,
    };
  });
}

/** Highest initiative first. Ties go by Edge, Reaction, Intuition and then each entry's own coin, so adding someone never reshuffles the rest. */
export function inInitiativeOrder(entries: readonly CombatEntry[]): CombatEntry[] {
  return turnOrder(entries);
}
