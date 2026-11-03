import { describe, expect, it } from "vitest";
import { restingFrom } from "../../src/gm/limits.js";

const now = 1_000_000;

describe("restingFrom", () => {
  it("recognizes a usage limit by its wording", () => {
    expect(restingFrom("Claude usage limit reached", null, now)).toMatchObject({ phase: "resting", until: null });
    expect(restingFrom("You've hit your limit", null, now)).not.toBeNull();
    expect(restingFrom("429 Too Many Requests", null, now)).not.toBeNull();
  });

  it("reports when the window resets if the CLI said", () => {
    const usage = { fiveHourUtilization: 1, resetsAt: now + 600 };
    expect(restingFrom("anything at all", usage, now)).toMatchObject({ phase: "resting", until: now + 600 });
  });

  it("treats an exhausted window as a limit even when the message says nothing", () => {
    expect(restingFrom("claude exited with code 1", { fiveHourUtilization: 1.02, resetsAt: now + 60 }, now)).not.toBeNull();
  });

  it("does not call an ordinary failure a limit", () => {
    expect(restingFrom("claude exited with code 1", { fiveHourUtilization: 0.4, resetsAt: now + 60 }, now)).toBeNull();
    expect(restingFrom("Could not start claude: spawn ENOENT", null, now)).toBeNull();
  });

  it("ignores a window that has already reset", () => {
    expect(restingFrom("claude exited with code 1", { fiveHourUtilization: 1, resetsAt: now - 1 }, now)).toBeNull();
  });
});
