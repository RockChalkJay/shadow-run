import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CharacterSheet, CombatState, ConditionMonitor, DamageType, HealMethod, Party, ResolvedRoll, RollRequest, type TranscriptEntry } from "@shadow-run/shared";
import { z } from "zod";
import { TREATMENTS } from "../rules/index.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A transcript entry before the store gives it an id and a time. */
export type NewEntry = DistributiveOmit<TranscriptEntry, "id" | "ts">;

/** A grunt's rating, role and nerve, as saved. */
const Grunt = z.object({
  professionalRating: z.number().int().min(0).max(10),
  lieutenant: z.boolean(),
  charisma: z.number().int().min(1),
  last: DamageType.nullable(),
});

/** A treatment a character has had for their current injuries. */
const Treatment = z.enum(TREATMENTS);

export const SavedState = z.object({
  version: z.literal(1),
  /** The Claude session the GM resumes. */
  claudeSessionId: z.string().optional(),
  /** Has the GM taken a turn yet? */
  opened: z.boolean(),
  /** Did a player ask to begin before the GM got to open? */
  openRequested: z.boolean(),
  turnCounter: z.number().int().min(0),
  pending: z.array(RollRequest),
  /** Roll outcomes the GM has not been told about yet. */
  results: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("resolved"), resolved: ResolvedRoll }),
      z.object({ kind: z.literal("cancelled"), request: RollRequest }),
      /** A report the system wrote for the GM, such as how a character fared against damage. */
      z.object({ kind: z.literal("report"), text: z.string() }),
    ]),
  ),
  /** How hurt each player character is. Older saves have none, and everyone starts unhurt. */
  pcs: z.array(z.object({ id: z.string(), monitor: ConditionMonitor, treated: z.array(Treatment).default([]), grunt: Grunt.optional() })).default([]),
  /** The non-player characters the GM has put on the table, and how hurt they are. */
  npcs: z
    .array(z.object({ id: z.string(), name: z.string(), body: z.number().int(), willpower: z.number().int(), monitor: ConditionMonitor, treated: z.array(Treatment).default([]), grunt: Grunt.optional() }))
    .default([]),
  /** The fight in progress, if any. */
  combat: CombatState.nullable().default(null),
  /** Hits still unspent on healing rolls the GM has been told about, so a restart does not grant them again. */
  healBudgets: z
    .array(
      z.object({
        rollId: z.string(),
        patient: z.object({ kind: z.enum(["pc", "npc"]), id: z.string() }),
        method: HealMethod,
        remaining: z.number().int().min(0),
      }),
    )
    .default([]),
  /** What players said that the GM has not heard yet. */
  held: z.array(z.object({ characterId: z.string().optional(), name: z.string(), text: z.string() })),
});
export type SavedState = z.infer<typeof SavedState>;

/** The sheet files among a folder's names, in the order the characters are read: by id, whatever order the disk lists them in. */
export function sheetFiles(names: readonly string[]): string[] {
  return names.filter((name) => name.endsWith(".json")).sort();
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** One campaign's files: the character sheets, the game state and the transcript. Writes are serialized and atomic. */
export class CampaignStore {
  private chain: Promise<unknown> = Promise.resolve();
  private lastId: number | undefined;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(name: string) {
    return join(this.dir, name);
  }

  /** Runs `job` after every earlier write has finished, whether or not they succeeded. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async readJson(name: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8"));
    } catch (err) {
      if (isMissing(err)) return null;
      throw new Error(`${this.file(name)} could not be read: ${(err as Error).message}`);
    }
  }

  private writeJson(name: string, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.file(name)), { recursive: true });
      const tmp = `${this.file(name)}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
      await rename(tmp, this.file(name));
    });
  }

  /**
   * The player characters, one `characters/<id>.json` file each, in order of id. A file must be named after the
   * character it holds, so there can be no two with one id. Null when there are no sheets at all.
   */
  async loadParty(): Promise<Party | null> {
    let names: string[];
    try {
      names = await readdir(this.file("characters"));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const files = sheetFiles(names);
    if (files.length === 0) return null;

    const sheets: CharacterSheet[] = [];
    for (const name of files) {
      const raw = await this.readJson(join("characters", name));
      const parsed = CharacterSheet.safeParse(raw);
      const path = this.file(join("characters", name));
      if (!parsed.success) throw new Error(`${path} is not a valid character sheet: ${z.prettifyError(parsed.error)}`);
      if (name !== `${parsed.data.id}.json`) {
        throw new Error(`${path} holds the character "${parsed.data.id}", so the file must be named ${parsed.data.id}.json`);
      }
      sheets.push(parsed.data);
    }
    return sheets;
  }

  /**
   * The campaign's characters, or `fallback` written out as sheets when it has none. Either way they are read back
   * from disk, so every start sees them in the same order, and `created` says which happened.
   */
  async loadOrCreateParty(fallback: Party): Promise<{ party: Party; created: boolean }> {
    const existing = await this.loadParty();
    if (existing) return { party: existing, created: false };
    await this.saveParty(fallback);
    return { party: (await this.loadParty()) ?? fallback, created: true };
  }

  async saveParty(party: Party): Promise<void> {
    await Promise.all(party.map((sheet) => this.writeJson(join("characters", `${sheet.id}.json`), sheet)));
  }

  async loadState(): Promise<SavedState | null> {
    const raw = await this.readJson("state.json");
    if (raw === null) return null;
    const parsed = SavedState.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${this.file("state.json")} is not a valid game state; move it aside to start over: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  saveState(state: SavedState): Promise<void> {
    return this.writeJson("state.json", state);
  }

  private async entries(): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file("transcript.jsonl"), "utf8");
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    return text.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as TranscriptEntry];
      } catch {
        // A line cut short by a crash is dropped rather than blocking the whole transcript.
        return [];
      }
    });
  }

  appendEntry(entry: NewEntry): Promise<TranscriptEntry> {
    return this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      this.lastId ??= (await this.entries()).at(-1)?.id ?? 0;
      const full = { ...entry, id: ++this.lastId, ts: this.now().toISOString() } as TranscriptEntry;
      await appendFile(this.file("transcript.jsonl"), `${JSON.stringify(full)}\n`);
      return full;
    });
  }

  /** The newest `limit` entries, oldest first. */
  async recentEntries(limit: number): Promise<TranscriptEntry[]> {
    await this.chain;
    return (await this.entries()).slice(-limit);
  }
}
