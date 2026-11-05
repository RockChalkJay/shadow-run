import type { EdgeView, RollRequest } from "@shadow-run/shared";

/** What each way of spending Edge on a roll costs in the core rules (PDF pp. 47-48). The server charges and checks; these are for showing the player. */
export const COST = { dice: 4, widen: 5, reroll: 1, bump: 2, buyHit: 3, rerollMissed: 4, hold: 1 } as const;

/** Why this character cannot spend this much Edge now, or null if they can. */
export function cannotSpend(edge: EdgeView | undefined, cost: number): string | null {
  if (!edge) return "This character has no Edge to spend.";
  if (edge.spentThisRound) return "Edge is already spent this round: only one expenditure a round.";
  if (cost > edge.points) return `Needs ${cost} Edge; ${edge.points} on hand.`;
  return null;
}

/**
 * Why no other Edge can go on this roll: it carries a declared Edge Action the player can pay for, which is the round's
 * one expenditure. A player who cannot pay for it rolls without it, so the other Edge is then open to them.
 */
export function actionTakesTheEdge(request: RollRequest, edge: EdgeView | undefined): string | null {
  const action = request.edgeAction;
  if (!action || cannotSpend(edge, action.cost) !== null) return null;
  return `${action.name} is declared and is this round's one expenditure of Edge.`;
}

/** Splits what was typed into faces: spaces, commas or nothing at all between single digits. */
export function facesFrom(text: string): number[] {
  return (text.match(/[1-6]/g) ?? []).map(Number);
}
