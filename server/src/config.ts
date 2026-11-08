import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_NAME, scenarioCampaign } from "./game/scenario.js";
import { parseDice } from "./rules/dice.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
  port: number;
  /** Port of the web app's dev server, whose pages may connect. */
  devPort: number;
  campaignsDir: string;
  scenariosDir: string;
  /** The folder under `campaignsDir` the table plays in. A scenario's is its own, wiped and refilled on every start. */
  campaign: string;
  /** Start from this saved scenario, for testing. */
  scenario?: string;
  /** Who plays the GM: Claude through the CLI, or a script that spends nothing. */
  gm: "claude" | "scripted";
  gmModel: string;
  gmEffort?: Effort;
  claudeBin?: string;
  /** Faces for the first dice the table rolls, in order, for testing; random after they run out. */
  dice?: number[];
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The effort level named by `SHADOWRUN_GM_EFFORT`, or undefined when it is not set. */
export function parseEffort(value: string | undefined): Effort | undefined {
  if (value !== undefined && !EFFORTS.includes(value as Effort)) {
    throw new Error(`SHADOWRUN_GM_EFFORT must be one of ${EFFORTS.join(", ")}, got "${value}"`);
  }
  return value as Effort | undefined;
}

/** The faces named by `SHADOWRUN_DICE`, or undefined when it is not set. */
export function parseDiceSetting(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDice(value);
  } catch (err) {
    throw new Error(`SHADOWRUN_DICE: ${err instanceof Error ? err.message : err}`);
  }
}

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number from 1 to 65535, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const scenario = env.SHADOWRUN_SCENARIO;
  if (scenario !== undefined && !SCENARIO_NAME.test(scenario)) {
    throw new Error(`SHADOWRUN_SCENARIO may use letters, digits, - and _ only, got "${scenario}"`);
  }
  if (scenario !== undefined && env.SHADOWRUN_CAMPAIGN !== undefined) {
    throw new Error("SHADOWRUN_SCENARIO and SHADOWRUN_CAMPAIGN cannot both be set: a scenario plays in a folder of its own, so a campaign is never touched");
  }
  const campaign = scenario !== undefined ? scenarioCampaign(scenario) : (env.SHADOWRUN_CAMPAIGN ?? "default");
  if (!/^[a-z0-9_-]+$/i.test(campaign)) throw new Error(`SHADOWRUN_CAMPAIGN may use letters, digits, - and _ only, got "${campaign}"`);
  const gm = env.SHADOWRUN_GM ?? "claude";
  if (gm !== "claude" && gm !== "scripted") throw new Error(`SHADOWRUN_GM must be "claude" or "scripted", got "${gm}"`);
  const effort = parseEffort(env.SHADOWRUN_GM_EFFORT);
  const dice = parseDiceSetting(env.SHADOWRUN_DICE);
  return {
    gm,
    gmModel: env.SHADOWRUN_GM_MODEL ?? "sonnet",
    ...(effort !== undefined && { gmEffort: effort }),
    ...(dice !== undefined && { dice }),
    ...(env.CLAUDE_BIN !== undefined && { claudeBin: env.CLAUDE_BIN }),
    port: port("PORT", env.PORT, 8787),
    devPort: port("WEB_PORT", env.WEB_PORT, 5173),
    campaignsDir: env.SHADOWRUN_CAMPAIGNS ?? join(repoRoot, "campaigns"),
    scenariosDir: env.SHADOWRUN_SCENARIOS ?? join(repoRoot, "scenarios"),
    campaign,
    ...(scenario !== undefined && { scenario }),
  };
}
