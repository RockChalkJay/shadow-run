import type { RollResult } from "@shadow-run/shared";

export interface SimpleTestOutcome {
  success: boolean;
  /** Hits beyond the threshold. */
  netHits: number;
}

/** A test against a fixed threshold. A roll with no hits fails whatever the threshold. */
export function simpleTest(roll: RollResult, threshold: number): SimpleTestOutcome {
  const needed = Math.max(1, threshold);
  return { success: roll.hits >= needed, netHits: Math.max(0, roll.hits - needed) };
}

export interface OpposedTestOutcome {
  winner: "attacker" | "defender";
  /** How many hits the winner had over the loser; 0 on a tie. */
  netHits: number;
}

/** The roller against an opponent's roll. A tie goes to the defender. */
export function opposedTest(attacker: RollResult, defender: RollResult): OpposedTestOutcome {
  return attacker.hits > defender.hits
    ? { winner: "attacker", netHits: attacker.hits - defender.hits }
    : { winner: "defender", netHits: defender.hits - attacker.hits };
}
