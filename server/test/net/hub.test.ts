import { request } from "node:http";
import type { ClientMessage, ServerEvent } from "@shadow-run/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GameSession } from "../../src/game/session.js";
import { CampaignStore, type NewEntry } from "../../src/game/store.js";
import { ScriptedGmDriver, type ScriptedTurn } from "../../src/gm/scriptedDriver.js";
import { Hub } from "../../src/net/hub.js";
import { allowedOrigins } from "../../src/net/origin.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { party, rollInput, tempStore } from "../helpers.js";

class Client {
  readonly events: ServerEvent[] = [];
  private waiters: Array<() => void> = [];
  closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.events.push(JSON.parse(data.toString()) as ServerEvent);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  send(message: ClientMessage | string) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Resolves with the first event, now or later, that matches. */
  async until<T extends ServerEvent>(match: (e: ServerEvent) => e is T): Promise<T>;
  async until(match: (e: ServerEvent) => boolean): Promise<ServerEvent>;
  async until(match: (e: ServerEvent) => boolean): Promise<ServerEvent> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out. Saw: ${this.events.map((e) => e.type).join(", ")}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
}

const open: Array<{ close(): Promise<void> | void }> = [];
afterEach(async () => {
  for (const thing of open.splice(0)) await thing.close();
});

/** A store whose writes take a while, to leave time for things to happen in the middle of one. */
class SlowStore extends CampaignStore {
  override async appendEntry(entry: NewEntry) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return super.appendEntry(entry);
  }
}

async function startTable(script: ScriptedTurn[], faces: number[] = [], store?: CampaignStore) {
  const hub = new Hub({ port: 0, allowedOrigins: (p) => allowedOrigins(p, 5173) });
  const session = await GameSession.create({
    store: store ?? (await tempStore()),
    driver: new ScriptedGmDriver(script),
    party,
    emit: (event) => hub.broadcast(event),
    d6: scriptedD6(faces),
  });
  hub.attach(session);
  const port = await hub.listen();
  open.push(hub, session);
  return { hub, session, port };
}

async function connect(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const client = new Client(ws);
  open.push({ close: () => ws.terminate() });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  return client;
}

const isRoll = (e: ServerEvent): e is Extract<ServerEvent, { type: "roll.requested" }> => e.type === "roll.requested";

describe("connecting", () => {
  it("greets a client with the state of the game", async () => {
    const { port } = await startTable([]);
    const client = await connect(port);
    const snapshot = await client.until((e) => e.type === "snapshot");
    expect(snapshot).toMatchObject({ type: "snapshot", gm: { phase: "idle" }, pendingRolls: [], transcript: [] });
    expect((snapshot as { party: unknown[] }).party).toHaveLength(2);
  });

  it("accepts the web app's origin", async () => {
    const { port } = await startTable([]);
    const client = await connect(port, { Origin: "http://localhost:5173" });
    await client.until((e) => e.type === "snapshot");
  });

  it.each([
    ["a web page from another site", { Origin: "https://evil.example" }],
    ["a page on another local port", { Origin: "http://localhost:9999" }],
    ["a host that does not name this machine", { Host: "evil.example:1" }],
  ])("turns away %s", async (_name, headers) => {
    const { port } = await startTable([]);
    const hostHeaders = "Host" in headers ? { Host: `evil.example:${port}` } : headers;
    await expect(connect(port, hostHeaders)).rejects.toThrow("status 403");
  });

  it("answers the health check, and refuses a bad host or an unknown path", async () => {
    const { port } = await startTable([]);
    const get = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject).end();
      });
    expect(await get("/api/health")).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await get("/api/health", { Host: "evil.example" })).status).toBe(403);
    expect((await get("/anything")).status).toBe(404);
  });
});

describe("messages", () => {
  it("answers something that is not JSON, or not a message, with an error and stays connected", async () => {
    const { port } = await startTable([]);
    const client = await connect(port);
    client.send("{oops");
    client.send({ type: "player.say", text: "" } as ClientMessage);
    client.send({ type: "nope" } as unknown as ClientMessage);
    await client.until((e) => e.type === "error" && e.message.includes("not JSON"));
    expect(client.events.filter((e) => e.type === "error")).toHaveLength(3);
    client.send({ type: "session.start" });
    await client.until((e) => e.type === "gm.status");
  });

  it("closes a connection that sends an enormous message", async () => {
    const { port } = await startTable([]);
    const client = await connect(port);
    client.send(JSON.stringify({ type: "player.say", text: "x".repeat(100_000) }));
    expect(await client.closed).toBe(1009);
  });
});

describe("playing", () => {
  it("runs a scene from the opening to the GM's reply to a roll", async () => {
    const { port } = await startTable(
      [{ say: ["The guard turns."], rolls: [rollInput()] }, { say: ["You slip by."] }],
      [6, 5, 3, 1],
    );
    const client = await connect(port);
    await client.until((e) => e.type === "snapshot");

    client.send({ type: "session.start" });
    const asked = await client.until(isRoll);
    expect(asked.request).toMatchObject({ characterId: "kira", pool: { total: 4 } });
    await client.until((e) => e.type === "gm.status" && e.status.phase === "waiting_for_rolls");

    client.send({ type: "roll.app", requestId: asked.request.id });
    const rolled = await client.until((e) => e.type === "entry" && e.entry.kind === "roll");
    expect(rolled).toMatchObject({ entry: { resolved: { roll: { dice: [6, 5, 3, 1], hits: 2 }, outcome: { success: true } } } });
    await client.until((e) => e.type === "entry" && e.entry.kind === "gm" && e.entry.text === "You slip by.");
    await client.until((e) => e.type === "gm.status" && e.status.phase === "idle" && client.events.filter((x) => x.type === "gm.turn_done").length === 2);
  });

  it("reports physical dice", async () => {
    const { port } = await startTable([{ rolls: [rollInput()] }, { say: ["ok"] }]);
    const client = await connect(port);
    client.send({ type: "session.start" });
    const asked = await client.until(isRoll);
    client.send({ type: "roll.physical", requestId: asked.request.id, dice: "1 1 1 2" });
    const rolled = await client.until((e) => e.type === "entry" && e.entry.kind === "roll");
    expect(rolled).toMatchObject({ entry: { resolved: { source: "physical", roll: { criticalGlitch: true } } } });
  });

  it("sends an error only to the client whose dice were wrong", async () => {
    const { port } = await startTable([{ rolls: [rollInput()] }]);
    const kira = await connect(port);
    const doc = await connect(port);
    kira.send({ type: "session.start" });
    const asked = await kira.until(isRoll);
    await doc.until(isRoll);

    kira.send({ type: "roll.physical", requestId: asked.request.id, dice: "6 5" });
    await kira.until((e) => e.type === "error" && e.message === "This roll is 4 dice; you entered 2.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(doc.events.some((e) => e.type === "error")).toBe(false);
  });

  it("shows everyone the same game, and catches a latecomer up", async () => {
    const { port } = await startTable([{ say: ["Hello, runners."] }]);
    const first = await connect(port);
    const second = await connect(port);
    first.send({ type: "player.say", characterId: "kira", text: "Morning." });
    await second.until((e) => e.type === "entry" && e.entry.kind === "say" && e.entry.name === "Kira");
    await second.until((e) => e.type === "entry" && e.entry.kind === "gm");

    const late = await connect(port);
    const snapshot = (await late.until((e) => e.type === "snapshot")) as Extract<ServerEvent, { type: "snapshot" }>;
    expect(snapshot.transcript.map((e) => e.kind)).toEqual(["say", "gm"]);
  });

  it("gives a client that connects in the middle of a save exactly the entries it should see, none missing and none twice", async () => {
    const dir = (await tempStore()).dir;
    const { port } = await startTable([], [], new SlowStore(dir));
    const kira = await connect(port);
    kira.send({ type: "player.say", characterId: "kira", text: "while you connect" });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const late = await connect(port);
    await late.until((e) => e.type === "entry" && e.entry.kind === "say");
    await new Promise((resolve) => setTimeout(resolve, 60));

    // What a client shows: the snapshot, then each entry that arrives after it.
    let shown: number[] = [];
    for (const event of late.events) {
      if (event.type === "snapshot") shown = event.transcript.map((e) => e.id);
      else if (event.type === "entry") shown.push(event.entry.id);
    }
    expect(shown).toEqual([1]);
  });

  it("refuses words from a character who is not in the party", async () => {
    const { port } = await startTable([]);
    const client = await connect(port);
    client.send({ type: "player.say", characterId: "nobody", text: "hi" });
    await client.until((e) => e.type === "error" && e.message.includes('no character "nobody"'));
  });

  it("lets the players stop a GM turn that is going nowhere", async () => {
    const { port } = await startTable([]);
    const client = await connect(port);
    client.send({ type: "turn.cancel" });
    await client.until((e) => e.type === "error" && e.message.includes("not in the middle of a turn"));
  });
});
