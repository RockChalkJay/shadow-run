import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CharacterSheet } from "@shadow-run/shared";
import { z } from "zod";
import { derivedValues } from "../rules/derived.js";
import { MADE_FROM_SCENARIO, SCENARIO_NAME } from "./scenario.js";
import { CampaignStore } from "./store.js";

/** The character file text for one sheet: the sheet as the game reads it, and with `derived` the record sheet's worked-out boxes too, which an import ignores. */
export function characterFileText(sheet: CharacterSheet, options: { derived?: boolean } = {}): string {
  return `${JSON.stringify(options.derived ? { ...sheet, derived: derivedValues(sheet) } : sheet, null, 2)}\n`;
}

/** The sheets in a campaign or scenario folder: one by id, or all of them. */
export async function exportCharacters(opts: { dir: string; id?: string }): Promise<CharacterSheet[]> {
  const party = await new CampaignStore(opts.dir).loadParty();
  if (!party) throw new Error(`${opts.dir} has no character sheets to export`);
  if (opts.id === undefined) return party;
  const found = party.find((sheet) => sheet.id === opts.id);
  if (!found) throw new Error(`There is no character "${opts.id}" in ${opts.dir}. It has: ${party.map((sheet) => sheet.id).join(", ")}.`);
  return [found];
}

/** One file given to an import: where it came from, for messages, and what it said. */
export interface ImportSource {
  name: string;
  text: string;
}

/** Reads a character file. The record sheet's `derived` block, which an export may add, is dropped; everything else is checked as a sheet is. */
export function readCharacterFile(source: ImportSource): CharacterSheet {
  let raw: unknown;
  try {
    raw = JSON.parse(source.text);
  } catch (err) {
    throw new Error(`${source.name} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const { derived: _derived, ...sheet } = raw as Record<string, unknown>;
    raw = sheet;
  }
  const parsed = CharacterSheet.safeParse(raw);
  if (!parsed.success) throw new Error(`${source.name} is not a valid character sheet: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface ImportResult {
  /** The characters in the files that were fine, in the order given. */
  sheets: CharacterSheet[];
  /** Problems with the files or with writing them; when there are any, nothing was written. */
  problems: string[];
  /** Whether the characters were written. */
  written: boolean;
}

/**
 * Imports character files into a folder's `characters/`. If any file is wrong, two files name one character, or a character is
 * already there without `force`, nothing is written and every problem is listed. With `check` the files are checked and nothing
 * is written either way. The write itself is one file at a time, so a disk that fails partway leaves the files before it.
 */
export async function importCharacters(opts: { sources: ImportSource[]; dir: string; force?: boolean; check?: boolean }): Promise<ImportResult> {
  const problems: string[] = [];
  const sheets: CharacterSheet[] = [];
  const from = new Map<string, string>();
  for (const source of opts.sources) {
    try {
      const sheet = readCharacterFile(source);
      const earlier = from.get(sheet.id);
      if (earlier !== undefined) problems.push(`${source.name} holds the character "${sheet.id}", which ${earlier} also holds`);
      else {
        from.set(sheet.id, source.name);
        sheets.push(sheet);
      }
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const store = new CampaignStore(opts.dir);
  if (!opts.force && sheets.length > 0) {
    // By file name, so a character whose file is there but not a valid sheet is not replaced without `force` either.
    const there = await readdir(join(opts.dir, "characters")).catch(() => [] as string[]);
    for (const sheet of sheets) {
      if (there.includes(`${sheet.id}.json`)) problems.push(`${sheet.id} is already in ${opts.dir}; import over it with --force`);
    }
  }
  if (problems.length > 0 || opts.check) return { sheets, problems, written: false };
  await store.saveParty(sheets);
  return { sheets, problems, written: true };
}

/** Where an import or export looks: a campaign, or a scenario, and never both. */
export interface Place {
  campaign?: string;
  scenario?: string;
}

/** The folder a place names: a scenario's, a named campaign's, or the "default" campaign's. */
export function placeDirectory(place: Place, dirs: { campaignsDir: string; scenariosDir: string }): string {
  if (place.scenario !== undefined) {
    if (!SCENARIO_NAME.test(place.scenario)) throw new Error(`A scenario name may use letters, digits, - and _ only, got "${place.scenario}"`);
    return join(dirs.scenariosDir, place.scenario);
  }
  const campaign = place.campaign ?? "default";
  if (!/^[a-z0-9_-]+$/i.test(campaign)) throw new Error(`A campaign name may use letters, digits, - and _ only, got "${campaign}"`);
  return join(dirs.campaignsDir, campaign);
}

/** Refuses a folder that is rebuilt from a scenario every time the table starts, where an import would be wiped before it was ever played. */
export async function refuseRebuiltFolder(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.includes(MADE_FROM_SCENARIO)) {
    throw new Error(`${dir} is rebuilt from a scenario on every start, so anything imported into it would be wiped. Import into the scenario instead, with --scenario.`);
  }
}

function readPlace(args: readonly string[], flags: Record<string, "flag" | "value">): { values: Record<string, string>; flags: Set<string>; words: string[] } | undefined {
  const values: Record<string, string> = {};
  const set = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const kind = flags[arg];
    if (kind === "flag") set.add(arg);
    else if (kind === "value") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      values[arg] = value;
    } else if (arg.startsWith("--")) return undefined;
    else words.push(arg);
  }
  if (values["--campaign"] !== undefined && values["--scenario"] !== undefined) return undefined;
  return { values, flags: set, words };
}

/** Reads `<id> | --all [--campaign x | --scenario y] [--out path] [--derived]`, or undefined when the words do not fit that. */
export function parseExportArgs(args: readonly string[]): (Place & { id?: string; out?: string; derived: boolean }) | undefined {
  const read = readPlace(args, { "--all": "flag", "--derived": "flag", "--campaign": "value", "--scenario": "value", "--out": "value" });
  if (!read) return undefined;
  const all = read.flags.has("--all");
  if (all ? read.words.length > 0 : read.words.length !== 1) return undefined;
  const { "--campaign": campaign, "--scenario": scenario, "--out": out } = read.values;
  if (all && out === undefined) return undefined;
  return {
    ...(!all && { id: read.words[0]! }),
    ...(campaign !== undefined && { campaign }),
    ...(scenario !== undefined && { scenario }),
    ...(out !== undefined && { out }),
    derived: read.flags.has("--derived"),
  };
}

/** Reads `<file>... [--campaign x | --scenario y] [--force] [--check]`, or undefined when the words do not fit that. */
export function parseImportArgs(args: readonly string[]): (Place & { files: string[]; force: boolean; check: boolean }) | undefined {
  const read = readPlace(args, { "--force": "flag", "--check": "flag", "--campaign": "value", "--scenario": "value" });
  if (!read || read.words.length === 0) return undefined;
  const { "--campaign": campaign, "--scenario": scenario } = read.values;
  return {
    files: read.words,
    ...(campaign !== undefined && { campaign }),
    ...(scenario !== undefined && { scenario }),
    force: read.flags.has("--force"),
    check: read.flags.has("--check"),
  };
}
