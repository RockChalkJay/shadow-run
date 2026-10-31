import { defaultRuleset, type Ruleset } from "./ruleset.js";

/** Who earns Edge from an attack, going by how far apart the two ratings are. */
export function edgeFromRatings(
  attackRating: number,
  defenseRating: number,
  rules: Ruleset = defaultRuleset,
): "attacker" | "defender" | null {
  const gap = rules.edge.ratingGapForEdge;
  if (attackRating - defenseRating >= gap) return "attacker";
  if (defenseRating - attackRating >= gap) return "defender";
  return null;
}

export interface EdgeGain {
  points: number;
  /** Edge gained so far this round, including this gain. */
  gainedThisRound: number;
  /** What was actually added; less than asked when a cap applied. */
  gained: number;
}

/** Adds Edge without passing the per-round cap or the overall maximum. */
export function gainEdge(
  points: number,
  gainedThisRound: number,
  amount: number,
  rules: Ruleset = defaultRuleset,
): EdgeGain {
  const room = Math.min(rules.edge.maxGainPerRound - gainedThisRound, rules.edge.max - points);
  const gained = Math.max(0, Math.min(amount, room));
  return { points: points + gained, gainedThisRound: gainedThisRound + gained, gained };
}

/** Takes `cost` Edge, or throws if there is not enough. */
export function spendEdge(points: number, cost: number): number {
  if (!Number.isInteger(cost) || cost < 1) throw new RangeError(`Edge cost must be 1 or more, got ${cost}`);
  if (cost > points) throw new RangeError(`Not enough Edge: have ${points}, need ${cost}`);
  return points - cost;
}
