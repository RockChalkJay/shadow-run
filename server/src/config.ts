import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  /** Port of the web app's dev server, whose pages may connect. */
  devPort: number;
  campaignsDir: string;
  campaign: string;
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number from 1 to 65535, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const campaign = env.SHADOWRUN_CAMPAIGN ?? "default";
  if (!/^[a-z0-9_-]+$/i.test(campaign)) throw new Error(`SHADOWRUN_CAMPAIGN may use letters, digits, - and _ only, got "${campaign}"`);
  return {
    port: port("PORT", env.PORT, 8787),
    devPort: port("WEB_PORT", env.WEB_PORT, 5173),
    campaignsDir: env.SHADOWRUN_CAMPAIGNS ?? join(repoRoot, "campaigns"),
    campaign,
  };
}
