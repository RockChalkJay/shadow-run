import {
  AttackInput,
  AwardEdgeInput,
  DealDamageInput,
  HealInput,
  JoinCombatInput,
  NpcRollInput,
  StartCombatInput,
  RollRequestInput,
  type CharacterRef,
  type CharacterView,
  type CombatParticipant,
  type CombatState,
  type DamageType,
  type EdgeView,
  type GmEvent,
  type HealMethod,
  type GmStatus,
  type CharacterSheet,
  type ResolvedRoll,
  type RollRequest,
  type RollResult,
  type ServerEvent,
  type Snapshot,
  type TranscriptEntry,
  type Usage,
  type Weapon,
} from "@shadow-run/shared";
import { z } from "zod";
import type { GmDriver, GmTools, GmTurnInput, ToolReply } from "../gm/driver.js";
import { restingFrom } from "../gm/limits.js";
import { attackDamage, COMPOSURE_THRESHOLD, cryptoD6, cryptoFlip, edgeFromRatings, endConfrontation, findEdgeEntry, gainEdge, loseEdge, spendEdge, startRound, startSession, type EdgeState, type Flip, defaultRuleset, groupBonusDice, passedRating, damageAfterResistance, damageResistancePool, healingAutoHit, healingThreshold, hitsPerBox, isTreatment, METHOD_NAMES, rollPool, simpleTest, type D6, type Ruleset } from "../rules/index.js";
import { afterWounds, attackerRequest, damageCode, defenderRequest, FALLBACK_EDGE_ADVICE } from "./attack.js";
import { inInitiativeOrder, rollEntries, type Candidate } from "./combat.js";
import { formatRecap } from "./recap.js";
import { Roster, type Target } from "./roster.js";
import { formatAttackForGm, formatCancelledForGm, formatCombat, formatCombatStatus, formatEdgeNote, formatStanding, formatDamageForGm, formatHealForGm, formatHealingOffer, formatNpcRoll, formatRollForGm } from "./rollReport.js";
import { MAX_PENDING_ROLLS, RollManager, type EdgeBoost, type RollEntry } from "./rollManager.js";
import type { CampaignStore, NewEntry, SavedState } from "./store.js";

export type Ack = { ok: true } | { ok: false; error: string };

/** Said to the GM whenever a roll is now on the players' screen. */
const WAIT_FOR_DICE = "The roll card is on the table's screen. End your turn now and wait for the result.";

type Found = Extract<Target, { ok: true }>;

/** What a player hands in with their dice. */
export type RollAnswer = (
  | { mode: "app" }
  | { mode: "physical"; dice: string; /** Extra dice rolled by hand for exploding 6s with Edge dice. */ explosions?: string }
) & {
  /** Spend Edge before the roll: 4 to add the Edge attribute to the pool and make 6s explode, or 5 to make 2s count as glitches on the opposing roll. */
  edge?: "dice" | "widen_glitch";
  /** Count the roll but wait for the player to decide on Edge before it counts. */
  hold?: boolean;
};

/** Edge spent on something other than a roll. */
export interface EdgeUse {
  use: "give_ally" | "heal_stun" | "heal_physical" | "initiative" | "special_effect";
  allyId?: string | undefined;
  description?: string | undefined;
}

/** Edge spent on a held roll. */
export type EdgeChoice =
  | { boost: "reroll"; targets: Array<{ side: "mine" | "theirs"; index: number }>; dice?: string }
  | { boost: "bump"; targets: Array<{ side: "mine" | "theirs"; index: number }> }
  | { boost: "buy_hit"; times?: number }
  | { boost: "reroll_failed"; dice?: string };

/** The Edge catalog entry behind each way of spending Edge on a roll, so costs are the book's and in one place. */
const BOOST_ENTRY = {
  dice: "edge_dice_explode",
  widen_glitch: "widen_glitch",
  reroll: "reroll_one_die",
  bump: "plus_one_to_die",
  buy_hit: "buy_hit",
  reroll_failed: "reroll_failed",
  give_ally: "give_ally_edge",
  heal_stun: "heal_stun_box",
  heal_physical: "heal_physical_box",
  initiative: "initiative_plus_3",
  special_effect: "special_effect",
} as const;
const boostCost = (boost: keyof typeof BOOST_ENTRY): number => findEdgeEntry(BOOST_ENTRY[boost])!.cost;

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
  party: CharacterSheet[];
  emit: (event: ServerEvent) => void;
  d6?: D6;
  /** Settles a tie in the initiative order that nothing else does; a number in [0, 1). */
  flip?: Flip;
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
  private readonly roster: Roster;
  private readonly d6: D6;
  private readonly flip: Flip;
  /** The fight in progress, if any. */
  private combat: CombatState | null;
  /** Every player character's Edge points. They start at the Edge attribute whenever the server starts. */
  private readonly edge = new Map<string, EdgeState>();
  /** Edge given for an attack its player has yet to make, by roll id, which is taken back if they skip it. */
  private readonly edgeForAttack = new Map<string, { characterId: string; gained: number }>();
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
  /**
   * Hits the GM may still spend on each healing roll it has been told the result of, by roll id. They last for the
   * turn that delivers them, and a turn that fails keeps what was spent, saved with the game, so that neither its
   * retry nor a restart grants them again.
   */
  private readonly healBudgets = new Map<string, { patient: { kind: "pc" | "npc"; id: string }; method: HealMethod; remaining: number }>();

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
    this.flip = opts.flip ?? cryptoFlip;
    this.combat = saved?.combat ?? null;
    for (const sheet of opts.party) this.edge.set(sheet.id, startSession(sheet.attributes.edge));
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
    for (const budget of saved?.healBudgets ?? []) this.healBudgets.set(budget.rollId, { patient: budget.patient, method: budget.method, remaining: budget.remaining });
    this.held = saved?.held ?? [];
    this.openRequested = saved?.openRequested ?? false;
    this.opened = saved?.opened ?? false;
    this.turnCounter = saved?.turnCounter ?? 0;
    this.claudeSessionId = saved?.claudeSessionId;
    this.status = this.restingStatus();
  }

  get party(): readonly CharacterSheet[] {
    return this.opts.party;
  }

  /** The Claude session the GM resumes, once there is one. */
  get gmSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  private member(id: string | undefined): CharacterSheet | undefined {
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
      ...this.roster.toSaved(),
      combat: this.combat,
      healBudgets: [...this.healBudgets].map(([rollId, b]) => ({ rollId, patient: b.patient, method: b.method, remaining: b.remaining })),
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
      edge: this.edgeViews(),
      combat: this.combat,
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

  // ---- Edge ----------------------------------------------------------------------------------

  private edgeView(id: string): EdgeView | undefined {
    const state = this.edge.get(id);
    return state && { id, points: state.points, rank: state.rank, spentThisRound: state.spentThisRound };
  }

  private edgeViews(): EdgeView[] {
    return [...this.edge.keys()].map((id) => this.edgeView(id)!);
  }

  private announceEdge(id: string): void {
    const edge = this.edgeView(id);
    if (edge) this.opts.emit({ type: "edge.updated", edge });
  }

  /** Why this character cannot spend this much Edge now, or null if they can. */
  private edgeProblem(id: string, cost: number): string | null {
    const state = this.edge.get(id);
    if (!state) return "That character has no Edge to spend.";
    const name = this.nameOf(id);
    if (state.spentThisRound) return `${name} has already spent Edge this round. Only one expenditure of Edge is allowed per round.`;
    if (cost > state.points) return `${name} has ${state.points} Edge and this costs ${cost}.`;
    return null;
  }

  private payEdge(id: string, cost: number): void {
    this.edge.set(id, spendEdge(this.edge.get(id)!, cost));
    this.announceEdge(id);
  }

  /** A new round gives every player character their one expenditure of Edge back. */
  private startEdgeRound(): void {
    for (const [id, state] of this.edge) {
      this.edge.set(id, startRound(state));
      this.announceEdge(id);
    }
  }

  /** Edge above the Edge attribute goes away when the confrontation that earned it ends. */
  private endEdgeConfrontation(): void {
    for (const [id, state] of this.edge) {
      this.edge.set(id, startRound(endConfrontation(state)));
      this.announceEdge(id);
    }
  }

  async submitRoll(requestId: string, answer: RollAnswer): Promise<Ack> {
    // A roll can outlive its character if the party was edited while it waited; it has nobody to apply to.
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (waiting && !this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);

    let edgeDice: number | undefined;
    let widenGlitch = false;
    if (waiting && answer.edge) {
      if (answer.hold) return { ok: false, error: "Edge for the roll itself is spent before it, which uses up this round's Edge, so there is nothing to decide afterwards. Roll with it, or hold without it." };
      if (answer.edge === "widen_glitch" && !waiting.opposed) return { ok: false, error: "There is no opposing roll, so there are no glitches to widen." };
      const problem = this.edgeProblem(waiting.characterId, boostCost(answer.edge));
      if (problem) return { ok: false, error: problem };
      if (answer.edge === "dice") {
        edgeDice = this.edge.get(waiting.characterId)!.rank;
        if (edgeDice === 0) return { ok: false, error: `${this.nameOf(waiting.characterId)} has no Edge attribute to add to the pool.` };
      } else {
        widenGlitch = true;
      }
    }
    if (waiting && answer.hold) {
      const problem = this.edgeProblem(waiting.characterId, 1);
      if (problem) return { ok: false, error: `${problem} Roll without holding.` };
    }

    const entry: RollEntry = {
      ...(answer.mode === "app" ? { mode: "app" as const } : { mode: "physical" as const, dice: answer.dice, ...(answer.explosions !== undefined && { explosions: answer.explosions }) }),
      ...(edgeDice !== undefined && { edgeDice }),
      ...(widenGlitch && { widenGlitch }),
    };

    if (answer.hold) {
      const held = this.rolls.hold(requestId, entry);
      if (!held.ok) return held;
      // Rolling the attack, even to wait on Edge, is making it.
      this.edgeForAttack.delete(requestId);
      this.opts.emit({ type: "roll.updated", request: held.request });
      await this.persist();
      return { ok: true };
    }

    const edgeInfo =
      edgeDice !== undefined
        ? { spent: boostCost("dice"), summary: `added ${edgeDice} Edge ${edgeDice === 1 ? "die" : "dice"} to the pool, and 6s exploded` }
        : widenGlitch
          ? { spent: boostCost("widen_glitch"), summary: "made 2s count toward a glitch on the opposing roll, as well as 1s" }
          : undefined;
    const result = this.rolls.resolve(requestId, entry, edgeInfo);
    if (!result.ok) return result;
    if (edgeInfo) this.payEdge(result.resolved.request.characterId, edgeInfo.spent);
    return this.completeRoll(result.resolved);
  }

  /** The player has seen a held roll and spends Edge on it; it then counts. */
  async spendEdge(requestId: string, choice: EdgeChoice): Promise<Ack> {
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (!waiting) return { ok: false, error: "That roll is not waiting; it may already have counted or been skipped." };
    if (!this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);
    if (!waiting.held) return { ok: false, error: "That roll has not been counted yet, so there is nothing to spend Edge on. Roll it with hold first." };

    let boost: EdgeBoost;
    let cost: number;
    switch (choice.boost) {
      case "reroll":
        boost = { kind: "reroll", targets: choice.targets, ...(choice.dice !== undefined && { dice: choice.dice }) };
        cost = boostCost("reroll") * choice.targets.length;
        break;
      case "bump":
        if (choice.targets.some((t) => t.side !== "mine")) return { ok: false, error: "Only your own dice can be raised." };
        boost = { kind: "bump", targets: choice.targets.map((t) => t.index) };
        cost = boostCost("bump") * choice.targets.length;
        break;
      case "buy_hit":
        boost = { kind: "buy_hit", times: choice.times ?? 1 };
        cost = boostCost("buy_hit") * boost.times;
        break;
      case "reroll_failed":
        boost = { kind: "reroll_failed", ...(choice.dice !== undefined && { dice: choice.dice }) };
        cost = boostCost("reroll_failed");
        break;
    }
    if (cost === 0) return { ok: false, error: "Name the dice to change." };
    const problem = this.edgeProblem(waiting.characterId, cost);
    if (problem) return { ok: false, error: problem };

    const changed = this.rolls.boost(requestId, boost);
    if (!changed.ok) return changed;
    this.payEdge(waiting.characterId, cost);
    const finished = this.rolls.finish(requestId, { spent: cost, summary: changed.summary });
    if (!finished.ok) return finished;
    return this.completeRoll(finished.resolved);
  }

  /** Spends Edge on something other than a roll, and tells the GM. */
  async useEdge(characterId: string, input: EdgeUse): Promise<Ack> {
    const sheet = this.member(characterId);
    if (!sheet) return { ok: false, error: `There is no character "${characterId}" at the table.` };
    const name = sheet.name;
    if (this.roster.view("pc", characterId)?.status === "dead") return { ok: false, error: `${name} is dead and cannot spend Edge.` };
    const cost = boostCost(input.use);
    const problem = this.edgeProblem(characterId, cost);
    if (problem) return { ok: false, error: problem };

    let detail: string;
    let report: string;
    switch (input.use) {
      case "give_ally": {
        if (!this.combat) return { ok: false, error: "Edge is gained only in a confrontation, so it can be given only in one." };
        const ally = input.allyId ? this.member(input.allyId) : undefined;
        if (!ally || !this.edge.has(ally.id)) return { ok: false, error: "Say which player character to give the Edge to." };
        if (ally.id === characterId) return { ok: false, error: `${name} cannot give Edge to themselves.` };
        if (this.roster.view("pc", ally.id)?.status !== "active") return { ok: false, error: `${ally.name} is not on their feet and cannot gain Edge.` };
        if (gainEdge(this.edge.get(ally.id)!, 1, this.rules).gained === 0) {
          return { ok: false, error: `${ally.name} cannot gain any more Edge now: at most two a round and seven in all.` };
        }
        this.payEdge(characterId, cost);
        await this.gainEdgeFor(ally.id, 1, `given by ${name}`, "ally");
        detail = `gave ${ally.name} 1 Edge`;
        report = `EDGE. ${name} spent ${cost} Edge to give ${ally.name} 1 Edge.`;
        break;
      }
      case "heal_stun":
      case "heal_physical": {
        const track = input.use === "heal_stun" ? "stun" : "physical";
        if (this.roster.view("pc", characterId)!.monitor[track] === 0) return { ok: false, error: `${name} has no ${track} damage to heal.` };
        this.payEdge(characterId, cost);
        const { after, healed } = this.roster.heal("pc", characterId, track, 1);
        this.announce(after);
        await this.record({ kind: "heal", reason: `${name}'s Edge`, type: track, healed, after });
        detail = `healed a box of ${track} damage`;
        report = `EDGE. ${name} spent ${cost} Edge to heal a box of ${track} damage.\n${formatStanding(after)}`;
        break;
      }
      case "initiative": {
        const at = this.combat?.order.findIndex((e) => e.members.some((m) => m.kind === "pc" && m.id === characterId));
        if (!this.combat || at === undefined || at < 0) return { ok: false, error: `${name} is not in a fight, so there is no initiative to raise.` };
        this.payEdge(characterId, cost);
        this.combat = { ...this.combat, order: this.combat.order.map((e, i) => (i === at ? { ...e, bonus: 3 } : e)) };
        this.opts.emit({ type: "combat.updated", combat: this.combat });
        detail = "added 3 to their Initiative Score from the next round";
        report = `EDGE. ${name} spent ${cost} Edge to add 3 to their Initiative Score from the next round.`;
        break;
      }
      case "special_effect": {
        const what = input.description?.trim() ?? "";
        if (what.length < 5) return { ok: false, error: "Describe the special effect, so the GM knows what the player has in mind." };
        this.payEdge(characterId, cost);
        detail = `created a special effect: ${what}`;
        report = `EDGE. ${name} spent ${cost} Edge to create a special effect: ${what}. Something fortuitous happens that tilts the scene slightly in their favor, and it is for you to decide exactly what. Make it happen in what you narrate; it should help, not win the scene.`;
        break;
      }
    }

    await this.record({ kind: "edge_use", characterId, name, cost, detail });
    this.results.push({ kind: "report", text: report });
    // Outside a fight there are no rounds, so each use of Edge is its own.
    if (!this.combat) {
      this.edge.set(characterId, startRound(this.edge.get(characterId)!));
      this.announceEdge(characterId);
    }
    await this.persist();
    // Only a special effect needs the GM to act at once; the rest it hears about with its next turn.
    if (input.use === "special_effect") {
      this.blocked = false;
      this.schedule();
    }
    return { ok: true };
  }

  /** The player has seen a held roll and lets it count as it stands. */
  async keepRoll(requestId: string): Promise<Ack> {
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (!waiting) return { ok: false, error: "That roll is not waiting; it may already have counted or been skipped." };
    if (!this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);
    const finished = this.rolls.finish(requestId);
    if (!finished.ok) return finished;
    return this.completeRoll(finished.resolved);
  }

  /** A roll has counted: apply what follows from it and tell the GM. */
  private async completeRoll(resolved: ResolvedRoll): Promise<Ack> {
    this.edgeForAttack.delete(resolved.request.id);
    const healing = resolved.request.healing;
    // Having the treatment done uses it up for these injuries, whatever it healed.
    if (healing && isTreatment(healing.method)) this.roster.markTreated(healing.patient.kind, healing.patient.id, healing.method);
    // A roll to resist damage is not a result for the GM to interpret: the damage is applied now, in this step,
    // and the GM is told how the character stands.
    const soak = resolved.request.soak ? this.applySoak(resolved) : undefined;
    // One side of an attack is not a result for the GM to interpret either: the attack is settled now and the GM is told how it went.
    const attacking = resolved.request.attack !== undefined;
    if (!attacking) this.results.push(soak ? { kind: "report", text: soak.report } : { kind: "resolved", resolved });
    await this.record({ kind: "roll", resolved });
    if (soak) await this.record(soak.entry);
    if (attacking) this.results.push({ kind: "report", text: await this.settlePlayerAttack(resolved) });
    // Outside a fight there are no rounds, so each roll is its own: the one expenditure of Edge does not carry to the next.
    const id = resolved.request.characterId;
    if (!this.combat && this.edge.has(id)) {
      this.edge.set(id, startRound(this.edge.get(id)!));
      this.announceEdge(id);
    }
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: true };
  }

  /** Removes a roll whose character is no longer at the table, and tells the GM nothing came of it. */
  private async dropOrphanedRoll(request: RollRequest): Promise<Ack> {
    this.rolls.cancel(request.id);
    this.results.push({ kind: "report", text: `ROLL DROPPED. ${request.label}: that character is no longer at the table, so nothing was rolled or applied.` });
    this.opts.emit({ type: "roll.cancelled", requestId: request.id });
    this.blocked = false;
    await this.persist();
    this.schedule();
    return { ok: false, error: "That character is no longer at the table, so the roll was dropped." };
  }

  async cancelRoll(requestId: string): Promise<Ack> {
    if (this.rolls.list().find((r) => r.id === requestId)?.soak) {
      return { ok: false, error: "That roll resists damage that is already coming, so it cannot be skipped. Roll it with the app or with dice." };
    }
    if (this.rolls.list().find((r) => r.id === requestId)?.attack?.role === "defender") {
      return { ok: false, error: "That roll defends against an attack that is already coming, so it cannot be skipped. Roll it with the app or with dice." };
    }
    const request = this.rolls.cancel(requestId);
    if (!request) return { ok: false, error: "That roll is not waiting for dice." };
    this.results.push({ kind: "cancelled", request });
    const given = this.edgeForAttack.get(requestId);
    if (given) await this.takeBackAttackEdge(requestId, given);
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
      dealDamage: (input) => whileCurrent(() => this.dealDamage(input)),
      attack: (input) => whileCurrent(() => this.attack(input)),
      awardEdge: (input) => whileCurrent(() => this.awardEdge(input)),
      startCombat: (input) => whileCurrent(() => this.startCombat(input)),
      joinCombat: (input) => whileCurrent(() => this.joinCombat(input)),
      nextRound: () => whileCurrent(() => this.nextRound()),
      endCombat: () => whileCurrent(() => this.endCombat()),
      heal: (input) => whileCurrent(() => this.heal(input)),
    };
  }

  /** Works out the patient and difficulty of a healing roll, or says why it cannot be asked for. */
  private healingFor(data: RollRequestInput): { ok: true; extra: NonNullable<Parameters<RollManager["create"]>[1]> } | { ok: false; error: string } {
    const asked = data.healing!;
    const patient = this.roster.resolve({ kind: asked.patient.kind, id: asked.patient.id }, { create: false });
    if (!patient.ok) return { ok: false, error: patient.error };
    const view = this.roster.view(patient.kind, patient.id)!;
    if (view.status === "dead") return { ok: false, error: `${patient.name} is dead, beyond the reach of any healing.` };

    if (view.grunt) return { ok: false, error: `${patient.name} is a grunt, with a single condition track the rules give no healing for. Narrate it instead.` };

    const { method } = asked;
    if (isTreatment(method)) {
      if (this.roster.hasBeenTreated(patient.kind, patient.id, method)) {
        return { ok: false, error: `${patient.name} has already had ${METHOD_NAMES[method]} for these injuries. It can be received only once until they are hurt again.` };
      }
      if (view.monitor.physical + view.monitor.stun + view.monitor.overflow === 0) return { ok: false, error: `${patient.name} has no damage to heal.` };
    } else {
      if (patient.kind !== "pc" || patient.id !== data.characterId) {
        return { ok: false, error: "Natural recovery is the patient's own roll. Ask for it from the player character who is recovering." };
      }
      const track = method.slice("natural_".length) as "stun" | "physical" | "overflow";
      if (view.monitor[track] === 0) return { ok: false, error: `${patient.name} has no ${track} damage to recover from.` };
    }

    // A player character's Essence is on their sheet, so the GM's word for it is not taken.
    const essence = patient.kind === "pc" ? this.member(patient.id)?.attributes.essence ?? asked.essence : asked.essence;
    const natural = !isTreatment(method);
    const threshold = natural ? 0 : healingThreshold(essence);
    const healing = { method, patient: { kind: patient.kind, id: patient.id, name: patient.name }, essence, threshold, autoHit: healingAutoHit(method, essence) };
    return { ok: true, extra: { healing, threshold: Math.max(1, threshold) } };
  }

  private async requestRoll(input: unknown): Promise<ToolReply> {
    const parsed = RollRequestInput.safeParse(input);
    let extra: NonNullable<Parameters<RollManager["create"]>[1]> | undefined;
    if (parsed.success && parsed.data.healing) {
      const prepared = this.healingFor(parsed.data);
      if (!prepared.ok) return { ok: false, text: prepared.error };
      extra = prepared.extra;
    }
    const created = this.rolls.create(input, extra);
    if (!created.ok) return { ok: false, text: created.error };
    await this.persist();
    this.opts.emit({ type: "roll.requested", request: created.request });
    return { ok: true, text: WAIT_FOR_DICE };
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
      report: formatDamageForGm({ ...damage, body: request.pool.total, edge: resolved.edge && formatEdgeNote(this.nameOf(request.characterId), resolved.edge) }),
      entry: { kind: "damage", ...damage },
    };
  }

  /** Why this target cannot be hurt, or null if it can. */
  private alreadyDead(target: Found): ToolReply | null {
    return this.roster.view(target.kind, target.id)?.status === "dead" ? { ok: false, text: `${target.name} is already dead.` } : null;
  }

  /** The refusal to give when no more rolls fit on the players' screen, or null if there is room. */
  private noRoomForRolls(): ToolReply | null {
    // Every roll the system adds here is damage that lands once it is answered, so a GM stuck in a loop must not be able to stack them.
    return this.rolls.list().length >= MAX_PENDING_ROLLS
      ? { ok: false, text: `There are already ${MAX_PENDING_ROLLS} rolls waiting for dice. Stop and wait for the table to answer them before hurting anyone else.` }
      : null;
  }

  /**
   * Hurts someone with a Damage Value they have yet to resist. A player character gets a roll of their own
   * Body, so `waiting` is true and the caller must hold the GM; a non-player character's Body is rolled here
   * and the damage applied at once.
   */
  private async harm(target: Found, label: string, damageValue: number, damageType: DamageType): Promise<{ waiting: boolean; text: string }> {
    if (target.kind === "pc") {
      // The player rolls their own Body to resist, so the dice are theirs.
      const request = this.rolls.createInternal({
        characterId: target.id,
        label: `Resist ${damageCode(damageValue, damageType)} damage: ${label}`,
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
        edgeAdvice: FALLBACK_EDGE_ADVICE,
        soak: { damageValue, damageType, source: label },
      });
      await this.persist();
      this.opts.emit({ type: "roll.requested", request });
      return { waiting: true, text: `${target.name} must roll Body to resist ${damageValue} ${damageType} damage.` };
    }

    // The system rolls an NPC's Body for them.
    const before = this.roster.view("npc", target.id)!;
    const resistance = rollPool(target.body, this.d6, this.rules);
    const taken = damageAfterResistance(damageValue, resistance.hits);
    const after = this.roster.damage("npc", target.id, damageType, taken);
    this.announce(after);
    const composure = this.testNerve(before, after);
    const damage = { label, damageType, damageValue, resistance, resistedBy: "system" as const, taken, after, ...(composure && { composure }) };
    await this.record({ kind: "damage", ...damage });
    await this.persist();
    return { waiting: false, text: formatDamageForGm({ ...damage, body: target.body }) };
  }

  /** A grunt that has just passed their Professional Rating and is still on their feet tests whether they bolt. */
  private testNerve(before: CharacterView, after: CharacterView) {
    if (!after.grunt || !passedRating(before.monitor.physical, after.monitor.physical, after.grunt.professionalRating, after.status === "active")) return undefined;
    const pool = this.roster.composurePool(after.id)!;
    const roll = rollPool(pool, this.d6, this.rules);
    const threshold = COMPOSURE_THRESHOLD;
    return { roll, pool, threshold, held: roll.hits >= threshold };
  }

  private async dealDamage(input: unknown): Promise<ToolReply> {
    const parsed = DealDamageInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The damage was not valid: ${z.prettifyError(parsed.error)}` };
    const { label, target: ref, damageValue, damageType } = parsed.data;
    const target = this.roster.resolve(ref);
    if (!target.ok) return { ok: false, text: target.error };
    const refusal = this.alreadyDead(target) ?? (target.kind === "pc" ? this.noRoomForRolls() : null);
    if (refusal) return refusal;

    const done = await this.harm(target, label, damageValue, damageType);
    return { ok: true, text: done.waiting ? `${done.text} ${WAIT_FOR_DICE}` : done.text };
  }

  /**
   * One attack. A player character's side is a roll request for them; the other side is rolled by the system
   * when they answer, and the damage worked out in code. When no player character has dice to roll, it all
   * happens here.
   */
  private async attack(input: unknown): Promise<ToolReply> {
    const parsed = AttackInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The attack was not valid: ${z.prettifyError(parsed.error)}` };
    const { label, stakes, weapon, attackPool, defensePool, edgeAdvice, attackRating, defenseRating } = parsed.data;
    const attacker = this.roster.resolve(parsed.data.attacker);
    if (!attacker.ok) return { ok: false, text: attacker.error };
    const defender = this.roster.resolve(parsed.data.defender);
    if (!defender.ok) return { ok: false, text: defender.error };

    if (attacker.kind === defender.kind && attacker.id === defender.id) return { ok: false, text: `${attacker.name} cannot attack themselves.` };
    if (attacker.kind === "pc" && defender.kind === "pc") {
      return { ok: false, text: "Attacks between two player characters are not handled yet. Ask the attacker for an opposed request_roll, then call deal_damage with the Damage Value it gives." };
    }
    const attackerView = this.roster.view(attacker.kind, attacker.id)!;
    if (attackerView.status !== "active") return { ok: false, text: `${attacker.name} is ${attackerView.status} and cannot attack.` };
    const refusal = this.alreadyDead(defender) ?? (attacker.kind === "pc" || defender.kind === "pc" ? this.noRoomForRolls() : null);
    if (refusal) return refusal;

    const group = this.formGroup(attacker, defender, parsed.data.alongside ?? []);
    if (!group.ok) return { ok: false, text: group.error };
    const attackerName = group.names.join(group.names.length > 2 ? ", " : " and ").replace(/, ([^,]*)$/, " and $1");
    const groupSize = group.names.length;
    const shared = { label, stakes, weapon, edgeAdvice };
    const defenderView = this.roster.view(defender.kind, defender.id)!;

    if (attacker.kind === "pc") {
      const theirs = defender;
      const request = attackerRequest(shared, { characterId: attacker.id, pool: attackPool }, {
        id: theirs.id,
        name: theirs.name,
        pool: afterWounds(defensePool.total, defenderView.woundModifier),
      });
      return this.putOnScreen(this.rolls.create(request.input, { attack: request.attack }), `${attacker.name}'s attack`, (requestId) => this.edgeFromAttack(attacker, defender, attackRating, defenseRating, requestId));
    }

    const attackDice = afterWounds(attackPool.total, attackerView.woundModifier) + groupBonusDice(groupSize);
    if (defender.kind === "pc") {
      // A defender who is down, or whose wounds leave them no dice, cannot defend at all.
      const dice = defensePool.total - this.roster.woundPenalty(defender.id);
      if (defenderView.status === "active" && dice >= 1) {
        const request = defenderRequest(shared, { characterId: defender.id, pool: defensePool }, { id: attacker.id, name: attackerName, pool: attackDice }, groupSize);
        return this.putOnScreen(this.rolls.create(request.input, { attack: request.attack }), `${defender.name}'s defense`, () => this.edgeFromAttack(attacker, defender, attackRating + groupSize - 1, defenseRating));
      }
    }

    // Nobody here has dice to roll, so the system rolls both sides. A player character who got this far cannot defend at all.
    const defenseDice = defender.kind === "pc" ? 0 : afterWounds(defensePool.total, defenderView.woundModifier);
    const settled = await this.settleAttack({
      label,
      weapon,
      attackerName,
      groupSize,
      defender,
      attackRoll: rollPool(attackDice, this.d6, this.rules),
      attackDice,
      attackedBy: "system",
      defenseRoll: rollPool(defenseDice, this.d6, this.rules),
      defenseDice,
      defendedBy: "system",
    });
    return { ok: true, text: settled.resist ? `${settled.text}\n${settled.resist} ${WAIT_FOR_DICE}` : settled.text };
  }

  /**
   * The grunts attacking together, the attacker first, or why they cannot. A group is grunts only, at most
   * the book's maximum, each able to act and none of them the target.
   */
  private formGroup(attacker: Found, defender: Found, alongside: CharacterRef[]): { ok: true; names: string[] } | { ok: false; error: string } {
    if (alongside.length === 0) return { ok: true, names: [attacker.name] };
    const max = (this.rules ?? defaultRuleset).grunt.maxGroupSize;
    if (alongside.length + 1 > max) return { ok: false, error: `A group attack has at most ${max} grunts, including the attacker.` };
    const isGrunt = (who: Found) => who.kind === "npc" && this.roster.view("npc", who.id)?.grunt !== undefined;
    if (!isGrunt(attacker)) return { ok: false, error: `${attacker.name} is not a grunt. Only grunts attack as a group, and a grunt has to be named with a professionalRating the first time; someone already on the table as a named character stays one.` };
    const seen = new Set([`${attacker.kind}:${attacker.id}`]);
    const names = [attacker.name];
    for (const ref of alongside) {
      const member = this.roster.resolve(ref);
      if (!member.ok) return { ok: false, error: member.error };
      const key = `${member.kind}:${member.id}`;
      if (seen.has(key)) return { ok: false, error: `${member.name} is already in this group attack.` };
      seen.add(key);
      if (member.kind === defender.kind && member.id === defender.id) return { ok: false, error: `${member.name} is the target and cannot attack themselves.` };
      if (!isGrunt(member)) return { ok: false, error: `${member.name} is not a grunt. Only grunts attack as a group.` };
      const status = this.roster.view(member.kind, member.id)!.status;
      if (status !== "active") return { ok: false, error: `${member.name} is ${status} and cannot attack.` };
      names.push(member.name);
    }
    return { ok: true, names };
  }

  /** Announces a roll the system just made out for a player, or says why it could not. */
  private async putOnScreen(created: ReturnType<RollManager["create"]>, what: string, afterwards?: (requestId: string) => Promise<string>): Promise<ToolReply> {
    if (!created.ok) return { ok: false, text: created.error };
    await this.persist();
    this.opts.emit({ type: "roll.requested", request: created.request });
    const note = afterwards ? await afterwards(created.request.id) : "";
    return { ok: true, text: `${what} is waiting for dice.${note ? ` ${note}` : ""} ${WAIT_FOR_DICE}` };
  }

  // ---- gaining Edge --------------------------------------------------------------------------

  /**
   * Gives a player character Edge, within the limits the book sets: at most two gained in a round, and no more than
   * seven in all. Says how much they actually got, which is none when a limit was already reached.
   */
  private async gainEdgeFor(id: string, amount: number, reason: string, source: "ratings" | "gm" | "ally"): Promise<{ gained: number; atMost: "round" | "total" | null }> {
    const before = this.edge.get(id)!;
    const result = gainEdge(before, amount, this.rules);
    this.edge.set(id, result.state);
    this.announceEdge(id);
    if (result.gained > 0) await this.record({ kind: "edge", characterId: id, name: this.nameOf(id), gained: result.gained, reason, source });
    const limit = this.rules?.edge ?? defaultRuleset.edge;
    const atMost = result.gained >= amount ? null : before.points >= limit.max ? "total" : "round";
    return { gained: result.gained, atMost };
  }

  /** The attack the Edge was given for was not made, so the Edge goes back. The round's limit on gaining stays used. */
  private async takeBackAttackEdge(requestId: string, given: { characterId: string; gained: number }): Promise<void> {
    this.edgeForAttack.delete(requestId);
    const name = this.nameOf(given.characterId);
    this.edge.set(given.characterId, loseEdge(this.edge.get(given.characterId)!, given.gained));
    this.announceEdge(given.characterId);
    await this.record({ kind: "edge", characterId: given.characterId, name, gained: -given.gained, reason: "taken back because the attack was not made", source: "ratings" });
    this.results.push({ kind: "report", text: `EDGE. ${name}'s ${given.gained} Edge from this attack is taken back, since the attack was not made.` });
  }

  /** Whether the Attack Rating and Defense Rating are far enough apart to earn a player character Edge; what to tell the GM. */
  private async edgeFromAttack(attacker: Found, defender: Found, attackRating: number, defenseRating: number, attackRequestId?: string): Promise<string> {
    // Edge is gained only in a confrontation, and only players use it: an opponent's side of the gap earns nothing.
    if (!this.combat) return "";
    const side = edgeFromRatings(attackRating, defenseRating, this.rules);
    const winner = side === "attacker" ? attacker : side === "defender" ? defender : null;
    if (!winner || winner.kind !== "pc") return "";
    const reason = side === "attacker" ? `Attack Rating ${attackRating} against Defense Rating ${defenseRating}` : `Defense Rating ${defenseRating} against Attack Rating ${attackRating}`;
    const result = await this.gainEdgeFor(winner.id, 1, reason, "ratings");
    // A player who is given Edge for an attack and then skips it has not earned it. A defense cannot be skipped.
    if (result.gained > 0 && attackRequestId !== undefined && winner.kind === "pc" && winner.id === attacker.id) {
      this.edgeForAttack.set(attackRequestId, { characterId: winner.id, gained: result.gained });
    }
    return this.edgeGainNote(winner.name, result, reason);
  }

  private edgeGainNote(name: string, result: { gained: number; atMost: "round" | "total" | null }, reason: string): string {
    if (result.gained > 0) return `EDGE. ${name} gains ${result.gained} Edge: ${reason}.`;
    return result.atMost === "total"
      ? `EDGE. ${name} would gain Edge (${reason}) but already has the most allowed.`
      : `EDGE. ${name} would gain Edge (${reason}) but has already gained the most allowed this round.`;
  }

  private async awardEdge(input: unknown): Promise<ToolReply> {
    const parsed = AwardEdgeInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The award was not valid: ${z.prettifyError(parsed.error)}` };
    const { characterId, reason } = parsed.data;
    if (!this.combat) {
      return { ok: false, text: "Edge is gained only in a confrontation. Start one with start_combat; hacking and social contests count as well as fights." };
    }
    if (!this.edge.has(characterId)) return { ok: false, text: `There is no player character "${characterId}" to award Edge.` };
    const status = this.roster.view("pc", characterId)?.status;
    if (status !== "active") return { ok: false, text: `${this.nameOf(characterId)} is ${status} and cannot gain Edge.` };
    return { ok: true, text: this.edgeGainNote(this.nameOf(characterId), await this.gainEdgeFor(characterId, 1, reason, "gm"), reason) };
  }

  /** A player has rolled their side of an attack: the system rolled the other, and now the damage is worked out. */
  private async settlePlayerAttack(resolved: ResolvedRoll): Promise<string> {
    const { request, roll, opposed, source } = resolved;
    const attack = request.attack!;
    if (!opposed) return `ATTACK VOID. ${request.label}: the other side of the attack was lost, so nothing was applied.`;
    const player = this.nameOf(request.characterId);
    const attacking = attack.role === "attacker";
    const defender = this.roster.resolve(attacking ? { kind: "npc", id: attack.other.id } : { kind: "pc", id: request.characterId }, { create: false });
    if (!defender.ok) return `ATTACK VOID. ${request.label}: ${defender.error}`;
    const settled = await this.settleAttack({
      label: request.label,
      weapon: attack.weapon,
      attackerName: attacking ? player : attack.other.name,
      groupSize: attack.groupSize ?? 1,
      edgeNote: resolved.edge && formatEdgeNote(player, resolved.edge),
      defender,
      attackRoll: attacking ? roll : opposed.roll,
      attackDice: attacking ? roll.dice.length : opposed.pool,
      attackedBy: attacking ? source : "system",
      defenseRoll: attacking ? opposed.roll : roll,
      defenseDice: attacking ? opposed.pool : roll.dice.length,
      defendedBy: attacking ? "system" : source,
    });
    return settled.text;
  }

  /** Works out whether an attack landed, records it, and hurts the defender if it did. `resist` is set when a player character must now roll Body. */
  private async settleAttack(a: {
    label: string;
    weapon: Weapon;
    attackerName: string;
    /** How many grunts attacked together; 1 for a single attacker. */
    groupSize: number;
    /** What the player spent on Edge on their side of the attack, if anything. */
    edgeNote?: string | undefined;
    defender: Found;
    attackRoll: RollResult;
    attackDice: number;
    attackedBy: "app" | "physical" | "system";
    defenseRoll: RollResult;
    defenseDice: number;
    defendedBy: "app" | "physical" | "system";
  }): Promise<{ text: string; resist?: string }> {
    const outcome = attackDamage(a.attackRoll, a.defenseRoll, a.weapon.damageValue);
    const report = {
      label: a.label,
      attacker: a.attackerName,
      defender: a.defender.name,
      weapon: a.weapon,
      groupSize: a.groupSize,
      attackRoll: a.attackRoll,
      attackDice: a.attackDice,
      attackedBy: a.attackedBy,
      defenseRoll: a.defenseRoll,
      defenseDice: a.defenseDice,
      defendedBy: a.defendedBy,
      hit: outcome.hit,
      damageValue: outcome.damageValue,
      edge: a.edgeNote,
    };
    await this.record({
      kind: "attack",
      label: a.label,
      attacker: a.attackerName,
      defender: a.defender.name,
      weapon: a.weapon,
      ...(a.groupSize > 1 && { groupSize: a.groupSize }),
      attackRoll: a.attackRoll,
      defenseRoll: a.defenseRoll,
      attackedBy: a.attackedBy,
      defendedBy: a.defendedBy,
      hit: outcome.hit,
      damageValue: outcome.damageValue,
    });
    const text = formatAttackForGm(report);
    if (!outcome.hit) return { text };

    const gone = this.alreadyDead(a.defender);
    if (gone) return { text: `${text}\n${gone.text}` };
    const source = a.groupSize > 1 ? `${a.weapon.name} (${a.attackerName})` : `${a.attackerName}'s ${a.weapon.name}`;
    const done = await this.harm(a.defender, source, outcome.damageValue, a.weapon.damageType);
    // A player character's resistance is a roll still to come; the damage result reaches the GM when it is answered.
    return done.waiting ? { text, resist: done.text } : { text: `${text}\n${done.text}` };
  }

  // ---- fights ----------------------------------------------------------------------------------

  private statusOf = (member: { kind: "pc" | "npc"; id: string }) => this.roster.view(member.kind, member.id)?.status;

  /**
   * The numbers each participant's initiative is rolled from, or why the fight cannot have them. A player
   * character's come from their sheet and nobody else's word; a non-player character's come from the GM.
   */
  private combatCandidates(participants: readonly CombatParticipant[], already: ReadonlySet<string>): { ok: true; list: Candidate[] } | { ok: false; error: string } {
    const list: Candidate[] = [];
    const seen = new Set(already);
    for (const p of participants) {
      const who = this.roster.resolve(p.who);
      if (!who.ok) return { ok: false, error: who.error };
      const key = `${who.kind}:${who.id}`;
      if (seen.has(key)) return { ok: false, error: `${who.name} is already in this fight.` };
      seen.add(key);
      const view = this.roster.view(who.kind, who.id)!;
      if (view.status !== "active") return { ok: false, error: `${who.name} is ${view.status} and cannot take part in the fight.` };

      if (who.kind === "pc") {
        if (p.initiative) return { ok: false, error: `${who.name}'s initiative comes from their sheet. Leave initiative out for a player character.` };
        const sheet = this.member(who.id)!;
        const a = sheet.attributes;
        list.push({ member: { kind: "pc", id: who.id, name: who.name }, reaction: a.reaction, intuition: a.intuition, dice: sheet.initiativeDice, edge: a.edge });
        continue;
      }

      if (!p.initiative) return { ok: false, error: `Give initiative (reaction, intuition and dice) for ${who.name}, a non-player character.` };
      if (p.group !== undefined && !view.grunt) return { ok: false, error: `${who.name} is not a grunt. Only grunts roll initiative together as a group.` };
      list.push({
        member: { kind: "npc", id: who.id, name: who.name },
        reaction: p.initiative.reaction,
        intuition: p.initiative.intuition,
        dice: p.initiative.dice,
        // A grunt's Professional Rating stands in for their Edge when a tie is broken.
        edge: view.grunt ? view.grunt.professionalRating : (p.edge ?? 0),
        group: p.group,
      });
    }
    return { ok: true, list };
  }

  /** Tells clients and the transcript that the fight changed, and saves it. */
  private async announceCombat(event: "start" | "join" | "round" | "end", names: string[], round: number): Promise<void> {
    this.opts.emit({ type: "combat.updated", combat: this.combat });
    await this.record({ kind: "combat", event, round, names });
    await this.persist();
  }

  private async startCombat(input: unknown): Promise<ToolReply> {
    const parsed = StartCombatInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The fight was not valid: ${z.prettifyError(parsed.error)}` };
    if (this.combat) {
      return { ok: false, text: `A fight is already under way (round ${this.combat.round}). Use join_combat to add people, or end_combat first.` };
    }
    const prepared = this.combatCandidates(parsed.data.participants, new Set());
    if (!prepared.ok) return { ok: false, text: prepared.error };

    this.combat = { round: 1, order: inInitiativeOrder(rollEntries(prepared.list, this.d6, this.flip, this.rules)) };
    await this.announceCombat("start", prepared.list.map((c) => c.member.name), 1);
    return { ok: true, text: `${formatCombat("COMBAT BEGINS.", this.combat, this.statusOf)}\nEach turn, everyone acts once in this order. Call next_round when they all have, and end_combat when the fight is over.` };
  }

  private async joinCombat(input: unknown): Promise<ToolReply> {
    const parsed = JoinCombatInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The fighters were not valid: ${z.prettifyError(parsed.error)}` };
    if (!this.combat) return { ok: false, text: "There is no fight under way. Call start_combat to begin one." };
    const inFight = new Set(this.combat.order.flatMap((entry) => entry.members.map((m) => `${m.kind}:${m.id}`)));
    const prepared = this.combatCandidates(parsed.data.participants, inFight);
    if (!prepared.ok) return { ok: false, text: prepared.error };

    // Those already in the order keep their places and their coins; the newcomers slot in by score.
    this.combat = { ...this.combat, order: inInitiativeOrder([...this.combat.order, ...rollEntries(prepared.list, this.d6, this.flip, this.rules)]) };
    await this.announceCombat("join", prepared.list.map((c) => c.member.name), this.combat.round);
    return { ok: true, text: formatCombat("JOINED THE FIGHT.", this.combat, this.statusOf) };
  }

  private async nextRound(): Promise<ToolReply> {
    if (!this.combat) return { ok: false, text: "There is no fight under way. Call start_combat to begin one." };
    // Initiative bought with Edge takes effect now, and the order is settled again with each entry's own coin.
    const raised = this.combat.order.map((entry) => {
      const { bonus, ...plain } = entry;
      return bonus ? { ...plain, score: plain.score + bonus } : entry;
    });
    this.combat = { round: this.combat.round + 1, order: inInitiativeOrder(raised) };
    this.startEdgeRound();
    await this.announceCombat("round", [], this.combat.round);
    return { ok: true, text: `${formatCombat("NEW ROUND.", this.combat, this.statusOf)}\nInitiative is not rerolled.` };
  }

  private async endCombat(): Promise<ToolReply> {
    if (!this.combat) return { ok: false, text: "There is no fight under way." };
    const { round } = this.combat;
    this.combat = null;
    this.endEdgeConfrontation();
    await this.announceCombat("end", [], round);
    return { ok: true, text: `COMBAT ENDS after ${round} ${round === 1 ? "round" : "rounds"}.` };
  }

  private async heal(input: unknown): Promise<ToolReply> {
    const parsed = HealInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: `The healing was not valid: ${z.prettifyError(parsed.error)}` };
    const { rollId, type, boxes, reason } = parsed.data;
    const budget = this.healBudgets.get(rollId);
    if (!budget) {
      return { ok: false, text: "No healing roll with that id has hits to spend this turn. Ask for a healing roll with request_roll and heal only from its result, in the turn you are told it." };
    }
    const target = this.roster.resolve(budget.patient, { create: false });
    if (!target.ok) return { ok: false, text: target.error };
    const standing = this.roster.view(target.kind, target.id)!;
    if (standing.status === "dead") return { ok: false, text: `${target.name} is dead, beyond the reach of any healing.` };

    const perBox = hitsPerBox(budget.method, type);
    if (perBox === null) return { ok: false, text: `${METHOD_NAMES[budget.method]} cannot heal ${type} damage.` };
    // Overflow heals first when a healer treats someone; natural recovery is rolled for each track separately.
    if (isTreatment(budget.method) && type !== "overflow" && standing.monitor.overflow > 0) {
      return { ok: false, text: `${target.name} has overflow damage, which heals first. Heal overflow before ${type}.` };
    }
    const toHeal = Math.min(boxes, standing.monitor[type]);
    if (toHeal * perBox > budget.remaining) {
      const affordable = Math.floor(budget.remaining / perBox);
      return {
        ok: false,
        text: `That would cost ${toHeal * perBox} hits (${perBox} per ${type} box) and the roll has ${budget.remaining} left, enough for ${affordable} ${type} ${affordable === 1 ? "box" : "boxes"}.`,
      };
    }

    const { after, healed } = this.roster.heal(target.kind, target.id, type, toHeal);
    budget.remaining -= healed * perBox;
    this.announce(after);
    await this.record({ kind: "heal", reason, type, healed, after });
    await this.persist();
    return { ok: true, text: formatHealForGm({ reason, type, healed, after, left: budget.remaining }) };
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
    if (this.combat) parts.push(formatCombatStatus(this.combat, this.statusOf));
    for (const outcome of turn.results) {
      if (outcome.kind === "report") parts.push(outcome.text);
      else if (outcome.kind === "resolved") {
        const { request } = outcome.resolved;
        parts.push(formatRollForGm(outcome.resolved, this.nameOf(request.characterId)));
        const budget = this.healBudgets.get(request.id);
        if (budget && request.healing) {
          parts.push(formatHealingOffer({ healer: this.nameOf(request.characterId), patient: request.healing.patient.name, method: budget.method, hits: budget.remaining, rollId: request.id }));
        }
      }
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
    for (const outcome of turn.results) {
      const healing = outcome.kind === "resolved" ? outcome.resolved.request.healing : undefined;
      if (outcome.kind === "resolved" && healing && outcome.resolved.outcome.netHits > 0 && !this.healBudgets.has(outcome.resolved.request.id)) {
        this.healBudgets.set(outcome.resolved.request.id, { patient: healing.patient, method: healing.method, remaining: outcome.resolved.outcome.netHits });
      }
    }

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
      this.healBudgets.clear();
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
