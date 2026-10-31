/** Events produced while the GM (a `claude -p` process) takes one turn. */
export type GmEvent =
  | { type: "session"; sessionId: string }
  /** A new block of narration begins; start a new paragraph if text is already showing. */
  | { type: "text_block_start" }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "rate_limit"; fiveHourUtilization: number; resetsAt: number }
  | { type: "done"; sessionId: string; costUsd: number; stopReason: string }
  | { type: "error"; message: string };
