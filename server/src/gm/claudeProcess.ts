import { spawn, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import type { GmEvent } from "@shadow-run/shared";
import { parseStreamLine } from "./streamParser.js";

export interface GmTurnOptions {
  prompt: string;
  /**
   * Directory the process runs in. It keeps a project CLAUDE.md and settings out of the GM,
   * but not the account context Claude Code adds itself, such as the user's email.
   */
  cwd: string;
  /** Resume this session; omit to start a new one. */
  sessionId?: string;
  /** The system prompt, as text. Prefer `systemPromptFile`: arguments are size-limited and visible to other processes. */
  systemPrompt?: string;
  /** A file holding the system prompt. */
  systemPromptFile?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Built-in tools to expose. Empty means none. */
  tools?: string[];
  /** Tools that run without a permission prompt, e.g. `mcp__gm__request_roll`. */
  allowedTools?: string[];
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
  /** A file holding the MCP configuration, which keeps a tools secret out of the process list. */
  mcpConfigFile?: string;
  claudeBin?: string;
  signal?: AbortSignal;
}

// Variables that would send a GM turn somewhere other than the user's Claude login.
const AUTH_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

const CANCELLED: GmEvent = { type: "error", message: "The GM turn was cancelled." };

export function buildArgs(opts: GmTurnOptions): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--tools", (opts.tools ?? []).join(","),
  ];
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.mcpConfigFile) {
    args.push("--strict-mcp-config", "--mcp-config", opts.mcpConfigFile);
  } else if (opts.mcpServers) {
    args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers }));
  }
  // A resumed session would otherwise keep the prompt it began with, ignoring later edits to the party, premise or prompt.
  if (opts.systemPromptFile) args.push("--system-prompt-file", opts.systemPromptFile, "--system-prompt-snapshot", "off");
  else if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt, "--system-prompt-snapshot", "off");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  return args;
}

/** The environment a GM process gets: ours, minus anything that would bill somewhere else, plus what the CLI needs to find the login. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" };
  for (const name of AUTH_OVERRIDES) delete env[name];
  // The CLI finds a subscription login by user name; a server started from an IDE or a service manager often has none set.
  const user = userInfo();
  env.USER ??= user.username;
  env.LOGNAME ??= user.username;
  env.HOME ??= user.homedir;
  return env;
}

/** Every GM process that is running, so none outlives the server. */
const live = new Set<ChildProcess>();

/**
 * Stops the process and anything it started. It runs as the leader of its own process group, so one
 * signal reaches them all. `hard` skips the grace period, for when the server itself is going away.
 */
function killTree(child: ChildProcess, hard = false): void {
  const { pid } = child;
  if (pid === undefined) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-pid, sig);
    } catch {
      // Already gone.
    }
  };
  if (hard) return signal("SIGKILL");
  signal("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
  }, 3000).unref();
}

/**
 * Stops every GM process still running. The processes lead their own groups, so they do not get the
 * terminal's Ctrl-C with the server, and without this a server that crashed would leave a turn
 * running and spending plan usage.
 */
export function stopAllGmProcesses(): void {
  for (const child of live) killTree(child, true);
}
process.once("exit", stopAllGmProcesses);

/**
 * Runs one GM turn as a `claude -p` process and streams its events. Always ends with
 * exactly one `done` or `error` event, unless the caller stops iterating first, in which
 * case the process is killed.
 */
export async function* runGmTurn(opts: GmTurnOptions): AsyncGenerator<GmEvent> {
  if (opts.signal?.aborted) {
    yield CANCELLED;
    return;
  }

  const child = spawn(opts.claudeBin ?? "claude", buildArgs(opts), {
    cwd: opts.cwd,
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  live.add(child);
  child.once("close", () => live.delete(child));

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exit = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once("error", (spawnError) => resolve({ code: null, spawnError }));
    child.once("close", (code) => resolve({ code }));
  });
  const onAbort = () => killTree(child);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // The prompt goes over stdin: the variadic flags would otherwise swallow a trailing argument.
  child.stdin.on("error", () => {});
  child.stdin.end(opts.prompt);

  try {
    let finished = false;
    // A failed turn's error is held back until the process has exited, because the CLI says why on stderr.
    let failed: Extract<GmEvent, { type: "error" }> | undefined;
    for await (const line of createInterface({ input: child.stdout })) {
      for (const event of parseStreamLine(line)) {
        if (event.type === "error") {
          failed = event;
          finished = true;
        } else {
          if (event.type === "done") finished = true;
          yield event;
        }
      }
    }

    const { code, spawnError } = await exit;
    if (failed) {
      const why = stderr.trim();
      yield { type: "error", message: why ? `${failed.message}: ${why}` : failed.message };
    } else if (finished) {
      return;
    } else if (opts.signal?.aborted) {
      yield CANCELLED;
    } else if (spawnError) {
      yield { type: "error", message: `Could not start claude: ${spawnError.message}` };
    } else {
      yield {
        type: "error",
        message: `claude exited with code ${code} before finishing the turn. ${stderr.trim()}`.trim(),
      };
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    // A caller that stops iterating early must not leave the turn running and spending usage.
    if (child.exitCode === null && child.signalCode === null) killTree(child);
  }
}
