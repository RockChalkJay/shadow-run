import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RollRequestInput, ServerEvent, TranscriptEntry } from "@shadow-run/shared";
import { demoParty } from "../src/game/demoParty.js";
import { GameSession, type SessionOptions } from "../src/game/session.js";
import { CampaignStore, type NewEntry, type SavedState } from "../src/game/store.js";
import type { GmDriver, GmTurnContext } from "../src/gm/driver.js";
import type { D6 } from "../src/rules/index.js";

export const party = demoParty;

/** A valid `request_roll` call for Kira, with anything overridden. */
export function rollInput(overrides: Partial<Omit<RollRequestInput, "healing">> = {}): Omit<RollRequestInput, "healing"> {
  return {
    characterId: "kira",
    label: "Sneak past the guard",
    pool: { total: 4, breakdown: "Agility 3 + Sneaking 1" },
    threshold: 2,
    stakes: "Reach the door unseen.",
    goodRoll: "Two or more hits.",
    badRoll: "Fewer than two hits.",
    consequences: {
      success: "Kira slips through.",
      failure: "The guard challenges her.",
      glitch: "A tile creaks.",
      criticalGlitch: "The alarm goes off.",
    },
    edgeAdvice: "Hold Edge for a reroll.",
    ...overrides,
  };
}

export async function tempStore(): Promise<CampaignStore> {
  return new CampaignStore(await mkdtemp(join(tmpdir(), "sr-campaign-")));
}

/** A store that lives in memory and answers within microtasks, for tests that depend on exact timing. */
export class MemoryStore extends CampaignStore {
  private state: SavedState | null = null;
  private log: TranscriptEntry[] = [];

  constructor() {
    super("/nonexistent");
  }

  override async loadParty() {
    return null;
  }

  override async loadState() {
    return this.state;
  }

  override async saveState(state: SavedState) {
    this.state = structuredClone(state);
  }

  override async appendEntry(entry: NewEntry) {
    const full = { ...entry, id: this.log.length + 1, ts: "now" } as TranscriptEntry;
    this.log.push(full);
    return full;
  }

  override async recentEntries(limit: number) {
    return this.log.slice(-limit);
  }
}

/** Collects what a session emits. */
export function collector() {
  const events: ServerEvent[] = [];
  return { events, emit: (event: ServerEvent) => void events.push(event) };
}

export async function newSession(driver: GmDriver, extra: Partial<SessionOptions> = {}) {
  const store = extra.store ?? (await tempStore());
  const sink = collector();
  const session = await GameSession.create({ store, driver, party, emit: sink.emit, ...extra });
  return { session, store, ...sink };
}

/** A d6 that returns the same face every time. */
export const always = (face: number): D6 => () => face;

export const types = (events: ServerEvent[]) => events.map((e) => e.type);

/**
 * A driver for tests that need the GM's tools. `run` makes the GM take a turn and, during it, calls
 * `act` with that turn's context, then hands back whatever `act` returned.
 */
export function toolRunner() {
  let act: ((ctx: GmTurnContext) => Promise<unknown>) | undefined;
  let result: unknown;
  const driver: GmDriver = {
    async takeTurn(_input, ctx) {
      const job = act;
      act = undefined;
      if (job) result = await job(ctx);
    },
  };
  return {
    driver,
    async run<T>(session: GameSession, job: (ctx: GmTurnContext) => Promise<T>): Promise<T> {
      act = job;
      await session.say("kira", "go");
      await session.whenIdle();
      return result as T;
    },
  };
}
