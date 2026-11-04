import { describe, expect, it } from "vitest";
import { formatRecap } from "../../src/game/recap.js";
import type { GmDriver, GmTools, GmTurnContext } from "../../src/gm/driver.js";
import { scriptedD6 } from "../../src/rules/index.js";
import { newSession, toolRunner } from "../helpers.js";

// Kira: Reaction 5, Intuition 4 (base 9), 1 initiative die, Edge 3. Doc: Reaction 3, Intuition 4 (base 7), Edge 4.
const kira = { who: { kind: "pc", id: "kira" } };
const doc = { who: { kind: "pc", id: "doc" } };
const ganger = (over: object = {}) => ({
  who: { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 },
  initiative: { reaction: 3, intuition: 3, dice: 1 },
  ...over,
});
const guard = (n: number, over: object = {}) => ({
  who: { kind: "npc", id: `guard-${n}`, name: `Guard ${n}`, body: 2, willpower: 2, professionalRating: 3, charisma: 2 },
  initiative: { reaction: 2, intuition: 2, dice: 1 },
  group: "patrol",
  ...over,
});

/** Runs these tool calls in one GM turn, with the system's dice and tie coins scripted. */
async function turn(faces: number[], job: (tools: GmTools) => Promise<unknown>, coins: number[] = []) {
  const runner = toolRunner();
  const flips = [...coins];
  const t = await newSession(runner.driver, { d6: scriptedD6(faces), flip: () => flips.shift() ?? 0.5 });
  const result = await runner.run(t.session, (ctx: GmTurnContext) => job(ctx.tools));
  return { ...t, runner, result };
}
const text = (r: unknown) => (r as { text: string }).text;
const ids = (t: { session: { snapshot(): { combat: { order: Array<{ members: Array<{ id: string }> }> } | null } } }) =>
  t.session.snapshot().combat?.order.map((e) => e.members.map((m) => m.id).join("+"));

describe("starting a fight", () => {
  it("rolls initiative for everyone, from the sheet for a player and from the GM's numbers for anyone else, and reports the order", async () => {
    const { result, session } = await turn([4, 5], (tools) => tools.startCombat({ participants: [kira, ganger()] }));
    expect(text(result)).toBe(
      [
        "COMBAT BEGINS. Round 1. Initiative is rolled by the system and stands from round to round. Highest goes first:",
        "1. Kira: 13 (Reaction 5 + Intuition 4 = 9, plus 4 on 1D6). 1 major and 2 minor actions.",
        "2. Ganger: 11 (Reaction 3 + Intuition 3 = 6, plus 5 on 1D6). 1 major and 2 minor actions.",
        "Each turn, everyone acts once in this order. Call next_round when they all have, and end_combat when the fight is over.",
      ].join("\n"),
    );
    expect(session.snapshot().combat).toMatchObject({ round: 1, order: [{ score: 13 }, { score: 11 }] });
  });

  it("puts the highest score first whatever order the GM listed them in", async () => {
    const t = await turn([1, 6], (tools) => tools.startCombat({ participants: [kira, ganger()] }));
    expect(ids(t)).toEqual(["ganger-1", "kira"]);
  });

  it("counts extra initiative dice and caps the minor actions at five", async () => {
    const { result } = await turn([2, 2, 2, 2, 2], (tools) =>
      tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 3, intuition: 3, dice: 4 } })] }),
    );
    expect(text(result)).toContain("1. Ganger: 14 (Reaction 3 + Intuition 3 = 6, plus 8 on 4D6)");
    expect(text(result)).toContain("1 major and 5 minor actions.");
  });

  it("breaks a tie on Edge, using a grunt's Professional Rating as theirs", async () => {
    // Kira: 9 + 1 = 10 with Edge 3. The grunt: 9 + 1 = 10, with Professional Rating 5.
    const t = await turn([1, 1], (tools) =>
      tools.startCombat({ participants: [kira, guard(1, { initiative: { reaction: 5, intuition: 4, dice: 1 }, group: undefined, who: { kind: "npc", id: "g", name: "G", body: 2, willpower: 2, professionalRating: 5, charisma: 2 } })] }),
    );
    expect(ids(t)).toEqual(["g", "kira"]);
  });

  it("breaks a tie on a named character's Edge from the GM, and then on Reaction, then Intuition", async () => {
    const edge = await turn([1, 1], (tools) => tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 5, intuition: 4, dice: 1 }, edge: 6 })] }));
    expect(ids(edge)).toEqual(["ganger-1", "kira"]);
    const reaction = await turn([1, 1], (tools) => tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 6, intuition: 3, dice: 1 }, edge: 3 })] }));
    expect(ids(reaction)).toEqual(["ganger-1", "kira"]);
  });

  it("flips the stored coin when nothing else separates them", async () => {
    const low = await turn([1, 1], (tools) => tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 5, intuition: 4, dice: 1 }, edge: 3 })] }), [0.1, 0.9]);
    expect(ids(low)).toEqual(["kira", "ganger-1"]);
    const high = await turn([1, 1], (tools) => tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 5, intuition: 4, dice: 1 }, edge: 3 })] }), [0.9, 0.1]);
    expect(ids(high)).toEqual(["ganger-1", "kira"]);
  });

  it("rolls grunts with the same group label once and has them act together", async () => {
    // Two dice only: Kira's, then the whole patrol's. A third roll would run the script dry.
    // The others are listed with different numbers, which are ignored: the group takes the first one's.
    const { result, session } = (await turn([6, 3], (tools) =>
      tools.startCombat({ participants: [kira, guard(1), guard(2, { initiative: { reaction: 9, intuition: 9, dice: 3 } }), guard(3, { initiative: { reaction: 7, intuition: 7, dice: 2 } })] }),
    )) as { result: { text: string }; session: any };
    expect(result.text).toContain("2. Guard 1, Guard 2 and Guard 3 (acting together): 7 (Reaction 2 + Intuition 2 = 4, plus 3 on 1D6).");
    expect(session.snapshot().combat.order).toHaveLength(2);
  });

  it("saves the fight to the transcript and tells clients about it", async () => {
    const { store, events } = await turn([4, 5], (tools) => tools.startCombat({ participants: [kira, ganger()] }));
    expect((await store.recentEntries(10)).find((e) => e.kind === "combat")).toMatchObject({ event: "start", round: 1, names: ["Kira", "Ganger"] });
    expect(events).toContainEqual({ type: "combat.updated", combat: expect.objectContaining({ round: 1 }) });
  });
});

describe("a fight that cannot be started", () => {
  const refused = async (participants: unknown[], faces: number[] = [1, 1, 1, 1]) => text((await turn(faces, (tools) => tools.startCombat({ participants }))).result);

  it("without two people", async () => {
    expect(await refused([kira])).toContain("The fight was not valid");
  });

  it("when a player character is given initiative of their own, since their sheet gives it", async () => {
    expect(await refused([{ ...kira, initiative: { reaction: 9, intuition: 9, dice: 5 } }, ganger()])).toBe(
      "Kira's initiative comes from their sheet. Leave initiative out for a player character.",
    );
  });

  it("when a non-player character comes with no numbers", async () => {
    expect(await refused([kira, ganger({ initiative: undefined })])).toBe("Give initiative (reaction, intuition and dice) for Ganger, a non-player character.");
  });

  it("when someone is named twice", async () => {
    expect(await refused([kira, kira])).toBe("Kira is already in this fight.");
  });

  it("when a named character is put in a group, since only grunts roll together", async () => {
    expect(await refused([kira, ganger({ group: "thugs" })])).toBe("Ganger is not a grunt. Only grunts roll initiative together as a group.");
  });

  it("when someone is already down", async () => {
    const runner = toolRunner();
    const t = await newSession(runner.driver, { d6: scriptedD6([3, 3, 3, 3]) });
    const reply = await runner.run(t.session, async (ctx) => {
      await ctx.tools.dealDamage({ label: "Fall", target: { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 }, damageValue: 40, damageType: "physical" });
      return ctx.tools.startCombat({ participants: [kira, ganger()] });
    });
    expect(reply).toEqual({ ok: false, text: "Ganger is dead and cannot take part in the fight." });
  });

  it("while one is already under way", async () => {
    const { result } = await turn([1, 1], async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      return tools.startCombat({ participants: [kira, ganger()] });
    });
    expect(result).toEqual({ ok: false, text: "A fight is already under way (round 1). Use join_combat to add people, or end_combat first." });
  });
});

describe("rounds, joining and ending", () => {
  it("moves to the next round without rerolling or reordering", async () => {
    const { result, session } = await turn([4, 5], async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      return tools.nextRound();
    });
    expect(text(result)).toContain("NEW ROUND. Round 2.");
    expect(text(result)).toContain("1. Kira: 13");
    expect(text(result)).toContain("Initiative is not rerolled.");
    expect(session.snapshot().combat).toMatchObject({ round: 2, order: [{ score: 13 }, { score: 11 }] });
  });

  it("lets someone join: they roll and take their place by score, and no one already in the order moves", async () => {
    // Kira 9 + 4 = 13, the ganger 6 + 5 = 11; Doc joins with 7 + 5 = 12.
    const { result, session } = await turn([4, 5, 5], async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      return tools.joinCombat({ participants: [doc] });
    });
    expect(text(result)).toContain("JOINED THE FIGHT. Round 1.");
    expect(text(result)).toContain("2. Doc: 12 (Reaction 3 + Intuition 4 = 7, plus 5 on 1D6).");
    expect(session.snapshot().combat!.order.map((e: { members: Array<{ id: string }> }) => e.members[0]!.id)).toEqual(["kira", "doc", "ganger-1"]);
  });

  it("does not reshuffle two who tied when a third joins", async () => {
    // Kira (10, Edge 3) and the ganger (10, Edge 3, same Reaction and Intuition as her) tie on everything; the coins put the ganger first.
    const { session } = await turn(
      [1, 1, 6],
      async (tools) => {
        await tools.startCombat({ participants: [kira, ganger({ initiative: { reaction: 5, intuition: 4, dice: 1 }, edge: 3 })] });
        return tools.joinCombat({ participants: [doc] });
      },
      [0.9, 0.1, 0.5],
    );
    expect(session.snapshot().combat!.order.map((e: { members: Array<{ id: string }> }) => e.members[0]!.id)).toEqual(["doc", "ganger-1", "kira"]);
  });

  it("gives grunts who join under an existing group's label an entry of their own", async () => {
    // Kira 13, the patrol (4 + 3 = 7), then two more guards under the same label roll 4 + 5 = 9 on their own.
    const { session } = await turn([4, 3, 5], async (tools) => {
      await tools.startCombat({ participants: [kira, guard(1)] });
      return tools.joinCombat({ participants: [guard(2), guard(3)] });
    });
    const order = session.snapshot().combat!.order.map((e: { members: Array<{ id: string }>; score: number }) => `${e.members.map((m) => m.id).join("+")}:${e.score}`);
    expect(order).toEqual(["kira:13", "guard-2+guard-3:9", "guard-1:7"]);
  });

  it("refuses to join with no fight, or someone who is already in it", async () => {
    const none = await turn([], (tools) => tools.joinCombat({ participants: [doc] }));
    expect(none.result).toEqual({ ok: false, text: "There is no fight under way. Call start_combat to begin one." });
    const twice = await turn([1, 1], async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      return tools.joinCombat({ participants: [kira] });
    });
    expect(twice.result).toEqual({ ok: false, text: "Kira is already in this fight." });
  });

  it("ends the fight and says how long it lasted", async () => {
    const { result, session, events, store } = await turn([4, 5], async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      await tools.nextRound();
      return tools.endCombat();
    });
    expect(result).toEqual({ ok: true, text: "COMBAT ENDS after 2 rounds." });
    expect(session.snapshot().combat).toBeNull();
    expect(events.filter((e) => e.type === "combat.updated").at(-1)).toEqual({ type: "combat.updated", combat: null });
    expect((await store.recentEntries(10)).filter((e) => e.kind === "combat").map((e) => (e as { event: string }).event)).toEqual(["start", "round", "end"]);
  });

  it("refuses to move on or end when there is no fight", async () => {
    const next = await turn([], (tools) => tools.nextRound());
    expect(next.result).toEqual({ ok: false, text: "There is no fight under way. Call start_combat to begin one." });
    const end = await turn([], (tools) => tools.endCombat());
    expect(end.result).toEqual({ ok: false, text: "There is no fight under way." });
  });
});

describe("the fight in later turns", () => {
  /** A GM that does whatever job it is next given, and remembers what it was told. */
  async function table(faces: number[]) {
    const inputs: string[] = [];
    const jobs: Array<(ctx: GmTurnContext) => Promise<unknown>> = [];
    const results: unknown[] = [];
    const driver: GmDriver = {
      async takeTurn(input, ctx) {
        inputs.push(input.text);
        const job = jobs.shift();
        if (job) results.push(await job(ctx));
      },
    };
    const made = await newSession(driver, { d6: scriptedD6(faces), flip: () => 0.5 });
    const gm = async (job: (tools: GmTools) => Promise<unknown>) => {
      jobs.push((ctx) => job(ctx.tools));
      await made.session.say("kira", "go");
      await made.session.whenIdle();
      return results.at(-1);
    };
    return { ...made, inputs, gm };
  }

  it("tells the GM the round and the order at the top of every turn, and who is down", async () => {
    const t = await table([4, 5, 3, 3, 3, 3]);
    await t.gm((tools) => tools.startCombat({ participants: [kira, ganger()] }));
    await t.gm(() => Promise.resolve());
    expect(t.inputs.at(-1)).toMatch(/^COMBAT\. Round 1\. Order: Kira 13; Ganger 11\.\n/);

    await t.gm((tools) => tools.dealDamage({ label: "Fall", target: { kind: "npc", id: "ganger-1" }, damageValue: 10, damageType: "stun" }));
    await t.gm(() => Promise.resolve());
    expect(t.inputs.at(-1)).toContain("COMBAT. Round 1. Order: Kira 13; Ganger 11 [UNCONSCIOUS].");
  });

  it("says nothing about a fight when there is none", async () => {
    const t = await table([4, 5]);
    await t.gm((tools) => tools.startCombat({ participants: [kira, ganger()] }));
    await t.gm((tools) => tools.endCombat());
    await t.gm(() => Promise.resolve());
    expect(t.inputs.at(-1)).not.toContain("COMBAT.");
  });

  it("is still under way after a restart, with the same order and round", async () => {
    const first = await table([4, 5]);
    await first.gm(async (tools) => {
      await tools.startCombat({ participants: [kira, ganger()] });
      return tools.nextRound();
    });
    const before = first.session.snapshot().combat;
    await first.session.close();
    const second = await newSession(toolRunner().driver, { store: first.store });
    expect(second.session.snapshot().combat).toEqual(before);
    expect(before).toMatchObject({ round: 2 });
  });
});

describe("the fight in the recap", () => {
  it("lists when it began, who joined, each round and the end", () => {
    const entry = (e: object) => ({ id: 1, ts: "t", ...e }) as never;
    const text = formatRecap(
      [
        entry({ kind: "combat", event: "start", round: 1, names: ["Kira", "Ganger"] }),
        entry({ kind: "combat", event: "join", round: 1, names: ["Doc"] }),
        entry({ kind: "combat", event: "round", round: 2, names: [] }),
        entry({ kind: "combat", event: "end", round: 2, names: [] }),
      ],
      (id) => id,
    );
    expect(text).toBe(
      ["[Combat] A fight begins: Kira, Ganger.", "[Combat] Joined the fight: Doc.", "[Combat] Round 2 begins.", "[Combat] The fight ends after 2 rounds."].join("\n"),
    );
  });
});
