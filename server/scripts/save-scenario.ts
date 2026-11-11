// Saves a campaign's current game as a scenario that `SHADOWRUN_SCENARIO=<name>` can start from again.
//
//   npm run scenario:save -- <name>                 saves the "default" campaign
//   npm run scenario:save -- <name> --campaign night-one
//   npm run scenario:save -- <name> --force         replaces a scenario that already exists
//
// Save while the table is idle, so no turn is half written.

import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { parseSaveArgs, saveScenario } from "../src/game/scenario.js";

const parsed = parseSaveArgs(process.argv.slice(2));
if (!parsed) {
  console.error("Usage: npm run scenario:save -- <name> [--campaign <campaign>] [--force]");
  process.exit(1);
}
const { name, campaign, force } = parsed;

const config = loadConfig({ ...process.env, SHADOWRUN_SCENARIO: undefined, ...(campaign && { SHADOWRUN_CAMPAIGN: campaign }) });
const target = await saveScenario({
  campaignDir: join(config.campaignsDir, config.campaign),
  scenariosDir: config.scenariosDir,
  name,
  force,
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
console.log(`Saved the "${config.campaign}" campaign as the scenario "${name}" in ${target}.`);
console.log(`Start from it with: SHADOWRUN_SCENARIO=${name} npm run dev:server`);
