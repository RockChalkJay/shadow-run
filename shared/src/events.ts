/** Events produced while the GM (a `claude -p` process) takes one turn. */
export type GmEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "rate_limit"; fiveHourUtilization: number; resetsAt: number }
  | { type: "done"; sessionId: string; costUsd: number; stopReason: string }
  | { type: "error"; message: string };
