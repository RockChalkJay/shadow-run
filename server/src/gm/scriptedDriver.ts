import type { PartyMember } from "@shadow-run/shared";
import type { GmDriver, GmTurnContext, GmTurnInput } from "./driver.js";

export interface ScriptedTurn {
  /** Narration, one block per entry. */
  say?: string[];
  /** Rolls to ask for, in the shape of a `request_roll` call. */
  rolls?: unknown[];
  /** Attacks to make, in the shape of an `attack` call. */
  attacks?: unknown[];
  /** Damage to deal, in the shape of a `deal_damage` call. */
  damage?: unknown[];
  /** Healing to give, in the shape of a `heal` call. */
  heals?: unknown[];
  /** Fail the turn with this message instead of speaking. */
  fail?: string;
}

export type Script = ScriptedTurn[] | ((input: GmTurnInput, turnNumber: number) => ScriptedTurn);

export interface ScriptedOptions {
  /** Pause between chunks of narration, to look like streaming. */
  chunkDelayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** A stand-in GM that follows a script, for trying the table and testing it without spending any Claude usage. */
export class ScriptedGmDriver implements GmDriver {
  /** Every input the GM was given, in order. */
  readonly inputs: GmTurnInput[] = [];

  constructor(
    private readonly script: Script,
    private readonly options: ScriptedOptions = {},
  ) {}

  async takeTurn(input: GmTurnInput, ctx: GmTurnContext): Promise<void> {
    this.inputs.push(input);
    const turnNumber = this.inputs.length;
    const turn = typeof this.script === "function" ? this.script(input, turnNumber) : (this.script[turnNumber - 1] ?? {});
    ctx.onEvent({ type: "session", sessionId: "scripted" });
    if (turn.fail !== undefined) throw new Error(turn.fail);

    for (const block of turn.say ?? []) {
      ctx.onEvent({ type: "text_block_start" });
      for (const word of block.match(/\S+\s*/g) ?? []) {
        ctx.signal.throwIfAborted();
        ctx.onEvent({ type: "text", text: word });
        await sleep(this.options.chunkDelayMs ?? 0, ctx.signal);
      }
    }
    for (const roll of turn.rolls ?? []) {
      ctx.signal.throwIfAborted();
      const reply = await ctx.tools.requestRoll(roll);
      if (!reply.ok) throw new Error(`The scripted roll was refused: ${reply.text}`);
    }
    for (const [tool, calls] of [["attack", turn.attacks], ["dealDamage", turn.damage], ["heal", turn.heals]] as const) {
      for (const call of calls ?? []) {
        ctx.signal.throwIfAborted();
        const reply = await ctx.tools[tool](call);
        if (!reply.ok) throw new Error(`The scripted ${tool} was refused: ${reply.text}`);
      }
    }
    ctx.onEvent({ type: "done", sessionId: "scripted", costUsd: 0, stopReason: "end_turn" });
  }
}

/** A short demo for trying the table: one opening scene with a roll, then replies that echo what the table did. */
export function demoScript(party: readonly PartyMember[]): Script {
  const first = party[0];
  return (input) => {
    if (input.kind === "open" && first) {
      return {
        say: [
          "Rain hammers the neon outside a Redmond noodle shop. Your fixer's contact, a nervous man in a Mitsuhama jacket, slides a credstick across the table. One night, one data courier to lift out of a Renraku annex.",
          `The annex lobby is quiet. A bored guard watches a trideo by the door, and ${first.name} has to get past him.`,
        ],
        rolls: [
          {
            characterId: first.id,
            label: "Slip past the lobby guard",
            pool: { total: 8, breakdown: "Agility + Sneaking (demo pool)" },
            opposed: { by: "Lobby guard (Perception)", pool: 5, role: "acting" },
            stakes: "Reach the stairwell unseen, or the guard calls it in and the annex locks down.",
            goodRoll: "More hits than the guard.",
            badRoll: "The guard matches your hits, or you glitch.",
            consequences: {
              success: "You slip into the stairwell unnoticed.",
              failure: "The guard spots you and reaches for his radio.",
              glitch: "A loose tile clicks underfoot, and the guard half turns.",
              criticalGlitch: "You knock over a planter. The guard shouts and the alarm trips.",
            },
            edgeAdvice: "Hold your Edge for a reroll; there will be worse moments tonight.",
          },
        ],
      };
    }
    if (input.text.includes("ROLL RESULT") && input.text.includes("FAILURE") && first) {
      return {
        say: ["The guard spins and swings his baton."],
        damage: [{ label: "The guard's baton", target: { kind: "pc", id: first.id }, damageValue: 5, damageType: "physical" }],
      };
    }
    if (input.text.includes("DAMAGE RESULT")) return { say: ["The guard shouts for backup. What do you do?"] };
    if (input.text.includes("ROLL RESULT")) return { say: ["The demo GM nods and waits to see what you do next."] };
    return { say: [`The demo GM heard you. (${input.text.split("\n").slice(-1)[0]})`] };
  };
}
