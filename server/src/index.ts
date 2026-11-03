import { join } from "node:path";
import { loadConfig } from "./config.js";
import { demoParty } from "./game/demoParty.js";
import { GameSession } from "./game/session.js";
import { CampaignStore } from "./game/store.js";
import { demoScript, ScriptedGmDriver } from "./gm/scriptedDriver.js";
import { Hub } from "./net/hub.js";
import { allowedOrigins } from "./net/origin.js";

async function main() {
  const config = loadConfig();
  const store = new CampaignStore(join(config.campaignsDir, config.campaign));

  let party = await store.loadParty();
  if (!party) {
    party = demoParty;
    await store.saveParty(party);
    console.log(`No party.json in ${store.dir}; wrote a demo party there. Edit it to play your own characters.`);
  }

  const hub = new Hub({ port: config.port, allowedOrigins: (port) => allowedOrigins(port, config.devPort) });
  const session = await GameSession.create({
    store,
    party,
    driver: new ScriptedGmDriver(demoScript(party), { chunkDelayMs: 25 }),
    emit: (event) => hub.broadcast(event),
  });
  hub.attach(session);
  const port = await hub.listen();
  session.resume();
  console.log(`The table is open for campaign "${config.campaign}" at ws://127.0.0.1:${port}/ws (scripted GM; no Claude usage).`);

  const shutdown = async () => {
    await session.close();
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
