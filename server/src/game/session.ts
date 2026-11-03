import {
  DealDamageInput,
  HealInput,
  NpcRollInput,
  type CharacterView,
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
import { cryptoD6, damageAfterResistance, damageResistancePool, rollPool, simpleTest, type D6, type Ruleset } from "../rules/index.js";
import { formatRecap } from "./recap.js";
import { Roster } from "./roster.js";
import { formatCancelledForGm, formatDamageForGm, formatHealForGm, formatNpcRoll, formatRollForGm } from "./rollReport.js";
import { MAX_PENDING_ROLLS, RollManager, type RollEntry } from "./rollManager.js";
import type { CampaignStore, NewEntry, SavedState } from "./store.js";

export type Ack = { ok: true } | { ok: false; error: string };

type Held = SavedState["held"][number];
type Outcome = SavedState["results"][number];

interface Turn {
  results: Outcome[];
  held: Held[];
  openRequested: boolean;
}

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
 * The game: who is playing, which rolls are waiting for dice, and the conversation with the GM.
 * The GM takes one turn at a time and is held back while anyone owes it a roll.
 */
export class GameSession {
  private readonly rolls: RollManager;
  private readonly roster: Roster;
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
    this.roster = new Roster(opts.party, saved ?? undefined, this.rules);
    this.rolls = new RollManager(
      {
        knownCharacter: (id) => this.member(id) !== undefined,
        canAct: (id) => this.roster.canAct(id),
        woundPenalty: (id) => this.roster.woundPenalty(id),
        d6: this.d6,
        rules: this.rules,
      },
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
    return this.member(id)?.name ?? "The players";
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
      ...this.roster.toSaved(),
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
      characters: this.roster.views(),
      pendingRolls: this.rolls.list(),
      transcript: [...this.recent],
      gm: this.status,
      usage: this.usage,
    };
  }

  // ---- what the players do -------------------------------------------------------------------

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
    if (characterId !== undefined && !this.member(characterId)) return { ok: false, error: `There is no character "${characterId}" in the party.` };
    const name = this.nameOf(characterId);
    await this.record({ kind: "say", ...(characterId !== undefined && { characterId }), name, text });
    this.held.push({ ...(characterId !== undefined && { characterId }), name, text });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  async submitRoll(requestId: string, entry: RollEntry): Promise<Ack> {
    // A roll can outlive its character if the party was edited while it waited; it has nobody to apply to.
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (waiting && !this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);

    const result = this.rolls.resolve(requestId, entry);
    if (!result.ok) return result;
    const { resolved } = result;
    // A roll to resist damage is not a result for the GM to interpret: the damage is applied now, in this step,
    // and the GM is told how the character stands.
    const soak = resolved.request.soak ? this.applySoak(resolved) : undefined;
    this.results.push(soak ? { kind: "report", text: soak.report } : { kind: "resolved", resolved });
    await this.record({ kind: "roll", resolved });
    if (soak) await this.record(soak.entry);
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  /** Removes a roll whose character is no longer in the party, and tells the GM nothing came of it. */
  private async dropOrphanedRoll(request: RollRequest): Promise<Ack> {
    this.rolls.cancel(request.id);
    this.results.push({ kind: "report", text: `ROLL DROPPED. ${request.label}: that character is no longer in the party, so nothing was rolled or applied.` });
    this.opts.emit({ type: "roll.cancelled", requestId: request.id });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: false, error: "That character is no longer in the party, so the roll was dropped." };
  }

  async cancelRoll(requestId: string): Promise<Ack> {
    if (this.rolls.list().find((r) => r.id === requestId)?.soak) {
      return { ok: false, error: "That roll resists damage that is already coming, so it cannot be skipped. Roll it with the app or with dice." };
    }
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
   * a roll request on the players' screen for a turn nobody is waiting on.
   */
  private toolsFor(turnId: number, signal: AbortSignal): GmTools {
    const whileCurrent = (act: () => Promise<ToolReply>): Promise<ToolReply> =>
      this.activeTurn?.id === turnId && !signal.aborted
        ? act()
        : Promise.resolve({ ok: false, text: "That turn is over, so nothing was done. Do not call tools now." });
    return {
      requestRoll: (input) => whileCurrent(() => this.requestRoll(input)),
      rollNpc: (input) => whileCurrent(() => this.rollNpc(input)),
      dealDamage: (input) => whileCurrent(() => this.dealDamage(input)),
      heal: (input) => whileCurrent(() => this.heal(input)),
    };
  }

  private async requestRoll(input: unknown): Promise<ToolReply> {
    const created = this.rolls.create(input);
    if (!created.ok) return { ok: false, text: created.error };
    await this.persist();
    this.opts.emit({ type: "roll.requested", request: created.request });
    return { ok: true, text: "The roll request is on the players' screen. End your turn now and wait for the result." };
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

  private announce(character: CharacterView): void {
    this.opts.emit({ type: "character.updated", character });
  }

  /** Applies a resistance roll a player made, and says how the character stands. */
  private applySoak(resolved: ResolvedRoll): { report: string; entry: NewEntry } {
    const { request, roll, source } = resolved;
    const soak = request.soak!;
    const taken = damageAfterResistance(soak.damageValue, roll.hits);
    const after = this.roster.damage("pc", request.characterId, soak.damageType, taken);
    this.announce(after);
    const damage = { label: soak.source, damageType: soak.damageType, damageValue: soak.damageValue, resistance: roll, resistedBy: source, taken, after };
    return {
      report: formatDamageForGm({ ...damage, body: request.pool.total }),
      entry: { kind: "damage", ...damage },
    };
  }

  private async dealDamage(input: unknown): Promise<ToolReply> {
    const parsed = DealDamageInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The damage was not valid: ${z.prettifyError(parsed.error)}` };
    const { label, target: ref, damageValue, damageType } = parsed.data;
    const target = this.roster.resolve(ref);
    if (!target.ok) return { ok: false, text: target.error };
    if (this.roster.view(target.kind, target.id)?.status === "dead") return { ok: false, text: `${target.name} is already dead.` };

    if (target.kind === "pc") {
      // Every roll request here is damage that lands once it is answered, so a GM stuck in a loop must not be able to stack them.
      if (this.rolls.list().length >= MAX_PENDING_ROLLS) {
        return { ok: false, text: `There are already ${MAX_PENDING_ROLLS} rolls waiting for dice. Stop and wait for the players to answer them before hurting anyone else.` };
      }
      // The player rolls their own Body to resist, so the dice are theirs.
      const request = this.rolls.createInternal({
        characterId: target.id,
        label: `Resist ${damageValue}${damageType === "physical" ? "P" : "S"} damage: ${label}`,
        pool: { total: damageResistancePool(target.body), breakdown: `Body ${target.body}` },
        threshold: 1,
        stakes: `${damageValue} ${damageType} damage is coming. Every hit on this roll removes one point of it.`,
        goodRoll: "As many hits as possible. Each one blocks a point of damage.",
        badRoll: "Few hits. The rest lands on the condition monitor.",
        consequences: {
          success: "Each hit blocks a point of damage, and the rest is taken.",
          failure: "The full damage is taken.",
          glitch: "A glitch changes nothing in the numbers; the GM may add a small complication.",
          criticalGlitch: "A critical glitch changes nothing in the numbers; the GM may add a serious but not fatal complication.",
        },
        edgeAdvice: "The system does not apply Edge for you yet, so the players keep track of their own.",
        soak: { damageValue, damageType, source: label },
      });
      await this.persist();
      this.opts.emit({ type: "roll.requested", request });
      return {
        ok: true,
        text: `${target.name} must roll Body to resist ${damageValue} ${damageType} damage. The roll request is on the players' screen. End your turn now and wait for the result.`,
      };
    }

    // The system rolls an NPC's Body for them.
    const resistance = rollPool(target.body, this.d6, this.rules);
    const taken = damageAfterResistance(damageValue, resistance.hits);
    const after = this.roster.damage("npc", target.id, damageType, taken);
    this.announce(after);
    const damage = { label, damageType, damageValue, resistance, resistedBy: "system" as const, taken, after };
    await this.record({ kind: "damage", ...damage });
    await this.persist();
    return { ok: true, text: formatDamageForGm({ ...damage, body: target.body }) };
  }

  private async heal(input: unknown): Promise<ToolReply> {
    const parsed = HealInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The healing was not valid: ${z.prettifyError(parsed.error)}` };
    const { target: ref, type, boxes, reason } = parsed.data;
    const target = this.roster.resolve(ref, { create: false });
    if (!target.ok) return { ok: false, text: target.error };
    if (this.roster.view(target.kind, target.id)?.status === "dead") {
      return { ok: false, text: `${target.name} is dead, beyond the reach of any healing.` };
    }
    const { after, healed } = this.roster.heal(target.kind, target.id, type, boxes);
    this.announce(after);
    await this.record({ kind: "heal", reason, type, healed, after });
    await this.persist();
    return { ok: true, text: formatHealForGm({ reason, type, healed, after }) };
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
      if (outcome.kind === "report") parts.push(outcome.text);
      else if (outcome.kind === "resolved") parts.push(formatRollForGm(outcome.resolved, this.nameOf(outcome.resolved.request.characterId)));
      else parts.push(formatCancelledForGm(outcome.request, this.nameOf(outcome.request.characterId)));
    }
    if (turn.held.length > 0) parts.push(`The players say:\n${turn.held.map((m) => `- ${m.name}: ${m.text}`).join("\n")}`);
    return { kind: this.opened ? "continue" : "open", text: parts.join("\n\n") };
  }

  /**
   * The conversation up to the GM's last reply. What came after it is in the turn's own input, so
   * leaving it out here keeps a GM that starts over from hearing it twice.
   */
  private recapBeforeThisTurn(): string {
    const lastGm = this.recent.findLastIndex((entry) => entry.kind === "gm");
    return formatRecap(this.recent.slice(0, lastGm + 1), (id) => this.nameOf(id));
  }

  /** Returns false when the turn failed and the GM should wait for the players. */
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
      await this.opts.driver.takeTurn(this.turnInput(turn), {
        turnId,
        signal,
        onEvent,
        tools: this.toolsFor(turnId, signal),
        ...(this.claudeSessionId !== undefined && { resumeId: this.claudeSessionId }),
        recap: () => this.recapBeforeThisTurn(),
      });
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
