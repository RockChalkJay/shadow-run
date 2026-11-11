import { CharacterSheet } from "@shadow-run/shared";
import { z } from "zod";

/** A JSON Schema for a character file, as the text of `docs/character.schema.json`. It describes what may be written, so defaults are not required. */
export function characterJsonSchema(): string {
  const schema = z.toJSONSchema(CharacterSheet, { io: "input" });
  return `${JSON.stringify({ title: "Shadow Run character sheet", ...schema }, null, 2)}\n`;
}
