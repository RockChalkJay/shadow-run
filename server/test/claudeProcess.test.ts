import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GmEvent } from "@shadow-run/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArgs, runGmTurn, type GmTurnOptions } from "../src/gm/claudeProcess.js";

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const FAKE_CLAUDE = path("./fake-claude.mjs");
const TEXT_TURN = path("./fixtures/text-turn.jsonl");

const collect = async (opts: GmTurnOptions) => {
  const events: GmEvent[] = [];
  for await (const event of runGmTurn(opts)) events.push(event);
  return events;
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

  it("passes the system prompt and model when given", () => {
    const args = buildArgs({ ...base, systemPrompt: "You are the GM.", model: "sonnet" });
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are the GM.");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
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
    expect(events.map((e) => e.type)).toEqual(["session", "text", "rate_limit", "done"]);
  });

  it("sends the prompt over stdin", async () => {
    await turn();
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    expect(captured.stdin).toBe("Kira sneaks in.");
    expect(captured.args).toContain("-p");
  });

  it("keeps ANTHROPIC_API_KEY away from the child so the login is used", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    await turn();
    const captured = JSON.parse(await readFile(capturePath, "utf8"));
    expect(captured.apiKeyPresent).toBe(false);
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

  it("stops the process and reports a cancellation when aborted", async () => {
    delete process.env.FAKE_CLAUDE_FIXTURE;
    process.env.FAKE_CLAUDE_HANG = "1";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const events = await turn({ signal: controller.signal });
    expect(events).toEqual([{ type: "error", message: "The GM turn was cancelled." }]);
  });
});
