// Proves the GM loop against the real `claude` CLI: streaming text, a custom MCP tool call
// (`request_roll`), and resuming the same session for a second turn.
//
//   npm run spike:gm            run against the real CLI (uses a little of your Claude quota)
//   SPIKE_SAVE=dir npm run ...  also write each turn's raw events to dir/turn-N.json

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GmEvent, RollRequest } from "@shadow-run/shared";
import { runGmTurn, type GmTurnOptions } from "../src/gm/claudeProcess.js";
import { GM_MCP_NAME, startGmMcpServer } from "../src/gm/mcpServer.js";

const SYSTEM_PROMPT =
  "You are the Game Master of a Shadowrun 6th Edition session. Keep narration to two sentences. " +
  "When a player attempts something risky, call the request_roll tool instead of deciding the outcome.";

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

async function playTurn(
  label: string,
  prompt: string,
  base: Omit<GmTurnOptions, "prompt">,
  saveDir?: string,
): Promise<GmEvent[]> {
  console.log(`\n=== ${label} ===`);
  const events: GmEvent[] = [];
  for await (const event of runGmTurn({ ...base, prompt })) {
    events.push(event);
    if (event.type === "text") process.stdout.write(event.text);
    else if (event.type === "tool_use") console.log(`\n[tool_use] ${event.name}`);
    else if (event.type === "rate_limit") {
      console.log(`\n[usage] five-hour window ${(event.fiveHourUtilization * 100).toFixed(0)}% used`);
    } else if (event.type === "done") console.log(`\n[done] cost $${event.costUsd.toFixed(4)}`);
    else if (event.type === "error") console.log(`\n[error] ${event.message}`);
  }
  if (saveDir) await writeFile(join(saveDir, `${label}.json`), JSON.stringify(events, null, 2));
  return events;
}

async function main() {
  const rolls: RollRequest[] = [];
  const mcp = await startGmMcpServer({ onRollRequest: (r) => rolls.push(r) });
  const cwd = await mkdtemp(join(tmpdir(), "shadow-run-gm-"));
  const saveDir = process.env.SPIKE_SAVE;
  if (saveDir) await mkdir(saveDir, { recursive: true });

  const base = {
    cwd,
    model: "sonnet",
    systemPrompt: SYSTEM_PROMPT,
    tools: [],
    mcpServers: { [GM_MCP_NAME]: { type: "http" as const, url: mcp.url } },
    allowedTools: [`mcp__${GM_MCP_NAME}__request_roll`],
  };

  try {
    const turn1 = await playTurn(
      "turn-1",
      "Kira (id: kira, Agility 5, Sneaking 4, so a pool of 9) tries to slip past a bored Lone Star " +
        "guard to reach a server room door. Call request_roll for her.",
      base,
      saveDir,
    );
    const session = turn1.find((e) => e.type === "session");
    const sessionId = session?.type === "session" ? session.sessionId : undefined;

    check("turn 1 reports a session id", !!sessionId);
    check("turn 1 streams narration text", turn1.some((e) => e.type === "text"));
    check(
      "turn 1 calls request_roll",
      turn1.some((e) => e.type === "tool_use" && e.name === `mcp__${GM_MCP_NAME}__request_roll`),
    );
    check("MCP server received a valid roll request", rolls.length === 1, `got ${rolls.length}`);
    check("roll request carries the stakes text", !!rolls[0]?.stakes && !!rolls[0]?.consequences.glitch);
    check("turn 1 finishes cleanly", turn1.at(-1)?.type === "done", turn1.at(-1)?.type);

    if (sessionId) {
      const turn2 = await playTurn(
        "turn-2",
        "Result: Kira rolled 4 hits against the guard's 2. Narrate what happens in one sentence.",
        { ...base, sessionId },
        saveDir,
      );
      const resumed = turn2.find((e) => e.type === "session");
      check("turn 2 resumes the same session", resumed?.type === "session" && resumed.sessionId === sessionId);
      check("turn 2 finishes cleanly", turn2.at(-1)?.type === "done", turn2.at(-1)?.type);
      check("turn 2 does not ask for another roll", rolls.length === 1, `got ${rolls.length}`);
    }
  } finally {
    await mcp.close();
  }

  console.log("\n=== checks ===");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (rolls[0]) console.log("\nroll request received:\n" + JSON.stringify(rolls[0], null, 2));
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

await main();
