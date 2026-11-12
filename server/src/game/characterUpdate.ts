import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CharacterSheet, MAX_HISTORY, MAX_KARMA_PER_RUN, MAX_NUYEN_CHANGE, type Contact, type GearItem, type RunEntry } from "@shadow-run/shared";
import { z } from "zod";
import { CampaignStore } from "./store.js";

export { MAX_KARMA_PER_RUN, MAX_NUYEN_CHANGE };

/** What a run changes about a character. Everything is optional. */
export interface RunUpdate {
  /** Karma earned, added to both the Karma in hand and the total. */
  karma?: number;
  /** Nuyen gained, or spent when negative. */
  nuyen?: number;
  gear?: { add?: GearItem[]; remove?: string[] };
  /** Contacts to add, or update by name; a new one needs both ratings. */
  contacts?: Array<{ name: string; loyalty?: number; connection?: number; notes?: string }>;
  /** A line added to the sheet's notes. */
  note?: string;
  /** The run for the history; its number is the next one. */
  history?: Omit<RunEntry, "run" | "date">;
}

export type Applied = { ok: true; sheet: CharacterSheet; changes: string[] } | { ok: false; error: string };

const money = (n: number) => n.toLocaleString("en-US");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The sheet after a run, and the changes in words. Nothing is changed in place, and if anything cannot be applied (a limit, a
 * contact that is new but has no ratings, more gear than a list holds) nothing is: the error says why. A sheet whose gear is
 * still text keeps it, and gear changes for it are kept in the run's history instead.
 */
export function applyRunUpdate(sheet: CharacterSheet, update: RunUpdate, options: { date: string }): Applied {
  const changes: string[] = [];
  const next: CharacterSheet = structuredClone(sheet);

  if (update.karma !== undefined) {
    if (!Number.isInteger(update.karma) || update.karma < 0 || update.karma > MAX_KARMA_PER_RUN) {
      return { ok: false, error: `Karma for one run is a whole number from 0 to ${MAX_KARMA_PER_RUN}, got ${update.karma}.` };
    }
    if (update.karma > 0) {
      const before = next.personal?.karma ?? 0;
      next.personal = { ...next.personal, karma: before + update.karma, totalKarma: (next.personal?.totalKarma ?? 0) + update.karma };
      changes.push(`Karma ${before} → ${before + update.karma}`);
    }
  }

  if (update.nuyen !== undefined) {
    if (!Number.isInteger(update.nuyen) || Math.abs(update.nuyen) > MAX_NUYEN_CHANGE) {
      return { ok: false, error: `Nuyen for one run changes by a whole number up to ${money(MAX_NUYEN_CHANGE)}, got ${update.nuyen}.` };
    }
    const before = next.lifestyle?.nuyen ?? 0;
    if (before + update.nuyen < 0) return { ok: false, error: `${sheet.name} has ${money(before)} nuyen and cannot spend ${money(-update.nuyen)}.` };
    if (update.nuyen !== 0) {
      next.lifestyle = { ...next.lifestyle, nuyen: before + update.nuyen };
      changes.push(`Nuyen ${money(before)} → ${money(before + update.nuyen)}`);
    }
  }

  const gearNotes: string[] = [];
  const added = update.gear?.add ?? [];
  const removed = update.gear?.remove ?? [];
  if (added.length > 0 || removed.length > 0) {
    if (typeof next.gear === "string") {
      // Free text cannot have items added to it or taken out, so what changed goes in the history instead.
      gearNotes.push(...added.map((g) => `+ ${g.name}`), ...removed.map((name) => `− ${name}`));
      const what = [...added.map((g) => `+ ${g.name}`), ...removed.map((n) => `− ${n}`)].join(", ");
      changes.push(`Gear is written as text, so ${what} ${update.history ? "is in the history only" : "was not applied, and there is no history entry to hold it"}`);
    } else {
      let items = [...next.gear];
      for (const name of removed) {
        const at = items.findIndex((g) => same(g.name, name));
        if (at === -1) changes.push(`${name} was not in the gear`);
        else {
          items.splice(at, 1);
          changes.push(`Gear − ${name}`);
        }
      }
      for (const item of added) {
        const at = items.findIndex((g) => same(g.name, item.name));
        if (at === -1) {
          items.push(item);
          changes.push(`Gear + ${item.name}`);
        } else {
          items[at] = { ...items[at]!, ...item, name: items[at]!.name };
          changes.push(`Gear ${items[at]!.name} updated`);
        }
      }
      next.gear = items;
    }
  }

  for (const given of update.contacts ?? []) {
    const list: Contact[] = [...(next.contacts ?? [])];
    const at = list.findIndex((c) => same(c.name, given.name));
    if (at === -1) {
      if (given.loyalty === undefined || given.connection === undefined) {
        return { ok: false, error: `${given.name} is a new contact, so give both Loyalty and Connection.` };
      }
      list.push({ name: given.name, loyalty: given.loyalty, connection: given.connection, ...(given.notes !== undefined && { notes: given.notes }) });
      changes.push(`Contact ${given.name} added (Loyalty ${given.loyalty}, Connection ${given.connection})`);
    } else {
      const was = list[at]!;
      const updated = { ...was, ...(given.loyalty !== undefined && { loyalty: given.loyalty }), ...(given.connection !== undefined && { connection: given.connection }), ...(given.notes !== undefined && { notes: given.notes }) };
      list[at] = updated;
      const parts = [
        given.loyalty !== undefined && given.loyalty !== was.loyalty ? `Loyalty ${was.loyalty} → ${given.loyalty}` : "",
        given.connection !== undefined && given.connection !== was.connection ? `Connection ${was.connection} → ${given.connection}` : "",
        given.notes !== undefined && given.notes !== was.notes ? "notes changed" : "",
      ].filter(Boolean);
      if (parts.length > 0) changes.push(`Contact ${was.name}: ${parts.join(", ")}`);
    }
    next.contacts = list;
  }

  if (update.note?.trim()) {
    next.notes = next.notes ? `${next.notes}\n${update.note.trim()}` : update.note.trim();
    changes.push("A note added");
  }

  if (update.history) {
    if ((next.history ?? []).length >= MAX_HISTORY) {
      return { ok: false, error: `${sheet.name}'s history already holds ${MAX_HISTORY} runs, the most a sheet keeps. Trim the oldest from their sheet by hand, then write the session up again.` };
    }
    const run = Math.max(0, ...(next.history ?? []).map((r) => r.run)) + 1;
    const consequences = [update.history.consequences?.trim(), gearNotes.length > 0 ? `Gear: ${gearNotes.join(", ")}` : ""].filter(Boolean).join(" ");
    const { consequences: _drop, ...rest } = update.history;
    next.history = [...(next.history ?? []), { ...rest, ...(consequences && { consequences }), run, date: options.date }];
    changes.push(`History: run ${run} added`);
  }

  const parsed = CharacterSheet.safeParse(next);
  if (!parsed.success) return { ok: false, error: `That would not make a valid sheet: ${z.prettifyError(parsed.error)}` };
  return { ok: true, sheet: parsed.data, changes };
}

/** One line for the table to read: "Kira: Karma 6 → 16; Gear + Medkit". */
export function describeChanges(name: string, changes: readonly string[]): string {
  return `${name}: ${changes.length > 0 ? changes.join("; ") : "no change"}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Writes a sheet into a campaign's `characters/` folder, after copying the file that was there to `characters/history/<id>-<date>.json`
 * (`-2`, `-3` and so on if there is already one for that day). The history folder is not read as characters. If the copy cannot be
 * made, nothing is written. Returns where the old sheet went, or undefined if there was none.
 */
export async function saveSheetWithCopy(opts: { dir: string; sheet: CharacterSheet; date: string }): Promise<{ copy?: string }> {
  if (!DATE.test(opts.date)) throw new Error(`The date for a saved copy is YYYY-MM-DD, got "${opts.date}"`);
  const file = join(opts.dir, "characters", `${opts.sheet.id}.json`);
  const existing = await readFile(file).then(() => true, () => false);
  let copy: string | undefined;
  if (existing) {
    const folder = join(opts.dir, "characters", "history");
    await mkdir(folder, { recursive: true });
    for (let n = 1; n <= 99 && copy === undefined; n++) {
      const target = join(folder, `${opts.sheet.id}-${opts.date}${n === 1 ? "" : `-${n}`}.json`);
      // Never over a copy that is there already.
      const made = await copyFile(file, target, constants.COPYFILE_EXCL).then(() => true, (err: NodeJS.ErrnoException) => (err.code === "EEXIST" ? false : Promise.reject(err)));
      if (made) copy = target;
    }
    if (copy === undefined) throw new Error(`There are already 99 saved copies of ${opts.sheet.id} for ${opts.date}`);
  }
  await new CampaignStore(opts.dir).saveParty([opts.sheet]);
  return copy === undefined ? {} : { copy };
}
