import { spawn } from "node:child_process";
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
  systemPrompt?: string;
  model?: string;
  /** Built-in tools to expose. Empty means none. */
  tools?: string[];
  /** Tools that run without a permission prompt, e.g. `mcp__gm__request_roll`. */
  allowedTools?: string[];
  mcpServers?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
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
    "--setting-sources", "project",
    "--disable-slash-commands",
    "--tools", (opts.tools ?? []).join(","),
  ];
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.mcpServers) {
    args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers }));
  }
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  return args;
}

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

  const env = { ...process.env };
  for (const name of AUTH_OVERRIDES) delete env[name];

  const child = spawn(opts.claudeBin ?? "claude", buildArgs(opts), {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exit = new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once("error", (spawnError) => resolve({ code: null, spawnError }));
    child.once("close", (code) => resolve({ code }));
  });
  const onAbort = () => child.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  // The prompt goes over stdin: the variadic flags would otherwise swallow a trailing argument.
  child.stdin.on("error", () => {});
  child.stdin.end(opts.prompt);

  try {
    let finished = false;
    for await (const line of createInterface({ input: child.stdout })) {
      for (const event of parseStreamLine(line)) {
        if (event.type === "done" || event.type === "error") finished = true;
        yield event;
      }
    }

    const { code, spawnError } = await exit;
    if (finished) return;
    if (opts.signal?.aborted) {
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
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
