import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStreamLine } from "../src/gm/streamParser.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);

const parseAll = (lines: string[]) => lines.flatMap(parseStreamLine);

describe("parseStreamLine", () => {
  it("maps a recorded text turn to session, text, usage and done", () => {
    expect(parseAll(fixture("text-turn.jsonl"))).toEqual([
      { type: "session", sessionId: "c00a4cb3-107c-4ef9-a0df-8c3d44da04c3" },
      { type: "text", text: "ready" },
      { type: "rate_limit", fiveHourUtilization: 0.08, resetsAt: 1793437800 },
      {
        type: "done",
        sessionId: "c00a4cb3-107c-4ef9-a0df-8c3d44da04c3",
        costUsd: 0.004288,
        stopReason: "end_turn",
      },
    ]);
  });

  it("emits one text event per streamed delta", () => {
    const delta = (text: string) =>
      JSON.stringify({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      });
    expect(parseAll([delta("Neon "), delta("rain.")])).toEqual([
      { type: "text", text: "Neon " },
      { type: "text", text: "rain." },
    ]);
  });

  it("reports tool calls from the assistant message and skips its text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Kira waits." },
          { type: "tool_use", id: "toolu_1", name: "mcp__gm__request_roll", input: { characterId: "kira" } },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual([
      { type: "tool_use", name: "mcp__gm__request_roll", input: { characterId: "kira" } },
    ]);
  });

  it("ignores text from subagents", () => {
    const line = JSON.stringify({
      type: "stream_event",
      parent_tool_use_id: "toolu_9",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hidden" } },
    });
    expect(parseStreamLine(line)).toEqual([]);
  });

  it("turns an error result into an error event carrying the reason", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" });
    expect(parseStreamLine(line)).toEqual([
      { type: "error", message: "claude ended the turn with an error: Credit balance is too low" },
    ]);
  });

  it("treats a non-success result subtype as an error", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false });
    expect(parseStreamLine(line)).toEqual([
      { type: "error", message: "claude ended the turn with an error: error_max_turns" },
    ]);
  });

  it("skips usage events that lack the five-hour window", () => {
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    expect(parseStreamLine(line)).toEqual([]);
  });

  it("skips blank, non-JSON and unknown lines", () => {
    expect(parseStreamLine("")).toEqual([]);
    expect(parseStreamLine("warming up…")).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: "something_new" }))).toEqual([]);
    expect(parseStreamLine("[1,2]")).toEqual([]);
  });
});
