import { readFileSync } from "node:fs";
import { z } from "zod";

/** What the engine resolves in code; `gm` means the gamemaster adjudicates it from the summary. */
export const EdgeEffect = z.enum([
  "reroll_dice",
  "initiative_bonus",
  "bump_die",
  "give_edge",
  "negate_edge",
  "buy_hit",
  "heal_stun",
  "heal_physical",
  "edge_dice_explode",
  "reroll_failed",
  "widen_glitch",
  "gm",
]);
export type EdgeEffect = z.infer<typeof EdgeEffect>;

export const EdgeEntry = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  kind: z.enum(["boost", "action", "burn"]),
  /** Edge points for one use. Boosts may be repeated; burning costs a rank and every point instead. */
  cost: z.number().int().min(0),
  /** `pre` is declared before the roll, `post` after it, `any` at either time. */
  timing: z.enum(["pre", "post", "any"]),
  effect: EdgeEffect,
  /** The action an Edge Action must accompany. */
  requires: z.string().optional(),
  summary: z.string().min(1),
  /** Where it is in the core rulebook PDF. */
  page: z.string().min(1),
});
export type EdgeEntry = z.infer<typeof EdgeEntry>;

export const EdgeCatalog = z
  .object({ entries: z.array(EdgeEntry).min(1) })
  .refine((c) => new Set(c.entries.map((e) => e.id)).size === c.entries.length, "Edge entry ids must be unique");
export type EdgeCatalog = z.infer<typeof EdgeCatalog>;

export function loadEdgeCatalog(file = new URL("../data/sr6/edge.json", import.meta.url)): EdgeCatalog {
  return EdgeCatalog.parse(JSON.parse(readFileSync(file, "utf8")));
}

export const defaultEdgeCatalog: EdgeCatalog = loadEdgeCatalog();

export function findEdgeEntry(id: string, catalog: EdgeCatalog = defaultEdgeCatalog): EdgeEntry | undefined {
  return catalog.entries.find((e) => e.id === id);
}
