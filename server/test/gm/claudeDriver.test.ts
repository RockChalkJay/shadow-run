import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeGmDriver, type ClaudeDriverOptions } from "../../src/gm/claudeDriver.js";
import type { GameSession, SessionOptions } from "../../src/game/session.js";
import { always, newSession, party, rollInput } from "../helpers.js";

const FAKE_GM = fileURLToPath(new URL("../fake-claude-gm.mjs", import.meta.url));

type Step = { say: string } | { tool: string; args: unknown } | { hang: true };
interface Turn {
  sessionId?: string;
  lostSession?: boolean;
  steps: Step[];
}

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const thing of open.splice(0).reverse()) await thing.close();
});

/** A session whose GM is the real driver talking to a scripted stand-in for the `claude` CLI. */
async function table(script: Turn[], extra: Partial<ClaudeDriverOptions> = {}, sessionExtra: Partial<SessionOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sr-gm-"));
  const scriptFile = join(dir, "script.json");
  const logFile = join(dir, "log.jsonl");
  await writeFile(scriptFile, JSON.stringify(script));
  vi.stubEnv("FAKE_GM_SCRIPT", scriptFile);
  vi.stubEnv("FAKE_GM_LOG", logFile);

  const workDir = join(dir, "work");
  const driver = await ClaudeGmDriver.start({ party, claudeBin: FAKE_GM, workDir, ...extra });
  // The system's dice are fixed (no hits, no glitch) so replies that quote them have one shape.
  const made = await newSession(driver, { d6: always(3), ...sessionExtra });
  open.push(driver, made.session);

  const records = async (): Promise<Array<Record<string, any>>> => {
    const text = await readFile(logFile, "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const starts = async () => (await records()).filter((r) => r.kind === "start");
  const tools = async () => (await records()).filter((r) => r.kind === "tool");
  return { ...made, driver, workDir, records, starts, tools };
}

const requestedId = (events: Array<{ type: string }>) =>
  (events.find((e) => e.type === "roll.requested") as unknown as { request: { id: string } }).request.id;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a turn with the CLI", () => {
  it("shows the GM's words, puts its roll on the table, and holds for the dice", async () => {
    const t = await table([
      { steps: [{ say: "The guard turns." }, { tool: "request_roll", args: rollInput() }] },
      { steps: [{ say: "You slip by." }] },
    ]);
    await t.session.start();
    await t.session.whenIdle();

    expect(t.events.filter((e) => e.type === "gm.text").map((e) => (e as { text: string }).text).join("")).toBe("The guard turns.");
    expect(t.session.snapshot().pendingRolls).toHaveLength(1);
    expect(t.session.snapshot().gm).toEqual({ phase: "waiting_for_rolls" });
    const [reply] = await t.tools();
    expect(reply).toMatchObject({ tool: "request_roll", isError: false });
    expect(reply?.text).toContain("End your turn now");

    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 5 3 1" });
    await t.session.whenIdle();

    const [first, second] = await t.starts();
    expect(second?.resume).toBe("fake-session-1");
    expect(first?.resume).toBeUndefined();
    expect(second?.stdin).toContain("ROLL RESULT. Kira: Sneak past the guard.");
    expect((await t.store.recentEntries(20)).filter((e) => e.kind === "gm").map((e) => (e as { text: string }).text)).toEqual([
      "The guard turns.",
      "You slip by.",
    ]);
    expect(t.session.gmSessionId).toBe("fake-session-1");
  });

  it("runs the CLI the way the table intends", async () => {
    const t = await table([{ steps: [{ say: "Hello." }] }], { model: "haiku" });
    await t.session.start();
    await t.session.whenIdle();

    const [run] = await t.starts();
    expect(run).toMatchObject({
      stdin: "BEGIN SESSION. Open the first scene.",
      model: "haiku",
      allowedTools: "mcp__gm__request_roll,mcp__gm__roll_npc,mcp__gm__attack,mcp__gm__deal_damage,mcp__gm__heal,mcp__gm__award_edge,mcp__gm__start_combat,mcp__gm__join_combat,mcp__gm__next_round,mcp__gm__end_combat",
      settingSources: "",
    });
    expect(run?.systemPrompt).toContain("Kira (id: kira)");
    expect(await realpath(run?.cwd)).toBe(await realpath(t.workDir));
  });

  it("keeps the prompt and the tools secret off the command line, in files only this user can read", async () => {
    const t = await table([{ steps: [{ say: "Hello." }] }]);
    await t.session.start();
    await t.session.whenIdle();

    const [run] = await t.starts();
    const commandLine = (run?.argv as string[]).join(" ");
    expect(commandLine).not.toContain("Bearer");
    expect(commandLine).not.toContain("Kira (id");
    expect(run?.systemPromptFile).toBe(join(t.workDir, "system-prompt.md"));
    expect(run?.mcpConfigArg).toBe(join(t.workDir, "mcp.json"));
    expect((await stat(run?.systemPromptFile)).mode & 0o777).toBe(0o600);
    expect((await stat(run?.mcpConfigArg)).mode & 0o777).toBe(0o600);
  });

  it("sends the prompt fresh every turn, so a resumed session does not keep the one it began with", async () => {
    const t = await table([{ steps: [{ say: "One." }] }, { steps: [{ say: "Two." }] }]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "again");
    await t.session.whenIdle();
    const runs = await t.starts();
    expect(runs.map((r) => r.snapshot)).toEqual(["off", "off"]);
    expect(runs[1]?.resume).toBe("fake-session-1");
  });

  it("writes the latest party and premise into the prompt each time it starts", async () => {
    const first = await table([{ steps: [{ say: "Hi." }] }]);
    const extra = {
      ...party[0]!,
      id: "razor",
      name: "Razor",
      notes: "Demo. Human face.",
    };
    const second = await ClaudeGmDriver.start({ party: [...party, extra], premise: "A courier vanishes.", claudeBin: FAKE_GM, workDir: first.workDir });
    open.push(second);
    const written = await readFile(join(first.workDir, "system-prompt.md"), "utf8");
    expect(written).toContain("Razor (id: razor)");
    expect(written).toContain("A courier vanishes.");
  });

  it("copes with a premise far longer than a command line could hold", async () => {
    const t = await table([{ steps: [{ say: "Hello." }] }], { premise: "Long background. ".repeat(20_000) });
    await t.session.start();
    await t.session.whenIdle();
    expect(t.session.snapshot().gm).toEqual({ phase: "idle" });
    const [run] = await t.starts();
    expect((run?.systemPrompt as string).length).toBeGreaterThan(300_000);
  });

  it("lets the GM know a roll was refused, and why, so it can correct itself", async () => {
    const t = await table([{ steps: [{ say: "Hm." }, { tool: "request_roll", args: rollInput({ characterId: "nobody" }) }] }]);
    await t.session.start();
    await t.session.whenIdle();
    const [reply] = await t.tools();
    expect(reply).toMatchObject({ isError: true });
    expect(reply?.text).toContain('There is no character "nobody"');
    expect(t.events.some((e) => e.type === "roll.requested")).toBe(false);
  });

  it("hurts an NPC through the tools server and gives the GM the report in the same turn", async () => {
    const target = { kind: "npc", id: "ganger-1", name: "Ganger", body: 3, willpower: 3 };
    const t = await table([{ steps: [{ tool: "deal_damage", args: { label: "Pistol shot", target, damageValue: 5, damageType: "physical" } }, { say: "He staggers." }] }]);
    await t.session.start();
    await t.session.whenIdle();
    const [reply] = await t.tools();
    expect(reply).toMatchObject({ tool: "deal_damage", isError: false });
    expect(reply?.text).toMatch(/^DAMAGE RESULT\. Pistol shot: 5 physical damage to Ganger\.\nGanger resisted with Body 3/);
    expect(t.session.snapshot().characters.find((c) => c.id === "ganger-1")).toBeDefined();
  });

  it("puts a player's resistance roll on the table, and tells the GM how they stand once it is answered", async () => {
    const t = await table([
      { steps: [{ tool: "deal_damage", args: { label: "Pistol shot", target: { kind: "pc", id: "kira" }, damageValue: 7, damageType: "physical" } }] },
      { steps: [{ say: "She grits her teeth." }] },
    ]);
    await t.session.start();
    await t.session.whenIdle();
    const [reply] = await t.tools();
    expect(reply?.text).toContain("Kira must roll Body to resist 7 physical damage");

    await t.session.submitRoll(requestedId(t.events), { mode: "physical", dice: "6 5 3 1 1" });
    await t.session.whenIdle();
    const [, second] = await t.starts();
    expect(second?.stdin).toContain("DAMAGE RESULT. Pistol shot: 7 physical damage to Kira.");
    expect(second?.stdin).toContain("Kira: Physical 5/11");
  });

  it("refuses a heal that has no healing roll behind it, through the tools server", async () => {
    const t = await table([{ steps: [{ tool: "heal", args: { rollId: "made-up", type: "stun", boxes: 2, reason: "A medkit" } }] }]);
    await t.session.start();
    await t.session.whenIdle();
    const [healed] = await t.tools();
    expect(healed).toMatchObject({ tool: "heal", isError: true });
    expect(healed?.text).toContain("No healing roll with that id has hits to spend this turn");
  });

  it("answers an NPC roll straight away with the system's dice", async () => {
    const t = await table([{ steps: [{ tool: "roll_npc", args: { label: "Ganger fires", pool: 5, threshold: 2 } }, { say: "Bullets fly." }] }]);
    await t.session.start();
    await t.session.whenIdle();
    const [reply] = await t.tools();
    expect(reply).toMatchObject({ tool: "roll_npc", isError: false });
    expect(reply?.text).toMatch(/^NPC ROLL\. Ganger fires: 5 dice: [1-6 ]+ = \d hits?\.\nThreshold 2: (SUCCESS|FAILURE)\.$/);
    expect((await t.store.recentEntries(10)).some((e) => e.kind === "npc")).toBe(true);
  });
});

describe("when the game has a transcript but no GM session to resume", () => {
  it("tells the GM the story so far, which a new campaign has none of", async () => {
    const first = await table([{ steps: [{ say: "Rain falls." }] }]);
    await first.session.start();
    await first.session.whenIdle();
    expect((await first.starts())[0]?.stdin).not.toContain("Carry on from it");

    // The state a saved scenario starts from: everything but the GM's session.
    const { claudeSessionId, ...state } = (await first.store.loadState())!;
    expect(claudeSessionId).toBeDefined();
    await first.store.saveState(state);

    const second = await table([{ steps: [{ say: "Back again." }] }, { steps: [{ say: "Still here." }] }], {}, { store: first.store });
    await second.session.say("kira", "hello");
    await second.session.whenIdle();
    await second.session.say("kira", "and now?");
    await second.session.whenIdle();

    const [run, later] = await second.starts();
    expect(run?.resume).toBeUndefined();
    expect(run?.stdin).toContain("GM: Rain falls.");
    expect(run?.stdin).toContain("Carry on from it");
    expect(run?.stdin.match(/Kira: hello/g)).toHaveLength(1);
    // Once the GM has a session again it is resumed, and the story is not repeated to it.
    expect(later?.resume).toBe("fake-session-1");
    expect(later?.stdin).not.toContain("Carry on from it");
  });
});

describe("when the GM's session is lost", () => {
  it("starts a new one from the transcript, without repeating what is already in the turn", async () => {
    const t = await table([
      { steps: [{ say: "Rain falls." }] },
      { lostSession: true, steps: [] },
      { steps: [{ say: "Back again." }] },
    ]);
    await t.session.start();
    await t.session.whenIdle();
    await t.session.say("kira", "hello");
    await t.session.whenIdle();

    const [, lost, fresh] = await t.starts();
    expect(lost?.resume).toBe("fake-session-1");
    expect(fresh?.resume).toBeUndefined();
    expect(fresh?.stdin).toContain("GM: Rain falls.");
    expect(fresh?.stdin).toContain("Carry on from it");
    expect(fresh?.stdin.match(/Kira: hello/g)).toHaveLength(1);
    expect(t.session.gmSessionId).toBe("fake-session-3");
    expect(t.session.snapshot().gm).toEqual({ phase: "idle" });
    expect((await t.store.recentEntries(20)).at(-1)).toMatchObject({ kind: "gm", text: "Back again." });
  });

  it("does not start over for some other failure", async () => {
    const t = await table([{ steps: [{ say: "Hi." }] }], { claudeBin: "/nonexistent/claude" });
    await t.session.say("kira", "hi");
    await t.session.whenIdle();
    expect(t.session.snapshot().gm).toMatchObject({ phase: "error", message: expect.stringContaining("Could not start claude") });
  });
});

describe("a turn that goes wrong", () => {
  it("is an error when the GM neither speaks nor acts, so the table is not left waiting", async () => {
    const t = await table([{ steps: [] }]);
    await t.session.say("kira", "hello?");
    await t.session.whenIdle();
    expect(t.session.snapshot().gm).toEqual({ phase: "error", message: "The GM did not answer." });
  });

  it("stops the process when the turn is cancelled", async () => {
    const t = await table([{ steps: [{ say: "One moment" }, { hang: true }] }]);
    await t.session.say("kira", "hi");
    await vi.waitFor(() => expect(t.events.some((e) => e.type === "gm.text")).toBe(true));
    const [run] = await t.starts();

    expect(t.session.cancelTurn()).toEqual({ ok: true });
    await t.session.whenIdle();

    expect(t.session.snapshot().gm).toEqual({ phase: "error", message: "The turn was cancelled." });
    await vi.waitFor(() => expect(() => process.kill(run?.pid, 0)).toThrow());
  });
});
