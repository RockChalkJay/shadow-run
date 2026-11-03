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

  it("asks for real risk, and never a death that no roll or choice led to", () => {
    expect(prompt).toContain("bosses and professionals can kill");
    expect(prompt).toContain("Never kill a character without a roll or a choice of theirs being involved.");
  });

  it("no longer promises players a warning before every danger lands", () => {
    expect(prompt).not.toContain("never from a surprise");
    expect(prompt).not.toContain("clear warning");
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
    expect(prompt).toContain("It does not track Edge or initiative");
    expect(prompt).not.toContain("does not track injuries");
  });

  it("gives the GM the rulebook's numbers for opposition, not rules of thumb", () => {
    expect(prompt).toContain("taken from the rulebook's NPC stat blocks");
    expect(prompt).toContain("about 9 to 15 at rating 5 to 7");
    expect(prompt).toContain("about 13 to 21 at rating 8 to 10");
    expect(prompt).not.toContain("trained professionals 7 to 10");
    expect(prompt).toContain("light pistol 2P, heavy pistol 3P, submachine gun 4P, rifle 5P");
    expect(prompt).not.toContain("Ares Predator VI");
  });

  it("says when each grade of opposition breaks, as the rulebook does", () => {
    expect(prompt).toContain("untrained groups run as soon as one of them goes down");
    expect(prompt).toContain("semi-trained ones (rating 1 to 4) retreat after losing about a quarter");
    expect(prompt).toContain("elite ones (8 to 10) fight on to the last");
  });

  it("tells the GM the system owns injuries, and how to hurt and heal", () => {
    expect(prompt).toContain("You never decide how much damage lands");
    expect(prompt).toContain("call deal_damage with the Damage Value before they resist");
    expect(prompt).toContain("the weapon's Damage Value plus the attacker's net hits");
    expect(prompt).toContain("Use heal only after a roll that earned it");
    expect(prompt).toContain("Never heal without a roll");
  });

  it("explains wounds the way the rulebook does: a die per filled row, none on resisting damage", () => {
    expect(prompt).toContain("Each filled row of three boxes on either track costs one die on every roll except resisting damage");
    expect(prompt).toContain("unconscious and out of the action");
    expect(prompt).toContain("overflow is full is dead");
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
