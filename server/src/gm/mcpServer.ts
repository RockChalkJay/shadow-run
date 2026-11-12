import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AttackInput, AwardEdgeInput, DealDamageInput, HealInput, EndSessionInput, JoinCombatInput, NoteNpcInput, NoteThreadInput, NpcRollInput, RecallInput, RollRequestInput, StartCombatInput } from "@shadow-run/shared";
import type { ToolReply } from "./driver.js";

/** Name the GM process knows this server by; its tools appear as `mcp__gm__<tool>`. */
export const GM_MCP_NAME = "gm";

/** The tool names as the GM process calls them, for `--allowedTools`. */
export const GM_TOOL_NAMES = ["request_roll", "roll_npc", "attack", "deal_damage", "heal", "award_edge", "start_combat", "join_combat", "next_round", "end_combat", "note_npc", "note_thread", "recall", "end_session"].map((name) => `mcp__${GM_MCP_NAME}__${name}`);

export interface GmToolHandlers {
  requestRoll(input: unknown): Promise<ToolReply>;
  rollNpc(input: unknown): Promise<ToolReply>;
  attack(input: unknown): Promise<ToolReply>;
  awardEdge(input: unknown): Promise<ToolReply>;
  startCombat(input: unknown): Promise<ToolReply>;
  joinCombat(input: unknown): Promise<ToolReply>;
  nextRound(): Promise<ToolReply>;
  endCombat(): Promise<ToolReply>;
  dealDamage(input: unknown): Promise<ToolReply>;
  heal(input: unknown): Promise<ToolReply>;
  noteNpc(input: unknown): Promise<ToolReply>;
  noteThread(input: unknown): Promise<ToolReply>;
  recall(input: unknown): Promise<ToolReply>;
  endSession(input: unknown): Promise<ToolReply>;
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
        "so leave `threshold` out, and the result tells you how to spend the hits with the heal tool. When a player " +
        "declares an Edge Action that needs a roll other than an attack (Big Speech, Bring the Drama and the like), " +
        "set `edgeAction` to its id; the system charges the Edge when the roll counts, and carrying the action out is up to you.",
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
        "character. The first time you name an NPC give their name, body and willpower. Give the attacker's Attack Rating " +
        "and the defender's Defense Rating too: when they are four or more apart the system gives a player on the stronger side a point " +
        "of Edge before the dice are rolled. Grunts attacking together " +
        "attack as a group: name one as the attacker, give the highest pool among them, and list the rest in alongside. " +
        "When a player character " +
        "rolls, also give edgeAdvice, as you would for request_roll. When that player declares an Edge Action, set " +
        "`edgeAction` to its id: the system charges the Edge when their roll counts and applies Called Shot to the " +
        "damage itself. Do not narrate the result until you have the report.",
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
    "award_edge",
    {
      description:
        "Award a player character one point of Edge during a confrontation, for a brilliant, funny or decisive move, " +
        "or a clear advantage they have earned, and say why. The players read the reason. Use start_combat for any " +
        "confrontation (a fight, but also a hack or a social contest) so there is one to award it in. Never award Edge " +
        "for an action taken only to earn it, or outside a confrontation. The system enforces the book's limits: at most two " +
        "gained a round and seven in all. Edge from a gap between Attack Rating and Defense Rating is given by the " +
        "system on its own, so do not award that.",
      inputSchema: AwardEdgeInput.shape,
    },
    async (input) => asResult(await handlers.awardEdge(input)),
  );

  server.registerTool(
    "start_combat",
    {
      description:
        "Begin a fight. List everyone taking part and the system rolls initiative: Reaction + Intuition plus the " +
        "initiative dice. A player character's numbers come from their sheet, so give none; for a non-player " +
        "character give reaction, intuition and dice, and their name, body and willpower the first time. Grunts " +
        "with the same group label roll once and act together. You get the order, highest first, and everyone acts " +
        "once per round in it. Initiative is not rerolled between rounds. Never make up an order yourself.",
      inputSchema: StartCombatInput.shape,
    },
    async (input) => asResult(await handlers.startCombat(input)),
  );

  server.registerTool(
    "join_combat",
    {
      description:
        "Add people to a fight already under way, such as reinforcements. They roll initiative and take their place " +
        "by score; no one already in the order moves. Same participants as start_combat; grunts who join together " +
        "form a group of their own and never merge into one already in the order.",
      inputSchema: JoinCombatInput.shape,
    },
    async (input) => asResult(await handlers.joinCombat(input)),
  );

  server.registerTool(
    "next_round",
    {
      description:
        "Move the fight on to the next round once everyone in the order has acted. The order stands. Each turn you " +
        "are also told the round and the order, including who is down.",
      inputSchema: {},
    },
    async () => asResult(await handlers.nextRound()),
  );

  server.registerTool(
    "end_combat",
    {
      description: "End the fight when it is over, whether everyone on one side is down, has fled or has surrendered.",
      inputSchema: {},
    },
    async () => asResult(await handlers.endCombat()),
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

  server.registerTool(
    "note_npc",
    {
      description:
        "Write down a named non-player character in the campaign's notes, or update what is written, so they can come back in " +
        "a later scene or session as the same person. Use it when a named character first matters to the story (they speak " +
        "to the party, are hired, hunted or hurt) and whenever where they stand changes: their status (Alive, Dead, Burned, " +
        "Ally, Enemy or Unknown), who they work for, what they want. For anyone who may fight or roll, give stats such as " +
        "\"PR 3, Body 3, Willpower 4\" and use the same numbers whenever they return. Only what you give is changed. Do not " +
        "note nameless grunts. Never mention the notes to the players.",
      inputSchema: NoteNpcInput.shape,
    },
    async (input) => asResult(await handlers.noteNpc(input)),
  );

  server.registerTool(
    "note_thread",
    {
      description:
        "Write down a plot thread in the campaign's notes, or update it: a short title, where it stands (active, dormant, " +
        "resolved) and one or two sentences on what is going on. Use it when a thread opens, changes or ends, so a later " +
        "session can pick it up. The same title updates the same thread. Never mention the notes to the players.",
      inputSchema: NoteThreadInput.shape,
    },
    async (input) => asResult(await handlers.noteThread(input)),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Read the campaign's notes back before you bring someone or something back: `what` is npc (give their `name`), npcs " +
        "(everyone noted), threads, sessions (the last `last` entries of the session log, 1 to 5), or history (a player " +
        "character's earlier runs, newest first: give their `name` or id, and `last` up to 20, 5 by default). Use it instead of " +
        "guessing at what happened earlier, and keep what it says to yourself.",
      inputSchema: RecallInput.shape,
    },
    async (input) => asResult(await handlers.recall(input)),
  );

  server.registerTool(
    "end_session",
    {
      description:
        "Write up the session in the campaign's log. Use it only when the system tells you the table is wrapping up the " +
        "session, after a short closing beat, and call it once: a summary of what the characters did and learned, who they " +
        "met and what changed, the date in the story, the key rolls and how they came out, and what it cost or earned them " +
        "(karma, nuyen, gear, condition, notoriety). Update the notes with note_npc and note_thread first. Put what each " +
        "player character earned in `rewards`, one entry per character with their characterId: Karma (the core rules suggest 1 or 2 " +
        "for a session with little progress, 3 or 4 for a significant one, 5 or 6 for an excellent one or a finished run, more only " +
        "rarely), nuyen gained or spent (the book's unit is 5,000, a month of a Middle lifestyle: a simple night's work pays less, a " +
        "long dangerous run two or three months, a huge score six figures), gear gained or lost by name, contacts made or changed " +
        "(a new one needs Loyalty and Connection), and their own part in the run in `summary`, `goal` and `consequences`. Give only " +
        "what the story earned. The system adds the run to every character's history, saves the changes to their sheets, and refuses " +
        "the whole call, telling you why, if any part cannot be applied (one run is at most 30 Karma and 500,000 nuyen, and nuyen " +
        "cannot go below 0), so correct it and call again. The session is over once you have called it. Never mention the log or " +
        "the sheets to the players.",
      inputSchema: EndSessionInput.shape,
    },
    async (input) => asResult(await handlers.endSession(input)),
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
