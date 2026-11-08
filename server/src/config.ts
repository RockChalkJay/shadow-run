import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
  port: number;
  /** Port of the web app's dev server, whose pages may connect. */
  devPort: number;
  campaignsDir: string;
  campaign: string;
  /** Who plays the GM: Claude through the CLI, or a script that spends nothing. */
  gm: "claude" | "scripted";
  gmModel: string;
  gmEffort?: Effort;
  claudeBin?: string;
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The effort level named by `SHADOWRUN_GM_EFFORT`, or undefined when it is not set. */
export function parseEffort(value: string | undefined): Effort | undefined {
  if (value !== undefined && !EFFORTS.includes(value as Effort)) {
    throw new Error(`SHADOWRUN_GM_EFFORT must be one of ${EFFORTS.join(", ")}, got "${value}"`);
  }
  return value as Effort | undefined;
}

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number from 1 to 65535, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const campaign = env.SHADOWRUN_CAMPAIGN ?? "default";
  if (!/^[a-z0-9_-]+$/i.test(campaign)) throw new Error(`SHADOWRUN_CAMPAIGN may use letters, digits, - and _ only, got "${campaign}"`);
  const gm = env.SHADOWRUN_GM ?? "claude";
  if (gm !== "claude" && gm !== "scripted") throw new Error(`SHADOWRUN_GM must be "claude" or "scripted", got "${gm}"`);
  const effort = parseEffort(env.SHADOWRUN_GM_EFFORT);
  return {
    gm,
    gmModel: env.SHADOWRUN_GM_MODEL ?? "sonnet",
    ...(effort !== undefined && { gmEffort: effort }),
    ...(env.CLAUDE_BIN !== undefined && { claudeBin: env.CLAUDE_BIN }),
    port: port("PORT", env.PORT, 8787),
    devPort: port("WEB_PORT", env.WEB_PORT, 5173),
    campaignsDir: env.SHADOWRUN_CAMPAIGNS ?? join(repoRoot, "campaigns"),
    campaign,
  };
}
