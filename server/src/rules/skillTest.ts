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

/** The roller against an opponent's roll. A tie goes to the attacker, the one acting. */
export function opposedTest(attacker: RollResult, defender: RollResult): OpposedTestOutcome {
  return attacker.hits >= defender.hits
    ? { winner: "attacker", netHits: attacker.hits - defender.hits }
    : { winner: "defender", netHits: defender.hits - attacker.hits };
}

export interface AttackOutcome {
  hit: boolean;
  /** The weapon's Damage Value plus the attacker's net hits; 0 on a miss. */
  damageValue: number;
}

/** An attack against a defense roll. A tie still hits, for the weapon's base Damage Value. */
export function attackDamage(attacker: RollResult, defender: RollResult, baseDamageValue: number): AttackOutcome {
  const { winner, netHits } = opposedTest(attacker, defender);
  return winner === "attacker"
    ? { hit: true, damageValue: baseDamageValue + netHits }
    : { hit: false, damageValue: 0 };
}
