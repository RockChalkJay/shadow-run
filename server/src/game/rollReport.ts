import type { CharacterView, DamageType, HealType, ResolvedRoll, RollRequest, RollResult, Weapon } from "@shadow-run/shared";
import { damageCode } from "./attack.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const diceCount = (n: number) => `${n} ${n === 1 ? "die" : "dice"}`;

export function showDice(roll: RollResult): string {
  const exploded = roll.explosions?.length ? ` (exploded: ${roll.explosions.join(" ")})` : "";
  const bought = roll.bonusHits ? ` (+${plural(roll.bonusHits, "bought hit")})` : "";
  return `${roll.dice.join(" ") || "no dice"}${exploded}${bought}`;
}

function glitchNote(roll: RollResult): string {
  if (roll.criticalGlitch) return "CRITICAL GLITCH";
  if (roll.glitch) return "GLITCH";
  return "";
}

/** What the GM is told once a roll is counted. The consequence is the one the GM declared up front. */
export function formatRollForGm(resolved: ResolvedRoll, characterName: string): string {
  const { request, roll, opposed, outcome, source } = resolved;
  const lines = [
    `ROLL RESULT. ${characterName}: ${request.label}.`,
    `${characterName} rolled ${diceCount(request.pool.total)} (${source === "app" ? "app dice" : "dice at the table"}): ${showDice(roll)} = ${plural(roll.hits, "hit")}.`,
  ];
  if (opposed) {
    lines.push(
      `Opposed by ${opposed.by}, ${diceCount(opposed.pool)} rolled by the system: ${showDice(opposed.roll)} = ${plural(opposed.roll.hits, "hit")}.`,
    );
  } else {
    lines.push(`Threshold ${request.threshold ?? 1}.`);
  }

  const margin = outcome.netHits > 0 ? ` by ${plural(outcome.netHits, "net hit")}` : "";
  lines.push(`${outcome.success ? "SUCCESS" : "FAILURE"}${margin}.`);
  if (opposed) {
    lines.push(
      opposed.role === "acting"
        ? `(${characterName} is acting, so a tie goes to ${characterName}.)`
        : `(${opposed.by} is acting, so a tie goes to ${opposed.by}.)`,
    );
  }
  lines.push(`Apply this consequence, as you declared it: ${outcome.consequence}`);
  const glitch = glitchNote(roll);
  if (glitch) lines.push(`${glitch}. Also apply: ${outcome.glitchConsequence ?? ""}`);
  return lines.join("\n");
}

export function formatCancelledForGm(request: RollRequest, characterName: string): string {
  return `ROLL SKIPPED. The table skipped ${characterName}'s roll (${request.label}). Apply no consequence from it; carry on from the situation as it stood before the roll.`;
}

export interface NpcRoll {
  label: string;
  pool: number;
  roll: RollResult;
  threshold?: number;
  success?: boolean;
}

/** What the GM is told after rolling for a non-player character. */
export function formatNpcRoll({ label, pool, roll, threshold, success }: NpcRoll): string {
  const lines = [`NPC ROLL. ${label}: ${diceCount(pool)}: ${showDice(roll)} = ${plural(roll.hits, "hit")}.`];
  if (threshold !== undefined) lines.push(`Threshold ${threshold}: ${success ? "SUCCESS" : "FAILURE"}.`);
  const glitch = glitchNote(roll);
  if (glitch) lines.push(`${glitch}: the GM decides what goes wrong, keeping it ${roll.criticalGlitch ? "serious but not fatal" : "inconvenient, not disastrous"}.`);
  return lines.join("\n");
}

/** How hurt someone is, in words the GM can use. */
export function formatStanding(view: CharacterView): string {
  const m = view.monitor;
  const parts = [`${view.name}: Physical ${m.physical}/${m.physicalBoxes}, Stun ${m.stun}/${m.stunBoxes}, Overflow ${m.overflow}/${m.overflowBoxes}.`];
  if (view.woundModifier > 0) parts.push(`Wound penalty: -${view.woundModifier} dice on everything but damage resistance.`);
  if (view.status === "dead") parts.push(`${view.name} is DEAD.`);
  else if (view.status === "unconscious") parts.push(`${view.name} is UNCONSCIOUS and out of the action until healed.`);
  return parts.join(" ");
}

const how = { app: "app dice", physical: "dice at the table", system: "the system's dice" } as const;

export interface DamageReport {
  label: string;
  damageType: DamageType;
  damageValue: number;
  body: number;
  resistance: RollResult;
  resistedBy: keyof typeof how;
  taken: number;
  after: CharacterView;
}

/** What the GM is told once damage has been resisted and applied. */
export function formatDamageForGm(r: DamageReport): string {
  const got = r.taken === 0 ? "no damage got through" : `${r.taken} ${r.damageType} damage got through`;
  return [
    `DAMAGE RESULT. ${r.label}: ${r.damageValue} ${r.damageType} damage to ${r.after.name}.`,
    `${r.after.name} resisted with Body ${r.body} (${how[r.resistedBy]}): ${showDice(r.resistance)} = ${plural(r.resistance.hits, "hit")}, so ${got}.`,
    formatStanding(r.after),
  ].join("\n");
}

export interface HealReport {
  reason: string;
  type: HealType;
  healed: number;
  after: CharacterView;
}

export function formatHealForGm(r: HealReport): string {
  const did = r.healed === 0 ? `had no ${r.type} damage to heal` : `heals ${r.healed} ${r.type}`;
  return [`HEAL. ${r.reason}: ${r.after.name} ${did}.`, formatStanding(r.after)].join("\n");
}

export interface AttackReport {
  label: string;
  attacker: string;
  defender: string;
  weapon: Weapon;
  attackRoll: RollResult;
  attackDice: number;
  attackedBy: keyof typeof how;
  defenseRoll: RollResult;
  defenseDice: number;
  defendedBy: keyof typeof how;
  hit: boolean;
  damageValue: number;
}

/** What the GM is told once an attack has been rolled on both sides. */
export function formatAttackForGm(r: AttackReport): string {
  const base = r.weapon.damageValue;
  const lines = [
    `ATTACK RESULT. ${r.label}.`,
    `${r.attacker} attacked with ${r.weapon.name} (${damageCode(base, r.weapon.damageType)}), ${diceCount(r.attackDice)} (${how[r.attackedBy]}): ${showDice(r.attackRoll)} = ${plural(r.attackRoll.hits, "hit")}.`,
    `${r.defender} defended, ${diceCount(r.defenseDice)} (${how[r.defendedBy]}): ${showDice(r.defenseRoll)} = ${plural(r.defenseRoll.hits, "hit")}.`,
  ];
  if (r.hit) {
    const net = r.damageValue - base;
    lines.push(
      net > 0
        ? `HIT by ${plural(net, "net hit")}. Damage Value ${base} + ${net} = ${r.damageValue} ${r.weapon.damageType}, before ${r.defender} resists.`
        : `HIT on a tie. Damage Value ${r.damageValue} ${r.weapon.damageType}, before ${r.defender} resists.`,
    );
  } else if (r.attackRoll.hits === 0) {
    lines.push(`MISS. ${r.attacker} had no hits, so the attack cannot land.`);
  } else {
    lines.push(`MISS. ${r.defender} had more hits.`);
  }
  for (const [who, roll] of [[r.attacker, r.attackRoll], [r.defender, r.defenseRoll]] as const) {
    const note = glitchNote(roll);
    if (note) lines.push(`${who}: ${note}. The GM decides what goes wrong, keeping it ${roll.criticalGlitch ? "serious but not fatal" : "inconvenient, not disastrous"}.`);
  }
  return lines.join("\n");
}
