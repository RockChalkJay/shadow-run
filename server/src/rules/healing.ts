import type { HealMethod, HealType } from "@shadow-run/shared";

/** The kinds of healing a character can receive only once for any single set of injuries. */
export const TREATMENTS = ["first_aid", "medkit", "magic"] as const;
export type Treatment = (typeof TREATMENTS)[number];
export const isTreatment = (method: HealMethod): method is Treatment => (TREATMENTS as readonly string[]).includes(method);

export const METHOD_NAMES: Record<HealMethod, string> = {
  first_aid: "First Aid",
  medkit: "a medkit",
  magic: "healing magic",
  natural_stun: "natural recovery from stun",
  natural_physical: "natural recovery from physical damage",
  natural_overflow: "natural recovery from overflow",
};

/** Essence of a patient with no cyberware or bioware. */
const FULLY_NATURAL = 6;

/** Hits a healer's roll must beat: 5 minus the patient's Essence, rounded up, never below 0. */
export function healingThreshold(essence: number): number {
  return Math.max(0, Math.ceil(5 - essence));
}

/** First aid and medkits add a free hit to the roll when the patient is fully natural. */
export function healingAutoHit(method: HealMethod, essence: number): boolean {
  return (method === "first_aid" || method === "medkit") && essence >= FULLY_NATURAL;
}

/** Hits a roll has to spend on healing. Natural recovery has no threshold: every hit counts. */
export function healingHits(healing: { method: HealMethod; threshold: number; autoHit: boolean }, rollHits: number): number {
  if (!isTreatment(healing.method)) return rollHits;
  return Math.max(0, rollHits + (healing.autoHit ? 1 : 0) - healing.threshold);
}

/** Hits it costs to heal one box on a track, or null if this kind of healing cannot touch that track. */
export function hitsPerBox(method: HealMethod, type: HealType): number | null {
  switch (method) {
    case "first_aid":
      return type === "stun" ? 1 : 2;
    case "medkit":
    case "magic":
      return 1;
    case "natural_stun":
      return type === "stun" ? 1 : null;
    case "natural_physical":
      return type === "physical" ? 1 : null;
    case "natural_overflow":
      return type === "overflow" ? 1 : null;
  }
}

/** Natural recovery is a patient resting, so it is not stopped by being unconscious. */
export const isNaturalRecovery = (method: HealMethod): boolean => !isTreatment(method);

/** The book subtracts wound modifiers from the overflow recovery roll and from no other healing roll. */
export const healingFeelsWounds = (method: HealMethod): boolean => method !== "natural_stun" && method !== "natural_physical";
