import { randomUUID } from "node:crypto";
import { RollRequest, RollRequestInput, type ResolvedRoll, type RollResult } from "@shadow-run/shared";
import { z } from "zod";
import { cryptoD6, defaultRuleset, evaluate, opposedTest, parseDice, rollPool, simpleTest, type D6, type Ruleset } from "../rules/index.js";

export type Fail = { ok: false; error: string };

/** Most rolls that may wait for dice at once; more than a table can answer is the GM stuck in a loop. */
export const MAX_PENDING_ROLLS = 10;

export type RollEntry = { mode: "app" } | { mode: "physical"; dice: string };

export interface RollManagerOptions {
  /** Is this a character at the table? */
  knownCharacter: (id: string) => boolean;
  /** Why this character cannot act right now (unconscious, dead), or null. */
  canAct?: (id: string) => string | null;
  /** Dice this character loses on every test they are asked to make. */
  woundPenalty?: (id: string) => number;
  d6?: D6;
  rules?: Ruleset;
  newId?: () => string;
}

const describeIssues = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");

/**
 * The life of a roll the GM asked for: validated when requested, then rolled (by the app or at the
 * table) and counted by the rules engine. The GM never sees or sets a die, so it cannot fudge one.
 */
export class RollManager {
  private readonly pending = new Map<string, RollRequest>();
  private readonly d6: D6;
  private readonly rules: Ruleset;
  private readonly newId: () => string;

  constructor(private readonly opts: RollManagerOptions, initial: readonly RollRequest[] = []) {
    this.d6 = opts.d6 ?? cryptoD6;
    this.rules = opts.rules ?? defaultRuleset;
    this.newId = opts.newId ?? randomUUID;
    for (const request of initial) this.pending.set(request.id, request);
  }

  list(): RollRequest[] {
    return [...this.pending.values()];
  }

  create(input: unknown, extra: Pick<RollRequest, "attack"> = {}): { ok: true; request: RollRequest } | Fail {
    const parsed = RollRequestInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: `The roll request was not valid: ${describeIssues(parsed.error)}` };
    const data = parsed.data;
    if (this.pending.size >= MAX_PENDING_ROLLS) {
      return { ok: false, error: `There are already ${MAX_PENDING_ROLLS} rolls waiting for dice. Stop asking and wait for the table to answer them.` };
    }
    if (!this.opts.knownCharacter(data.characterId)) {
      return { ok: false, error: `There is no character "${data.characterId}" at the table.` };
    }
    if (data.threshold !== undefined && data.opposed) {
      return { ok: false, error: "A roll is either against a threshold or opposed, not both. Send one of them." };
    }
    const refusal = this.opts.canAct?.(data.characterId);
    if (refusal) return { ok: false, error: `${refusal} Narrate what happens instead of asking for a roll.` };

    const penalty = this.opts.woundPenalty?.(data.characterId) ?? 0;
    const dice = data.pool.total - penalty;
    if (dice < 1) {
      return { ok: false, error: `Wounds cost ${penalty} dice and leave this roll with none, so the attempt fails outright. Narrate that instead of asking for a roll.` };
    }
    const pool = penalty > 0 ? { total: dice, breakdown: `${data.pool.breakdown}, minus ${penalty} for wounds` } : data.pool;

    const request: RollRequest = {
      ...data,
      ...extra,
      pool,
      ...(penalty > 0 && { woundPenalty: penalty }),
      threshold: data.opposed ? undefined : (data.threshold ?? 1),
      id: this.newId(),
    };
    this.pending.set(request.id, request);
    return { ok: true, request };
  }

  /** Adds a roll the system itself asks for, such as resisting damage. It is not checked as a request from the GM. */
  createInternal(request: Omit<RollRequest, "id">): RollRequest {
    const full = RollRequest.parse({ ...request, id: this.newId() });
    this.pending.set(full.id, full);
    return full;
  }

  /** Counts the player's roll, rolls any opposition, and takes the request off the pending list. */
  resolve(requestId: string, entry: RollEntry): { ok: true; resolved: ResolvedRoll } | Fail {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "That roll is not waiting for dice; it may already have been rolled or skipped." };

    let roll: RollResult;
    if (entry.mode === "app") {
      roll = rollPool(request.pool.total, this.d6, this.rules);
    } else {
      let faces: number[];
      try {
        faces = parseDice(entry.dice);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      if (faces.length !== request.pool.total) {
        return { ok: false, error: `This roll is ${request.pool.total} dice; you entered ${faces.length}.` };
      }
      roll = evaluate(faces, this.rules);
    }

    const { consequences } = request;
    let success: boolean;
    let netHits: number;
    let opposed: ResolvedRoll["opposed"];
    if (request.opposed) {
      const { by, pool, role } = request.opposed;
      const opponent = rollPool(pool, this.d6, this.rules);
      opposed = { by, pool, role, roll: opponent };
      if (role === "acting") {
        const outcome = opposedTest(roll, opponent);
        success = outcome.winner === "attacker";
        netHits = success ? outcome.netHits : 0;
      } else {
        const outcome = opposedTest(opponent, roll);
        success = outcome.winner === "defender";
        netHits = success ? outcome.netHits : 0;
      }
    } else {
      ({ success, netHits } = simpleTest(roll, request.threshold ?? 1));
    }

    this.pending.delete(requestId);
    const glitchConsequence = roll.criticalGlitch ? consequences.criticalGlitch : roll.glitch ? consequences.glitch : undefined;
    return {
      ok: true,
      resolved: {
        request,
        source: entry.mode,
        roll,
        ...(opposed && { opposed }),
        outcome: {
          success,
          netHits,
          glitch: roll.glitch,
          criticalGlitch: roll.criticalGlitch,
          consequence: success ? consequences.success : consequences.failure,
          ...(glitchConsequence !== undefined && { glitchConsequence }),
        },
      },
    };
  }

  /** Skips a roll; returns it, or undefined if it was not pending. */
  cancel(requestId: string): RollRequest | undefined {
    const request = this.pending.get(requestId);
    this.pending.delete(requestId);
    return request;
  }
}
