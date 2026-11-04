import { randomUUID } from "node:crypto";
import { RollRequest, RollRequestInput, type ResolvedRoll, type RollResult } from "@shadow-run/shared";
import { z } from "zod";
import { attackDamage, bumpDie, buyHit, cryptoD6, defaultRuleset, evaluate, explode, explosionsFor, healingFeelsWounds, healingHits, isNaturalRecovery, nonHitIndexes, opposedTest, parseDice, rerollDice, rerollFailed, rollPool, scriptedD6, simpleTest, type D6, type Ruleset } from "../rules/index.js";

export type Fail = { ok: false; error: string };

/** Most rolls that may wait for dice at once; more than a table can answer is the GM stuck in a loop. */
export const MAX_PENDING_ROLLS = 10;

export type RollEntry = (
  | { mode: "app" }
  | { mode: "physical"; dice: string; /** Extra dice rolled by hand for exploding 6s; the app rolls them if left out. */ explosions?: string }
) & {
  /** Dice added to the pool by the 4-Edge boost, which also makes 6s explode. Set once the session has checked the Edge. */
  edgeDice?: number;
  /** The 5-Edge boost: 2s count toward a glitch on the opposing roll as well as 1s. Set once the session has checked the Edge. */
  widenGlitch?: boolean;
};

/** A change to a counted roll, bought with Edge. */
export type EdgeBoost =
  | { kind: "reroll"; targets: Array<{ side: "mine" | "theirs"; index: number }>; dice?: string }
  | { kind: "bump"; targets: number[] }
  | { kind: "buy_hit"; times: number }
  | { kind: "reroll_failed"; dice?: string };

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

  /**
   * `extra` is what only the session can know: the other side of an attack, or the patient and difficulty of a healing roll
   * (whose threshold the rules set, not the GM).
   */
  create(input: unknown, extra: Partial<Pick<RollRequest, "attack" | "healing">> & { threshold?: number } = {}): { ok: true; request: RollRequest } | Fail {
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
    if (data.healing && (data.opposed || !extra.healing)) {
      return { ok: false, error: "A healing roll is a simple test, set up by the game; leave out `opposed`." };
    }
    // Someone resting to recover can roll for it however hurt they are, even unconscious.
    const refusal = extra.healing && isNaturalRecovery(extra.healing.method) ? null : this.opts.canAct?.(data.characterId);
    if (refusal) return { ok: false, error: `${refusal} Narrate what happens instead of asking for a roll.` };

    const penalty = extra.healing && !healingFeelsWounds(extra.healing.method) ? 0 : (this.opts.woundPenalty?.(data.characterId) ?? 0);
    const dice = data.pool.total - penalty;
    if (dice < 1) {
      return { ok: false, error: `Wounds cost ${penalty} dice and leave this roll with none, so the attempt fails outright. Narrate that instead of asking for a roll.` };
    }
    const pool = penalty > 0 ? { total: dice, breakdown: `${data.pool.breakdown}, minus ${penalty} for wounds` } : data.pool;

    const { healing: _asked, ...rest } = data;
    const { threshold: setByRules, ...stored } = extra;
    const request: RollRequest = {
      ...rest,
      ...stored,
      pool,
      ...(penalty > 0 && { woundPenalty: penalty }),
      threshold: data.opposed ? undefined : (setByRules ?? data.threshold ?? 1),
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

  /** The dice the player rolled, and the opposition's; nothing is changed. */
  private count(request: RollRequest, entry: RollEntry): { ok: true; source: "app" | "physical"; roll: RollResult; opponent?: RollResult } | Fail {
    const edgeDice = entry.edgeDice ?? 0;
    const size = request.pool.total + edgeDice;
    let roll: RollResult;
    try {
      if (entry.mode === "app") {
        roll = rollPool(size, this.d6, this.rules, edgeDice > 0 ? { explode: true } : {});
      } else {
        const faces = parseDice(entry.dice);
        if (faces.length !== size) {
          return {
            ok: false,
            error: edgeDice > 0
              ? `This roll is ${size} dice (${request.pool.total} plus ${edgeDice} Edge dice); you entered ${faces.length}.`
              : `This roll is ${request.pool.total} dice; you entered ${faces.length}.`,
          };
        }
        if (edgeDice === 0 && entry.explosions !== undefined) return { ok: false, error: "Extra dice for 6s come only with Edge dice, which were not spent on this roll." };
        const explosions = edgeDice > 0 ? (entry.explosions !== undefined ? explosionsFor(faces, parseDice(entry.explosions)) : explode(faces, this.d6)) : [];
        roll = evaluate(faces, this.rules, { explosions });
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const opponent = request.opposed ? rollPool(request.opposed.pool, this.d6, this.rules, entry.widenGlitch ? { glitchFaces: 2 } : {}) : undefined;
    return { ok: true, source: entry.mode, roll, ...(opponent && { opponent }) };
  }

  /** Works out how a counted roll came out. */
  private settle(request: RollRequest, source: "app" | "physical", roll: RollResult, opponent: RollResult | undefined, edge?: ResolvedRoll["edge"]): ResolvedRoll {
    const { consequences } = request;
    let success: boolean;
    let netHits: number;
    let opposed: ResolvedRoll["opposed"];
    if (request.opposed && opponent) {
      const { by, pool, role } = request.opposed;
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
      if (request.attack) {
        // An attack that rolls no hits cannot land, whatever the other side rolled, so the verdict follows the attack rules.
        const attacking = request.attack.role === "attacker";
        const [attackRoll, defenseRoll] = attacking ? [roll, opponent] : [opponent, roll];
        const landed = attackDamage(attackRoll, defenseRoll, 0);
        success = attacking ? landed.hit : !landed.hit;
        netHits = attacking ? landed.damageValue : Math.max(0, defenseRoll.hits - attackRoll.hits);
      }
    } else {
      ({ success, netHits } = simpleTest(roll, request.threshold ?? 1));
      if (request.healing) {
        // The hits to heal with include the free hit and use the Essence-based threshold; the threshold shown on the roll is only that threshold with a floor of 1.
        netHits = healingHits(request.healing, roll.hits);
        success = netHits > 0;
      }
    }

    const { held: _held, ...plain } = request;
    const glitchConsequence = roll.criticalGlitch ? consequences.criticalGlitch : roll.glitch ? consequences.glitch : undefined;
    return {
      request: plain,
      source,
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
      ...(edge && { edge }),
    };
  }

  /** Counts the player's roll, rolls any opposition, and takes the request off the pending list. */
  resolve(requestId: string, entry: RollEntry, edge?: ResolvedRoll["edge"]): { ok: true; resolved: ResolvedRoll } | Fail {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "That roll is not waiting for dice; it may already have been rolled or skipped." };
    if (request.held) return { ok: false, error: "That roll is already counted. Keep it, or spend Edge on it." };

    const counted = this.count(request, entry);
    if (!counted.ok) return counted;
    this.pending.delete(requestId);
    return { ok: true, resolved: this.settle(request, counted.source, counted.roll, counted.opponent, edge) };
  }

  /** Counts the roll but keeps it pending, so the player can decide on Edge before it counts. */
  hold(requestId: string, entry: RollEntry): { ok: true; request: RollRequest } | Fail {
    const request = this.pending.get(requestId);
    if (!request) return { ok: false, error: "That roll is not waiting for dice; it may already have been rolled or skipped." };
    if (request.held) return { ok: false, error: "That roll is already counted. Keep it, or spend Edge on it." };

    const counted = this.count(request, entry);
    if (!counted.ok) return counted;
    const held = { source: counted.source, roll: counted.roll, ...(counted.opponent && { opponent: counted.opponent }) };
    const updated = { ...request, held };
    this.pending.set(requestId, updated);
    return { ok: true, request: updated };
  }

  /** Changes a held roll the way an Edge boost does, and says what it did. Nothing changes if it is refused. */
  boost(requestId: string, boost: EdgeBoost): { ok: true; summary: string } | Fail {
    const request = this.pending.get(requestId);
    if (!request?.held) return { ok: false, error: "That roll has not been counted yet, so there is nothing to spend Edge on." };
    const { held } = request;

    try {
      let roll = held.roll;
      let opponent = held.opponent;
      let summary: string;
      switch (boost.kind) {
        case "reroll": {
          if (boost.targets.length === 0) return { ok: false, error: "Name the dice to reroll." };
          const mine = boost.targets.filter((t) => t.side === "mine").map((t) => t.index);
          const theirs = boost.targets.filter((t) => t.side === "theirs").map((t) => t.index);
          if (theirs.length > 0 && !opponent) return { ok: false, error: "There is no opposing roll to reroll." };
          let d6: D6 = this.d6;
          if (boost.dice !== undefined) {
            const faces = parseDice(boost.dice);
            if (faces.length !== boost.targets.length) {
              return { ok: false, error: `That rerolls ${boost.targets.length} ${boost.targets.length === 1 ? "die" : "dice"}; you gave ${faces.length} new ${faces.length === 1 ? "value" : "values"}. Give yours first, then the opponent's.` };
            }
            d6 = scriptedD6(faces);
          }
          const parts: string[] = [];
          if (mine.length > 0) {
            const before = mine.map((i) => roll.dice[i]);
            roll = rerollDice(roll, mine, d6, this.rules);
            parts.push(`rerolled ${mine.length === 1 ? "die" : "dice"} ${mine.map((i) => i + 1).join(", ")} of their own roll (${before.map((b, n) => `${b} became ${roll.dice[mine[n]!]}`).join("; ")})`);
          }
          if (theirs.length > 0) {
            const before = theirs.map((i) => opponent!.dice[i]);
            opponent = rerollDice(opponent!, theirs, d6, this.rules);
            parts.push(`rerolled ${theirs.length === 1 ? "die" : "dice"} ${theirs.map((i) => i + 1).join(", ")} of the opposing roll (${before.map((b, n) => `${b} became ${opponent!.dice[theirs[n]!]}`).join("; ")})`);
          }
          summary = parts.join(" and ");
          break;
        }
        case "bump": {
          if (boost.targets.length === 0) return { ok: false, error: "Name the dice to raise." };
          if (new Set(boost.targets).size !== boost.targets.length) return { ok: false, error: "A die can be raised only once." };
          const before = boost.targets.map((i) => roll.dice[i]);
          for (const i of boost.targets) roll = bumpDie(roll, i, this.rules);
          summary = `added 1 to ${boost.targets.length === 1 ? "die" : "dice"} ${boost.targets.map((i) => i + 1).join(", ")} of their roll (${before.map((b) => `${b} became ${b! + 1}`).join("; ")})`;
          break;
        }
        case "buy_hit": {
          for (let n = 0; n < boost.times; n++) roll = buyHit(roll, this.rules);
          summary = `bought ${boost.times} ${boost.times === 1 ? "hit" : "hits"}`;
          break;
        }
        case "reroll_failed": {
          const failed = nonHitIndexes(roll, this.rules);
          if (failed.length === 0) return { ok: false, error: "Every die is a hit, so there is nothing to reroll." };
          let d6: D6 = this.d6;
          if (boost.dice !== undefined) {
            const faces = parseDice(boost.dice);
            if (faces.length !== failed.length) {
              return { ok: false, error: `${failed.length} ${failed.length === 1 ? "die is" : "dice are"} not hits, so that rerolls ${failed.length}; you gave ${faces.length} new ${faces.length === 1 ? "value" : "values"}, in order.` };
            }
            d6 = scriptedD6(faces);
          }
          const before = roll.hits;
          roll = rerollFailed(roll, d6, this.rules);
          summary = `rerolled the ${failed.length} ${failed.length === 1 ? "die" : "dice"} that missed (${before} hits became ${roll.hits})`;
          break;
        }
      }
      this.pending.set(requestId, { ...request, held: { source: held.source, roll, ...(opponent && { opponent }) } });
      return { ok: true, summary };
    } catch (err) {
      if (err instanceof RangeError) return { ok: false, error: err.message };
      throw err;
    }
  }

  /** Counts a held roll as it now stands and takes it off the pending list. */
  finish(requestId: string, edge?: ResolvedRoll["edge"]): { ok: true; resolved: ResolvedRoll } | Fail {
    const request = this.pending.get(requestId);
    if (!request?.held) return { ok: false, error: "That roll has not been counted yet." };
    this.pending.delete(requestId);
    return { ok: true, resolved: this.settle(request, request.held.source, request.held.roll, request.held.opponent, edge) };
  }

  /** Skips a roll; returns it, or undefined if it was not pending. */
  cancel(requestId: string): RollRequest | undefined {
    const request = this.pending.get(requestId);
    this.pending.delete(requestId);
    return request;
  }
}
