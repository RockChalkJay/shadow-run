import type { ResolvedRoll, RollRequest, RollResult } from "@shadow-run/shared";

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
