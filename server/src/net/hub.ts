import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientMessage, type ServerEvent } from "@shadow-run/shared";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Ack, GameSession } from "../game/session.js";
import { refusalFor } from "./origin.js";

export interface HubOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  /** Browser origins that may connect; clients with no Origin (the command-line client) always may, from this machine. */
  allowedOrigins: (port: number) => string[];
}

/** The table's connection to browsers and other clients: one WebSocket, plus a health check. */
export class Hub {
  private session: GameSession | undefined;
  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private port = 0;

  constructor(private readonly opts: HubOptions) {
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.server = createServer((req, res) => {
      const refusal = refusalFor(req, this.port, this.opts.allowedOrigins(this.port));
      if (refusal) {
        res.writeHead(403, { "content-type": "text/plain" }).end(refusal);
      } else if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    this.server.on("upgrade", (req, socket, head) => {
      const refusal = req.url === "/ws" ? refusalFor(req, this.port, this.opts.allowedOrigins(this.port)) : "Not found.";
      if (refusal) {
        socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(refusal)}\r\n\r\n${refusal}`);
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }

  /** The session the hub talks to. It is attached after creation because the session sends its events through the hub. */
  attach(session: GameSession): void {
    this.session = session;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host ?? "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  /** The snapshot is sent in the same step the socket joins the broadcast list, so no update can fall between them. */
  private accept(ws: WebSocket): void {
    ws.on("error", (err) => console.error("A client connection failed:", err.message));
    ws.on("message", (raw) => void this.receive(ws, raw.toString()));
    if (this.session) this.send(ws, this.session.snapshot());
  }

  private async receive(ws: WebSocket, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = ClientMessage.parse(JSON.parse(raw));
    } catch (err) {
      const detail = err instanceof z.ZodError ? z.prettifyError(err) : "that was not JSON";
      return this.send(ws, { type: "error", message: `Message not understood: ${detail}` });
    }
    const ack = await this.dispatch(message).catch((err: Error): Ack => ({ ok: false, error: err.message }));
    if (!ack.ok) this.send(ws, { type: "error", message: ack.error });
  }

  private async dispatch(message: ClientMessage): Promise<Ack> {
    const session = this.session;
    if (!session) return { ok: false, error: "The table is not ready yet." };
    switch (message.type) {
      case "session.start":
        return session.start();
      case "player.say":
        return session.say(message.characterId, message.text);
      case "roll.app":
        return session.submitRoll(message.requestId, { mode: "app" });
      case "roll.physical":
        return session.submitRoll(message.requestId, { mode: "physical", dice: message.dice });
      case "roll.cancel":
        return session.cancelRoll(message.requestId);
      case "turn.cancel":
        return session.cancelTurn();
      case "turn.retry":
        return session.retry();
    }
  }

  async close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
