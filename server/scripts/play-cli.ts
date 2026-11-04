// Plays at the table from a terminal, over the same WebSocket the browser will use.
//
//   npm run dev:server     in one terminal
//   npm run play           in another

import { createInterface } from "node:readline";
import type { CharacterView, ClientMessage, CombatState, CharacterSheet, RollRequest, ServerEvent, TranscriptEntry } from "@shadow-run/shared";
import { WebSocket } from "ws";
import { formatCombatStatus, formatStanding, showDice } from "../src/game/rollReport.js";

const url = process.env.TABLE_URL ?? `ws://127.0.0.1:${process.env.PORT ?? 8787}/ws`;
const ws = new WebSocket(url);

let party: CharacterSheet[] = [];
let characters: CharacterView[] = [];
let combat: CombatState | null = null;
let active: CharacterSheet | undefined;
let pending: RollRequest[] = [];
let streaming = false;

const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
const name = (id: string) => party.find((m) => m.id === id)?.name ?? id;
const line = (text = "") => {
  if (streaming) process.stdout.write("\n");
  streaming = false;
  console.log(text);
};

function card(request: RollRequest) {
  line(`\n  ROLL #${pending.indexOf(request) + 1}: ${name(request.characterId)} to ${request.label}`);
  line(`    dice: ${request.pool.total} (${request.pool.breakdown})`);
  if (request.soak) {
    line(`    resisting ${request.soak.damageValue} ${request.soak.damageType} damage: every hit removes one point of it`);
    line("    /app to roll with the app's dice, or /dice 6 5 3 1 ... for dice you rolled");
    return;
  }
  if (request.healing) {
    const { method, patient, threshold, autoHit } = request.healing;
    line(`    healing: ${method.replaceAll("_", " ")} on ${patient.name}, threshold ${threshold}${autoHit ? " (plus a free hit for a fully natural patient)" : ""}; the hits are spent on healing`);
  } else {
    line(request.opposed ? `    against: ${request.opposed.by}, ${request.opposed.pool} dice (rolled by the system)` : `    needs: ${request.threshold ?? 1} hit(s)`);
  }
  line(`    at stake: ${request.stakes}`);
  line(`    good roll: ${request.goodRoll}`);
  line(`    bad roll:  ${request.badRoll}`);
  line(`    success: ${request.consequences.success}`);
  line(`    failure: ${request.consequences.failure}`);
  line(`    glitch:  ${request.consequences.glitch}`);
  line(`    critical glitch: ${request.consequences.criticalGlitch}`);
  line(`    Edge: ${request.edgeAdvice}`);
  line("    /app to roll with the app's dice, or /dice 6 5 3 1 ... for dice you rolled");
}

function show(entry: TranscriptEntry) {
  switch (entry.kind) {
    case "say":
      return line(`${entry.name}: ${entry.text}`);
    case "gm":
      return line(`\nGM: ${entry.text}\n`);
    case "roll": {
      const { request, roll, opposed, outcome } = entry.resolved;
      line(`\n  ${name(request.characterId)} rolled: ${showDice(roll)} = ${roll.hits} hit(s)`);
      // Resisting damage and either side of an attack have no success or failure of their own; the entry that follows says what came of it.
      if (request.soak) return line();
      if (request.attack) return line(opposed ? `  ${opposed.by} rolled: ${showDice(opposed.roll)} = ${opposed.roll.hits} hit(s)` : undefined);
      if (opposed) line(`  ${opposed.by} rolled: ${showDice(opposed.roll)} = ${opposed.roll.hits} hit(s)`);
      line(`  ${outcome.success ? "SUCCESS" : "FAILURE"}${outcome.netHits ? ` by ${outcome.netHits} net hit(s)` : ""}${roll.criticalGlitch ? ", CRITICAL GLITCH" : roll.glitch ? ", GLITCH" : ""}`);
      line(`  ${outcome.consequence}`);
      if (outcome.glitchConsequence) line(`  ${outcome.glitchConsequence}`);
      return line();
    }
    case "roll_cancelled":
      return line(`  (roll skipped: ${entry.label})`);
    case "npc":
      return line(`  NPC roll, ${entry.label}: ${entry.pool} dice ${showDice(entry.roll)} = ${entry.roll.hits} hits`);
    case "attack": {
      const result = entry.hit ? `HIT for Damage Value ${entry.damageValue} ${entry.weapon.damageType}` : "MISS";
      line(`  ${entry.attacker} attacks ${entry.defender} with ${entry.weapon.name}: ${entry.attackRoll.hits} hit(s) against ${entry.defenseRoll.hits}. ${result}`);
      return;
    }
    case "damage":
      line(`\n  ${entry.after.name} resists ${entry.damageValue} ${entry.damageType} damage (${entry.label}): ${showDice(entry.resistance)} = ${entry.resistance.hits} hit(s), takes ${entry.taken}`);
      line(`  ${formatStanding(entry.after)}\n`);
      return;
    case "combat":
      return line(
        entry.event === "start" ? `\n  A fight begins: ${entry.names.join(", ")}`
        : entry.event === "join" ? `  Joined the fight: ${entry.names.join(", ")}`
        : entry.event === "round" ? `  -- round ${entry.round} --`
        : `  The fight ends after ${entry.round} round(s)\n`,
      );
    case "heal":
      line(`\n  ${entry.reason}: ${entry.after.name} heals ${entry.healed} ${entry.type}`);
      line(`  ${formatStanding(entry.after)}\n`);
      return;
    case "system":
      return line(`  [${entry.text}]`);
  }
}

function handle(event: ServerEvent) {
  switch (event.type) {
    case "snapshot":
      party = event.party;
      characters = event.characters;
      combat = event.combat;
      active ??= party[0];
      pending = event.pendingRolls;
      line(`Connected. Party: ${party.map((m) => `${m.name} (${m.id})`).join(", ")}. Speaking as ${active?.name}. Type /help for commands.`);
      for (const entry of event.transcript.slice(-8)) show(entry);
      for (const request of pending) card(request);
      break;
    case "gm.status":
      if (event.status.phase === "error") line(`  [GM error: ${event.status.message}; /retry, or say something]`);
      if (event.status.phase === "resting") line(`  [${event.status.message}]`);
      if (event.status.phase === "waiting_for_rolls") line("  [waiting for dice]");
      break;
    case "gm.block":
      process.stdout.write(streaming ? "\n\nGM: " : "\nGM: ");
      streaming = true;
      break;
    case "gm.text":
      process.stdout.write(event.text);
      streaming = true;
      break;
    case "gm.turn_done":
      if (streaming) process.stdout.write("\n");
      streaming = false;
      break;
    case "roll.requested":
      pending.push(event.request);
      card(event.request);
      break;
    case "roll.cancelled":
      pending = pending.filter((r) => r.id !== event.requestId);
      break;
    case "entry": {
      const { entry } = event;
      if (entry.kind === "roll") {
        const done = entry.resolved.request.id;
        pending = pending.filter((r) => r.id !== done);
      }
      if (entry.kind !== "gm") show(entry);
      break;
    }
    case "combat.updated":
      combat = event.combat;
      break;
    case "character.updated":
      characters = [...characters.filter((c) => !(c.kind === event.character.kind && c.id === event.character.id)), event.character];
      break;
    case "usage":
      break;
    case "error":
      line(`  ! ${event.message}`);
      break;
  }
}

ws.on("message", (data) => handle(JSON.parse(data.toString()) as ServerEvent));
ws.on("close", () => {
  console.log("Disconnected.");
  process.exit(0);
});
ws.on("error", (err) => {
  console.error(`Could not reach the table at ${url}: ${err.message}. Is "npm run dev:server" running?`);
  process.exit(1);
});

const help = [
  "  text              say something as the active character",
  "  /as <id>          speak as another character",
  "  /start            begin the session",
  "  /app [n]          roll pending roll n (default 1) with the app's dice",
  "  /dice [n:] f f f  report dice rolled at the table, e.g. /dice 6 5 3 1 or /dice 2: 4 4 1",
  "  /skip [n]         skip a pending roll",
  "  /status           show how hurt everyone is",
  "  /stop             stop the GM mid-turn",
  "  /retry            try the GM's turn again",
  "  /quit",
].join("\n");

createInterface({ input: process.stdin }).on("line", (input) => {
  const text = input.trim();
  if (!text) return;
  if (!text.startsWith("/")) return send({ type: "player.say", ...(active && { characterId: active.id }), text });

  const [command = "", ...args] = text.slice(1).split(/\s+/);
  const pick = (arg: string | undefined) => pending[(arg && /^\d+$/.test(arg) ? Number(arg) : 1) - 1];
  switch (command) {
    case "help":
      return console.log(help);
    case "quit":
      return ws.close();
    case "start":
      return send({ type: "session.start" });
    case "status":
      if (combat) console.log(`  ${formatCombatStatus(combat, (m) => characters.find((c) => c.kind === m.kind && c.id === m.id)?.status)}`);
      return console.log(characters.map((c) => `  ${c.kind === "npc" ? "(NPC) " : ""}${formatStanding(c)}`).join("\n") || "  Nobody is on the table yet.");
    case "stop":
      return send({ type: "turn.cancel" });
    case "retry":
      return send({ type: "turn.retry" });
    case "as": {
      const member = party.find((m) => m.id === args[0]);
      if (!member) return console.log(`  No character "${args[0]}". Choose from: ${party.map((m) => m.id).join(", ")}`);
      active = member;
      return console.log(`  Speaking as ${member.name}.`);
    }
    case "app": {
      const request = pick(args[0]);
      return request ? send({ type: "roll.app", requestId: request.id }) : console.log("  No such pending roll.");
    }
    case "skip": {
      const request = pick(args[0]);
      return request ? send({ type: "roll.cancel", requestId: request.id }) : console.log("  No such pending roll.");
    }
    case "dice": {
      const first = args[0] ?? "";
      const which = first.match(/^(\d+):$/);
      const request = pick(which?.[1]);
      const dice = (which ? args.slice(1) : args).join(" ");
      return request ? send({ type: "roll.physical", requestId: request.id, dice }) : console.log("  No such pending roll.");
    }
    default:
      return console.log(`  Unknown command /${command}. Type /help.`);
  }
});
