import { describe, expect, it } from "vitest";
import { MAX_NPCS, Roster } from "../../src/game/roster.js";
import { newMonitor } from "../../src/rules/index.js";
import { party } from "../helpers.js";

// Kira: Body 5, Willpower 3 -> Physical 11, Stun 10, Overflow 10. Doc: Body 3, Willpower 5 -> Physical 10, Stun 11, Overflow 6.
const fresh = () => new Roster(party, undefined);
const ganger = { kind: "npc" as const, id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };

describe("Roster: player characters", () => {
  it("starts everyone unhurt, with boxes from their attributes", () => {
    const kira = fresh().view("pc", "kira");
    expect(kira).toMatchObject({
      id: "kira",
      kind: "pc",
      name: "Kira",
      status: "active",
      woundModifier: 0,
      monitor: { physicalBoxes: 11, stunBoxes: 10, overflowBoxes: 10, physical: 0, stun: 0, overflow: 0 },
    });
    expect(fresh().view("pc", "doc")?.monitor).toMatchObject({ physicalBoxes: 10, stunBoxes: 11, overflowBoxes: 6 });
  });

  it("lists everyone, player characters first", () => {
    const roster = fresh();
    roster.resolve(ganger);
    expect(roster.views().map((v) => `${v.kind}:${v.id}`)).toEqual(["pc:kira", "pc:doc", "npc:ganger-1"]);
  });

  it("keeps saved damage when the game is loaded again", () => {
    const first = fresh();
    first.damage("pc", "kira", "physical", 4);
    first.damage("pc", "doc", "stun", 5);
    const second = new Roster(party, first.toSaved());
    expect(second.view("pc", "kira")?.monitor).toMatchObject({ physical: 4 });
    expect(second.view("pc", "doc")?.monitor).toMatchObject({ stun: 5 });
  });

  it("resizes the boxes if a character's attributes changed, keeping the damage and never more than the boxes", () => {
    const saved = { pcs: [{ id: "kira", monitor: { ...newMonitor(3, 3), physical: 8, overflow: 2 } }], npcs: [] };
    const stronger = new Roster(party, saved);
    expect(stronger.view("pc", "kira")?.monitor).toMatchObject({ physicalBoxes: 11, physical: 8, overflow: 2 });

    const weaker = new Roster([{ ...party[0]!, attributes: { ...party[0]!.attributes, body: 1 } }], { pcs: [{ id: "kira", monitor: { ...newMonitor(5, 3), physical: 11 } }], npcs: [] });
    expect(weaker.view("pc", "kira")?.monitor).toMatchObject({ physicalBoxes: 9, physical: 9 });
  });

  it("gives a character with no saved entry a fresh monitor", () => {
    const roster = new Roster(party, { pcs: [{ id: "kira", monitor: newMonitor(5, 3) }], npcs: [] });
    expect(roster.view("pc", "doc")?.monitor.physical).toBe(0);
  });
});

describe("Roster: treatments", () => {
  it("remembers who has had which treatment, and starts them over when the character is hurt again", () => {
    const roster = fresh();
    roster.damage("pc", "kira", "physical", 4);
    roster.markTreated("pc", "kira", "first_aid");
    expect(roster.hasBeenTreated("pc", "kira", "first_aid")).toBe(true);
    expect(roster.hasBeenTreated("pc", "kira", "medkit")).toBe(false);
    expect(roster.hasBeenTreated("pc", "doc", "first_aid")).toBe(false);

    roster.damage("pc", "kira", "physical", 0);
    expect(roster.hasBeenTreated("pc", "kira", "first_aid")).toBe(true);
    roster.damage("pc", "kira", "physical", 1);
    expect(roster.hasBeenTreated("pc", "kira", "first_aid")).toBe(false);
  });

  it("keeps treatments when the game is loaded again, for players and non-player characters", () => {
    const first = fresh();
    first.resolve(ganger);
    first.damage("pc", "kira", "physical", 4);
    first.damage("npc", "ganger-1", "physical", 3);
    first.markTreated("pc", "kira", "magic");
    first.markTreated("npc", "ganger-1", "medkit");
    const second = new Roster(party, first.toSaved());
    expect(second.hasBeenTreated("pc", "kira", "magic")).toBe(true);
    expect(second.hasBeenTreated("npc", "ganger-1", "medkit")).toBe(true);
    expect(second.hasBeenTreated("pc", "kira", "medkit")).toBe(false);
  });

  it("treats a save from before treatments were tracked as untreated", () => {
    const roster = new Roster(party, { pcs: [{ id: "kira", monitor: newMonitor(5, 3) }], npcs: [] });
    expect(roster.hasBeenTreated("pc", "kira", "first_aid")).toBe(false);
  });
});

describe("Roster: who can act and what wounds cost", () => {
  it("stops an unconscious or dead character acting, and says why", () => {
    const roster = fresh();
    expect(roster.canAct("kira")).toBeNull();
    roster.damage("pc", "kira", "stun", 10);
    expect(roster.canAct("kira")).toBe("Kira is unconscious and cannot act until healed.");
    roster.damage("pc", "kira", "physical", 21);
    expect(roster.canAct("kira")).toBe("Kira is dead and cannot act.");
  });

  it("charges a die for each complete row of three boxes on either track", () => {
    const roster = fresh();
    expect(roster.woundPenalty("kira")).toBe(0);
    roster.damage("pc", "kira", "physical", 2);
    roster.damage("pc", "kira", "stun", 2);
    expect(roster.woundPenalty("kira")).toBe(0);
    roster.damage("pc", "kira", "physical", 4);
    roster.damage("pc", "kira", "stun", 1);
    expect(roster.woundPenalty("kira")).toBe(3);
    expect(roster.view("pc", "kira")?.woundModifier).toBe(3);
  });

  it("knows nothing of a non-player character's ability to act", () => {
    expect(fresh().canAct("ganger-1")).toBeNull();
  });
});

describe("Roster: non-player characters", () => {
  it("adds one the first time it is named, with a name and attributes", () => {
    const roster = fresh();
    expect(roster.resolve(ganger)).toEqual({ ok: true, kind: "npc", id: "ganger-1", name: "Ganger", body: 3 });
    expect(roster.view("npc", "ganger-1")?.monitor).toMatchObject({ physicalBoxes: 10, stunBoxes: 10, overflowBoxes: 6 });
  });

  it("then knows them by id alone, and ignores different numbers given later", () => {
    const roster = fresh();
    roster.resolve(ganger);
    expect(roster.resolve({ kind: "npc", id: "ganger-1" })).toMatchObject({ ok: true, name: "Ganger", body: 3 });
    expect(roster.resolve({ ...ganger, name: "Someone Else", body: 9 })).toMatchObject({ name: "Ganger", body: 3 });
  });

  it.each([
    ["no name", { kind: "npc" as const, id: "g", body: 3, willpower: 3 }],
    ["no body", { kind: "npc" as const, id: "g", name: "G", willpower: 3 }],
    ["no willpower", { kind: "npc" as const, id: "g", name: "G", body: 3 }],
  ])("will not add one with %s, and says what is missing", (_label, ref) => {
    expect(fresh().resolve(ref)).toEqual({ ok: false, error: '"g" is new to the table. Give the NPC\'s name, body and willpower the first time you mention them.' });
  });

  it("refuses an id that belongs to a player character, or a player character who is not there", () => {
    expect(fresh().resolve({ ...ganger, id: "kira" })).toMatchObject({ ok: false, error: expect.stringContaining("is a player character") });
    expect(fresh().resolve({ kind: "pc", id: "nobody" })).toEqual({ ok: false, error: 'There is no player character "nobody" at the table.' });
  });

  it("can be asked not to add anyone", () => {
    expect(fresh().resolve({ kind: "npc", id: "ghost" }, { create: false })).toEqual({ ok: false, error: 'There is no non-player character "ghost" on the table.' });
  });

  it("stops tracking more than the limit", () => {
    const roster = fresh();
    for (let i = 0; i < MAX_NPCS; i++) expect(roster.resolve({ ...ganger, id: `n${i}` }).ok).toBe(true);
    expect(roster.resolve({ ...ganger, id: "one-too-many" })).toMatchObject({ ok: false, error: expect.stringContaining(`${MAX_NPCS}`) });
  });

  it("keeps them, hurt, when the game is loaded again", () => {
    const first = fresh();
    first.resolve(ganger);
    first.damage("npc", "ganger-1", "physical", 7);
    const second = new Roster(party, first.toSaved());
    expect(second.view("npc", "ganger-1")).toMatchObject({ name: "Ganger", monitor: { physical: 7 }, woundModifier: 2 });
  });
});

describe("Roster: damage and healing", () => {
  it("marks damage, carries stun into physical, and overflows into death", () => {
    const roster = fresh();
    expect(roster.damage("pc", "kira", "stun", 12).monitor).toMatchObject({ stun: 10, physical: 2 });
    const dead = roster.damage("pc", "kira", "physical", 19);
    expect(dead.monitor).toMatchObject({ physical: 11, overflow: 10 });
    expect(dead.status).toBe("dead");
  });

  it("heals no more than there is to heal, and says how much it did", () => {
    const roster = fresh();
    roster.damage("pc", "kira", "physical", 3);
    expect(roster.heal("pc", "kira", "physical", 5)).toMatchObject({ healed: 3, after: { monitor: { physical: 0 } } });
    expect(roster.heal("pc", "kira", "physical", 2).healed).toBe(0);
  });

  it("heals overflow separately, and brings a character back from unconscious", () => {
    const roster = fresh();
    roster.damage("pc", "doc", "physical", 12);
    expect(roster.view("pc", "doc")?.monitor).toMatchObject({ physical: 10, overflow: 2 });
    roster.heal("pc", "doc", "overflow", 2);
    expect(roster.heal("pc", "doc", "physical", 1).after.status).toBe("active");
  });

  it("will not hurt or heal someone who is not there", () => {
    expect(() => fresh().damage("pc", "nobody", "physical", 1)).toThrow();
    expect(() => fresh().heal("npc", "ghost", "physical", 1)).toThrow();
  });

  it("does not hand out its own monitors to be changed", () => {
    const roster = fresh();
    const view = roster.view("pc", "kira")!;
    view.monitor.physical = 9;
    expect(roster.view("pc", "kira")?.monitor.physical).toBe(0);
  });
});
