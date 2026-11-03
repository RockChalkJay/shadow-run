import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { allowedOrigins, refusalFor } from "../../src/net/origin.js";

const req = (remote: string | undefined, headers: Record<string, string>) =>
  ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

const origins = allowedOrigins(8787, 5173);

describe("allowedOrigins", () => {
  it("covers the server's own pages and the dev server's, on localhost and 127.0.0.1", () => {
    expect(origins).toEqual([
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });
});

describe("refusalFor", () => {
  it("lets the command-line client in: loopback, a loopback Host, and no Origin", () => {
    expect(refusalFor(req("127.0.0.1", { host: "127.0.0.1:8787" }), 8787, origins)).toBeNull();
    expect(refusalFor(req("::1", { host: "[::1]:8787" }), 8787, origins)).toBeNull();
    expect(refusalFor(req("::ffff:127.0.0.1", { host: "localhost:8787" }), 8787, origins)).toBeNull();
  });

  it("lets the web app in from its own origin", () => {
    expect(refusalFor(req("127.0.0.1", { host: "localhost:8787", origin: "http://localhost:5173" }), 8787, origins)).toBeNull();
  });

  it("refuses a web page from anywhere else, which could otherwise drive the table from the owner's browser", () => {
    const reason = refusalFor(req("127.0.0.1", { host: "127.0.0.1:8787", origin: "https://evil.example" }), 8787, origins);
    expect(reason).toMatch(/Origin https:\/\/evil\.example is not allowed/);
    expect(refusalFor(req("127.0.0.1", { host: "127.0.0.1:8787", origin: "http://localhost:9999" }), 8787, origins)).not.toBeNull();
  });

  it("refuses a Host that does not name this machine, which is what DNS rebinding sends", () => {
    expect(refusalFor(req("127.0.0.1", { host: "evil.example:8787" }), 8787, origins)).toMatch(/Host/);
    expect(refusalFor(req("127.0.0.1", { host: "localhost:1234" }), 8787, origins)).toMatch(/Host/);
    expect(refusalFor(req("127.0.0.1", {}), 8787, origins)).toMatch(/Host/);
  });

  it("refuses anyone not on this machine", () => {
    expect(refusalFor(req("192.168.1.20", { host: "127.0.0.1:8787" }), 8787, origins)).toMatch(/Only this machine/);
    expect(refusalFor(req(undefined, { host: "127.0.0.1:8787" }), 8787, origins)).toMatch(/Only this machine/);
  });
});
