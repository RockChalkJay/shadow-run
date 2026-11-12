import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CharacterSheet } from "@shadow-run/shared";
import type { EdgeCatalog } from "../rules/index.js";
import { runGmTurn, type GmTurnOptions } from "./claudeProcess.js";
import type { GmDriver, GmTurnContext, GmTurnInput, ToolReply } from "./driver.js";
import { GM_MCP_NAME, GM_TOOL_NAMES, startGmMcpServer, type RunningMcpServer } from "./mcpServer.js";
import { privateDir, writePrivateFile } from "./privateDir.js";
import { buildSystemPrompt } from "./systemPrompt.js";

export interface ClaudeDriverOptions {
  party: readonly CharacterSheet[];
  premise?: string;
  edge?: EdgeCatalog;
  /** A model alias or name for the `claude` CLI. */
  model?: string;
  effort?: GmTurnOptions["effort"];
  claudeBin?: string;
  /** Where the GM process runs; made private to this user. */
  workDir?: string;
}

const NO_TURN: ToolReply = { ok: false, text: "No turn is in progress, so nothing was done. Do not call tools now." };

/** What the CLI says when asked to resume a session it no longer has. */
const LOST_SESSION = /no conversation found/i;

/** What a GM starting a conversation is told before the turn itself: what the campaign's notes hold, then the story so far. */
function startOverPrompt(brief: string, recap: string, text: string): string {
  return [
    brief,
    recap ? "Your memory of the earlier part of this session was lost, so the conversation so far is below, as the table saw it. Carry on from it and do not repeat it." : "",
    recap ? `--- The conversation so far ---\n${recap}\n--- End of the conversation so far ---` : "",
    text,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Plays the GM with the `claude` CLI on the owner's own login, one `claude -p` process per turn. */
export class ClaudeGmDriver implements GmDriver {
  private current: GmTurnContext | null = null;
  private party: readonly CharacterSheet[];

  private constructor(
    private readonly opts: ClaudeDriverOptions,
    private readonly mcp: RunningMcpServer,
    private readonly cwd: string,
    /** Where the system prompt and the tools configuration are kept, out of reach of other users and of the process list. */
    private readonly files: { systemPrompt: string; mcpConfig: string },
  ) {
    this.party = opts.party;
  }

  /** Rewrites the system prompt with the sheets as they are now; the next turn of any conversation is sent it. */
  async refreshParty(party: readonly CharacterSheet[]): Promise<void> {
    this.party = party;
    await writePrivateFile(this.files.systemPrompt, buildSystemPrompt({ ...this.opts, party }));
  }

  static async start(opts: ClaudeDriverOptions): Promise<ClaudeGmDriver> {
    const cwd = await privateDir(opts.workDir ?? join(tmpdir(), "shadow-run-gm"));
    // The tools server outlives any one turn, so it asks the driver which turn is current each time it is called.
    let driver: ClaudeGmDriver | undefined;
    const mcp = await startGmMcpServer({
      requestRoll: (input) => driver?.current?.tools.requestRoll(input) ?? Promise.resolve(NO_TURN),
      rollNpc: (input) => driver?.current?.tools.rollNpc(input) ?? Promise.resolve(NO_TURN),
      dealDamage: (input) => driver?.current?.tools.dealDamage(input) ?? Promise.resolve(NO_TURN),
      attack: (input) => driver?.current?.tools.attack(input) ?? Promise.resolve(NO_TURN),
      awardEdge: (input) => driver?.current?.tools.awardEdge(input) ?? Promise.resolve(NO_TURN),
      startCombat: (input) => driver?.current?.tools.startCombat(input) ?? Promise.resolve(NO_TURN),
      joinCombat: (input) => driver?.current?.tools.joinCombat(input) ?? Promise.resolve(NO_TURN),
      nextRound: () => driver?.current?.tools.nextRound() ?? Promise.resolve(NO_TURN),
      endCombat: () => driver?.current?.tools.endCombat() ?? Promise.resolve(NO_TURN),
      heal: (input) => driver?.current?.tools.heal(input) ?? Promise.resolve(NO_TURN),
      noteNpc: (input) => driver?.current?.tools.noteNpc(input) ?? Promise.resolve(NO_TURN),
      noteThread: (input) => driver?.current?.tools.noteThread(input) ?? Promise.resolve(NO_TURN),
      recall: (input) => driver?.current?.tools.recall(input) ?? Promise.resolve(NO_TURN),
      endSession: (input) => driver?.current?.tools.endSession(input) ?? Promise.resolve(NO_TURN),
    });
    const files = { systemPrompt: join(cwd, "system-prompt.md"), mcpConfig: join(cwd, "mcp.json") };
    await writePrivateFile(files.systemPrompt, buildSystemPrompt(opts));
    await writePrivateFile(files.mcpConfig, JSON.stringify({ mcpServers: { [GM_MCP_NAME]: { type: "http", url: mcp.url, headers: mcp.headers } } }));
    driver = new ClaudeGmDriver(opts, mcp, cwd, files);
    return driver;
  }

  async takeTurn(input: GmTurnInput, ctx: GmTurnContext): Promise<void> {
    this.current = ctx;
    try {
      // With no session to resume, such as a game started from a saved scenario, the GM is told what its notes hold and what has happened so far.
      const fresh = ctx.resumeId === undefined;
      const brief = fresh ? ((await ctx.brief?.()) ?? "") : "";
      const recap = fresh ? ctx.recap() : "";
      await this.attempt(brief || recap ? startOverPrompt(brief, recap, input.text) : input.text, ctx, ctx.resumeId);
    } finally {
      this.current = null;
    }
  }

  private async attempt(prompt: string, ctx: GmTurnContext, sessionId: string | undefined): Promise<void> {
    let sawSession = false;
    let produced = false;
    let failure: string | undefined;

    for await (const event of runGmTurn({
      prompt,
      cwd: this.cwd,
      ...(sessionId !== undefined && { sessionId }),
      systemPromptFile: this.files.systemPrompt,
      model: this.opts.model ?? "sonnet",
      ...(this.opts.effort && { effort: this.opts.effort }),
      tools: [],
      allowedTools: GM_TOOL_NAMES,
      mcpConfigFile: this.files.mcpConfig,
      ...(this.opts.claudeBin && { claudeBin: this.opts.claudeBin }),
      signal: ctx.signal,
    })) {
      if (event.type === "error") {
        failure = event.message;
        continue;
      }
      if (event.type === "session") sawSession = true;
      if (event.type === "text" || event.type === "tool_use") produced = true;
      ctx.onEvent(event);
    }

    if (failure !== undefined) {
      // A session the CLI no longer has is not the table's problem: start over from what was said.
      if (sessionId !== undefined && !sawSession && LOST_SESSION.test(failure) && !ctx.signal.aborted) {
        console.warn("The GM's earlier session is gone; starting a new one from the transcript.");
        return this.attempt(startOverPrompt((await ctx.brief?.()) ?? "", ctx.recap(), prompt), ctx, undefined);
      }
      throw new Error(failure);
    }
    if (!produced) throw new Error("The GM did not answer.");
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }
}
