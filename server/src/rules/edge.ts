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

export interface EdgeState {
  /** The Edge attribute. */
  rank: number;
  /** Edge points on hand. */
  points: number;
  gainedThisRound: number;
  /** Only one expenditure of Edge is allowed per round. */
  spentThisRound: boolean;
}

/** A session starts with as many Edge points as the character's Edge rank. */
export function startSession(rank: number): EdgeState {
  if (!Number.isInteger(rank) || rank < 0) throw new RangeError(`Edge rank must be a whole number, got ${rank}`);
  return { rank, points: rank, gainedThisRound: 0, spentThisRound: false };
}

export function startRound(state: EdgeState): EdgeState {
  return { ...state, gainedThisRound: 0, spentThisRound: false };
}

export interface EdgeGain {
  state: EdgeState;
  /** What was actually added; less than asked when a cap applied. */
  gained: number;
}

/** Adds Edge without passing the per-round cap or the overall maximum. */
export function gainEdge(state: EdgeState, amount: number, rules: Ruleset = defaultRuleset): EdgeGain {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`Edge gained must be a whole number, got ${amount}`);
  const room = Math.min(rules.edge.maxGainPerRound - state.gainedThisRound, rules.edge.max - state.points);
  const gained = Math.max(0, Math.min(amount, room));
  return {
    state: { ...state, points: state.points + gained, gainedThisRound: state.gainedThisRound + gained },
    gained,
  };
}

/**
 * Takes `cost` Edge. The one expenditure of a round may be a boost repeated, so `cost` is the
 * whole amount; it throws if Edge was already spent this round or there is not enough.
 */
export function spendEdge(state: EdgeState, cost: number): EdgeState {
  if (!Number.isInteger(cost) || cost < 1) throw new RangeError(`Edge cost must be 1 or more, got ${cost}`);
  if (state.spentThisRound) throw new RangeError("Edge was already spent this round");
  if (cost > state.points) throw new RangeError(`Not enough Edge: have ${state.points}, need ${cost}`);
  return { ...state, points: state.points - cost, spentThisRound: true };
}

/** Loses Edge to a foe's boost; never below zero. */
export function loseEdge(state: EdgeState, amount: number): EdgeState {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`Edge lost must be a whole number, got ${amount}`);
  return { ...state, points: Math.max(0, state.points - amount) };
}

/** Edge above the Edge attribute goes away when a confrontation ends; Edge below it stays. */
export function endConfrontation(state: EdgeState): EdgeState {
  return { ...state, points: Math.min(state.points, state.rank) };
}

/** Burning Edge costs a point of Edge rank for good and every point on hand. It works even in a round Edge was spent. */
export function burnEdge(state: EdgeState): EdgeState {
  return { ...state, rank: Math.max(0, state.rank - 1), points: 0 };
}
