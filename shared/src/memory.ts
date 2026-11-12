import { z } from "zod";
import { GearItem } from "./sheet.js";

/** The GM's note about a non-player character: who they are and where they stand with the party. Only `name` is needed. */
export const NoteNpcInput = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(120).optional(),
  /** Alive, Dead, Burned, Ally, Enemy or Unknown, or a few words of the GM's own. */
  status: z.string().trim().min(1).max(40).optional(),
  /** What they are rolled with when they come back, such as "PR 3, Body 3, Willpower 4". */
  stats: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(400).optional(),
});
export type NoteNpcInput = z.infer<typeof NoteNpcInput>;

/** The GM's note about a plot thread: a short title, where it stands, and what is going on. */
export const NoteThreadInput = z.object({
  title: z.string().trim().min(1).max(80),
  status: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(500),
});
export type NoteThreadInput = z.infer<typeof NoteThreadInput>;

/** What the GM asks the notes for. `name` goes with `npc`, and `last` with `sessions`. */
export const RecallInput = z.object({
  what: z.enum(["npc", "npcs", "threads", "sessions", "history"]),
  /** An NPC's name, or a player character's name or id for their history. */
  name: z.string().trim().min(1).max(60).optional(),
  /** How many of the latest sessions (up to 5) or of a character's runs (up to 20). */
  last: z.number().int().min(1).max(20).optional(),
});
export type RecallInput = z.infer<typeof RecallInput>;

/** The most Karma and nuyen one run may change a sheet by, so a slip by whoever writes the update cannot ruin a character. */
export const MAX_KARMA_PER_RUN = 30;
export const MAX_NUYEN_CHANGE = 500_000;

/** What a run did for one player character: what they earned, what changed, and their part in it, for their sheet. */
export const RewardInput = z.object({
  characterId: z.string().trim().min(1).max(60),
  /** Karma earned, added to the Karma in hand and the total. */
  karma: z.number().int().min(0).max(MAX_KARMA_PER_RUN).optional(),
  /** Nuyen gained, or spent when negative. */
  nuyen: z.number().int().min(-MAX_NUYEN_CHANGE).max(MAX_NUYEN_CHANGE).optional(),
  gear: z
    .object({ add: z.array(GearItem).max(10).optional(), remove: z.array(z.string().trim().min(1).max(120)).max(10).optional() })
    .optional(),
  /** Contacts made, or changed by name; a new one needs both ratings. */
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        loyalty: z.number().int().min(0).max(12).optional(),
        connection: z.number().int().min(0).max(12).optional(),
        notes: z.string().trim().max(300).optional(),
      }),
    )
    .max(10)
    .optional(),
  /** A line to add to the character's notes. */
  note: z.string().trim().max(300).optional(),
  /** This character's part in the run, for their history; the session's summary is used if left out. */
  summary: z.string().trim().min(1).max(600).optional(),
  goal: z.string().trim().max(300).optional(),
  consequences: z.string().trim().max(300).optional(),
});
export type RewardInput = z.infer<typeof RewardInput>;

/** The GM's write-up of a session, once the table has asked to wrap up. The system adds the date. */
export const EndSessionInput = z.object({
  summary: z.string().trim().min(20).max(1500),
  /** The date and time in the story when it ended. */
  fictionDate: z.string().trim().max(60).optional(),
  /** Key rolls and how they came out. */
  rolls: z.string().trim().max(600).optional(),
  /** What changed: karma, nuyen, gear, condition, notoriety. */
  consequences: z.string().trim().max(600).optional(),
  /** What each player character earned and changed, for their sheet. Every character's history gets the run either way. */
  rewards: z.array(RewardInput).max(8).optional(),
});
export type EndSessionInput = z.infer<typeof EndSessionInput>;
