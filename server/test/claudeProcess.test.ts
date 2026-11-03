import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GmEvent } from "@shadow-run/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildArgs, childEnv, runGmTurn, stopAllGmProcesses, type GmTurnOptions } from "../src/gm/claudeProcess.js";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const FAKE_CLAUDE = path("./fake-claude.mjs");
const TEXT_TURN = path("./fixtures/text-turn.jsonl");

const collect = async (opts: GmTurnOptions) => {
  const events: GmEvent[] = [];
  for await (const event of runGmTurn(opts)) events.push(event);
  return events;
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const exitsWithin = async (pid: number, ms: number) => {
  for (const end = Date.now() + ms; isAlive(pid) && Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
};

describe("buildArgs", () => {
  const base: GmTurnOptions = { prompt: "go", cwd: "/tmp" };

  it("disables every built-in tool by default", () => {
    const args = buildArgs(base);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("starts a new session unless asked to resume", () => {
    expect(buildArgs(base)).not.toContain("--resume");
    const args = buildArgs({ ...base, sessionId: "abc" });
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
  });

  it("wires up MCP servers exclusively and pre-approves the allowed tools", () => {
    const args = buildArgs({
      ...base,
      mcpServers: { gm: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      allowedTools: ["mcp__gm__request_roll", "WebSearch"],
    });
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
      mcpServers: { gm: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__gm__request_roll,WebSearch");
  });

  it("passes the system prompt, model and effort when given", () => {
    const args = buildArgs({ ...base, systemPrompt: "You are the GM.", model: "sonnet", effort: "high" });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are the GM.");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(buildArgs(base)).not.toContain("--effort");
  });

  it("sends the system prompt fresh every turn, so a resumed session does not keep the one it began with", () => {
    const inline = buildArgs({ ...base, systemPrompt: "You are the GM." });
    expect(inline[inline.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
    const file = buildArgs({ ...base, systemPromptFile: "/work/system-prompt.md" });
    expect(file[file.indexOf("--system-prompt-file") + 1]).toBe("/work/system-prompt.md");
    expect(file[file.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
    expect(file).not.toContain("--system-prompt");
  });

  it("can take the system prompt and the tools configuration as files, keeping both off the command line", () => {
    const args = buildArgs({
      ...base,
      systemPromptFile: "/work/system-prompt.md",
      mcpConfigFile: "/work/mcp.json",
      mcpServers: { gm: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer secret" } } },
    });
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/work/mcp.json");
    expect(args.join(" ")).not.toContain("secret");
    expect(args).toContain("--strict-mcp-config");
  });

  it("loads no settings files, so nothing configured on the machine reaches the GM", () => {
    const args = buildArgs(base);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
  });
});

describe("childEnv", () => {
  it("drops credentials and provider switches, and turns off CLAUDE.md files", () => {
    const env = childEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1", PATH: "/bin", USER: "me", LOGNAME: "me", HOME: "/home/me" });
    expect(env).toMatchObject({ PATH: "/bin", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_BEDROCK");
  });

  it("supplies the user and home the CLI needs to find the login when the server was started without them", () => {
    const env = childEnv({ PATH: "/bin" });
    expect(env.USER).toBeTruthy();
    expect(env.LOGNAME).toBeTruthy();
    expect(env.HOME).toBeTruthy();
  });

  it("leaves a user and home that are already set alone", () => {
    expect(childEnv({ USER: "someone", LOGNAME: "someone", HOME: "/elsewhere" })).toMatchObject({ USER: "someone", HOME: "/elsewhere" });
  });
});

describe("runGmTurn", () => {
  let dir: string;
  let capturePath: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sr-test-"));
    capturePath = join(dir, "capture.json");
    process.env.FAKE_CLAUDE_CAPTURE = capturePath;
    process.env.FAKE_CLAUDE_FIXTURE = TEXT_TURN;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  const turn = (extra: Partial<GmTurnOptions> = {}) =>
    collect({ prompt: "Kira sneaks in.", cwd: dir, claudeBin: FAKE_CLAUDE, ...extra });

  it("streams a recorded turn and finishes with done", async () => {
    const events = await turn();
    expect(events.map((e) => e.type)).toEqual(["session", "text_block_start", "text", "rate_limit", "done"]);
  });

  it("sends the prompt over stdin", async () => {
    await turn();
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    expect(captured.stdin).toBe("Kira sneaks in.");
    expect(captured.args).toContain("-p");
  });

  it("keeps credentials and provider switches away from the child so the login is used", async () => {
    const overrides = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ];
    for (const name of overrides) process.env[name] = "1";
    process.env.ANTHROPIC_BASE_URL = "http://gateway.test";
    await turn();
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    for (const name of overrides) expect(captured.envKeys).not.toContain(name);
    expect(captured.envKeys).toContain("ANTHROPIC_BASE_URL");
  });

  it("kills the process when the caller stops iterating early", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    for await (const _event of runGmTurn({ prompt: "go", cwd: dir, claudeBin: FAKE_CLAUDE })) break;
    const { pid } = JSON.parse(await readFile(capturePath, "utf8"));
    expect(await exitsWithin(pid, 3000)).toBe(true);
  });

  it("stops everything the process started, not just the process", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    process.env.FAKE_CLAUDE_FORK = "1";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    await turn({ signal: controller.signal });
    const { pid, grandchildPid } = JSON.parse(await readFile(capturePath, "utf8"));
    expect(grandchildPid).toBeGreaterThan(0);
    expect(await exitsWithin(pid, 3000)).toBe(true);
    expect(await exitsWithin(grandchildPid, 3000)).toBe(true);
  });

  it("stops every running GM process on request", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    const running = (async () => {
      for await (const _event of runGmTurn({ prompt: "go", cwd: dir, claudeBin: FAKE_CLAUDE })) {
        // Drain.
      }
    })();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(capturePath, "utf8")).pid).toBeGreaterThan(0));
    const { pid } = JSON.parse(await readFile(capturePath, "utf8"));
    stopAllGmProcesses();
    expect(await exitsWithin(pid, 3000)).toBe(true);
    await running;
  });

  it("stops the GM process when the server exits without any cleanup, as in a crash", async () => {
    process.env.FAKE_CLAUDE_HANG = "1";
    process.env.CRASH_BIN = FAKE_CLAUDE;
    const helper = path("./helpers/crash.ts");
    const result = spawnSync("npx", ["tsx", helper], { env: process.env, encoding: "utf8", timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const { pid } = JSON.parse(await readFile(capturePath, "utf8"));
    expect(await exitsWithin(pid, 3000)).toBe(true);
  });

  it("does not start the process when the signal is already aborted", async () => {
    const events = await turn({ signal: AbortSignal.abort() });
    expect(events).toEqual([{ type: "error", message: "The GM turn was cancelled." }]);
    await expect(readFile(capturePath, "utf8")).rejects.toThrow();
  });

  it("leaves no abort listener behind once the turn is over", async () => {
    const controller = new AbortController();
    await turn({ signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("reports an error when claude cannot be started", async () => {
    const events = await turn({ claudeBin: join(dir, "does-not-exist") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("Could not start claude");
  });

  it("reports the exit code and stderr when claude dies without a result", async () => {
    delete process.env.FAKE_CLAUDE_FIXTURE;
    process.env.FAKE_CLAUDE_EXIT = "3";
    process.env.FAKE_CLAUDE_STDERR = "Not logged in";
    const events = await turn();
    expect(events).toEqual([
      { type: "error", message: "claude exited with code 3 before finishing the turn. Not logged in" },
    ]);
  });

  it("adds what the CLI said on stderr to a failed turn, which is where it explains itself", async () => {
    process.env.FAKE_CLAUDE_FIXTURE = path("./fixtures/lost-session.jsonl");
    process.env.FAKE_CLAUDE_EXIT = "1";
    process.env.FAKE_CLAUDE_STDERR = "No conversation found with session ID: 0000\n";
    const events = await turn({ sessionId: "0000" });
    expect(events).toEqual([
      {
        type: "error",
        message: "claude ended the turn with an error: error_during_execution: No conversation found with session ID: 0000",
      },
    ]);
  });

  it("stops the process and reports a cancellation when aborted", async () => {
    delete process.env.FAKE_CLAUDE_FIXTURE;
    process.env.FAKE_CLAUDE_HANG = "1";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const events = await turn({ signal: controller.signal });
    expect(events).toEqual([{ type: "error", message: "The GM turn was cancelled." }]);
  });
});
