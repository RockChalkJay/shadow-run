import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RollRequestInput, type RollRequest } from "@shadow-run/shared";

/** Name the GM process knows this server by; its tools appear as `mcp__gm__<tool>`. */
export const GM_MCP_NAME = "gm";

export interface GmToolHandlers {
  onRollRequest(request: RollRequest): void;
}

function buildServer(handlers: GmToolHandlers): McpServer {
  const server = new McpServer({ name: "shadow-run-gm", version: "0.1.0" });

  server.registerTool(
    "request_roll",
    {
      description:
        "Ask a player to roll dice. Use it for every roll the players make. Fill in the stakes, " +
        "what a good and a bad roll look like, and the consequence of each outcome, so the " +
        "players can decide how to spend Edge. After calling it, stop and wait: the players roll " +
        "and the result arrives as the next message. Do not narrate the outcome.",
      inputSchema: RollRequestInput.shape,
    },
    async (input) => {
      handlers.onRollRequest({ id: randomUUID(), ...input });
      return {
        content: [
          {
            type: "text",
            text: "The roll card is on the players' screen. End your turn now and wait for the result.",
          },
        ],
      };
    },
  );

  return server;
}

export interface RunningMcpServer {
  url: string;
  close(): Promise<void>;
}

/** Serves the GM's tools on a local port. Stateless: each request gets its own server instance. */
export async function startGmMcpServer(handlers: GmToolHandlers): Promise<RunningMcpServer> {
  const http = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405).end();
      return;
    }
    const server = buildServer(handlers);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
        http.closeAllConnections();
      }),
  };
}
