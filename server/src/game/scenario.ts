import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sheetFiles } from "./store.js";

/** Reads `<name> [--campaign <campaign>] [--force]`, or returns undefined when the words do not fit that. */
export function parseSaveArgs(args: readonly string[]): { name: string; campaign?: string; force: boolean } | undefined {
  let name: string | undefined;
  let campaign: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--force") force = true;
    else if (arg === "--campaign") {
      campaign = args[++i];
      if (campaign === undefined || campaign.startsWith("--")) return undefined;
    } else if (arg.startsWith("--") || name !== undefined) return undefined;
    else name = arg;
  }
  return name === undefined ? undefined : { name, ...(campaign !== undefined && { campaign }), force };
}

/** A scenario is named like a campaign: letters, digits, - and _. */
export const SCENARIO_NAME = /^[a-z0-9_-]+$/i;

/** A scenario started from `name` plays in a campaign folder of this name, which is wiped on every start. */
export const scenarioCampaign = (name: string) => `scenario-${name}`;

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

function checkName(name: string) {
  if (!SCENARIO_NAME.test(name)) throw new Error(`A scenario name may use letters, digits, - and _ only, got "${name}"`);
}

/** The scenarios saved in `dir`, by name. */
export async function listScenarios(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SCENARIO_NAME.test(e.name)).map((e) => e.name).sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Copies the files that make up a game from one folder to another: the character sheets, the game state, the
 * transcript and the premise. The GM's session id is left out of the state, since a scenario starts the GM
 * over from the transcript and does not resume whatever session was running when it was saved.
 */
async function copyGame(from: string, to: string) {
  await mkdir(to, { recursive: true });
  const names = await readdir(join(from, "characters")).catch((err) => (isMissing(err) ? [] : Promise.reject(err)));
  if (names.length > 0) {
    await mkdir(join(to, "characters"), { recursive: true });
    for (const name of sheetFiles(names)) await cp(join(from, "characters", name), join(to, "characters", name));
  }
  for (const name of ["transcript.jsonl", "premise.md"]) {
    await cp(join(from, name), join(to, name)).catch((err) => (isMissing(err) ? undefined : Promise.reject(err)));
  }
  const statePath = join(from, "state.json");
  const raw = await readFile(statePath, "utf8").catch((err) => (isMissing(err) ? null : Promise.reject(err)));
  if (raw === null) return;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${statePath} could not be read: ${(err as Error).message}`);
  }
  delete state.claudeSessionId;
  await writeFile(join(to, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** Saves a campaign's current game as the scenario `name`. An existing scenario is replaced only with `force`. */
export async function saveScenario(opts: { campaignDir: string; scenariosDir: string; name: string; force?: boolean }) {
  checkName(opts.name);
  const target = join(opts.scenariosDir, opts.name);
  if ((await listScenarios(opts.scenariosDir)).includes(opts.name) && !opts.force) {
    throw new Error(`The scenario "${opts.name}" already exists; save over it with --force`);
  }
  const sheets = await readdir(join(opts.campaignDir, "characters")).catch((err) => (isMissing(err) ? [] : Promise.reject(err)));
  if (sheetFiles(sheets).length === 0) throw new Error(`${opts.campaignDir} has no character sheets, so there is nothing to save`);
  await rm(target, { recursive: true, force: true });
  await copyGame(opts.campaignDir, target);
  return target;
}

/**
 * Starts `into` as a fresh copy of the scenario `name`, so every start is the same. Only a folder named for a
 * scenario is ever wiped, so a real campaign cannot be lost to a mistyped setting.
 */
export async function loadScenario(opts: { scenariosDir: string; name: string; into: string }) {
  checkName(opts.name);
  if (!basename(opts.into).startsWith("scenario-")) throw new Error(`Refusing to wipe ${opts.into}: it is not a scenario's folder`);
  const names = await listScenarios(opts.scenariosDir);
  if (!names.includes(opts.name)) {
    const have = names.length > 0 ? `Saved scenarios: ${names.join(", ")}.` : `There are none saved in ${opts.scenariosDir}.`;
    throw new Error(`There is no scenario "${opts.name}". ${have}`);
  }
  await rm(opts.into, { recursive: true, force: true });
  await copyGame(join(opts.scenariosDir, opts.name), opts.into);
}
