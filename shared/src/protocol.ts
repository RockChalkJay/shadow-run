import { z } from "zod";
import type { CharacterView, DamageType, HealType, Status } from "./character.js";
import type { PartyMember } from "./party.js";
import type { ResolvedRoll, RollRequest, RollResult } from "./roll.js";

export type { Status };

/** Longest message one player can say to the GM. */
export const MAX_SAY = 2000;

/** What the browser (or any client) may send. Everything is validated on the server. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.start") }),
  z.object({ type: z.literal("player.say"), characterId: z.string().optional(), text: z.string().trim().min(1).max(MAX_SAY) }),
  /** Roll the pending request for the player with the app's dice. */
  z.object({ type: z.literal("roll.app"), requestId: z.string() }),
  /** Report dice rolled at the table, e.g. "6 5 3 1 1 2". */
  z.object({ type: z.literal("roll.physical"), requestId: z.string(), dice: z.string().max(400) }),
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
    })
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
  party: PartyMember[];
  /** Every player character, and every non-player character the GM has put on the table. */
  characters: CharacterView[];
  pendingRolls: RollRequest[];
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
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "roll.requested"; request: RollRequest }
  | { type: "roll.cancelled"; requestId: string }
  /** Sent to the one client whose message was refused. */
  | { type: "error"; message: string };
