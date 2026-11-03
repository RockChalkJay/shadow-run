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
      const against = opposed ? ` against ${opposed.by} (${hits(opposed.roll.hits)})` : "";
      const glitch = roll.criticalGlitch ? ", critical glitch" : roll.glitch ? ", glitch" : "";
      const effect = [outcome.consequence, outcome.glitchConsequence].filter(Boolean).join(" ");
      return `[Roll] ${nameOf(request.characterId)}, ${request.label}: ${outcome.success ? "success" : "failure"} (${hits(roll.hits)}${against}${glitch}). ${effect}`;
    }
    case "roll_cancelled":
      return `[Roll skipped] ${nameOf(entry.characterId)}, ${entry.label}.`;
    case "npc":
      return `[NPC roll] ${entry.label}: ${hits(entry.roll.hits)}${entry.success === undefined ? "" : entry.success ? ", success" : ", failure"}.`;
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
