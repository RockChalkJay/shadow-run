import type { TranscriptEntry } from "@shadow-run/shared";

/** Most characters of recap handed to a GM that has to start over; the oldest lines go first. */
const MAX_RECAP = 12_000;

const hits = (n: number) => `${n} ${n === 1 ? "hit" : "hits"}`;

function line(entry: TranscriptEntry, nameOf: (id: string) => string): string | null {
  switch (entry.kind) {
    case "say":
      return `${entry.name}: ${entry.text}`;
    case "gm":
      return `GM: ${entry.text}`;
    case "roll": {
      const { request, roll, opposed, outcome } = entry.resolved;
      // A resistance roll has no success or failure; the damage line that follows says what came of it.
      // The same goes for either side of an attack: the attack line says whether it landed. What the player spent on Edge is still told.
      const edge = entry.resolved.edge && `${nameOf(request.characterId)} spent ${entry.resolved.edge.spent} Edge and ${entry.resolved.edge.summary}.`;
      if (request.soak || request.attack) return edge ? `[Edge] ${edge}` : null;
      const against = opposed ? ` against ${opposed.by} (${hits(opposed.roll.hits)})` : "";
      const glitch = roll.criticalGlitch ? ", critical glitch" : roll.glitch ? ", glitch" : "";
      const effect = [outcome.consequence, outcome.glitchConsequence].filter(Boolean).join(" ");
      return `[Roll] ${nameOf(request.characterId)}, ${request.label}: ${outcome.success ? "success" : "failure"} (${hits(roll.hits)}${against}${glitch}). ${effect}${edge ? ` ${edge}` : ""}`;
    }
    case "roll_cancelled":
      return `[Roll skipped] ${nameOf(entry.characterId)}, ${entry.label}.`;
    case "npc":
      return `[NPC roll] ${entry.label}: ${hits(entry.roll.hits)}${entry.success === undefined ? "" : entry.success ? ", success" : ", failure"}.`;
    case "attack":
      return `[Attack] ${entry.attacker} ${entry.hit ? "hit" : "missed"} ${entry.defender} with ${entry.weapon.name}${entry.edgeAction ? `, using ${entry.edgeAction}` : ""}.`;
    case "edge":
      return entry.gained < 0 ? `[Edge] ${entry.name} lost ${-entry.gained} Edge: ${entry.reason}.` : `[Edge] ${entry.name} gained ${entry.gained} Edge: ${entry.reason}.`;
    case "edge_use":
      return `[Edge] ${entry.name} spent ${entry.cost} Edge and ${entry.detail}.`;
    case "combat": {
      const who = entry.names.join(", ");
      if (entry.event === "start") return `[Combat] A fight begins: ${who}.`;
      if (entry.event === "join") return `[Combat] Joined the fight: ${who}.`;
      if (entry.event === "round") return `[Combat] Round ${entry.round} begins.`;
      return `[Combat] The fight ends after ${entry.round} ${entry.round === 1 ? "round" : "rounds"}.`;
    }
    case "damage":
      return `[Damage] ${entry.after.name} took ${entry.taken} ${entry.damageType} from ${entry.label}.${entry.after.status === "active" ? "" : ` ${entry.after.name} is ${entry.after.status}.`}${entry.composure && !entry.composure.held ? ` ${entry.after.name} bolted.` : ""}`;
    case "heal":
      return `[Heal] ${entry.after.name} healed ${entry.healed} ${entry.type}: ${entry.reason}.`;
    case "system":
      return null;
  }
}

/** The conversation so far as plain text, for a GM that has lost its own session and must pick up from the transcript. */
export function formatRecap(entries: readonly TranscriptEntry[], nameOf: (id: string) => string): string {
  const lines = entries.flatMap((entry) => {
    const text = line(entry, nameOf);
    return text === null ? [] : [text];
  });
  let total = 0;
  const kept: string[] = [];
  for (const text of lines.reverse()) {
    total += text.length + 1;
    if (total > MAX_RECAP) break;
    kept.push(text);
  }
  return kept.reverse().join("\n");
}
