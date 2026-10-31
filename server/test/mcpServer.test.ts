import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RollRequest, RollRequestInput } from "@shadow-run/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGmMcpServer, type RunningMcpServer } from "../src/gm/mcpServer.js";

const validRoll: RollRequestInput = {
  characterId: "kira",
  label: "Sneak past the guard",
  pool: { total: 9, breakdown: "Agility 5 + Sneaking 4" },
  stakes: "Reach the server room unseen, or the guard raises the alarm.",
  goodRoll: "Three or more hits.",
  badRoll: "Fewer hits than the guard.",
  consequences: {
    success: "Kira slips through.",
    failure: "The guard challenges her.",
    glitch: "A scuff makes him suspicious.",
    criticalGlitch: "The alarm goes off.",
  },
  edgeAdvice: "Hold Edge for a reroll.",
};

describe("GM MCP server", () => {
  let server: RunningMcpServer;
  let client: Client;
  let rolls: RollRequest[];

  beforeEach(async () => {
    rolls = [];
    server = await startGmMcpServer({ onRollRequest: (r) => rolls.push(r) });
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

  it("offers request_roll", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["request_roll"]);
  });

  it("hands a valid roll request to the app with a fresh id and tells the GM to wait", async () => {
    const result = await client.callTool({ name: "request_roll", arguments: validRoll });
    expect(result.isError).toBeFalsy();
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ ...validRoll, id: expect.any(String) });
    expect(JSON.stringify(result.content)).toContain("wait for the result");
  });

  it("rejects a roll with no dice and never shows it to the players", async () => {
    const bad = { ...validRoll, pool: { total: 0, breakdown: "nothing" } };
    const outcome = await client.callTool({ name: "request_roll", arguments: bad }).catch((e) => e);
    const failed = outcome instanceof Error || outcome.isError === true;
    expect(failed).toBe(true);
    expect(rolls).toHaveLength(0);
  });
});
