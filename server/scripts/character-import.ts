// Reads character files into a campaign or a scenario, as `characters/<id>.json`. All or none: if any file is wrong,
// nothing is written and every problem is listed.
//
//   npm run character:import -- kira.json                     into the "default" campaign
//   npm run character:import -- party/*.json --scenario ambush   into a scenario (made if it is new)
//   npm run character:import -- kira.json --campaign night-one
//   npm run character:import -- kira.json --force             replaces a character that is already there
//   npm run character:import -- kira.json --check             checks the files and writes nothing
//
// Stop the server first and restart it after: a character is read when the server starts.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { importCharacters, parseImportArgs, placeDirectory, refuseRebuiltFolder } from "../src/game/characterFile.js";

const parsed = parseImportArgs(process.argv.slice(2));
if (!parsed) {
  console.error("Usage: npm run character:import -- <file>... [--campaign <name> | --scenario <name>] [--force] [--check]");
  process.exit(1);
}

// npm runs the script from the server folder, so a relative path is taken from where the command was typed.
const from = process.env.INIT_CWD ?? process.cwd();

try {
  const config = loadConfig({ ...process.env, SHADOWRUN_SCENARIO: undefined });
  const dir = placeDirectory(parsed, config);
  await refuseRebuiltFolder(dir);
  const sources = await Promise.all(parsed.files.map(async (name) => ({ name, text: await readFile(resolve(from, name), "utf8") })));
  const result = await importCharacters({ sources, dir, force: parsed.force, check: parsed.check });
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(problem);
    console.error("Nothing was imported.");
    process.exit(1);
  }
  const verb = result.written ? "Imported" : "Checked";
  for (const sheet of result.sheets) console.log(`${verb} ${sheet.name} (${sheet.id})`);
  if (result.written) console.log(`Wrote ${result.sheets.length} character${result.sheets.length === 1 ? "" : "s"} to ${dir}. Restart the server to play them.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
