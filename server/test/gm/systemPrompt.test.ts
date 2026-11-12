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
    expect(prompt).toContain("Fire from Cover, id fire_from_cover (2; with Ranged Attack, in Cover IV)");
  });

  it("says the system keeps count of Edge, and nothing is left for it to learn", () => {
    expect(prompt).toContain("The system does. It tracks each player's Edge, gives it when a rating gap earns it, and counts what they spend on their own rolls or on giving it to an ally");
    expect(prompt).toContain("and the Edge rank they burn");
    expect(prompt).not.toContain("does not yet handle");
    expect(prompt).toContain("Do not take away or count Edge yourself.");
    expect(prompt).not.toContain("does not track Edge");
    expect(prompt).not.toContain("does not track injuries");
  });

  it("tells the GM that only the player burns Edge, and what a Smackdown or Not Dead Yet means for the story", () => {
    expect(prompt).toContain("Only the player chooses it, on the roll card or on a roll they hold; you never offer it, and it is not an Edge Action to pass on a tool.");
    expect(prompt).toContain("the Edge on a character's sheet above is their rank when the session began");
    expect(prompt).toContain("A Smackdown replaces the player's roll with an automatic success with four net hits");
    expect(prompt).toContain("It does not take them out of the danger they are in");
  });

  it("tells the GM how to declare an Edge Action: only when its need is met, by id, and which ones the system applies", () => {
    expect(prompt).toContain("pass its id as edgeAction on the request_roll or attack tool");
    expect(prompt).toContain("If what it needs is not true, tell the player instead of passing it.");
    expect(prompt).toContain("the player cannot also spend Edge on that roll");
    expect(prompt).toContain("The system applies Called Shot: Vitals and Called Shot: Disarm to an attack's damage itself");
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

  it("tells the GM what to do with an Edge report, in particular a special effect", () => {
    expect(prompt).toContain("You are told when a player spends Edge.");
    expect(prompt).toContain("a request for you to act");
    expect(prompt).toContain("It should help, not win the scene.");
    expect(prompt).toContain("may cause the opposition's glitch, which you will see on the result and must deal with");
  });

  it("tells the GM how Edge is gained: by rating gaps on its own, and by awards in a confrontation with a reason", () => {
    expect(prompt).toContain("the attacker's Attack Rating with it at this range, and the defender's Defense Rating (their Body plus any armor)");
    expect(prompt).toContain("so do not award that yourself");
    expect(prompt).toContain("Edge is gained only in such a confrontation.");
    expect(prompt).toContain("You may award a player 1 Edge with award_edge, giving a reason they will read");
    expect(prompt).toContain("a hack, a chase or a heated negotiation can all use start_combat");
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

  it("tells the GM about the campaign's notes: when to write them, to look before bringing someone back, to treat the memory message as true, and to keep it all from the players", () => {
    expect(prompt).toContain("# Campaign memory");
    for (const tool of ["note_npc", "note_thread", "recall"]) expect(prompt).toContain(tool);
    expect(prompt).toContain("PR 3, Body 3, Willpower 4");
    expect(prompt).toContain('A message that begins "CAMPAIGN MEMORY"');
    expect(prompt).toContain("never tell the players about them");
    expect(prompt).toContain("Nameless grunts are not noted.");
    expect(prompt).toContain('"BEGIN SESSION" with a number starts a new session');
    expect(prompt).toContain('"WRAP UP THE SESSION" means the table is saving the story so far');
    expect(prompt).toContain("call end_session");
    expect(prompt).toContain("a player character's earlier runs (history)");
    expect(prompt).toContain("end_session, at wrap-up, also carries what each player character earned in the run");
    // It comes before the privacy rule and the premise, so the premise stays last.
    expect(prompt.indexOf("# Campaign memory")).toBeLessThan(prompt.indexOf("# Privacy"));
    expect(prompt.indexOf("# Privacy")).toBeLessThan(prompt.indexOf("# This session"));
  });
});
