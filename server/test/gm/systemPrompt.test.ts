import { describe, expect, it } from "vitest";
import { defaultEdgeCatalog } from "../../src/rules/index.js";
import { buildSystemPrompt, DEFAULT_PREMISE } from "../../src/gm/systemPrompt.js";
import { describeCharacter } from "../../src/game/sheetText.js";
import { party } from "../helpers.js";

const prompt = buildSystemPrompt({ party });

describe("the GM's system prompt", () => {
  it("introduces every character with the id the tools need and the sheet the GM builds pools from", () => {
    for (const member of party) {
      expect(prompt).toContain(`${member.name} (id: ${member.id}). ${describeCharacter(member)}`);
    }
    expect(prompt).toContain(
      "Kira (id: kira). Human. Body 5, Agility 6, Reaction 5, Strength 4, Willpower 3, Logic 2, Intuition 4, Charisma 2, Edge 3, Essence 6. Initiative: Reaction + Intuition = 9, plus 1D6. Skills: Athletics 3, Close Combat 4, Firearms 6, Stealth 3. Demo character. Street samurai.",
    );
  });

  it("tells the GM every number on a sheet is exact, and that a skill left out means no ranks", () => {
    expect(prompt).toContain("Every number below is exact, and a skill that is not listed means the character has no ranks in it.");
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
    expect(prompt).toContain("It tracks each player's Edge and what they spend on their own rolls, and tells you when they spend it.");
    expect(prompt).toContain("Do not award, take away or count Edge yourself.");
    expect(prompt).not.toContain("does not track Edge");
    expect(prompt).not.toContain("does not track injuries");
  });

  it("tells the GM to start a fight with the tool, never to make up an order, and how the round runs", () => {
    expect(prompt).toContain("call start_combat with everyone in it");
    expect(prompt).toContain("Never make up an order yourself.");
    expect(prompt).toContain("initiative is not rerolled between rounds");
    expect(prompt).toContain("When everyone has acted, call next_round.");
    expect(prompt).toContain("call join_combat");
    expect(prompt).toContain("call end_combat");
    expect(prompt).toContain("a player character's come from their sheet, so give none");
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
    expect(prompt).toContain("these points are your guide for a whole group");
  });

  it("tells the GM the system keeps Edge and that results already count what was spent", () => {
    expect(prompt).toContain("The system keeps each player's Edge points and the players spend them on their own rolls");
    expect(prompt).toContain("the result you receive already counts it");
  });

  it("tells the GM the system owns injuries, and how to hurt and heal", () => {
    expect(prompt).toContain("You never decide how much damage lands");
    expect(prompt).toContain("Resolve every attack with the attack tool, not request_roll.");
    expect(prompt).toContain("You never decide whether an attack lands or how much damage it does.");
    expect(prompt).toContain("An attacker with no hits misses.");
    expect(prompt).toContain("give edgeAdvice for them as you would for request_roll");
    expect(prompt).toContain("call deal_damage with the Damage Value before they resist");
    expect(prompt).toContain("adds the attacker's net hits to the Damage Value");
    expect(prompt).toContain("Healing needs a roll.");
    expect(prompt).toContain("call heal with that id in that same turn, or the hits are lost");
    expect(prompt).toContain("each be received only once for a set of injuries");
    expect(prompt).toContain("Never heal without a roll");
  });

  it("tells the GM how to use grunts, and that a failed Composure test means they bolt", () => {
    expect(prompt).toContain("Nameless opposition are grunts.");
    expect(prompt).toContain("also give professionalRating (0 to 10, from the tiers above) and charisma");
    expect(prompt).toContain("A full track is dead if physical damage hit last and unconscious if stun did");
    expect(prompt).toContain("if the test fails the grunt bolts, so have it flee or surrender");
    expect(prompt).toContain("Grunts cannot be healed.");
    expect(prompt).toContain("the others in alongside (at most four more)");
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
