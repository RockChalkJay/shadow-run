// Writes characters out as portable JSON files: the same file a campaign keeps in `characters/`, which another campaign
// or scenario can import.
//
//   npm run character:export -- kira                     prints Kira, from the "default" campaign
//   npm run character:export -- kira --out kira.json     writes it to a file (or into a folder, as kira.json)
//   npm run character:export -- --all --out party/       writes every character into a folder
//   npm run character:export -- kira --campaign night-one | --scenario ambush     from another campaign or a scenario
//   npm run character:export -- kira --derived           adds the record sheet's worked-out boxes, which an import ignores

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { characterFileText, exportCharacters, parseExportArgs, placeDirectory } from "../src/game/characterFile.js";

const parsed = parseExportArgs(process.argv.slice(2));
if (!parsed) {
  console.error("Usage: npm run character:export -- <id> | --all --out <folder>  [--campaign <name> | --scenario <name>] [--out <path>] [--derived]");
  process.exit(1);
}

// npm runs the script from the server folder, so a relative path is taken from where the command was typed.
const from = process.env.INIT_CWD ?? process.cwd();
const out = parsed.out === undefined ? undefined : resolve(from, parsed.out);

try {
  const config = loadConfig({ ...process.env, SHADOWRUN_SCENARIO: undefined });
  const dir = placeDirectory(parsed, config);
  const sheets = await exportCharacters({ dir, ...(parsed.id !== undefined && { id: parsed.id }) });
  const text = (sheet: (typeof sheets)[number]) => characterFileText(sheet, { derived: parsed.derived });

  if (out === undefined) {
    process.stdout.write(text(sheets[0]!));
  } else {
    const isFolder = parsed.id === undefined || (await stat(out).then((s) => s.isDirectory(), () => parsed.out!.endsWith("/")));
    for (const sheet of sheets) {
      const file = isFolder ? join(out, `${sheet.id}.json`) : out;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text(sheet));
      console.log(`Wrote ${sheet.name} to ${file}`);
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
