import { z } from "zod";

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
  what: z.enum(["npc", "npcs", "threads", "sessions"]),
  name: z.string().trim().min(1).max(60).optional(),
  last: z.number().int().min(1).max(5).optional(),
});
export type RecallInput = z.infer<typeof RecallInput>;
