import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolReply } from "../src/gm/driver.js";
import { GM_TOOL_NAMES, startGmMcpServer, type RunningMcpServer } from "../src/gm/mcpServer.js";
import { rollInput } from "./helpers.js";

describe("GM MCP server", () => {
  let server: RunningMcpServer;
  let client: Client;
  let calls: Array<{ tool: string; input: unknown }>;
  let reply: ToolReply;

  beforeEach(async () => {
    calls = [];
    reply = { ok: true, text: "Done." };
    server = await startGmMcpServer({
      requestRoll: async (input) => (calls.push({ tool: "request_roll", input }), reply),
      rollNpc: async (input) => (calls.push({ tool: "roll_npc", input }), reply),
    });
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }),
    );
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("turns away requests that lack the secret", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer not-the-secret" })).status).toBe(401);
    expect((await post(server.headers)).status).toBe(200);
  });

  it("offers exactly the tools the GM process is allowed to use", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => `mcp__gm__${t.name}`).sort()).toEqual([...GM_TOOL_NAMES].sort());
  });

  it("tells the GM the consequences are binding and that it must wait for the result", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "request_roll")?.description ?? "";
    expect(description).toMatch(/binding/);
    expect(description).toMatch(/stop and wait/);
  });

  it("hands a roll request to the session and returns its words to the GM", async () => {
    reply = { ok: true, text: "The roll card is on the table's screen." };
    const result = await client.callTool({ name: "request_roll", arguments: rollInput() });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("The roll card is on the table's screen.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({ characterId: "kira", pool: { total: 4 } });
  });

  it("fills in the opposed role when the GM leaves it out", async () => {
    const { threshold: _drop, ...rest } = rollInput();
    await client.callTool({ name: "request_roll", arguments: { ...rest, opposed: { by: "Guard", pool: 5 } } });
    expect(calls[0]?.input).toMatchObject({ opposed: { by: "Guard", pool: 5, role: "acting" } });
  });

  it("marks a refusal as an error so the GM can correct itself", async () => {
    reply = { ok: false, text: 'There is no character "nobody" at the table.' };
    const result = await client.callTool({ name: "request_roll", arguments: rollInput({ characterId: "nobody" }) });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("There is no character");
  });

  it("rejects a roll with no dice before it reaches the session", async () => {
    const bad = { ...rollInput(), pool: { total: 0, breakdown: "nothing" } };
    const outcome = await client.callTool({ name: "request_roll", arguments: bad }).catch((e) => e);
    expect(outcome instanceof Error || outcome.isError === true).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes an NPC roll to the session", async () => {
    reply = { ok: true, text: "NPC ROLL. x: 4 dice: 6 5 2 1 = 2 hits." };
    const result = await client.callTool({ name: "roll_npc", arguments: { label: "Ganger", pool: 4, threshold: 2 } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ tool: "roll_npc", input: { label: "Ganger", pool: 4, threshold: 2 } }]);
  });

  it("rejects an NPC roll with an impossible pool", async () => {
    const outcome = await client.callTool({ name: "roll_npc", arguments: { label: "x", pool: 101 } }).catch((e) => e);
    expect(outcome instanceof Error || outcome.isError === true).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
