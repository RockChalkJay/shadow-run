import type { GmEvent } from "@shadow-run/shared";

export interface ToolReply {
  ok: boolean;
  /** Text handed back to the GM as the tool's result. */
  text: string;
}

/** What the GM may do during a turn. Everything it does that touches dice goes through here. */
export interface GmTools {
  requestRoll(input: unknown): Promise<ToolReply>;
  rollNpc(input: unknown): Promise<ToolReply>;
  /** Hurts someone. The target resists, and the system applies what gets through. */
  dealDamage(input: unknown): Promise<ToolReply>;
  /** One attack: the system rolls both sides, adds the net hits to the weapon's Damage Value, and hurts the defender. */
  attack(input: unknown): Promise<ToolReply>;
  /** Begins a fight: the system rolls initiative for everyone named and keeps the order. */
  startCombat(input: unknown): Promise<ToolReply>;
  /** Adds people to a fight already under way. */
  joinCombat(input: unknown): Promise<ToolReply>;
  /** Moves the fight on to the next round; the order stands. */
  nextRound(): Promise<ToolReply>;
  endCombat(): Promise<ToolReply>;
  heal(input: unknown): Promise<ToolReply>;
}

export interface GmTurnInput {
  /** `open` for the first turn of a session, `continue` after that. */
  kind: "open" | "continue";
  /** What happened at the table since the GM last spoke: what players said, how rolls came out. */
  text: string;
}

export interface GmTurnContext {
  turnId: number;
  /** The GM's own session from earlier turns, if there is one to pick up. */
  resumeId?: string;
  /** The conversation so far as plain text, for a GM that has to start a session over. */
  recap(): string;
  /** Aborted when the turn is cancelled or runs too long. */
  signal: AbortSignal;
  onEvent(event: GmEvent): void;
  tools: GmTools;
}

/** Whatever plays the GM: the Claude CLI in play, a script in tests and demos. */
export interface GmDriver {
  /** Runs one turn. Resolves when it ends cleanly; rejects if it fails or is aborted. */
  takeTurn(input: GmTurnInput, ctx: GmTurnContext): Promise<void>;
  /** Releases anything the driver holds, such as a local server. */
  close?(): Promise<void>;
}
