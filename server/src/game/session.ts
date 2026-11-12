import {
  AttackInput,
  AwardEdgeInput,
  DealDamageInput,
  HealInput,
  EndSessionInput,
  JoinCombatInput,
  NoteNpcInput,
  NoteThreadInput,
  NpcRollInput,
  RecallInput,
  type RewardInput,
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
  type EdgeActionOnRoll,
  type EdgeBurn,
  type ResolvedRoll,
  type RollRequest,
  type RollResult,
  type ServerEvent,
  type SessionInfo,
  type Snapshot,
  type TranscriptEntry,
  type Usage,
  type Weapon,
} from "@shadow-run/shared";
import { z } from "zod";
import { basename } from "node:path";
import { CampaignMemory, memoryBrief, npcLine, recallText } from "./campaignMemory.js";
import { applyRunUpdate, describeChanges, saveSheetWithCopy, type RunUpdate } from "./characterUpdate.js";
import { withBurnedEdge } from "./burned.js";
import { historyRecall } from "./sheetText.js";
import type { GmDriver, GmTools, GmTurnInput, ToolReply } from "../gm/driver.js";
import { restingFrom } from "../gm/limits.js";
import { attackDamage, burnEdge, COMPOSURE_THRESHOLD, cryptoD6, cryptoFlip, edgeFromRatings, endConfrontation, findEdgeEntry, gainEdge, loseEdge, spendEdge, startRound, startSession, type EdgeState, type Flip, defaultEdgeCatalog, defaultRuleset, groupBonusDice, screenRules, passedRating, damageAfterResistance, damageResistancePool, healingAutoHit, healingThreshold, hitsPerBox, isTreatment, METHOD_NAMES, rollPool, simpleTest, type D6, type Ruleset } from "../rules/index.js";
import { afterWounds, attackerRequest, damageCode, defenderRequest, FALLBACK_EDGE_ADVICE } from "./attack.js";
import { calledShotOf, edgeActionSummary, type CalledShot } from "./edgeAction.js";
import { inInitiativeOrder, rollEntries, type Candidate } from "./combat.js";
import { formatRecap } from "./recap.js";
import { Roster, type Target } from "./roster.js";
import { formatAttackForGm, formatCancelledForGm, formatCombat, formatBurnNote, formatCombatStatus, formatEdgeNote, formatStanding, formatDamageForGm, formatHealForGm, formatHealingOffer, formatNpcRoll, formatRollForGm } from "./rollReport.js";
import { MAX_PENDING_ROLLS, RollManager, type EdgeBoost, type RollEntry } from "./rollManager.js";
import type { CampaignStore, NewEntry, SavedState } from "./store.js";

export type Ack = { ok: true } | { ok: false; error: string };

/** Said to the GM whenever a roll is now on the players' screen. */
const WAIT_FOR_DICE = "The roll card is on the table's screen. End your turn now and wait for the result.";

type Found = Extract<Target, { ok: true }>;

/** What a player hands in with their dice. */
export type RollAnswer =
  | ((
      | { mode: "app" }
      | { mode: "physical"; dice: string; /** Extra dice rolled by hand for exploding 6s with Edge dice. */ explosions?: string }
    ) & {
      /** Spend Edge before the roll: 4 to add the Edge attribute to the pool and make 6s explode, or 5 to make 2s count as glitches on the opposing roll. */
      edge?: "dice" | "widen_glitch";
      /** Count the roll but wait for the player to decide on Edge before it counts. */
      hold?: boolean;
    })
  /** Burn Edge instead of rolling: an automatic success with four net hits. */
  | { mode: "smackdown" };

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
  | { boost: "reroll_failed"; dice?: string }
  /** Burn Edge to survive a held roll to resist damage that would kill. */
  | { boost: "not_dead_yet" };

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
  /** The table asked to wrap the session up. */
  wrapUp: boolean;
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
  /** The campaign's notes, which the GM writes and reads; by default the files in the store's folder. */
  memory?: CampaignMemory;
  /** For testing: every roll is held until it is kept, and a held roll can be rolled again. */
  testMode?: boolean;
  /** Longest a GM turn may take before it is stopped. */
  turnTimeoutMs?: number;
  now?: () => Date;
}

/** A session as the GM wrote it up: its number in the log, its summary and date, and what it changed for each character. */
interface WrittenUp {
  number: number;
  summary: string;
  fictionDate?: string;
  changes?: Array<{ name: string; changes: string[] }>;
}

/** The date as the table writes it in the session log, in the server's own time zone. */
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** What the GM is told when the table wraps the session up, with the system's own account of the session to write from. */
function wrapUpText(digest: string): string {
  return [
    "WRAP UP THE SESSION. The table is stopping here. Close the scene in a short beat that leaves the characters somewhere they can safely stop, with no new danger, and do not start anything new. Then call end_session once with the write-up. Update the notes with note_npc and note_thread first if anything changed that they do not yet say. Never mention the log or the notes to the players.",
    digest ? `What the system recorded this session, to write from:\n${digest}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the GM is told when the notes cannot be read or saved: not why, and not to speak of it. */
const NOTES_UNAVAILABLE = "The campaign notes cannot be used just now, so carry on without them. Do not mention this to the players.";

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
  private readonly memory: CampaignMemory;
  /** The problems with the notes the table has been told of. */
  private readonly reportedMemoryProblems = new Set<string>();
  /** The session in play, or the one that just ended. */
  private sessionNumber: number;
  /** The session was wrapped up, and nothing happens until the next one begins. */
  private ended: boolean;
  /** The table asked to wrap up and the GM has not been given the turn for it yet. */
  private wrapUpRequested: boolean;
  /** What the table asked the next session to be about, until the GM has opened it. */
  private mission: string | undefined;
  /** The GM's opening turn is being taken, so the session has begun though `opened` is not set yet. */
  private opening = false;
  /** The wrap-up turn the GM is in, and the log entry it wrote in it. */
  private wrapping: { logged?: WrittenUp } | null = null;
  /** The fight in progress, if any. */
  private combat: CombatState | null;
  /** Every player character's Edge points. They start at the Edge attribute whenever the server starts. */
  private readonly edge = new Map<string, EdgeState>();
  /** The sheets as played: their Edge is what is left after the rank each character has burned. */
  private sheets: CharacterSheet[];
  /** Edge rank each player character has burned for good, saved with the game and taken off their sheet whenever it is loaded. */
  private readonly burned: Record<string, number>;
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
    this.sheets = [...opts.party];
    this.burned = { ...saved?.burned };
    for (const sheet of this.sheets) this.edge.set(sheet.id, startSession(sheet.attributes.edge));
    this.rules = opts.rules;
    this.roster = new Roster(opts.party, saved ?? undefined, this.rules);
    this.memory = opts.memory ?? new CampaignMemory(opts.store.dir);
    // A named character the GM brings in is listed in the notes at once, so they can be found when they return even if the GM never writes them up.
    this.roster.onNewNpc = (npc) => void this.memory.ensureNpc({ name: npc.name, stats: `Body ${npc.body}, Willpower ${npc.willpower}` }).catch((err) => this.memoryProblem(err));
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
    this.sessionNumber = saved?.sessionNumber ?? 1;
    this.ended = saved?.ended ?? false;
    this.wrapUpRequested = saved?.wrapUpRequested ?? false;
    this.mission = saved?.mission;
    this.status = this.restingStatus();
  }

  get party(): readonly CharacterSheet[] {
    return this.sheets;
  }

  /** The Claude session the GM resumes, once there is one. */
  get gmSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  private member(id: string | undefined): CharacterSheet | undefined {
    return id === undefined ? undefined : this.sheets.find((m) => m.id === id);
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
      sessionNumber: this.sessionNumber,
      wrapUpRequested: this.wrapUpRequested,
      ended: this.ended,
      ...(this.mission !== undefined && { mission: this.mission }),
      turnCounter: this.turnCounter,
      pending: this.rolls.list(),
      results: this.results,
      ...this.roster.toSaved(),
      combat: this.combat,
      burned: this.burned,
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
      party: [...this.sheets],
      characters: this.roster.views(),
      pendingRolls: this.rolls.list(),
      edge: this.edgeViews(),
      combat: this.combat,
      transcript: [...this.recent],
      gm: this.status,
      usage: this.usage,
      rules: screenRules(this.rules),
      testMode: this.opts.testMode ?? false,
      session: this.sessionInfo(),
    };
  }

  private sessionInfo(): SessionInfo {
    const phase = this.ended ? "ended" : this.wrapUpRequested || this.wrapping ? "wrapping" : this.opened || this.openRequested ? "open" : "idle";
    return { number: phase === "idle" ? 0 : this.sessionNumber, phase };
  }

  private announceSession(): void {
    this.opts.emit({ type: "session.updated", session: this.sessionInfo() });
  }

  // ---- what the table does -------------------------------------------------------------------

  /**
   * Begins a session: the GM opens the first scene. After a session was wrapped up this begins the next one, with a new
   * conversation, a fresh Edge for everyone and, if the table gave one, the mission it wants.
   */
  async start(mission?: string): Promise<Ack> {
    if (!this.ended && (this.opened || this.openRequested || this.opening)) return { ok: false, error: "The session has already begun." };
    const number = await this.nextSessionNumber();
    if (this.ended) this.refreshEdge();
    this.sessionNumber = number;
    this.mission = mission?.trim() || undefined;
    this.ended = false;
    this.opened = false;
    this.openRequested = true;
    this.blocked = false;
    await this.record({ kind: "session", event: "start", number, ...(this.mission !== undefined && { mission: this.mission }) });
    await this.persist();
    this.announceSession();
    this.schedule();
    return { ok: true };
  }

  /** The number for the session about to begin: the next after the highest in the campaign's log. */
  private async nextSessionNumber(): Promise<number> {
    try {
      const logged = await this.memory.sessions();
      return Math.max(0, ...logged.map((s) => s.number)) + 1;
    } catch (err) {
      await this.memoryProblem(err);
      return this.ended ? this.sessionNumber + 1 : this.sessionNumber;
    }
  }

  /** Everyone starts a session with Edge points equal to their Edge attribute. */
  private refreshEdge(): void {
    for (const sheet of this.sheets) {
      this.edge.set(sheet.id, startSession(sheet.attributes.edge));
      this.announceEdge(sheet.id);
    }
  }

  /**
   * The table stops for now: the GM closes the scene and writes up the session. It waits for rolls to be answered or skipped, and
   * for a turn in progress to end, so that nothing is cut off. A fight in progress carries over.
   */
  async wrapUp(): Promise<Ack> {
    if (!this.opened || this.ended) return { ok: false, error: "There is no session in play to wrap up." };
    if (this.wrapUpRequested || this.wrapping) return { ok: false, error: "The GM is already wrapping up the session." };
    if (this.rolls.list().length > 0) return { ok: false, error: "Answer or skip the rolls that are waiting first." };
    // A turn in progress, not the loop: the loop is still winding down for a moment after a turn ends, and picks the wrap-up up.
    if (this.current) return { ok: false, error: "The GM is in the middle of a turn. Wrap up when it has finished." };
    this.wrapUpRequested = true;
    this.blocked = false;
    await this.persist();
    this.announceSession();
    this.schedule();
    return { ok: true };
  }

  /** Picks up work saved before a restart: messages or roll results the GM never heard. */
  resume(): void {
    this.schedule();
  }

  async say(characterId: string | undefined, text: string): Promise<Ack> {
    if (this.ended) return { ok: false, error: "The session is over. Begin the next one first." };
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

  /** Why this character cannot burn Edge, or null if they can. Burning works even in a round Edge was spent. */
  private burnProblem(id: string): string | null {
    const state = this.edge.get(id);
    if (!state) return "That character has no Edge to burn.";
    if (state.rank === 0) return `${this.nameOf(id)} has no Edge rank left to burn.`;
    return null;
  }

  /** Burns a point of Edge rank for good, and every Edge point on hand, and says what it cost. The caller saves the game. */
  private async burnFor(id: string, kind: EdgeBurn["kind"]): Promise<EdgeBurn> {
    const before = this.edge.get(id)!;
    const after = burnEdge(before);
    this.edge.set(id, after);
    this.burned[id] = (this.burned[id] ?? 0) + 1;
    this.sheets = this.sheets.map((sheet) => (sheet.id === id ? { ...sheet, attributes: { ...sheet.attributes, edge: after.rank } } : sheet));
    this.announceEdge(id);
    const burn = { kind, lost: before.points, rank: after.rank };
    await this.record({ kind: "edge_burn", characterId: id, name: this.nameOf(id), burn: kind, lost: burn.lost, rank: burn.rank });
    return burn;
  }

  /** What a player spent or burned on a roll, for the GM. */
  private edgeNotes(resolved: ResolvedRoll): string | undefined {
    const name = this.nameOf(resolved.request.characterId);
    const notes = [resolved.edge && formatEdgeNote(name, resolved.edge), resolved.burn && formatBurnNote(name, resolved.burn)].filter((n): n is string => n !== undefined);
    return notes.length > 0 ? notes.join("\n") : undefined;
  }

  /**
   * An Edge Action the GM named for a player character's roll, read from the catalog, or why it cannot be used.
   * Nothing is charged here: the Edge is paid when the roll counts. Called Shot works on an attack's damage, so it
   * goes only with the player's own attack.
   */
  private edgeActionFor(characterId: string, id: string, goesWith: "roll" | "attack" | "defense"): { ok: true; action: EdgeActionOnRoll } | { ok: false; error: string } {
    const entry = findEdgeEntry(id);
    if (entry?.kind === "burn") return { ok: false, error: `${entry.name} is burning Edge, which only the player can choose, on the roll card or the roll they hold. Do not pass it as an Edge Action.` };
    if (!entry || entry.kind !== "action") {
      const ids = defaultEdgeCatalog.entries.filter((e) => e.kind === "action").map((e) => e.id).join(", ");
      return { ok: false, error: `"${id}" is not an Edge Action. They are: ${ids}.` };
    }
    if (calledShotOf(id) && goesWith !== "attack") {
      return { ok: false, error: `${entry.name} changes the damage of the player's own attack, so it goes only on the attack tool, with the player character as the attacker.` };
    }
    const problem = this.edgeProblem(characterId, entry.cost);
    if (problem) return { ok: false, error: `${problem} ${entry.name} cannot be used now: ask for the roll without it, or tell the players it is not possible yet.` };
    return { ok: true, action: { id: entry.id, name: entry.name, cost: entry.cost, summary: entry.summary, ...(entry.requires !== undefined && { requires: entry.requires }) } };
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
    if (answer.mode === "smackdown") return this.smackdown(requestId, waiting);

    // An Edge Action the GM declared is the one expenditure of Edge this roll gets, paid when it counts. A player who
    // can no longer pay for it, because Edge went elsewhere meanwhile, rolls without it.
    const declared = waiting?.edgeAction;
    const action = waiting && declared && !this.edgeProblem(waiting.characterId, declared.cost) ? declared : undefined;
    if (waiting && action && (answer.edge || answer.hold)) {
      return { ok: false, error: `${this.nameOf(waiting.characterId)} declared ${action.name}, which is this round's one expenditure of Edge, so no other Edge can be spent on this roll. Roll without it.` };
    }

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
    // In test mode every roll is held, with Edge to spend or not, so that it can be rolled again.
    if (waiting && answer.hold && !this.opts.testMode) {
      // A roll to resist damage may be held with no Edge to spend, since a player with some rank left can burn it to survive a killing blow.
      const problem = this.edgeProblem(waiting.characterId, 1);
      if (problem && !(waiting.soak && this.burnProblem(waiting.characterId) === null)) return { ok: false, error: `${problem} Roll without holding.` };
    }

    const entry: RollEntry = {
      ...(answer.mode === "app" ? { mode: "app" as const } : { mode: "physical" as const, dice: answer.dice, ...(answer.explosions !== undefined && { explosions: answer.explosions }) }),
      ...(edgeDice !== undefined && { edgeDice }),
      ...(widenGlitch && { widenGlitch }),
    };

    if (answer.hold) {
      const held = this.rolls.hold(requestId, entry);
      if (!held.ok) return held;
      // Rolling the attack, even to wait on Edge, is making it. In test mode a held roll can still be rolled again, and
      // the Edge given for the attack must go back if it is then skipped, so it stays until the roll counts.
      if (!this.opts.testMode) this.edgeForAttack.delete(requestId);
      this.opts.emit({ type: "roll.updated", request: held.request });
      await this.persist();
      return { ok: true };
    }

    const edgeInfo =
      edgeDice !== undefined
        ? { spent: boostCost("dice"), summary: `added ${edgeDice} Edge ${edgeDice === 1 ? "die" : "dice"} to the pool, and 6s exploded` }
        : widenGlitch
          ? { spent: boostCost("widen_glitch"), summary: "made 2s count toward a glitch on the opposing roll, as well as 1s" }
          : action
            ? { spent: action.cost, summary: edgeActionSummary(action), action: action.id }
            : undefined;
    const result = this.rolls.resolve(requestId, entry, edgeInfo);
    if (!result.ok) return result;
    if (edgeInfo) this.payEdge(result.resolved.request.characterId, edgeInfo.spent);
    return this.completeRoll(result.resolved);
  }

  /**
   * The player burns Edge for Smackdown instead of rolling: an automatic success with four net hits, for a point of Edge
   * rank and every Edge point on hand. It replaces the roll, so it needs a roll that has yet to be counted, and it is not
   * for the rolls that resist damage or heal, which have their own ways.
   */
  private async smackdown(requestId: string, waiting: RollRequest | undefined): Promise<Ack> {
    if (!waiting) return { ok: false, error: "That roll is not waiting for dice; it may already have been rolled or skipped." };
    const name = this.nameOf(waiting.characterId);
    if (waiting.held) return { ok: false, error: "That roll is already counted. Smackdown replaces the roll, so it has to come before the dice." };
    if (waiting.soak) return { ok: false, error: `Smackdown cannot resist damage. If the blow would kill ${name}, hold this roll and burn Not Dead Yet once the dice are counted.` };
    if (waiting.healing) return { ok: false, error: "A healing roll cannot be a Smackdown." };
    const declared = waiting.edgeAction;
    if (declared && !this.edgeProblem(waiting.characterId, declared.cost)) {
      return { ok: false, error: `${name} declared ${declared.name}, and burning Edge spends all their Edge, so the two cannot go together. Roll without Smackdown.` };
    }
    const problem = this.burnProblem(waiting.characterId);
    if (problem) return { ok: false, error: problem };

    const result = this.rolls.resolve(requestId, { mode: "smackdown", netHits: findEdgeEntry("smackdown")!.amount! });
    if (!result.ok) return result;
    const burn = await this.burnFor(waiting.characterId, "smackdown");
    return this.completeRoll({ ...result.resolved, burn });
  }

  /**
   * The player burns Edge, for good, to survive a held roll to resist damage that would kill. The damage still lands, but
   * stops one box short of death, so they are left unconscious and dying and still in whatever danger the blow came from.
   */
  private async notDeadYet(waiting: RollRequest): Promise<Ack> {
    const name = this.nameOf(waiting.characterId);
    if (!waiting.soak) return { ok: false, error: "Not Dead Yet saves a character from a killing blow, so only a held roll to resist damage can use it." };
    const taken = damageAfterResistance(waiting.soak.damageValue, waiting.held!.roll.hits);
    if (!this.roster.wouldKill("pc", waiting.characterId, waiting.soak.damageType, taken)) {
      return { ok: false, error: `${name} would survive this as the roll stands, so there is no killing blow for Not Dead Yet to save them from.` };
    }
    const problem = this.burnProblem(waiting.characterId);
    if (problem) return { ok: false, error: problem };

    const finished = this.rolls.finish(waiting.id);
    if (!finished.ok) return finished;
    const burn = await this.burnFor(waiting.characterId, "not_dead_yet");
    return this.completeRoll({ ...finished.resolved, burn });
  }

  /** The player has seen a held roll and spends Edge on it; it then counts. */
  async spendEdge(requestId: string, choice: EdgeChoice): Promise<Ack> {
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (!waiting) return { ok: false, error: "That roll is not waiting; it may already have counted or been skipped." };
    if (!this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);
    if (!waiting.held) return { ok: false, error: "That roll has not been counted yet, so there is nothing to spend Edge on. Roll it with hold first." };
    if (choice.boost === "not_dead_yet") return this.notDeadYet(waiting);

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
        // The player typed this, and the GM reads it inside a report it treats as fact: one line, quoted as what they said.
        const what = (input.description ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim();
        if (what.length < 5) return { ok: false, error: "Describe the special effect, so the GM knows what the player has in mind." };
        this.payEdge(characterId, cost);
        detail = `created a special effect: "${what}"`;
        report = `EDGE. ${name} spent ${cost} Edge to create a special effect. The player describes it as: "${what}". Something fortuitous happens that tilts the scene slightly in their favor, and it is for you to decide exactly what. Make it happen in what you narrate; it should help, not win the scene.`;
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

  /** In test mode, throws away a held roll's dice so it can be rolled again. Nothing was paid or told to the GM while it was held. */
  async redoRoll(requestId: string): Promise<Ack> {
    if (!this.opts.testMode) return { ok: false, error: "Rolling again is for testing. Start the server with SHADOWRUN_TEST_MODE=1 to use it." };
    const waiting = this.rolls.list().find((r) => r.id === requestId);
    if (waiting && !this.member(waiting.characterId)) return this.dropOrphanedRoll(waiting);
    const redone = this.rolls.redo(requestId);
    if (!redone.ok) return redone;
    this.opts.emit({ type: "roll.updated", request: redone.request });
    await this.persist();
    return { ok: true };
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
    const unpaid = resolved.request.edgeAction;
    if (unpaid && resolved.edge?.action !== unpaid.id) {
      this.results.push({ kind: "report", text: `EDGE. ${this.nameOf(resolved.request.characterId)} could not pay ${unpaid.cost} Edge for ${unpaid.name} when the roll was made, so it did not happen and nothing was spent. Do not narrate it.` });
    }
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
    // Once the session is written up nothing more happens in it, so the dice, damage and combat tools are refused; the notes tools still work.
    const gameplay = (act: () => Promise<ToolReply>): Promise<ToolReply> =>
      whileCurrent(() => (this.wrapping?.logged ? Promise.resolve({ ok: false, text: "The session is written up and over, so nothing more happens in it. Do not call tools now." }) : act()));
    return {
      requestRoll: (input) => gameplay(() => this.requestRoll(input)),
      rollNpc: (input) => gameplay(() => this.rollNpc(input)),
      dealDamage: (input) => gameplay(() => this.dealDamage(input)),
      attack: (input) => gameplay(() => this.attack(input)),
      awardEdge: (input) => gameplay(() => this.awardEdge(input)),
      startCombat: (input) => gameplay(() => this.startCombat(input)),
      joinCombat: (input) => gameplay(() => this.joinCombat(input)),
      nextRound: () => gameplay(() => this.nextRound()),
      endCombat: () => gameplay(() => this.endCombat()),
      heal: (input) => gameplay(() => this.heal(input)),
      noteNpc: (input) => whileCurrent(() => this.noteNpc(input)),
      noteThread: (input) => whileCurrent(() => this.noteThread(input)),
      recall: (input) => whileCurrent(() => this.recall(input)),
      endSession: (input) => whileCurrent(() => this.endSession(input)),
    };
  }

  /** The notes could not be read or saved: the table is told, and the GM is told only that this one did not go in. */
  private async memoryProblem(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`The campaign notes could not be used: ${message}`);
    // Once for each problem, so a notes file that stays broken does not fill the story with the same line.
    if (this.reportedMemoryProblems.has(message)) return;
    this.reportedMemoryProblems.add(message);
    await this.record({ kind: "system", text: `The campaign notes could not be saved: ${message}` });
  }

  private async noteNpc(input: unknown): Promise<ToolReply> {
    const parsed = NoteNpcInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) };
    const { name, role, status, stats, notes } = parsed.data;
    const player = this.sheets.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase());
    if (player) return { ok: false, text: `${player.name} is a player character. The notes list non-player characters only.` };
    try {
      await this.memory.setNpc({ name, ...(role !== undefined && { role }), ...(status !== undefined && { status }), ...(stats !== undefined && { stats }), ...(notes !== undefined && { notes }) });
      const saved = (await this.memory.npcs()).find((n) => n.name.toLowerCase() === name.toLowerCase());
      return { ok: true, text: `Noted. ${saved ? npcLine(saved) : name}` };
    } catch (err) {
      await this.memoryProblem(err);
      return { ok: false, text: NOTES_UNAVAILABLE };
    }
  }

  private async noteThread(input: unknown): Promise<ToolReply> {
    const parsed = NoteThreadInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) };
    const { title, status, summary } = parsed.data;
    try {
      await this.memory.setThread({ title, text: `${status.replace(/\.+$/, "")}. ${summary}` });
      return { ok: true, text: `Noted the thread "${title}".` };
    } catch (err) {
      await this.memoryProblem(err);
      return { ok: false, text: NOTES_UNAVAILABLE };
    }
  }

  /**
   * The GM's write-up of the session, which is only asked for when the table wraps it up. It goes in the log, and what the run
   * earned and changed goes on each player character's sheet (with a dated copy of the old one saved first), and the run goes in
   * every character's history. If anything cannot be applied, nothing is: the GM is told why and can write it up again. The session
   * ends when the turn does.
   */
  private async endSession(input: unknown): Promise<ToolReply> {
    if (!this.wrapping) return { ok: false, text: "The table has not asked to wrap up the session, so do not write it up now." };
    if (this.wrapping.logged) return { ok: false, text: `Session ${this.wrapping.logged.number} is already written up.` };
    const parsed = EndSessionInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) };
    const { summary, fictionDate, rolls, consequences, rewards = [] } = parsed.data;

    const unknown = rewards.filter((r) => !this.member(r.characterId)).map((r) => r.characterId);
    if (unknown.length > 0) return { ok: false, text: `There is no character ${unknown.map((id) => `"${id}"`).join(", ")} at the table. The ids are ${this.sheets.map((s) => s.id).join(", ")}.` };
    const twice = rewards.find((r, i) => rewards.findIndex((other) => other.characterId === r.characterId) !== i);
    if (twice) return { ok: false, text: `${twice.characterId} is in the rewards twice. Give each character once.` };

    const date = localDate(this.opts.now?.() ?? new Date());
    let planned: Array<{ sheet: CharacterSheet; changes: string[] }>;
    try {
      planned = await this.planRewards({ rewards, summary, date });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // The table is told too, once, since some of these (a sheet that is full) are not the GM's to fix.
      if (!this.reportedMemoryProblems.has(text)) {
        this.reportedMemoryProblems.add(text);
        await this.record({ kind: "system", text });
      }
      return { ok: false, text };
    }

    let number: number;
    try {
      number = await this.memory.logSession({ date, summary, ...(fictionDate !== undefined && { fictionDate }), ...(rolls !== undefined && { rolls }), ...(consequences !== undefined && { consequences }) });
    } catch (err) {
      await this.memoryProblem(err);
      return { ok: false, text: "The session log cannot be written just now. Do not mention this to the players." };
    }
    // The log is the commit: from here the session is over, whether or not the sheets can be saved.
    this.wrapping.logged = { number, summary, ...(fictionDate !== undefined && { fictionDate }) };
    this.wrapping.logged.changes = await this.applyRewards(planned, date, number);
    return { ok: true, text: `Session ${number} is written up and over. Give the players one last line if you have not already, and nothing more.` };
  }

  /** The sheets after the run, worked out for every player character without saving anything; throws the GM's refusal if any part cannot be applied. */
  private async planRewards(opts: { rewards: RewardInput[]; summary: string; date: string }): Promise<Array<{ sheet: CharacterSheet; changes: string[] }>> {
    // Updates are made to the sheets as they are on disk, without the Edge rank burned, which is taken off whenever they are loaded.
    const onDisk = new Map((await this.opts.store.loadParty().catch(() => null))?.map((sheet) => [sheet.id, sheet]) ?? []);
    const campaign = basename(this.opts.store.dir).slice(0, 60);
    const problems: string[] = [];
    const planned: Array<{ sheet: CharacterSheet; changes: string[] }> = [];
    for (const member of this.sheets) {
      const reward = opts.rewards.find((r) => r.characterId === member.id);
      const base = onDisk.get(member.id) ?? { ...member, attributes: { ...member.attributes, edge: member.attributes.edge + (this.burned[member.id] ?? 0) } };
      const update: RunUpdate = {
        ...(reward?.karma !== undefined && { karma: reward.karma }),
        ...(reward?.nuyen !== undefined && { nuyen: reward.nuyen }),
        ...(reward?.gear && { gear: { ...(reward.gear.add && { add: reward.gear.add }), ...(reward.gear.remove && { remove: reward.gear.remove }) } }),
        ...(reward?.contacts && { contacts: reward.contacts.map((c) => ({ name: c.name, ...(c.loyalty !== undefined && { loyalty: c.loyalty }), ...(c.connection !== undefined && { connection: c.connection }), ...(c.notes !== undefined && { notes: c.notes }) })) }),
        ...(reward?.note && { note: reward.note }),
        history: {
          summary: reward?.summary ?? (opts.summary.length > 600 ? `${opts.summary.slice(0, 599)}…` : opts.summary),
          ...(reward?.goal && { goal: reward.goal }),
          with: this.sheets.filter((s) => s.id !== member.id).map((s) => s.name).slice(0, 12),
          campaign,
          ...(reward?.consequences && { consequences: reward.consequences }),
        },
      };
      const applied = applyRunUpdate(base, update, { date: opts.date });
      if (applied.ok) planned.push({ sheet: applied.sheet, changes: applied.changes });
      else problems.push(`${member.name}: ${applied.error}`);
    }
    if (problems.length > 0) throw new Error(`The session was not written up, because: ${problems.join(" ")}`);
    return planned;
  }

  /** Saves the sheets, each after a dated copy of the old one, makes them the sheets in play, tells the GM's driver and tells the table what changed. */
  private async applyRewards(planned: Array<{ sheet: CharacterSheet; changes: string[] }>, date: string, number: number): Promise<Array<{ name: string; changes: string[] }>> {
    const saved: CharacterSheet[] = [];
    const told: Array<{ name: string; changes: string[] }> = [];
    for (const { sheet, changes } of planned) {
      try {
        await saveSheetWithCopy({ dir: this.opts.store.dir, sheet, date });
      } catch (err) {
        await this.memoryProblem(new Error(`${sheet.name}'s sheet could not be saved, so what the run changed for them is lost: ${err instanceof Error ? err.message : err}`));
        continue;
      }
      saved.push(sheet);
      told.push({ name: sheet.name, changes });
      await this.record({ kind: "system", text: `After session ${number}, ${describeChanges(sheet.name, changes)}` });
    }
    if (saved.length === 0) return told;
    const played = withBurnedEdge(saved, this.burned);
    this.sheets = this.sheets.map((sheet) => played.find((p) => p.id === sheet.id) ?? sheet);
    await this.opts.driver.refreshParty?.(this.sheets).catch((err) => console.warn(`The GM could not be given the updated sheets: ${err instanceof Error ? err.message : err}`));
    return told;
  }

  private async recall(input: unknown): Promise<ToolReply> {
    const parsed = RecallInput.safeParse(input);
    if (!parsed.success) return { ok: false, text: z.prettifyError(parsed.error) };
    try {
      const { what, name, last } = parsed.data;
      if (what === "history") return historyRecall(this.sheets, { name, last });
      const [threads, npcs, sessions] = await Promise.all([this.memory.threads(), this.memory.npcs(), this.memory.sessions()]);
      return recallText({ what, name, last }, { threads, npcs, sessions });
    } catch (err) {
      await this.memoryProblem(err);
      return { ok: false, text: NOTES_UNAVAILABLE };
    }
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
    let named: EdgeActionOnRoll | undefined;
    if (parsed.success && parsed.data.edgeAction !== undefined && this.member(parsed.data.characterId)) {
      if (parsed.data.healing) return { ok: false, text: "A healing roll cannot carry an Edge Action." };
      const read = this.edgeActionFor(parsed.data.characterId, parsed.data.edgeAction, "roll");
      if (!read.ok) return { ok: false, text: read.error };
      named = read.action;
    }
    if (parsed.success && parsed.data.healing) {
      const prepared = this.healingFor(parsed.data);
      if (!prepared.ok) return { ok: false, text: prepared.error };
      extra = prepared.extra;
    }
    if (named) extra = { ...extra, edgeAction: named };
    const created = this.rolls.create(input, extra);
    if (!created.ok) return { ok: false, text: created.error };
    await this.persist();
    this.opts.emit({ type: "roll.requested", request: created.request });
    const action = this.actionNote(created.request);
    return { ok: true, text: `${action ? `${action} ` : ""}${WAIT_FOR_DICE}` };
  }

  /** Tells the GM what an Edge Action on a new roll will cost and when, or nothing if there is none. */
  private actionNote(request: RollRequest): string {
    const action = request.edgeAction;
    return action ? `${this.nameOf(request.characterId)} will pay ${action.cost} Edge for ${action.name} when the roll counts.` : "";
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
    if (source === "smackdown") throw new Error("A roll to resist damage cannot be a Smackdown.");
    const taken = damageAfterResistance(soak.damageValue, roll.hits);
    const after = this.roster.damage("pc", request.characterId, soak.damageType, taken, { surviveDeath: resolved.burn?.kind === "not_dead_yet" });
    this.announce(after);
    const damage = { label: soak.source, damageType: soak.damageType, damageValue: soak.damageValue, resistance: roll, resistedBy: source, taken, after };
    return {
      report: formatDamageForGm({ ...damage, body: request.pool.total, edge: this.edgeNotes(resolved) }),
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
    const { label, stakes, weapon, attackPool, defensePool, edgeAdvice, attackRating, defenseRating, edgeAction } = parsed.data;
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
      const named = edgeAction === undefined ? undefined : this.edgeActionFor(attacker.id, edgeAction, "attack");
      if (named && !named.ok) return { ok: false, text: named.error };
      const theirs = defender;
      const request = attackerRequest(shared, { characterId: attacker.id, pool: attackPool }, {
        id: theirs.id,
        name: theirs.name,
        pool: afterWounds(defensePool.total, defenderView.woundModifier),
      });
      return this.putOnScreen(this.rolls.create(request.input, { attack: request.attack, ...(named && { edgeAction: named.action }) }), `${attacker.name}'s attack`, (requestId) => this.edgeFromAttack(attacker, defender, attackRating, defenseRating, requestId));
    }

    const attackDice = afterWounds(attackPool.total, attackerView.woundModifier) + groupBonusDice(groupSize);
    if (defender.kind === "pc") {
      // A defender who is down, or whose wounds leave them no dice, cannot defend at all.
      const dice = defensePool.total - this.roster.woundPenalty(defender.id);
      if (defenderView.status === "active" && dice >= 1) {
        const named = edgeAction === undefined ? undefined : this.edgeActionFor(defender.id, edgeAction, "defense");
        if (named && !named.ok) return { ok: false, text: named.error };
        const request = defenderRequest(shared, { characterId: defender.id, pool: defensePool }, { id: attacker.id, name: attackerName, pool: attackDice }, groupSize);
        return this.putOnScreen(this.rolls.create(request.input, { attack: request.attack, ...(named && { edgeAction: named.action }) }), `${defender.name}'s defense`, () => this.edgeFromAttack(attacker, defender, attackRating + groupSize - 1, defenseRating));
      }
    }
    if (edgeAction !== undefined) return { ok: false, text: "No player character has dice to roll in this attack, so there is no Edge Action to use: non-player characters do not use Edge." };

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
    const action = this.actionNote(created.request);
    return { ok: true, text: `${what} is waiting for dice.${action ? ` ${action}` : ""}${note ? ` ${note}` : ""} ${WAIT_FOR_DICE}` };
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
      edgeNote: this.edgeNotes(resolved),
      // Called Shot reshapes the damage of the player's own attack; the system applies it here.
      ...(attacking && { calledShot: calledShotOf(resolved.edge?.action) }),
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
    /** The Called Shot the attacker paid Edge for, which changes the damage if the attack lands. */
    calledShot?: CalledShot | undefined;
    defender: Found;
    attackRoll: RollResult;
    attackDice: number;
    attackedBy: "app" | "physical" | "system" | "smackdown";
    defenseRoll: RollResult;
    defenseDice: number;
    defendedBy: "app" | "physical" | "system" | "smackdown";
  }): Promise<{ text: string; resist?: string }> {
    const landed = attackDamage(a.attackRoll, a.defenseRoll, a.weapon.damageValue);
    const shot = a.calledShot;
    const bonus = landed.hit && shot?.effect === "called_shot_vitals" ? { name: shot.name, amount: shot.amount } : undefined;
    const disarmed = landed.hit && shot?.effect === "called_shot_disarm" ? shot.name : undefined;
    const outcome = disarmed ? { hit: true, damageValue: 0 } : { hit: landed.hit, damageValue: landed.damageValue + (bonus?.amount ?? 0) };
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
      ...(bonus && { bonus }),
      ...(disarmed && { disarmed }),
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
      ...(shot && { edgeAction: shot.name }),
    });
    const text = formatAttackForGm(report);
    // A disarming hit does no damage, so there is nothing for the defender to resist.
    if (!outcome.hit || disarmed) return { text };

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

  /**
   * The GM's wrap-up turn is over. If it wrote the session up, the session ends: a marker goes in the story, and the GM's conversation is
   * let go, so the next session starts a new one from the notes. If it did not, the session stays open and the table is told.
   */
  private async finishWrapUp(logged: WrittenUp | undefined): Promise<void> {
    if (!logged) {
      await this.record({ kind: "system", text: "The GM did not write up the session, so it is still open. Wrap up again to try once more." });
      this.announceSession();
      return;
    }
    this.sessionNumber = logged.number;
    this.ended = true;
    this.claudeSessionId = undefined;
    await this.record({ kind: "session", event: "end", number: logged.number, summary: logged.summary, ...(logged.fictionDate !== undefined && { fictionDate: logged.fictionDate }), ...(logged.changes && logged.changes.length > 0 && { changes: logged.changes }) });
    this.announceSession();
  }

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
    if (!opening && !this.wrapUpRequested && this.results.length === 0 && this.held.length === 0) return null;
    const turn = { results: this.results, held: this.held, openRequested: this.openRequested, wrapUp: this.wrapUpRequested };
    this.opening = opening;
    this.results = [];
    this.held = [];
    this.openRequested = false;
    this.wrapUpRequested = false;
    return turn;
  }

  private turnInput(turn: Turn, digest = ""): GmTurnInput {
    const parts: string[] = [];
    if (!this.opened) {
      parts.push(this.sessionNumber === 1 ? "BEGIN SESSION. Open the first scene." : `BEGIN SESSION ${this.sessionNumber}. Open the first scene of this session, carrying on from your notes.`);
      if (this.mission) parts.push(`What the table wants this session to be about: ${this.mission}`);
    }
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
    if (turn.wrapUp) parts.push(wrapUpText(digest));
    if (turn.held.length > 0) parts.push(`The players say:\n${turn.held.map((m) => `- ${m.name}: ${m.text}`).join("\n")}`);
    return { kind: this.opened ? "continue" : "open", text: parts.join("\n\n") };
  }

  /**
   * The conversation up to the GM's last reply. What came after it is in the turn's own input, so
   * leaving it out here keeps a GM that starts over from hearing it twice.
   */
  private recapBeforeThisTurn(): string {
    // Only this session: an earlier one is in the notes the GM is given, and is not a conversation to carry on from.
    const inSession = this.recent.slice(this.recent.findLastIndex((entry) => entry.kind === "session" && entry.event === "start") + 1);
    const lastGm = inSession.findLastIndex((entry) => entry.kind === "gm");
    return formatRecap(inSession.slice(0, lastGm + 1), (id) => this.nameOf(id));
  }

  /** The system's account of this session, for the GM to write it up from. */
  private async sessionDigest(): Promise<string> {
    const entries = await this.opts.store.recentEntries(500);
    const inSession = entries.slice(entries.findLastIndex((entry) => entry.kind === "session" && entry.event === "start") + 1);
    return formatRecap(inSession, (id) => this.nameOf(id), 4000);
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
    if (turn.wrapUp) this.wrapping = {};
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
    let wrapped: GameSession["wrapping"] = null;
    try {
      const digest = turn.wrapUp ? await this.sessionDigest().catch(() => "") : "";
      await this.opts.driver.takeTurn(this.turnInput(turn, digest), {
        turnId,
        signal,
        onEvent,
        tools: this.toolsFor(turnId, signal),
        ...(this.claudeSessionId !== undefined && { resumeId: this.claudeSessionId }),
        recap: () => this.recapBeforeThisTurn(),
        brief: () => memoryBrief(this.memory).catch((err) => (void this.memoryProblem(err), "")),
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
      wrapped = this.wrapping;
      this.wrapping = null;
    }

    if (narration.trim()) await this.record({ kind: "gm", text: narration.trim() });
    this.opts.emit({ type: "gm.turn_done", turnId });

    if (failure === undefined) {
      this.healBudgets.clear();
      this.opened = true;
      this.opening = false;
      this.mission = undefined;
      this.blocked = false;
      if (turn.wrapUp) await this.finishWrapUp(wrapped?.logged);
      await this.persist();
      return true;
    }

    if (turn.wrapUp && wrapped?.logged) {
      // The session was written up before the turn failed, so it is over; asking again would log it twice.
      await this.finishWrapUp(wrapped.logged);
      await this.record({ kind: "system", text: `The GM's turn ended with a problem after it had written the session up, so the session is over anyway: ${failure}` });
      await this.persist();
      return true;
    }

    // Give the GM back what it was told, so the next attempt includes it.
    this.results = [...turn.results, ...this.results];
    this.held = [...turn.held, ...this.held];
    this.openRequested = this.openRequested || (turn.openRequested && !this.opened);
    this.opening = false;
    this.wrapUpRequested = this.wrapUpRequested || turn.wrapUp;
    this.blocked = true;
    const resting = restingFrom(failure, this.usage, Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000));
    this.setStatus(resting ?? { phase: "error", message: failure });
    const text = resting ? resting.message : this.cancelledByUser ? failure : `The GM's turn failed: ${failure}`;
    await this.record({ kind: "system", text });
    await this.persist();
    return false;
  }
}
