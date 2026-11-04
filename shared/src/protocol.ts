import { z } from "zod";
import type { CombatState } from "./combat.js";
import type { CharacterView, DamageType, EdgeView, HealType, Status } from "./character.js";
import type { CharacterSheet } from "./sheet.js";
import type { ResolvedRoll, RollRequest, RollResult, Weapon } from "./roll.js";

export type { Status };

/** Longest message one player can say to the GM. */
export const MAX_SAY = 2000;

/** What the browser (or any client) may send. Everything is validated on the server. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start") }),
  z.object({ type: z.literal("player.say"), characterId: z.string().optional(), text: z.string().trim().min(1).max(MAX_SAY) }),
  /**
   * Roll the pending request for the player with the app's dice. `edge: "dice"` spends 4 Edge to add the Edge
   * attribute to the pool and make 6s explode; `hold` counts the roll but waits for the player to decide on Edge.
   */
  z.object({ type: z.literal("roll.app"), requestId: z.string(), edge: z.literal("dice").optional(), hold: z.boolean().optional() }),
  /**
   * Report dice rolled by hand, e.g. "6 5 3 1 1 2". With Edge dice, `explosions` are the extra dice rolled for 6s
   * (the app rolls them if they are left out).
   */
  z.object({
    type: z.literal("roll.physical"),
    requestId: z.string(),
    dice: z.string().max(400),
    explosions: z.string().max(400).optional(),
    edge: z.literal("dice").optional(),
    hold: z.boolean().optional(),
  }),
  /**
   * Spend Edge on a held roll, which then counts. `reroll` rerolls the dice at `targets` (1 Edge each, yours or the
   * opponent's), `bump` adds 1 to your dice at `targets` (2 each), `buy_hit` adds `times` hits (3 each), and
   * `reroll_failed` rerolls every die that is not a hit (4). `dice` are the new values if rolled by hand; the app
   * rolls them if left out.
   */
  z.object({
    type: z.literal("roll.edge"),
    requestId: z.string(),
    boost: z.enum(["reroll", "bump", "buy_hit", "reroll_failed"]),
    targets: z.array(z.object({ side: z.enum(["mine", "theirs"]), index: z.number().int().min(0).max(999) })).max(20).optional(),
    times: z.number().int().min(1).max(10).optional(),
    dice: z.string().max(400).optional(),
  }),
  /** Let a held roll count as it stands, spending no Edge. */
  z.object({ type: z.literal("roll.keep"), requestId: z.string() }),
  /** Skip a pending roll. */
  z.object({ type: z.literal("roll.cancel"), requestId: z.string() }),
  /** Stop the GM mid-turn. */
  z.object({ type: z.literal("turn.cancel") }),
  /** Try the GM's last turn again after an error. */
  z.object({ type: z.literal("turn.retry") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type GmStatus =
  | { phase: "idle" }
  | { phase: "thinking"; turnId: number }
  | { phase: "waiting_for_rolls" }
  /** The Claude plan's usage limit was reached; `until` is when it resets, if known (epoch seconds). */
  | { phase: "resting"; until: number | null; message: string }
  | { phase: "error"; message: string };

interface EntryBase {
  /** Position in the transcript, counting from 1. */
  id: number;
  ts: string;
}

export type TranscriptEntry =
  | (EntryBase & { kind: "say"; characterId?: string; name: string; text: string })
  | (EntryBase & { kind: "gm"; text: string })
  | (EntryBase & { kind: "roll"; resolved: ResolvedRoll })
  | (EntryBase & { kind: "roll_cancelled"; requestId: string; characterId: string; label: string })
  | (EntryBase & { kind: "npc"; label: string; pool: number; roll: RollResult; threshold?: number; success?: boolean })
  | (EntryBase & {
      kind: "damage";
      /** What caused the damage, as the GM described it. */
      label: string;
      damageType: DamageType;
      damageValue: number;
      /** The resistance roll: made by the app or at the table for a player character, by the system for an NPC. */
      resistance: RollResult;
      resistedBy: "app" | "physical" | "system";
      /** Damage that got through. */
      taken: number;
      after: CharacterView;
      /** Set when a grunt passed their Professional Rating with this damage and the system tested their nerve. */
      composure?: { roll: RollResult; pool: number; threshold: number; held: boolean };
    })
  | (EntryBase & {
      kind: "attack";
      label: string;
      attacker: string;
      defender: string;
      weapon: Weapon;
      /** How many grunts attacked together; absent for a single attacker. */
      groupSize?: number;
      attackRoll: RollResult;
      defenseRoll: RollResult;
      /** Who rolled each side: the app or physical dice for a player, the system for a non-player character. */
      attackedBy: "app" | "physical" | "system";
      defendedBy: "app" | "physical" | "system";
      hit: boolean;
      /** The weapon's Damage Value plus the attacker's net hits, before the defender resists; 0 on a miss. */
      damageValue: number;
    })
  | (EntryBase & { kind: "combat"; event: "start" | "join" | "round" | "end"; round: number; names: string[] })
  | (EntryBase & { kind: "heal"; reason: string; type: HealType; healed: number; after: CharacterView })
  | (EntryBase & { kind: "system"; text: string });

export interface Usage {
  /** Share of the five-hour plan window used, 0 to 1. */
  fiveHourUtilization: number;
  /** When that window resets, in epoch seconds. */
  resetsAt: number;
}

export interface Snapshot {
  type: "snapshot";
  party: CharacterSheet[];
  /** Every player character, and every non-player character the GM has put on the table. */
  characters: CharacterView[];
  pendingRolls: RollRequest[];
  /** Every player character's Edge points. */
  edge: EdgeView[];
  /** The fight in progress, if there is one. */
  combat: CombatState | null;
  /** The most recent entries, oldest first. */
  transcript: TranscriptEntry[];
  gm: GmStatus;
  usage: Usage | null;
}

/**
 * What the server sends. A client gets a `snapshot` first, taken in one step with its connection, so
 * every event after it is something the snapshot lacks and nothing is missed or repeated. Entries are
 * also appended to the transcript, so a client that reconnects catches up from the snapshot.
 */
export type ServerEvent =
  | Snapshot
  | { type: "gm.status"; status: GmStatus }
  /** A new block of narration begins in this turn; start a new paragraph if text is already showing. */
  | { type: "gm.block"; turnId: number }
  | { type: "gm.text"; turnId: number; text: string }
  | { type: "gm.turn_done"; turnId: number }
  | { type: "usage"; usage: Usage }
  | { type: "character.updated"; character: CharacterView }
  /** A fight began, gained people, moved to a new round, or ended (null). */
  | { type: "combat.updated"; combat: CombatState | null }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "roll.requested"; request: RollRequest }
  /** A pending roll changed: it was counted and is waiting for the player to decide on Edge. */
  | { type: "roll.updated"; request: RollRequest }
  | { type: "edge.updated"; edge: EdgeView }
  | { type: "roll.cancelled"; requestId: string }
  /** Sent to the one client whose message was refused. */
  | { type: "error"; message: string };
