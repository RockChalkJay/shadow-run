import type { EdgeActionOnRoll } from "@shadow-run/shared";
import { findEdgeEntry } from "../rules/index.js";

/** What the engine does for an Edge Action itself. Every other action is the GM's to carry out. */
export type CalledShot = { effect: "called_shot_vitals"; name: string; amount: number } | { effect: "called_shot_disarm"; name: string };

/** The Called Shot the engine applies to an attack's damage, if this Edge Action is one. */
export function calledShotOf(actionId: string | undefined): CalledShot | undefined {
  const entry = actionId === undefined ? undefined : findEdgeEntry(actionId);
  if (!entry) return undefined;
  if (entry.effect === "called_shot_vitals") return { effect: entry.effect, name: entry.name, amount: entry.amount! };
  if (entry.effect === "called_shot_disarm") return { effect: entry.effect, name: entry.name };
  return undefined;
}

const withoutFullStop = (text: string) => text.replace(/\.$/, "");

/** What the player's Edge Action did, worded for "EDGE. <name> spent <cost> Edge and <this>." in the GM's report. */
export function edgeActionSummary(action: EdgeActionOnRoll): string {
  const shot = calledShotOf(action.id);
  if (shot?.effect === "called_shot_vitals") return `used ${shot.name}, which adds ${shot.amount} to the Damage Value if the attack hits`;
  if (shot?.effect === "called_shot_disarm") return `used ${shot.name}, which means a hit does no damage and knocks the target's weapon from their hands`;
  return `used the Edge Action ${action.name}: ${withoutFullStop(action.summary)}`;
}
