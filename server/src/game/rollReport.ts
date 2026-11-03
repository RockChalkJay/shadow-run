import type { CharacterView, DamageType, HealMethod, HealType, ResolvedRoll, RollRequest, RollResult, Weapon } from "@shadow-run/shared";
import { METHOD_NAMES } from "../rules/index.js";
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
  } else if (request.healing) {
    lines.push(`Healing threshold ${request.healing.threshold}${request.healing.autoHit ? ", with a free hit for a fully natural patient" : ""}.`);
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
  const g = view.grunt;
  const parts = [
    g
      ? `${view.name} (${g.lieutenant ? "lieutenant, " : ""}grunt, Professional Rating ${g.professionalRating}): ${m.physical}/${m.physicalBoxes} boxes of damage.`
      : `${view.name}: Physical ${m.physical}/${m.physicalBoxes}, Stun ${m.stun}/${m.stunBoxes}, Overflow ${m.overflow}/${m.overflowBoxes}.`,
  ];
  if (view.woundModifier > 0) parts.push(`Wound penalty: -${view.woundModifier} dice on everything but damage resistance.`);
  if (view.status === "dead") parts.push(`${view.name} is DEAD.`);
  else if (view.status === "unconscious") parts.push(`${view.name} is UNCONSCIOUS and out of the action${g ? "" : " until healed"}.`);
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
  /** Set when a grunt passed their Professional Rating with this damage. */
  composure?: { roll: RollResult; pool: number; threshold: number; held: boolean };
}

/** What the GM is told once damage has been resisted and applied. */
export function formatDamageForGm(r: DamageReport): string {
  const got = r.taken === 0 ? "no damage got through" : `${r.taken} ${r.damageType} damage got through`;
  return [
    `DAMAGE RESULT. ${r.label}: ${r.damageValue} ${r.damageType} damage to ${r.after.name}.`,
    `${r.after.name} resisted with Body ${r.body} (${how[r.resistedBy]}): ${showDice(r.resistance)} = ${plural(r.resistance.hits, "hit")}, so ${got}.`,
    formatStanding(r.after),
    ...(r.composure ? [formatComposure(r.after, r.composure)] : []),
  ].join("\n");
}

/** The result of a grunt's test of nerve, which is binding: a grunt that fails it bolts. */
function formatComposure(after: CharacterView, c: NonNullable<DamageReport["composure"]>): string {
  const name = after.name;
  return [
    `COMPOSURE. ${name} is past their Professional Rating of ${after.grunt!.professionalRating}, so the system tested their nerve with Willpower + Charisma, ${diceCount(c.pool)} (${how.system}): ${showDice(c.roll)} = ${plural(c.roll.hits, "hit")} against a threshold of ${c.threshold}.`,
    c.held ? `${name} HOLDS and keeps fighting.` : `${name} BOLTS. They break now: they flee or surrender, and you carry that out in what you narrate.`,
  ].join(" ");
}

export interface HealReport {
  reason: string;
  type: HealType;
  healed: number;
  after: CharacterView;
  /** Hits still unspent on the healing roll. */
  left: number;
}

export function formatHealForGm(r: HealReport): string {
  const did = r.healed === 0 ? `had no ${r.type} damage to heal` : `heals ${r.healed} ${r.type}`;
  return [`HEAL. ${r.reason}: ${r.after.name} ${did}.`, formatStanding(r.after), `${plural(r.left, "hit")} left on this healing roll.`].join("\n");
}

const rates: Record<HealMethod, string> = {
  first_aid: "First Aid heals 1 stun box per hit, or 1 physical or overflow box per 2 hits.",
  medkit: "A medkit heals 1 box of stun, physical or overflow per hit.",
  magic: "Healing magic heals 1 box of stun, physical or overflow per hit.",
  natural_stun: "Natural recovery heals 1 stun box per hit.",
  natural_physical: "Natural recovery heals 1 physical box per hit.",
  natural_overflow: "Natural recovery heals 1 overflow box per hit.",
};

/** Tells the GM what a healing roll earned and how to spend it, since it may only heal as much as the roll allows. */
export function formatHealingOffer(r: { healer: string; patient: string; method: HealMethod; hits: number; rollId: string }): string {
  const subject = r.method.startsWith("natural_") ? `${r.patient}'s ${METHOD_NAMES[r.method]}` : `${r.healer}'s ${METHOD_NAMES[r.method]} on ${r.patient}`;
  return [
    `HEALING AVAILABLE. ${subject}: ${plural(r.hits, "hit")} to spend. Roll id: ${r.rollId}`,
    `Spend them with the heal tool, giving that roll id, in this turn; hits you do not spend are lost. ${rates[r.method]}${r.method.startsWith("natural_") ? "" : " Overflow damage heals first."}`,
  ].join("\n");
}

export interface AttackReport {
  label: string;
  attacker: string;
  defender: string;
  weapon: Weapon;
  /** How many grunts attacked together; 1 or absent for a single attacker. */
  groupSize?: number;
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
    `${r.attacker} attacked ${(r.groupSize ?? 1) > 1 ? `as a group of ${r.groupSize} ` : ""}with ${r.weapon.name} (${damageCode(base, r.weapon.damageType)}), ${diceCount(r.attackDice)} (${how[r.attackedBy]}): ${showDice(r.attackRoll)} = ${plural(r.attackRoll.hits, "hit")}.`,
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
