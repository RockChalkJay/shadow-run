import {
  MAX_POOL,
  type GmEvent,
  type GmStatus,
  type PartyMember,
  type ResolvedRoll,
  type RollRequest,
  type ServerEvent,
  type Snapshot,
  type TranscriptEntry,
  type Usage,
} from "@shadow-run/shared";
import { z } from "zod";
import type { GmDriver, GmTools, GmTurnInput, ToolReply } from "../gm/driver.js";
import { restingFrom } from "../gm/limits.js";
import { cryptoD6, rollPool, simpleTest, type D6, type Ruleset } from "../rules/index.js";
import { formatCancelledForGm, formatNpcRoll, formatRollForGm } from "./rollReport.js";
import { RollManager, type RollEntry } from "./rollManager.js";
import type { CampaignStore, NewEntry, SavedState } from "./store.js";

export type Ack = { ok: true } | { ok: false; error: string };

type Held = SavedState["held"][number];
type Outcome = SavedState["results"][number];

interface Turn {
  results: Outcome[];
  held: Held[];
  openRequested: boolean;
}

const NpcRollInput = z.object({
  label: z.string().min(1).describe("Who is rolling and why, e.g. 'Ganger sprays the doorway'"),
  pool: z.number().int().min(0).max(MAX_POOL).describe("Number of d6"),
  threshold: z.number().int().min(1).optional().describe("Hits needed, if the roll is against a fixed threshold"),
});

export interface SessionOptions {
  store: CampaignStore;
  driver: GmDriver;
  party: PartyMember[];
  emit: (event: ServerEvent) => void;
  d6?: D6;
  rules?: Ruleset;
  /** Longest a GM turn may take before it is stopped. */
  turnTimeoutMs?: number;
  now?: () => Date;
}

/** How many transcript entries a client receives when it connects. */
const SNAPSHOT_ENTRIES = 100;

/**
 * The table: who is playing, which rolls are waiting for dice, and the conversation with the GM.
 * The GM takes one turn at a time and is held back while anyone owes it a roll.
 */
export class GameSession {
  private readonly rolls: RollManager;
  private readonly d6: D6;
  private readonly rules: Ruleset | undefined;
  private results: Outcome[];
  private held: Held[];
  private openRequested: boolean;
  private opened: boolean;
  private turnCounter: number;
  private claudeSessionId: string | undefined;
  private status: GmStatus = { phase: "idle" };
  private usage: Usage | null = null;
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  /** After a failed turn the GM waits for a new message or a retry instead of repeating itself. */
  private blocked = false;
  private current: AbortController | null = null;
  private cancelledByUser = false;
  /** The turn whose tools work, while it is running and has not been stopped. */
  private activeTurn: { id: number; signal: AbortSignal } | null = null;

  static async create(opts: SessionOptions): Promise<GameSession> {
    const [saved, recent] = await Promise.all([opts.store.loadState(), opts.store.recentEntries(SNAPSHOT_ENTRIES)]);
    return new GameSession(opts, saved, recent);
  }

  private constructor(
    private readonly opts: SessionOptions,
    saved: SavedState | null,
    /** The newest transcript entries, kept so a snapshot can be taken without waiting for the disk. */
    private readonly recent: TranscriptEntry[],
  ) {
    this.d6 = opts.d6 ?? cryptoD6;
    this.rules = opts.rules;
    this.rolls = new RollManager(
      { knownCharacter: (id) => this.member(id) !== undefined, d6: this.d6, rules: this.rules },
      saved?.pending ?? [],
    );
    this.results = saved?.results ?? [];
    this.held = saved?.held ?? [];
    this.openRequested = saved?.openRequested ?? false;
    this.opened = saved?.opened ?? false;
    this.turnCounter = saved?.turnCounter ?? 0;
    this.claudeSessionId = saved?.claudeSessionId;
    this.status = this.restingStatus();
  }

  get party(): readonly PartyMember[] {
    return this.opts.party;
  }

  /** The Claude session the GM resumes, once there is one. */
  get gmSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  private member(id: string | undefined): PartyMember | undefined {
    return id === undefined ? undefined : this.opts.party.find((m) => m.id === id);
  }

  private nameOf(id: string | undefined): string {
    return this.member(id)?.name ?? "Table";
  }

  private restingStatus(): GmStatus {
    return this.rolls.list().length > 0 ? { phase: "waiting_for_rolls" } : { phase: "idle" };
  }

  private setStatus(status: GmStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    this.opts.emit({ type: "gm.status", status });
  }

  private toSaved(): SavedState {
    return {
      version: 1,
      ...(this.claudeSessionId !== undefined && { claudeSessionId: this.claudeSessionId }),
      opened: this.opened,
      openRequested: this.openRequested,
      turnCounter: this.turnCounter,
      pending: this.rolls.list(),
      results: this.results,
      held: this.held,
    };
  }

  private persist(): Promise<void> {
    return this.opts.store.saveState(this.toSaved());
  }

  private async record(entry: NewEntry): Promise<TranscriptEntry> {
    const full = await this.opts.store.appendEntry(entry);
    // Remembering the entry and announcing it happen in one step, so a snapshot taken at any moment
    // holds exactly the entries announced before it.
    this.recent.push(full);
    if (this.recent.length > SNAPSHOT_ENTRIES) this.recent.shift();
    this.opts.emit({ type: "entry", entry: full });
    return full;
  }

  /**
   * Everything a client needs to catch up. It is taken in one step with no waiting, so a client that
   * starts listening at the same moment misses nothing and sees nothing twice.
   */
  snapshot(): Snapshot {
    return {
      type: "snapshot",
      party: [...this.opts.party],
      pendingRolls: this.rolls.list(),
      transcript: [...this.recent],
      gm: this.status,
      usage: this.usage,
    };
  }

  // ---- what the table does -------------------------------------------------------------------

  /** Begins the session: the GM opens the first scene. */
  async start(): Promise<Ack> {
    if (this.opened || this.openRequested) return { ok: false, error: "The session has already begun." };
    this.openRequested = true;
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  /** Picks up work saved before a restart: messages or roll results the GM never heard. */
  resume(): void {
    this.schedule();
  }

  async say(characterId: string | undefined, text: string): Promise<Ack> {
    if (characterId !== undefined && !this.member(characterId)) return { ok: false, error: `There is no character "${characterId}" at the table.` };
    const name = this.nameOf(characterId);
    await this.record({ kind: "say", ...(characterId !== undefined && { characterId }), name, text });
    this.held.push({ ...(characterId !== undefined && { characterId }), name, text });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  async submitRoll(requestId: string, entry: RollEntry): Promise<Ack> {
    const result = this.rolls.resolve(requestId, entry);
    if (!result.ok) return result;
    this.results.push({ kind: "resolved", resolved: result.resolved });
    await this.record({ kind: "roll", resolved: result.resolved });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  async cancelRoll(requestId: string): Promise<Ack> {
    const request = this.rolls.cancel(requestId);
    if (!request) return { ok: false, error: "That roll is not waiting for dice." };
    this.results.push({ kind: "cancelled", request });
    this.opts.emit({ type: "roll.cancelled", requestId });
    await this.record({ kind: "roll_cancelled", requestId, characterId: request.characterId, label: request.label });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  /** Stops the GM mid-turn. What it was told is kept for its next turn. */
  cancelTurn(): Ack {
    if (!this.current) return { ok: false, error: "The GM is not in the middle of a turn." };
    this.cancelledByUser = true;
    this.current.abort(new Error("The turn was cancelled."));
    return { ok: true };
  }

  /** Tries again after a failed turn. */
  retry(): Ack {
    if (!this.blocked) return { ok: false, error: "There is nothing to retry." };
    this.blocked = false;
    this.schedule();
    return { ok: true };
  }

  /** Resolves once the GM has no turn running and no work waiting that it can act on. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.loop;
  }

  /** Stops any turn in progress and waits for it to finish. */
  async close(): Promise<void> {
    this.current?.abort(new Error("The server is shutting down."));
    await this.whenIdle();
  }

  // ---- what the GM does ----------------------------------------------------------------------

  /**
   * The tools for one turn. They work only while that turn is the current one and has not been
   * stopped: a process that is being shut down can still send one last call, and it must not put
   * a roll on the table for a turn nobody is waiting on.
   */
  private toolsFor(turnId: number, signal: AbortSignal): GmTools {
    const whileCurrent = (act: () => Promise<ToolReply>): Promise<ToolReply> =>
      this.activeTurn?.id === turnId && !signal.aborted
        ? act()
        : Promise.resolve({ ok: false, text: "That turn is over, so nothing was done. Do not call tools now." });
    return {
      requestRoll: (input) => whileCurrent(() => this.requestRoll(input)),
      rollNpc: (input) => whileCurrent(() => this.rollNpc(input)),
    };
  }

  private async requestRoll(input: unknown): Promise<ToolReply> {
    const created = this.rolls.create(input);
    if (!created.ok) return { ok: false, text: created.error };
    await this.persist();
    this.opts.emit({ type: "roll.requested", request: created.request });
    return { ok: true, text: "The roll card is on the table's screen. End your turn now and wait for the result." };
  }

  private async rollNpc(input: unknown): Promise<ToolReply> {
    const parsed = NpcRollInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The NPC roll was not valid: ${z.prettifyError(parsed.error)}` };
    const { label, pool, threshold } = parsed.data;
    const roll = rollPool(pool, this.d6, this.rules);
    const success = threshold === undefined ? undefined : simpleTest(roll, threshold).success;
    const npc = { label, pool, roll, ...(threshold !== undefined && { threshold }), ...(success !== undefined && { success }) };
    await this.record({ kind: "npc", ...npc });
    return { ok: true, text: formatNpcRoll(npc) };
  }

  // ---- the GM's turns ------------------------------------------------------------------------

  /** Starts the turn loop if it is not running. A running loop looks for more work when its turn ends. */
  private schedule(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pump();
  }

  /**
   * The turn loop. It stops running in the same step as the check that finds no work, so work added
   * after that check always finds the loop stopped and starts it again.
   */
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const turn = this.takeNextTurn();
        if (!turn) break;
        if (!(await this.runTurn(turn))) break;
      }
      if (!this.blocked) this.setStatus(this.restingStatus());
    } catch (err) {
      console.error("The GM's turn loop failed:", err);
      this.blocked = true;
      this.setStatus({ phase: "error", message: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  private takeNextTurn(): Turn | null {
    if (this.blocked || this.rolls.list().length > 0) return null;
    const opening = this.openRequested && !this.opened;
    if (!opening && this.results.length === 0 && this.held.length === 0) return null;
    const turn = { results: this.results, held: this.held, openRequested: this.openRequested };
    this.results = [];
    this.held = [];
    this.openRequested = false;
    return turn;
  }

  private turnInput(turn: Turn): GmTurnInput {
    const parts: string[] = [];
    if (!this.opened) parts.push("BEGIN SESSION. Open the first scene.");
    for (const outcome of turn.results) {
      parts.push(
        outcome.kind === "resolved"
          ? formatRollForGm(outcome.resolved, this.nameOf(outcome.resolved.request.characterId))
          : formatCancelledForGm(outcome.request, this.nameOf(outcome.request.characterId)),
      );
    }
    if (turn.held.length > 0) parts.push(`The players say:\n${turn.held.map((m) => `- ${m.name}: ${m.text}`).join("\n")}`);
    return { kind: this.opened ? "continue" : "open", text: parts.join("\n\n") };
  }

  /** Returns false when the turn failed and the GM should wait for the table. */
  private async runTurn(turn: Turn): Promise<boolean> {
    const turnId = ++this.turnCounter;
    const controller = new AbortController();
    this.current = controller;
    this.cancelledByUser = false;
    const timeout = AbortSignal.timeout(this.opts.turnTimeoutMs ?? 240_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    this.activeTurn = { id: turnId, signal };
    this.setStatus({ phase: "thinking", turnId });

    let narration = "";
    let reportedError: string | undefined;
    let active = true;
    const onEvent = (event: GmEvent) => {
      if (!active) return;
      switch (event.type) {
        case "session":
          if (event.sessionId !== this.claudeSessionId) {
            this.claudeSessionId = event.sessionId;
            void this.persist().catch((err) => console.error("Could not save the game state:", err));
          }
          break;
        case "text_block_start":
          if (narration.trim()) narration += "\n\n";
          this.opts.emit({ type: "gm.block", turnId });
          break;
        case "text":
          narration += event.text;
          this.opts.emit({ type: "gm.text", turnId, text: event.text });
          break;
        case "rate_limit":
          this.usage = { fiveHourUtilization: event.fiveHourUtilization, resetsAt: event.resetsAt };
          this.opts.emit({ type: "usage", usage: this.usage });
          break;
        case "error":
          reportedError = event.message;
          break;
        default:
          break;
      }
    };

    let failure: string | undefined;
    try {
      await this.opts.driver.takeTurn(this.turnInput(turn), { turnId, signal, onEvent, tools: this.toolsFor(turnId, signal) });
      failure = reportedError;
    } catch (err) {
      failure =
        reportedError ??
        (this.cancelledByUser ? "The turn was cancelled." : timeout.aborted ? "The GM took too long to answer." : (err as Error).message);
    } finally {
      active = false;
      this.current = null;
      this.activeTurn = null;
    }

    if (narration.trim()) await this.record({ kind: "gm", text: narration.trim() });
    this.opts.emit({ type: "gm.turn_done", turnId });

    if (failure === undefined) {
      this.opened = true;
      this.blocked = false;
      await this.persist();
      return true;
    }

    // Give the GM back what it was told, so the next attempt includes it.
    this.results = [...turn.results, ...this.results];
    this.held = [...turn.held, ...this.held];
    this.openRequested = this.openRequested || (turn.openRequested && !this.opened);
    this.blocked = true;
    const resting = restingFrom(failure, this.usage, Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000));
    this.setStatus(resting ?? { phase: "error", message: failure });
    const text = resting ? resting.message : this.cancelledByUser ? failure : `The GM's turn failed: ${failure}`;
    await this.record({ kind: "system", text });
    await this.persist();
    return false;
  }
}
