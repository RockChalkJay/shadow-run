// Plays at the table from a terminal, over the same WebSocket the browser will use.
//
//   npm run dev:server     in one terminal
//   npm run play           in another

import { createInterface } from "node:readline";
import type { CharacterView, ClientMessage, CombatState, EdgeView, CharacterSheet, RollRequest, ServerEvent, TranscriptEntry } from "@shadow-run/shared";
import { WebSocket } from "ws";
import { formatCombatStatus, formatStanding, showDice } from "../src/game/rollReport.js";

const url = process.env.TABLE_URL ?? `ws://127.0.0.1:${process.env.PORT ?? 8787}/ws`;
const ws = new WebSocket(url);

let party: CharacterSheet[] = [];
let characters: CharacterView[] = [];
let combat: CombatState | null = null;
let active: CharacterSheet | undefined;
let pending: RollRequest[] = [];
let edges: EdgeView[] = [];
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

/** A counted roll that is waiting for the player to decide on Edge, with its dice numbered so they can be named. */
function showHeld(request: RollRequest) {
  const held = request.held;
  if (!held) return;
  const numbered = (dice: number[]) => dice.map((d, i) => `${i + 1}:${d}`).join(" ");
  const edge = edges.find((e) => e.id === request.characterId);
  line(`\n  ${name(request.characterId)}'s roll is counted but waiting for Edge: ${held.roll.hits} hit(s)`);
  line(`    your dice:      ${numbered(held.roll.dice)}${held.roll.explosions?.length ? ` (exploded: ${held.roll.explosions.join(" ")})` : ""}`);
  if (held.opponent) line(`    their dice:     ${numbered(held.opponent.dice)} = ${held.opponent.hits} hit(s)`);
  line(`    Edge on hand:   ${edge ? `${edge.points}${edge.spentThisRound ? " (already spent this round)" : ""}` : "none"}`);
  line("    /edge reroll 2 t1 [= 5 4]   reroll your die 2 and their die 1 (1 Edge each); new values after = if rolled by hand");
  line("    /edge bump 3                add 1 to your die 3 (2 Edge)     /edge buy [n]   buy hits (3 each)");
  line("    /edge failed [= 5 4 1]      reroll every die that missed (4 Edge)     /keep   count it as it stands");
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
    case "edge":
      return line(`  ${entry.name} gains ${entry.gained} Edge: ${entry.reason}`);
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
      edges = event.edge;
      line(`Connected. Party: ${party.map((m) => `${m.name} (${m.id})`).join(", ")}. Speaking as ${active?.name}. Type /help for commands.`);
      for (const entry of event.transcript.slice(-8)) show(entry);
      for (const request of pending) (request.held ? showHeld(request) : card(request));
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
    case "roll.updated":
      pending = pending.map((r) => (r.id === event.request.id ? event.request : r));
      showHeld(event.request);
      break;
    case "edge.updated":
      edges = [...edges.filter((e) => e.id !== event.edge.id), event.edge];
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
  "  /app [n] [edge] [hold]   roll pending roll n (default 1) with the app's dice; edge = spend 4 Edge on Edge dice, hold = decide on Edge after",
  "  /dice [n:] f f f [x f f] [edge] [hold]   report dice rolled by hand, e.g. /dice 6 5 3 1 or /dice 2: 4 4 1; after x, the extra dice for 6s with edge",
  "  /edge <reroll|bump|buy|failed> ...   spend Edge on a held roll (see the roll for the forms)",
  "  /keep [n]         let a held roll count as it stands",
  "  /skip [n]         skip a pending roll",
  "  /status           show how hurt everyone is, the fight, and Edge",
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
      if (edges.length > 0) console.log(`  Edge: ${edges.map((e) => `${name(e.id)} ${e.points}/${e.rank}${e.spentThisRound ? " (spent)" : ""}`).join(", ")}`);
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
      const flags = args.filter((a) => a === "edge" || a === "hold");
      const request = pick(args.find((a) => /^\d+$/.test(a)));
      return request
        ? send({ type: "roll.app", requestId: request.id, ...(flags.includes("edge") && { edge: "dice" as const }), ...(flags.includes("hold") && { hold: true }) })
        : console.log("  No such pending roll.");
    }
    case "keep": {
      const request = pick(args[0]);
      return request ? send({ type: "roll.keep", requestId: request.id }) : console.log("  No such pending roll.");
    }
    case "edge": {
      const held = pending.find((r) => r.held);
      if (!held) return console.log("  No roll is waiting on an Edge decision. Roll with hold first.");
      const [boost = "", ...rest] = args;
      const at = rest.indexOf("=");
      const words = at === -1 ? rest : rest.slice(0, at);
      const dice = at === -1 ? undefined : rest.slice(at + 1).join(" ");
      const targets = words.map((w) => (w.startsWith("t") ? { side: "theirs" as const, index: Number(w.slice(1)) - 1 } : { side: "mine" as const, index: Number(w) - 1 }));
      if (boost === "reroll") return send({ type: "roll.edge", requestId: held.id, boost: "reroll", targets, ...(dice !== undefined && { dice }) });
      if (boost === "bump") return send({ type: "roll.edge", requestId: held.id, boost: "bump", targets });
      if (boost === "buy") return send({ type: "roll.edge", requestId: held.id, boost: "buy_hit", ...(words[0] && { times: Number(words[0]) }) });
      if (boost === "failed") return send({ type: "roll.edge", requestId: held.id, boost: "reroll_failed", ...(dice !== undefined && { dice }) });
      return console.log("  /edge reroll|bump|buy|failed ...");
    }
    case "skip": {
      const request = pick(args[0]);
      return request ? send({ type: "roll.cancel", requestId: request.id }) : console.log("  No such pending roll.");
    }
    case "dice": {
      const first = args[0] ?? "";
      const which = first.match(/^(\d+):$/);
      const request = pick(which?.[1]);
      const words = which ? args.slice(1) : args;
      const flags = words.filter((w) => w === "edge" || w === "hold");
      const rest = words.filter((w) => w !== "edge" && w !== "hold");
      const split = rest.findIndex((w) => w === "x" || w === "x:");
      const dice = (split === -1 ? rest : rest.slice(0, split)).join(" ");
      const explosions = split === -1 ? undefined : rest.slice(split + 1).join(" ");
      return request
        ? send({
            type: "roll.physical",
            requestId: request.id,
            dice,
            ...(explosions !== undefined && { explosions }),
            ...(flags.includes("edge") && { edge: "dice" as const }),
            ...(flags.includes("hold") && { hold: true }),
          })
        : console.log("  No such pending roll.");
    }
    default:
      return console.log(`  Unknown command /${command}. Type /help.`);
  }
});
