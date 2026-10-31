import { randomInt } from "node:crypto";

/** A source of d6 results, each 1 to 6. */
export type D6 = () => number;

export const cryptoD6: D6 = () => randomInt(1, 7);

/** A repeatable d6 for tests (mulberry32). */
export function seededD6(seed: number): D6 {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return 1 + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 6);
  };
}

/** A d6 that returns the given faces in order and throws once they run out. */
export function scriptedD6(faces: readonly number[]): D6 {
  let next = 0;
  return () => {
    const face = faces[next++];
    if (face === undefined) throw new Error("scriptedD6 ran out of faces");
    return face;
  };
}
