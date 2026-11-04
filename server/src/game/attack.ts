import type { DamageType, RollRequest, Weapon } from "@shadow-run/shared";

/** "3P" or "5S": a Damage Value with its type. */
export const damageCode = (value: number, type: DamageType) => `${value}${type === "physical" ? "P" : "S"}`;

/** Dice left once wounds are counted; a character cannot roll fewer than none. */
export const afterWounds = (pool: number, penalty: number) => Math.max(0, pool - penalty);

interface Side {
  characterId: string;
  pool: { total: number; breakdown: string };
}

interface Other {
  id: string;
  name: string;
  /** Dice the system rolls for them, after their wounds. */
  pool: number;
}

interface Shared {
  label: string;
  stakes: string;
  weapon: Weapon;
  edgeAdvice?: string | undefined;
}

/** Said on a roll request the system wrote itself, when there is no Edge advice from the GM to give. */
export const FALLBACK_EDGE_ADVICE = "The system tracks your Edge. Spend it before the roll, or hold the roll and decide once you have seen the dice.";

/** A player character attacks someone the system rolls for: they roll the attack, the system rolls the defense. */
export function attackerRequest(shared: Shared, mine: Side, defender: Other) {
  const { weapon } = shared;
  return {
    input: {
      characterId: mine.characterId,
      label: shared.label,
      pool: mine.pool,
      opposed: { by: defender.name, pool: defender.pool, role: "acting" as const },
      stakes: shared.stakes,
      goodRoll: `At least one hit, and more than ${defender.name}'s defense. Each net hit adds a point to the ${weapon.name}'s Damage Value of ${damageCode(weapon.damageValue, weapon.damageType)}.`,
      badRoll: `No hits, or fewer than ${defender.name}'s defense. The attack misses.`,
      consequences: {
        success: "The attack hits. Net hits add to the Damage Value, then the target resists with Body.",
        failure: "The attack misses.",
        glitch: "A glitch does not change whether the attack hits; the GM may add a small complication, such as a wild shot or a jam.",
        criticalGlitch: "A critical glitch means the attack misses and something serious but not fatal goes wrong.",
      },
      edgeAdvice: shared.edgeAdvice ?? FALLBACK_EDGE_ADVICE,
    },
    attack: { role: "attacker" as const, weapon, other: { kind: "npc" as const, id: defender.id, name: defender.name } },
  } satisfies { input: unknown; attack: RollRequest["attack"] };
}

/** Someone the system rolls for attacks a player character: they roll the defense, the system rolls the attack. */
export function defenderRequest(shared: Shared, mine: Side, attacker: Other, groupSize = 1) {
  const { weapon } = shared;
  return {
    input: {
      characterId: mine.characterId,
      label: shared.label,
      pool: mine.pool,
      opposed: { by: attacker.name, pool: attacker.pool, role: "defending" as const },
      stakes: shared.stakes,
      goodRoll: `As many hits as possible. You need more than ${attacker.name}'s attack to avoid it, and any attack with no hits misses.`,
      badRoll: `Fewer hits than ${attacker.name}'s attack. The ${weapon.name} hits and ${damageCode(weapon.damageValue, weapon.damageType)} plus their net hits comes at you.`,
      consequences: {
        success: "The attack misses.",
        failure: "The attack hits. You then roll Body to resist the damage.",
        glitch: "A glitch does not change whether the attack hits; the GM may add a small complication.",
        criticalGlitch: "A critical glitch means the attack hits and something serious but not fatal goes wrong.",
      },
      edgeAdvice: shared.edgeAdvice ?? FALLBACK_EDGE_ADVICE,
    },
    attack: { role: "defender" as const, weapon, ...(groupSize > 1 && { groupSize }), other: { kind: "npc" as const, id: attacker.id, name: attacker.name } },
  } satisfies { input: unknown; attack: RollRequest["attack"] };
}
