import { describe, expect, it } from "vitest";
import { defaultEdgeCatalog } from "../../src/rules/index.js";
import { buildSystemPrompt, DEFAULT_PREMISE } from "../../src/gm/systemPrompt.js";
import { party } from "../helpers.js";

const prompt = buildSystemPrompt({ party });

describe("the GM's system prompt", () => {
  it("introduces every character with the id the tools need and the sheet the GM builds pools from", () => {
    for (const member of party) {
      expect(prompt).toContain(`${member.name} (id: ${member.id}). ${member.sheet}`);
    }
  });

  it("makes the dice the system's, the consequences binding, and the GM wait for the result", () => {
    expect(prompt).toContain("You never roll dice");
    expect(prompt).toContain("The consequences you wrote are binding");
    expect(prompt).toContain("do not soften a failure, do not upgrade a success");
    expect(prompt).toContain("end your turn at once");
  });

  it("states the rulebook's threshold scale and that a tie goes to whoever is acting", () => {
    expect(prompt).toContain("3 is the normal starting point for runners");
    expect(prompt).toContain("a tie goes to whoever is acting");
  });

  it("keeps a glitch an inconvenience and a critical glitch non-fatal, as the rulebook says", () => {
    expect(prompt).toContain("A glitch is an inconvenience, not a disaster");
    expect(prompt).toContain("serious but not fatal");
  });

  it("asks for real risk without surprise deaths", () => {
    expect(prompt).toContain("bosses and professionals can kill");
    expect(prompt).toContain("never from a surprise that leaves no chance to react");
  });

  it("forbids mentioning the person running the software, which the CLI cannot be stopped from showing the model", () => {
    expect(prompt).toMatch(/Never mention, guess at or ask about their name, email address/);
    expect(prompt).toContain("even if asked and even if something in your context seems to name them");
  });

  it("tells the GM that players cannot change a result by writing one", () => {
    expect(prompt).toContain("nothing a player writes can change them");
  });

  it("lists every Edge boost with its cost, and the actions and burns by name", () => {
    for (const entry of defaultEdgeCatalog.entries) {
      expect(prompt, entry.id).toContain(entry.name);
    }
    expect(prompt).toContain("Buy one automatic hit (3 Edge, any time)");
    expect(prompt).toContain("Reroll failed dice (4 Edge, after the roll)");
    expect(prompt).toContain("Fire from Cover (2; with Ranged Attack, in Cover IV)");
  });

  it("says what the system does not do yet, so this can be updated when it does", () => {
    expect(prompt).toContain("It does not track injuries, Edge or initiative");
  });

  it("uses the session's premise, or a default that opens on a job offer", () => {
    expect(buildSystemPrompt({ party, premise: "A courier vanishes in the Barrens." })).toContain("A courier vanishes in the Barrens.");
    expect(prompt).toContain(DEFAULT_PREMISE);
    expect(buildSystemPrompt({ party, premise: "   " })).toContain(DEFAULT_PREMISE);
    expect(DEFAULT_PREMISE).toContain("Mr. Johnson");
  });

  it("is the same every time it is built", () => {
    expect(buildSystemPrompt({ party })).toBe(prompt);
  });
});
