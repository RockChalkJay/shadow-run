#!/usr/bin/env node
// Stand-in for `claude -p` that plays a scripted GM, for tests that exercise the whole path: it reads the
// --mcp-config it is given, calls the tools over HTTP with the secret, and prints stream-json as the CLI does.
//
//   FAKE_GM_SCRIPT  path to a JSON array with one entry per invocation:
//                   { sessionId?, lostSession?, steps: [ {say}, {tool, args}, {hang} ] }
//   FAKE_GM_LOG     path of a JSON-lines file recording each invocation and each tool result
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const { FAKE_GM_SCRIPT, FAKE_GM_LOG } = process.env;
const log = (record) => appendFileSync(FAKE_GM_LOG, `${JSON.stringify(record)}\n`);
const previous = existsSync(FAKE_GM_LOG) ? readFileSync(FAKE_GM_LOG, "utf8").split("\n").filter((l) => l.includes('"kind":"start"')).length : 0;
const call = previous + 1;
const script = JSON.parse(readFileSync(FAKE_GM_SCRIPT, "utf8"));
const turn = script[call - 1] ?? { steps: [] };

const resume = after("--resume");
const systemPromptFile = after("--system-prompt-file");
const mcpArg = after("--mcp-config") ?? "{}";
const mcpText = mcpArg.trimStart().startsWith("{") ? mcpArg : readFileSync(mcpArg, "utf8");
log({
  kind: "start",
  call,
  pid: process.pid,
  resume,
  stdin,
  cwd: process.cwd(),
  model: after("--model"),
  argv,
  systemPrompt: systemPromptFile ? readFileSync(systemPromptFile, "utf8") : after("--system-prompt"),
  systemPromptFile,
  snapshot: after("--system-prompt-snapshot"),
  mcpConfigArg: mcpArg,
  allowedTools: after("--allowedTools"),
  settingSources: after("--setting-sources"),
});

const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const sessionId = turn.sessionId ?? resume ?? `fake-session-${call}`;

if (turn.lostSession && resume) {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: null, session_id: resume });
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

out({ type: "system", subtype: "init", session_id: sessionId });

const config = JSON.parse(mcpText).mcpServers?.gm;
let client;
async function tools() {
  if (!client) {
    client = new Client({ name: "fake-claude", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  }
  return client;
}

for (const step of turn.steps) {
  if (step.say !== undefined) {
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    for (const word of step.say.match(/\S+\s*/g) ?? []) {
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } } });
    }
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: step.say }] } });
  } else if (step.tool) {
    const name = `mcp__gm__${step.tool}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${call}`, name, input: step.args }] } });
    const result = await (await tools()).callTool({ name: step.tool, arguments: step.args });
    log({ kind: "tool", call, tool: step.tool, isError: result.isError === true, text: result.content?.map((c) => c.text).join("") });
  } else if (step.hang) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
}

await client?.close();
out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, stop_reason: "end_turn", total_cost_usd: 0 });
