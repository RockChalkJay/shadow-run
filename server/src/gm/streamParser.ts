import type { GmEvent } from "@shadow-run/shared";

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Turns one line of `claude -p --output-format stream-json` output into GM events. */
export function parseStreamLine(line: string): GmEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(msg)) return [];

  switch (msg.type) {
    case "system":
      return msg.subtype === "init" && typeof msg.session_id === "string"
        ? [{ type: "session", sessionId: msg.session_id }]
        : [];
    case "stream_event":
      return [...textBlockStart(msg), ...textDelta(msg)];
    case "assistant":
      return toolUses(msg);
    case "rate_limit_event":
      return rateLimit(msg);
    case "result":
      return [turnEnd(msg)];
    default:
      return [];
  }
}

function textBlockStart(msg: Json): GmEvent[] {
  const { event } = msg;
  if (msg.parent_tool_use_id != null || !isRecord(event)) return [];
  const block = event.content_block;
  return event.type === "content_block_start" && isRecord(block) && block.type === "text"
    ? [{ type: "text_block_start" }]
    : [];
}

// Text is taken from the streamed deltas only; the final `assistant` message repeats it.
function textDelta(msg: Json): GmEvent[] {
  const { event } = msg;
  if (msg.parent_tool_use_id != null || !isRecord(event)) return [];
  const { delta } = event;
  if (event.type !== "content_block_delta" || !isRecord(delta)) return [];
  return delta.type === "text_delta" && typeof delta.text === "string"
    ? [{ type: "text", text: delta.text }]
    : [];
}

function toolUses(msg: Json): GmEvent[] {
  const { message } = msg;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block): GmEvent[] =>
    isRecord(block) && block.type === "tool_use" && typeof block.name === "string"
      ? [{ type: "tool_use", name: block.name, input: block.input }]
      : [],
  );
}

function rateLimit(msg: Json): GmEvent[] {
  const info = msg.rate_limit_info;
  const windows = isRecord(info) ? info.unifiedWindows : undefined;
  const fiveHour = isRecord(windows) ? windows.five_hour : undefined;
  if (
    !isRecord(fiveHour) ||
    typeof fiveHour.utilization !== "number" ||
    typeof fiveHour.resetsAt !== "number"
  ) {
    return [];
  }
  return [
    {
      type: "rate_limit",
      fiveHourUtilization: fiveHour.utilization,
      resetsAt: fiveHour.resetsAt,
    },
  ];
}

function turnEnd(msg: Json): GmEvent {
  if (msg.is_error === true || msg.subtype !== "success") {
    const detail = typeof msg.result === "string" && msg.result ? msg.result : `${msg.subtype}`;
    return { type: "error", message: `claude ended the turn with an error: ${detail}` };
  }
  return {
    type: "done",
    sessionId: typeof msg.session_id === "string" ? msg.session_id : "",
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
    stopReason: typeof msg.stop_reason === "string" ? msg.stop_reason : "unknown",
  };
}
