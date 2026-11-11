// Writes docs/character.schema.json, a JSON Schema for a character sheet, for editors that check JSON as it is typed.
// It is generated from the same definition the server checks sheets with; run it after changing the sheet, and
// the test that compares the file with the definition says when it is out of date.
//
//   npm run character:schema

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { characterJsonSchema } from "../src/game/characterSchema.js";

const file = fileURLToPath(new URL("../../docs/character.schema.json", import.meta.url));
await writeFile(file, characterJsonSchema());
console.log(`Wrote ${file}`);
