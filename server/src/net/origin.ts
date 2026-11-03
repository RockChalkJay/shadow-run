import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Pages allowed to talk to the game: the dev server's, and ones this server serves itself. */
export function allowedOrigins(port: number, devPort = 5173, extra: readonly string[] = []): string[] {
  return [
    ...[port, devPort].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
    ...extra,
  ];
}

/**
 * Why a request to the game should be refused, or null if it is fine. This server answers only the
 * machine it runs on, and a web page in the owner's browser must not be able to drive it:
 * the connection must come from loopback, the Host must name loopback (so DNS rebinding does not
 * get through), and a browser's Origin must be one of ours. A client with no Origin is not a browser.
 */
export function refusalFor(req: IncomingMessage, port: number, origins: readonly string[]): string | null {
  const remote = req.socket.remoteAddress;
  if (!remote || !LOOPBACK.has(remote)) return "Only this machine may connect.";

  const host = req.headers.host?.toLowerCase();
  if (!host || !["localhost", "127.0.0.1", "[::1]"].some((name) => host === `${name}:${port}`)) {
    return "The Host header does not name this machine.";
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !origins.includes(origin)) return `Origin ${origin} is not allowed.`;
  return null;
}
