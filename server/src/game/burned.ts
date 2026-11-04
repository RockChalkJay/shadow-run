import type { CharacterSheet } from "@shadow-run/shared";

/** The sheets with the Edge rank each character has burned for good taken off. The sheet files themselves are never changed. */
export function withBurnedEdge(party: readonly CharacterSheet[], burned: Readonly<Record<string, number>>): CharacterSheet[] {
  return party.map((sheet) => {
    const lost = burned[sheet.id] ?? 0;
    return lost === 0 ? sheet : { ...sheet, attributes: { ...sheet.attributes, edge: Math.max(0, sheet.attributes.edge - lost) } };
  });
}
