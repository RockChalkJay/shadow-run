import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AttackInput, DealDamageInput, HealInput, NpcRollInput, RollRequestInput } from "@shadow-run/shared";
import type { ToolReply } from "./driver.js";

/** Name the GM process knows this server by; its tools appear as `mcp__gm__<tool>`. */
export const GM_MCP_NAME = "gm";

/** The tool names as the GM process calls them, for `--allowedTools`. */
export const GM_TOOL_NAMES = ["request_roll", "roll_npc", "attack", "deal_damage", "heal"].map((name) => `mcp__${GM_MCP_NAME}__${name}`);

export interface GmToolHandlers {
  requestRoll(input: unknown): Promise<ToolReply>;
  rollNpc(input: unknown): Promise<ToolReply>;
  attack(input: unknown): Promise<ToolReply>;
  dealDamage(input: unknown): Promise<ToolReply>;
  heal(input: unknown): Promise<ToolReply>;
}

const asResult = (reply: ToolReply) => ({
  content: [{ type: "text" as const, text: reply.text }],
  isError: !reply.ok,
});

function buildServer(handlers: GmToolHandlers): McpServer {
  const server = new McpServer({ name: "shadow-run-gm", version: "0.2.0" });

  server.registerTool(
    "request_roll",
    {
      description:
        "Ask a player to roll dice for their character. Use it whenever the outcome of an action is uncertain " +
        "and matters. Fill in everything: the dice pool and how you built it from the character's sheet; " +
        "either a threshold, or an opposing pool that the system rolls for you; what is at stake; what a good " +
        "and a bad roll look like; and what happens on a success, a failure, a glitch and a critical glitch. " +
        "Those consequences are binding: the system tells you which applies and you must carry it out. " +
        "After calling it, stop and wait. The players roll and the result comes back as your next message, " +
        "so never describe the outcome yourself. To heal someone, set `healing` (First Aid, a medkit, a healing " +
        "spell, or the patient's own natural recovery): the system sets the threshold from the patient's Essence, " +
        "so leave `threshold` out, and the result tells you how to spend the hits with the heal tool.",
      inputSchema: RollRequestInput.shape,
    },
    async (input) => asResult(await handlers.requestRoll(input)),
  );

  server.registerTool(
    "roll_npc",
    {
      description:
        "Roll dice for a non-player character when no player is rolling against them, for example an NPC " +
        "acting on their own or a guard noticing something unopposed. The system rolls and shows the table, " +
        "and you get the result straight away. Do not use it to oppose a player's roll; set `opposed` on " +
        "request_roll instead.",
      inputSchema: NpcRollInput.shape,
    },
    async (input) => asResult(await handlers.rollNpc(input)),
  );

  server.registerTool(
    "attack",
    {
      description:
        "Resolve one attack with a weapon: a gunshot, a sword swing, a punch. Use it for every attack in a fight, " +
        "in place of request_roll and deal_damage. Give the attacker's pool (weapon skill plus Agility) and the " +
        "defender's pool (Reaction plus Intuition), each with how you built it, and the weapon's base Damage Value. " +
        "The system rolls both sides, adds the attacker's net hits to the Damage Value, has the defender resist with " +
        "Body, and applies what gets through. You never decide whether it hits or how much damage lands. An attacker " +
        "with no hits misses. A player character's dice are rolled on the players' screen, so when the reply says a " +
        "roll is waiting, end your turn and wait; the full result comes back as your next message. When only " +
        "non-player characters are involved you get the result straight away. At least one side must be a non-player " +
        "character. The first time you name an NPC give their name, body and willpower. When a player character " +
        "rolls, also give edgeAdvice, as you would for request_roll. Do not narrate the result " +
        "until you have the report.",
      inputSchema: AttackInput.shape,
    },
    async (input) => asResult(await handlers.attack(input)),
  );

  server.registerTool(
    "deal_damage",
    {
      description:
        "Hurt a character: a hit that landed, a fall, fire, a hazard. Use it for every injury, and never decide " +
        "yourself how much damage lands. Give the Damage Value before the target resists; the target resists with " +
        "Body and the system applies what gets through. A player character rolls their own Body on the table's " +
        "screen, so end your turn and wait; an NPC's Body is rolled for you and you get the report straight away. " +
        "The first time you name an NPC give their name, body and willpower; after that the id is enough. " +
        "Do not narrate the wound until you have the report.",
      inputSchema: DealDamageInput.shape,
    },
    async (input) => asResult(await handlers.dealDamage(input)),
  );

  server.registerTool(
    "heal",
    {
      description:
        "Spend the hits of a healing roll to heal someone. Healing needs a roll: ask for it with request_roll and its " +
        "`healing` field, and when the result comes back it gives you the hits to spend and a roll id. Call heal with that " +
        "roll id, the track and the number of boxes; the patient is the one on the roll. First Aid heals 1 stun box per " +
        "hit or 1 physical or overflow box per 2 hits; a medkit and healing magic heal 1 box of any track per hit; natural " +
        "recovery heals 1 box of its own track per hit. A healer treating someone must heal overflow damage first. Hits you do not spend in the turn " +
        "you are told the result are lost, and a dead character cannot be healed.",
      inputSchema: HealInput.shape,
    },
    async (input) => asResult(await handlers.heal(input)),
  );

  return server;
}

export interface RunningMcpServer {
  url: string;
  /** Sent with every request; without them the server answers 401. */
  headers: Record<string, string>;
  close(): Promise<void>;
}

/**
 * Serves the GM's tools on a local port, guarded by a secret that only this process and the
 * GM it launches know, so other local processes and web pages can't invoke the tools.
 * Stateless: each request gets its own server instance.
 */
export async function startGmMcpServer(handlers: GmToolHandlers): Promise<RunningMcpServer> {
  const expected = Buffer.from(`Bearer ${randomBytes(24).toString("hex")}`);
  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const http = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
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
    headers: { Authorization: expected.toString() },
    close: () =>
      new Promise((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
        http.closeAllConnections();
      }),
  };
}
