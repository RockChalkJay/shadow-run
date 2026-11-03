import type { GmStatus, Usage } from "@shadow-run/shared";

export type Resting = Extract<GmStatus, { phase: "resting" }>;

/**
 * Whether a failed turn was the Claude plan's usage limit rather than a fault. Based on the wording
 * of the failure and on the usage figures the CLI reports; the stream at the limit has not been observed.
 */
export function restingFrom(message: string, usage: Usage | null, nowSeconds: number): Resting | null {
  const worded = /usage limit|limit reached|hit your limit|rate limit|too many requests/i.test(message);
  const exhausted = usage !== null && usage.fiveHourUtilization >= 1 && usage.resetsAt > nowSeconds;
  if (!worded && !exhausted) return null;
  return {
    phase: "resting",
    until: usage !== null && usage.resetsAt > nowSeconds ? usage.resetsAt : null,
    message: "The Claude plan's usage limit was reached. The GM will pick up again when it resets.",
  };
}
