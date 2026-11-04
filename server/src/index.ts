import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { demoParty } from "./game/demoParty.js";
import { GameSession } from "./game/session.js";
import { CampaignStore } from "./game/store.js";
import { ClaudeGmDriver } from "./gm/claudeDriver.js";
import type { GmDriver } from "./gm/driver.js";
import { demoScript, ScriptedGmDriver } from "./gm/scriptedDriver.js";
import { Hub } from "./net/hub.js";
import { allowedOrigins } from "./net/origin.js";

async function main() {
  const config = loadConfig();
  const store = new CampaignStore(join(config.campaignsDir, config.campaign));

  const { party, created } = await store.loadOrCreateParty(demoParty);
  if (created) {
    console.log(`No character sheets in ${join(store.dir, "characters")}; wrote two demo characters there. Edit them or add your own, then restart.`);
    if (existsSync(join(store.dir, "party.json"))) console.log("The party.json in that folder is no longer read.");
  }

  let driver: GmDriver;
  if (config.gm === "claude") {
    const bin = config.claudeBin ?? "claude";
    const found = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (found.error || found.status !== 0) {
      console.warn(`Could not run "${bin} --version". Install the Claude CLI and log in, or set SHADOWRUN_GM=scripted to try the table without it.`);
    }
    const premise = await readFile(join(store.dir, "premise.md"), "utf8").catch(() => undefined);
    driver = await ClaudeGmDriver.start({
      party,
      ...(premise !== undefined && { premise }),
      model: config.gmModel,
      ...(config.gmEffort && { effort: config.gmEffort }),
      ...(config.claudeBin && { claudeBin: config.claudeBin }),
    });
  } else {
    driver = new ScriptedGmDriver(demoScript(party), { chunkDelayMs: 25 });
  }

  const hub = new Hub({ port: config.port, allowedOrigins: (port) => allowedOrigins(port, config.devPort) });
  const session = await GameSession.create({ store, party, driver, emit: (event) => hub.broadcast(event) });
  hub.attach(session);
  const port = await hub.listen();
  session.resume();
  const who = config.gm === "claude" ? `Claude (${config.gmModel}) as the GM, on your own plan` : "scripted GM; no Claude usage";
  console.log(`The table is open for campaign "${config.campaign}" at ws://127.0.0.1:${port}/ws (${who}).`);

  const shutdown = async () => {
    await session.close();
    await driver.close?.();
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
