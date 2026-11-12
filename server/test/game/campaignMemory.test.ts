import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampaignMemory, formatBrief, MEMORY_FILES, npcLine, parseNpcs, parseSessions, parseThreads, recallText, withNpc, withSession, withThread, type LoggedSession, type Npc, type Thread } from "../../src/game/campaignMemory.js";

// Files laid out the way a table keeps them by hand.
const BIBLE = `# Campaign Bible

**Operating protocol:** follow the GM protocol as written.

---

## Setting & Tone

Seattle sprawl, gritty neon-noir. Blend of:
- **Awakened mystery** — carried forward from the last job.

## Standing Plot Threads

1. **The Train Fallout** — active, just starting. A corp has noticed the team.
2. **Gang Beef** — dormant/background. Will flare up now and then,
   not yet named.

## Major NPCs / Factions

(To be filled in as introduced.)

1. **Not a thread** — a numbered line in another section.

## Session Index

See \`session-log.md\`.
`;

const NPCS = `# NPC Tracker

Status legend: **Alive / Dead / Burned / Ally / Enemy / Unknown**

| Name | Role/Affiliation | Status | Notes |
| :--- | :--- | :--- | :--- |
| (none logged yet) | | | |

Add a stat block subsection below for any NPC who might roll dice.

### Stat blocks
(none)
`;

const LOG = `# Session Log

Append-only. Newest session at the bottom.

---

## Prior History (reconstructed, pre-log)

- **"Ghost Train"** — completed before this log began.

---
`;

const without = (text: string, line: string) => text.split("\n").filter((l) => l !== line).join("\n");

describe("the standing plot threads", () => {
  it("are the numbered items under their heading, with an item's indented lines counted in it", () => {
    expect(parseThreads(BIBLE)).toEqual([
      { number: 1, title: "The Train Fallout", text: "active, just starting. A corp has noticed the team." },
      { number: 2, title: "Gang Beef", text: "dormant/background. Will flare up now and then, not yet named." },
    ]);
  });

  it("are none when the file has no such section, or no file", () => {
    expect(parseThreads("# Campaign Bible\n\nJust prose.\n")).toEqual([]);
    expect(parseThreads("")).toEqual([]);
  });

  it("get a new thread after the last, and nothing else in the file changes", () => {
    const after = withThread(BIBLE, { title: "The Rail Yard", text: "open. Someone wants the cargo." });
    expect(after).toContain("3. **The Rail Yard** — open. Someone wants the cargo.");
    expect(without(after, "3. **The Rail Yard** — open. Someone wants the cargo.")).toBe(BIBLE);
    expect(parseThreads(after).map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("are numbered after the highest number in the file, not after how many there are", () => {
    const gappy = BIBLE.replace("2. **Gang Beef**", "5. **Gang Beef**");
    expect(withThread(gappy, { title: "New", text: "x" })).toContain("6. **New** — x");
  });

  it("have a thread of the same title rewritten in place, whatever its capitals, keeping its number and its neighbours", () => {
    const after = withThread(BIBLE, { title: "gang beef", text: "active. They burned the safehouse." });
    expect(after).toContain("2. **Gang Beef** — active. They burned the safehouse.");
    expect(after).not.toContain("not yet named");
    expect(after).toContain("1. **The Train Fallout** — active, just starting. A corp has noticed the team.");
    expect(after).toContain("1. **Not a thread** — a numbered line in another section.");
    expect(parseThreads(after)).toHaveLength(2);
  });

  it("keep a title that had ** in it readable, and find it again to update", () => {
    const once = withThread(BIBLE, { title: "A **b** c", text: "x" });
    expect(parseThreads(once).at(-1)).toMatchObject({ title: "A b c", text: "x" });
    const twice = withThread(once, { title: "a **b** C", text: "y" });
    expect(parseThreads(twice)).toHaveLength(3);
    expect(parseThreads(twice).at(-1)?.text).toBe("y");
  });

  it("are written on one line, whatever lines the text came in", () => {
    const after = withThread(BIBLE, { title: "Two\nlines", text: "a\n\nb   c" });
    expect(after).toContain("3. **Two lines** — a b c");
  });

  it("start the section when the file has none, and the file when there is none", () => {
    expect(withThread("# Campaign Bible\n\nProse.\n", { title: "A", text: "b" })).toBe("# Campaign Bible\n\nProse.\n\n## Standing Plot Threads\n\n1. **A** — b\n");
    expect(withThread("", { title: "A", text: "b" })).toBe("# Campaign Bible\n\n## Standing Plot Threads\n\n1. **A** — b\n");
  });

  it("go into a section that has no items yet, where it is, without crowding what follows", () => {
    const empty = "# Campaign Bible\n\n## Standing Plot Threads\n\n## Session Index\n\nSee the log.\n";
    expect(withThread(empty, { title: "A", text: "b" })).toBe("# Campaign Bible\n\n## Standing Plot Threads\n\n1. **A** — b\n\n## Session Index\n\nSee the log.\n");
    const bare = "## Standing Plot Threads\n## Next\n";
    expect(withThread(bare, { title: "A", text: "b" })).toBe("## Standing Plot Threads\n1. **A** — b\n\n## Next\n");
  });
});

describe("the NPC tracker", () => {
  const FILE = "npc-tracker.md";

  it("lists no one while it holds only the placeholder row", () => {
    expect(parseNpcs(FILE, NPCS)).toEqual([]);
  });

  it("takes the first NPC in place of the placeholder, adds a Stats column, and leaves everything outside the table as it was", () => {
    const after = withNpc(FILE, NPCS, { name: "Mr. Smith", role: "Fixer, Renraku", status: "Ally", stats: "PR 3, Body 3, Willpower 4", notes: "Pays on time" });
    expect(after).toContain("| Name | Role/Affiliation | Status | Stats | Notes |");
    expect(after).toContain("| Mr. Smith | Fixer, Renraku | Ally | PR 3, Body 3, Willpower 4 | Pays on time |");
    expect(after).not.toContain("none logged yet");
    expect(after.split("\n").filter((l) => !l.startsWith("|")).join("\n")).toBe(NPCS.split("\n").filter((l) => !l.startsWith("|")).join("\n"));
    expect(parseNpcs(FILE, after)).toEqual([{ name: "Mr. Smith", role: "Fixer, Renraku", status: "Ally", stats: "PR 3, Body 3, Willpower 4", notes: "Pays on time" }]);
  });

  it("adds the next NPC under the last, and an NPC with nothing said about them is Unknown", () => {
    const one = withNpc(FILE, NPCS, { name: "Mr. Smith", role: "Fixer" });
    const two = withNpc(FILE, one, { name: "Ganger" });
    expect(parseNpcs(FILE, two).map((n) => [n.name, n.status])).toEqual([["Mr. Smith", "Unknown"], ["Ganger", "Unknown"]]);
  });

  it("updates only the parts given for an NPC already there, whatever the capitals, and keeps their name as written", () => {
    const one = withNpc(FILE, NPCS, { name: "Mr. Smith", role: "Fixer", status: "Ally", notes: "Pays on time" });
    const after = withNpc(FILE, one, { name: "mr. smith", status: "Burned", stats: "PR 3" });
    expect(parseNpcs(FILE, after)).toEqual([{ name: "Mr. Smith", role: "Fixer", status: "Burned", stats: "PR 3", notes: "Pays on time" }]);
  });

  it("keeps the rows it was not asked about, cell for cell", () => {
    const table = "| Name | Role | Status | Notes |\n| --- | --- | --- | --- |\n| Ana | Doc | Ally | stitches runners |\n| Bo | Cop | Enemy | on the take |\n";
    const after = withNpc(FILE, table, { name: "Cy", status: "Alive" });
    expect(parseNpcs(FILE, after).map((n) => [n.name, n.role, n.status, n.notes])).toEqual([
      ["Ana", "Doc", "Ally", "stitches runners"],
      ["Bo", "Cop", "Enemy", "on the take"],
      ["Cy", "", "Alive", ""],
    ]);
  });

  it("keeps a column the system does not know, and does not add Stats twice", () => {
    const table = "| Name | Status | Last seen | Notes |\n| --- | --- | --- | --- |\n| Ana | Ally | the docks | doc |\n";
    const once = withNpc(FILE, table, { name: "Ana", stats: "PR 1" });
    expect(once).toContain("| Name | Status | Last seen | Stats | Notes |");
    expect(once).toContain("| Ana | Ally | the docks | PR 1 | doc |");
    expect(withNpc(FILE, once, { name: "Ana", stats: "PR 2" }).match(/Stats/g)).toHaveLength(1);
  });

  it("reads a table whose separator row uses single dashes, as the markdown rules allow", () => {
    expect(parseNpcs(FILE, "| Name | Status |\n|-|:-:|\n| Ana | Ally |\n").map((n) => n.name)).toEqual(["Ana"]);
  });

  it("keeps a pipe inside a cell", () => {
    const after = withNpc(FILE, NPCS, { name: "Ana", notes: "owes a|b" });
    expect(parseNpcs(FILE, after)[0]?.notes).toBe("owes a|b");
  });

  it("is the first table with a Name column, whatever other tables the file has", () => {
    const file = "| Faction | Reach |\n| --- | --- |\n| Ares | global |\n\nPeople:\n\n| Name | Status |\n| --- | --- |\n| Ana | Ally |\n";
    expect(parseNpcs(FILE, file).map((n) => n.name)).toEqual(["Ana"]);
    const after = withNpc(FILE, file, { name: "Bo" });
    expect(after.startsWith("| Faction | Reach |\n| --- | --- |\n| Ares | global |\n\nPeople:")).toBe(true);
    expect(parseNpcs(FILE, after).map((n) => n.name)).toEqual(["Ana", "Bo"]);
  });

  it("does not trip over another table's odd rows", () => {
    const file = "| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n\n| Name |\n| --- |\n| Ana |\n";
    expect(parseNpcs(FILE, file).map((n) => n.name)).toEqual(["Ana"]);
  });

  it("starts the table when the file has none, and the file when there is none", () => {
    const prose = withNpc(FILE, "# NPC Tracker\n\nNobody yet.\n", { name: "Ana" });
    expect(prose).toContain("Nobody yet.");
    expect(parseNpcs(FILE, prose).map((n) => n.name)).toEqual(["Ana"]);
    const fresh = withNpc(FILE, "", { name: "Ana", status: "Ally" });
    expect(fresh).toContain("Status legend");
    expect(parseNpcs(FILE, fresh)).toMatchObject([{ name: "Ana", status: "Ally" }]);
  });

  it("refuses a table it cannot rewrite safely, naming the file and line, and leaves it alone", () => {
    const wide = "| Name | Status |\n| --- | --- |\n| Ana | Ally | extra |\n";
    expect(() => withNpc(FILE, wide, { name: "Bo" })).toThrow(/npc-tracker\.md line 3 has 3 columns, and the table has 2/);
    expect(() => parseNpcs(FILE, wide)).toThrow(/line 3/);
    expect(() => withNpc(FILE, "| Who | Status |\n| --- | --- |\n| Ana | Ally |\n", { name: "Bo" })).toThrow(/npc-tracker\.md line 1: the table has no Name column/);
    expect(() => withNpc(FILE, "Intro\n\n| Who | Status |\n| --- | --- |\n| Ana | Ally |\n", { name: "Bo" })).toThrow(/npc-tracker\.md line 3: the table has no Name column/);
  });
});

describe("the session log", () => {
  it("is empty until a session is added", () => {
    expect(parseSessions(LOG)).toEqual([]);
    expect(parseSessions("")).toEqual([]);
  });

  it("gets a session at the end, numbered from 1, and the file before it is kept exactly", () => {
    const { text, number } = withSession(LOG, { date: "2026-11-12", fictionDate: "Tue 14 Mar 2081, evening", summary: "The team met Mr. Smith.", rolls: "Sneak: success", consequences: "Each gains 3 Karma." });
    expect(number).toBe(1);
    expect(text.startsWith(LOG.trimEnd())).toBe(true);
    expect(text).toContain("## Session 1 — 2026-11-12 (in fiction: Tue 14 Mar 2081, evening)\n\nThe team met Mr. Smith.\n\n**Key rolls:** Sneak: success\n\n**Consequences:** Each gains 3 Karma.\n");
    expect(parseSessions(text)).toEqual([{ number: 1, heading: "Session 1 — 2026-11-12 (in fiction: Tue 14 Mar 2081, evening)", body: "The team met Mr. Smith.\n\n**Key rolls:** Sneak: success\n\n**Consequences:** Each gains 3 Karma." }]);
  });

  it("numbers the next after the last, and leaves the earlier ones untouched", () => {
    const first = withSession(LOG, { date: "2026-11-12", summary: "One." }).text;
    const second = withSession(first, { date: "2026-11-19", summary: "Two." });
    expect(second.number).toBe(2);
    expect(second.text.startsWith(first.trimEnd())).toBe(true);
    expect(parseSessions(second.text).map((s) => [s.number, s.body])).toEqual([[1, "One."], [2, "Two."]]);
  });

  it("numbers the next after the highest in the file, not after how many there are", () => {
    const later = withSession(LOG, { date: "2026-11-12", summary: "One.", number: 7 }).text;
    expect(withSession(later, { date: "2026-11-19", summary: "Two." }).number).toBe(8);
  });

  it("does not count the rule between entries as part of one", () => {
    const ruled = "## Session 1 — 2026-11-12\n\nOne.\n\n---\n\n## Session 2 — 2026-11-19\n\nTwo.\n\n---\n";
    expect(parseSessions(ruled).map((s) => s.body)).toEqual(["One.", "Two."]);
  });

  it("cannot be given another session by what is written in it", () => {
    const sneaky = withSession(LOG, { date: "2026-11-12", summary: "Before.\n## Session 9 — fake\nAfter.", rolls: "# Session 8", consequences: "ok\n## Session 7" });
    expect(parseSessions(sneaky.text).map((s) => s.number)).toEqual([1]);
    expect(sneaky.text).toContain("\\## Session 9 — fake");
    expect(withSession(sneaky.text, { date: "2026-11-19", summary: "Next." }).number).toBe(2);
  });

  it("puts the date on one line", () => {
    expect(withSession("", { date: "2026-11-12\n## Session 5", summary: "s" }).text).toContain("## Session 1 — 2026-11-12 ## Session 5\n");
  });

  it("will not use a number twice, since it only ever adds", () => {
    const first = withSession(LOG, { date: "2026-11-12", summary: "One." }).text;
    expect(() => withSession(first, { date: "2026-11-19", summary: "Again.", number: 1 })).toThrow("Session 1 is already in the log");
    expect(withSession(first, { date: "2026-11-19", summary: "Later.", number: 7 }).number).toBe(7);
  });

  it("starts the file when there is none, and leaves out parts that were not given", () => {
    const { text } = withSession("", { date: "2026-11-12", summary: "One." });
    expect(text).toContain("Append-only.");
    expect(text).not.toContain("Key rolls");
    expect(text).not.toContain("in fiction");
  });
});

describe("a campaign's memory on disk", () => {
  const folder = () => mkdtemp(join(tmpdir(), "sr-memory-"));

  it("reads as empty when no file is there yet, and creates the files as they are needed", async () => {
    const dir = await folder();
    const memory = new CampaignMemory(dir);
    expect(await memory.threads()).toEqual([]);
    expect(await memory.npcs()).toEqual([]);
    expect(await memory.sessions()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);

    await memory.setThread({ title: "A", text: "b" });
    await memory.setNpc({ name: "Ana", status: "Ally" });
    expect(await memory.logSession({ date: "2026-11-12", summary: "One." })).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([MEMORY_FILES.bible, MEMORY_FILES.npcs, MEMORY_FILES.log].sort());
    expect((await memory.threads()).map((t) => t.title)).toEqual(["A"]);
    expect((await memory.npcs()).map((n) => n.name)).toEqual(["Ana"]);
    expect((await memory.sessions()).map((s) => s.number)).toEqual([1]);
  });

  it("reads what an earlier change has not finished writing yet", async () => {
    // Each read is the first thing asked after one write, so it must wait for that write itself.
    const npcs = new CampaignMemory(await folder());
    const a = npcs.setNpc({ name: "Ana" });
    expect((await npcs.npcs()).map((n) => n.name)).toEqual(["Ana"]);
    const threads = new CampaignMemory(await folder());
    const b = threads.setThread({ title: "A", text: "b" });
    expect((await threads.threads()).map((t) => t.title)).toEqual(["A"]);
    const log = new CampaignMemory(await folder());
    const c = log.logSession({ date: "2026-11-12", summary: "s" });
    expect((await log.sessions()).map((s) => s.number)).toEqual([1]);
    await Promise.all([a, b, c]);
  });

  it("works on the files a person wrote, and leaves no temporary file behind", async () => {
    const dir = await folder();
    await writeFile(join(dir, MEMORY_FILES.bible), BIBLE);
    await writeFile(join(dir, MEMORY_FILES.npcs), NPCS);
    const memory = new CampaignMemory(dir);
    await memory.setThread({ title: "Gang Beef", text: "active. Flared up." });
    await memory.setNpc({ name: "Mr. Smith", status: "Ally" });
    expect(await readFile(join(dir, MEMORY_FILES.bible), "utf8")).toContain("2. **Gang Beef** — active. Flared up.");
    expect(await readFile(join(dir, MEMORY_FILES.bible), "utf8")).toContain("**Operating protocol:** follow the GM protocol as written.");
    expect((await memory.npcs()).map((n) => n.name)).toEqual(["Mr. Smith"]);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every change when several arrive at once", async () => {
    const dir = await folder();
    const memory = new CampaignMemory(dir);
    await Promise.all(["Ana", "Bo", "Cy", "Di", "Ed"].map((name) => memory.setNpc({ name })));
    expect((await memory.npcs()).map((n) => n.name).sort()).toEqual(["Ana", "Bo", "Cy", "Di", "Ed"]);
    expect(await Promise.all([1, 2, 3].map(() => memory.logSession({ date: "2026-11-12", summary: "s" })))).toEqual([1, 2, 3]);
  });

  it("names the file when it cannot be read, or is a table it cannot rewrite, and changes nothing", async () => {
    const dir = await folder();
    await mkdir(join(dir, MEMORY_FILES.bible));
    await expect(new CampaignMemory(dir).threads()).rejects.toThrow(/campaign-bible\.md could not be read/);

    const other = await folder();
    const bad = "| Who | Status |\n| --- | --- |\n| Ana | Ally |\n";
    await writeFile(join(other, MEMORY_FILES.npcs), bad);
    await expect(new CampaignMemory(other).setNpc({ name: "Bo" })).rejects.toThrow(/npc-tracker\.md line 1/);
    expect(await readFile(join(other, MEMORY_FILES.npcs), "utf8")).toBe(bad);
    // A refused change does not block the next one.
    await expect(new CampaignMemory(other).logSession({ date: "2026-11-12", summary: "s" })).resolves.toBe(1);
  });
});

describe("ensuring an NPC is in the tracker", () => {
  it("adds one who is not there, and leaves one who is exactly as they are, without rewriting the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-memory-"));
    const odd = "| Name | Status | Notes |\n|:--|:-:|---|\n| Ana |  Ally  | keeps   spacing |\n";
    await writeFile(join(dir, MEMORY_FILES.npcs), odd);
    const memory = new CampaignMemory(dir);
    await memory.ensureNpc({ name: "ana", stats: "PR 9" });
    expect(await readFile(join(dir, MEMORY_FILES.npcs), "utf8")).toBe(odd);
    await memory.ensureNpc({ name: "Bo", stats: "Body 3, Willpower 3" });
    expect((await memory.npcs()).map((n) => [n.name, n.stats])).toEqual([["Ana", ""], ["Bo", "Body 3, Willpower 3"]]);
  });
});

describe("what a new conversation is told", () => {
  const thread = (n: number, text = "active. Going on."): Thread => ({ number: n, title: `Thread ${n}`, text });
  const npc = (n: number): Npc => ({ name: `NPC ${n}`, role: "Fixer", status: "Ally", stats: "PR 3", notes: "never in the brief" });
  const session: LoggedSession = { number: 2, heading: "Session 2 — 2026-11-19", body: "The team escaped." };

  it("is nothing when nothing is noted", () => {
    expect(formatBrief([], [], [])).toBe("");
  });

  it("has the threads, a line for each NPC and how the last session ended, and says it is true", () => {
    const brief = formatBrief([thread(1)], [npc(1)], [{ ...session, number: 1, heading: "Session 1", body: "Earlier." }, session]);
    expect(brief.split("\n")[0]).toMatch(/^CAMPAIGN MEMORY\. .*Treat it as true/);
    expect(brief).toContain("Standing plot threads:\n- Thread 1: active. Going on.");
    expect(brief).toContain("Non-player characters the party has met:\n- NPC 1 (Fixer): Ally. PR 3.");
    expect(brief).toContain("Last session, Session 2 — 2026-11-19:\nThe team escaped.");
    expect(brief).not.toContain("Earlier.");
    expect(brief).not.toContain("never in the brief");
  });

  it("leaves out the parts that are empty", () => {
    expect(formatBrief([], [npc(1)], [])).not.toContain("Standing plot threads");
    expect(formatBrief([thread(1)], [], [])).not.toContain("Non-player characters");
    expect(formatBrief([thread(1)], [], [])).not.toContain("Last session");
  });

  it("stays short: a few of each, clipped, and a count of the rest", () => {
    const brief = formatBrief(Array.from({ length: 20 }, (_, i) => thread(i + 1, "x".repeat(500))), Array.from({ length: 50 }, (_, i) => npc(i + 1)), [{ ...session, body: "y".repeat(3000) }]);
    expect(brief).toContain("- Thread 12:");
    expect(brief).not.toContain("- Thread 13:");
    expect(brief).toContain("- and 8 more");
    expect(brief).toContain("- NPC 40 (Fixer)");
    expect(brief).not.toContain("- NPC 41 ");
    expect(brief).toContain("- and 10 more");
    expect(brief).not.toContain("x".repeat(221));
    expect(brief).not.toContain("y".repeat(901));
    expect(brief.length).toBeLessThan(6000);
  });

  it("writes an NPC as name, role, status and stats", () => {
    expect(npcLine({ name: "Ana", role: "", status: "", stats: "", notes: "" })).toBe("Ana: Unknown.");
    expect(npcLine(npc(1))).toBe("NPC 1 (Fixer): Ally. PR 3.");
  });
});

describe("what the GM recalls", () => {
  const notes = { threads: [] as Thread[], npcs: [{ name: "Mr. Smith", role: "Fixer", status: "Ally", stats: "", notes: "" }, { name: "Ms. Smithson", role: "", status: "Enemy", stats: "", notes: "" }], sessions: [1, 2, 3, 4].map((n) => ({ number: n, heading: `Session ${n}`, body: `Body ${n}` })) };

  it("finds an NPC by the whole name before part of it", () => {
    expect(recallText({ what: "npc", name: "ms. smithson" }, notes).text).toBe("Ms. Smithson: Enemy.");
    expect(recallText({ what: "npc", name: "smith" }, notes).text).toBe("Mr. Smith (Fixer): Ally.");
  });

  it("prefers the NPC whose whole name was given over one whose name only contains it", () => {
    const both = { ...notes, npcs: [{ name: "Ana Maria", role: "", status: "Enemy", stats: "", notes: "" }, { name: "Ana", role: "", status: "Ally", stats: "", notes: "" }] };
    expect(recallText({ what: "npc", name: "ana" }, both).text).toBe("Ana: Ally.");
  });

  it("gives the last sessions asked for, oldest first, and one by default", () => {
    expect(recallText({ what: "sessions" }, notes).text).toBe("Session 4\nBody 4");
    expect(recallText({ what: "sessions", last: 2 }, notes).text).toBe("Session 3\nBody 3\n\nSession 4\nBody 4");
  });

  it("clips a long session", () => {
    const long = { ...notes, sessions: [{ number: 1, heading: "Session 1", body: "z".repeat(5000) }] };
    expect(recallText({ what: "sessions" }, long).text.length).toBeLessThan(1600);
  });
});
