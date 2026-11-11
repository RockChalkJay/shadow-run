import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * What a campaign remembers between sessions, kept as three markdown files in the campaign's folder, in the layout a table keeps
 * them by hand: a bible with the standing plot threads, an NPC tracker, and an append-only session log. The system reads and
 * rewrites only the thread list and the NPC table, and appends to the log; every other word of a file is kept as it was written.
 */
export const MEMORY_FILES = { bible: "campaign-bible.md", npcs: "npc-tracker.md", log: "session-log.md" } as const;

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// ---- standing plot threads --------------------------------------------------------------------------------------------------

/** One numbered item under "Standing Plot Threads": `1. **Title** — what is going on`. */
export interface Thread {
  number: number;
  title: string;
  /** Everything after the title: the status and what is going on, as written. */
  text: string;
}

const THREADS_HEADING = /^##\s+Standing Plot Threads\s*$/i;
const ITEM = /^(\d+)\.\s+\*\*(.+?)\*\*\s*(?:[—–-]+\s*)?(.*)$/;

interface ThreadItem extends Thread {
  /** The lines the item takes up in the file, from its first line to its last. */
  from: number;
  to: number;
}

/** Where the thread section is and the numbered items in it; text that is not an item is left alone. */
function threadSection(lines: readonly string[]): { heading: number; end: number; items: ThreadItem[] } | null {
  const heading = lines.findIndex((line) => THREADS_HEADING.test(line));
  if (heading === -1) return null;
  let end = lines.findIndex((line, i) => i > heading && /^#{1,2}\s/.test(line));
  if (end === -1) end = lines.length;
  const items: ThreadItem[] = [];
  for (let i = heading + 1; i < end; i++) {
    const match = ITEM.exec(lines[i]!);
    if (!match) continue;
    let to = i;
    // An item goes on over the indented lines that follow it.
    while (to + 1 < end && /^\s+\S/.test(lines[to + 1]!)) to++;
    const text = oneLine([match[3]!, ...lines.slice(i + 1, to + 1)].join(" "));
    items.push({ number: Number(match[1]), title: match[2]!.trim(), text, from: i, to });
    i = to;
  }
  return { heading, end, items };
}

/** The standing plot threads, in the order the file lists them. */
export function parseThreads(text: string): Thread[] {
  const section = threadSection(text.split("\n"));
  return (section?.items ?? []).map(({ number, title, text: body }) => ({ number, title, text: body }));
}

const threadLine = (number: number, title: string, text: string) => `${number}. **${oneLine(title)}** — ${oneLine(text)}`;

/** The file with a thread added, or the one of that title (any capitals) rewritten in place; nothing else in it changes. */
export function withThread(file: string, thread: { title: string; text: string }): string {
  const lines = file.split("\n");
  const section = threadSection(lines);
  if (!section) {
    const body = file.trim() === "" ? "# Campaign Bible\n" : file.replace(/\s*$/, "\n");
    return `${body}\n## Standing Plot Threads\n\n${threadLine(1, thread.title, thread.text)}\n`;
  }
  const same = section.items.find((item) => item.title.toLowerCase() === oneLine(thread.title).toLowerCase());
  if (same) {
    lines.splice(same.from, same.to - same.from + 1, threadLine(same.number, same.title, thread.text));
    return lines.join("\n");
  }
  const number = Math.max(0, ...section.items.map((item) => item.number)) + 1;
  const last = section.items.at(-1);
  if (last) {
    lines.splice(last.to + 1, 0, threadLine(number, thread.title, thread.text));
  } else {
    // No items yet: put the first after the heading and its blank line.
    const at = lines[section.heading + 1] === "" ? section.heading + 2 : section.heading + 1;
    const next = lines[at];
    lines.splice(at, 0, threadLine(number, thread.title, thread.text), ...(next !== undefined && next !== "" ? [""] : []));
  }
  return lines.join("\n");
}

// ---- NPC tracker --------------------------------------------------------------------------------------------------------------

export interface Npc {
  name: string;
  role: string;
  /** Alive, Dead, Burned, Ally, Enemy or Unknown, as the file's legend says; any words are kept. */
  status: string;
  /** What a returning character needs to be rolled for: "PR 5, Body 5, Willpower 4". */
  stats: string;
  notes: string;
}

const NPC_HEADER = ["Name", "Role/Affiliation", "Status", "Stats", "Notes"];

interface Table {
  /** Index of the header line, and of the last line of the table. */
  from: number;
  to: number;
  header: string[];
  rows: string[][];
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());

const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** The first table in the file: a header line, a separator line, and the rows after them. */
function findTable(lines: readonly string[], file: string): Table | null {
  const from = lines.findIndex((line, i) => line.trim().startsWith("|") && lines[i + 1] !== undefined && isSeparator(lines[i + 1]!));
  if (from === -1) return null;
  const header = cells(lines[from]!);
  let to = from + 1;
  const rows: string[][] = [];
  while (to + 1 < lines.length && lines[to + 1]!.trim().startsWith("|")) {
    to++;
    const row = cells(lines[to]!);
    if (row.length > header.length) throw new Error(`${file} line ${to + 1} has ${row.length} columns, and the table has ${header.length}; fix it by hand and try again`);
    rows.push([...row, ...Array(header.length - row.length).fill("")]);
  }
  return { from, to, header, rows };
}

const column = (header: readonly string[], ...names: string[]) => header.findIndex((cell) => names.some((name) => cell.toLowerCase().startsWith(name)));

const escapeCell = (text: string) => oneLine(text).replace(/\|/g, "\\|");
const renderRow = (row: readonly string[]) => `| ${row.map(escapeCell).join(" | ")} |`;
const renderTable = (header: readonly string[], rows: readonly string[][]) => [renderRow(header), `| ${header.map(() => ":---").join(" | ")} |`, ...rows.map(renderRow)];

const isPlaceholder = (row: readonly string[]) => /^\(.*\)$/.test(row[0] ?? "") && row.slice(1).every((cell) => cell === "");

/** The NPCs in the tracker's table. */
export function parseNpcs(file: string, text: string): Npc[] {
  const table = findTable(text.split("\n"), file);
  if (!table) return [];
  const at = {
    name: column(table.header, "name"),
    role: column(table.header, "role"),
    status: column(table.header, "status"),
    stats: column(table.header, "stats"),
    notes: column(table.header, "notes"),
  };
  if (at.name === -1) throw new Error(`${file} line ${table.from + 1}: the table has no Name column`);
  const get = (row: readonly string[], i: number) => (i === -1 ? "" : (row[i] ?? ""));
  return table.rows
    .filter((row) => !isPlaceholder(row))
    .map((row) => ({ name: get(row, at.name), role: get(row, at.role), status: get(row, at.status), stats: get(row, at.stats), notes: get(row, at.notes) }));
}

/**
 * The file with an NPC added to the table, or the row of that name (any capitals) updated with the parts given; the other rows
 * and every line outside the table keep their words. A Stats column is added if the table does not have one.
 */
export function withNpc(file: string, text: string, npc: Partial<Npc> & { name: string }): string {
  if (text.trim() === "") {
    return `${["# NPC Tracker", "", "Status legend: **Alive / Dead / Burned / Ally / Enemy / Unknown**", "", ...renderTable(NPC_HEADER, [npcRow(NPC_HEADER, npc)])].join("\n")}\n`;
  }
  const lines = text.split("\n");
  const table = findTable(lines, file);
  if (!table) {
    const body = text.replace(/\s*$/, "\n");
    return `${body}\n${renderTable(NPC_HEADER, [npcRow(NPC_HEADER, npc)]).join("\n")}\n`;
  }
  let { header, rows } = table;
  if (column(header, "name") === -1) throw new Error(`${file} line ${table.from + 1}: the table has no Name column`);
  if (column(header, "stats") === -1) {
    const before = column(header, "notes");
    const insertAt = before === -1 ? header.length : before;
    header = [...header.slice(0, insertAt), "Stats", ...header.slice(insertAt)];
    rows = rows.map((row) => [...row.slice(0, insertAt), "", ...row.slice(insertAt)]);
  }
  const nameAt = column(header, "name");
  const existing = rows.find((row) => row[nameAt]!.toLowerCase() === oneLine(npc.name).toLowerCase());
  if (existing) {
    const updated = npcRow(header, npc, existing);
    rows = rows.map((row) => (row === existing ? updated : row));
  } else {
    rows = [...rows.filter((row) => !isPlaceholder(row)), npcRow(header, npc)];
  }
  lines.splice(table.from, table.to - table.from + 1, ...renderTable(header, rows));
  return lines.join("\n");
}

/** A table row for an NPC: the parts given, over the row it replaces if there is one; a new NPC's status is Unknown until it is said. */
function npcRow(header: readonly string[], npc: Partial<Npc> & { name: string }, was?: readonly string[]): string[] {
  const row = was ? [...was] : header.map(() => "");
  const parts: Array<[string[], string | undefined]> = [
    [["name"], was ? undefined : npc.name],
    [["role"], npc.role],
    [["status"], npc.status ?? (was ? undefined : "Unknown")],
    [["stats"], npc.stats],
    [["notes"], npc.notes],
  ];
  for (const [names, value] of parts) {
    const at = column(header, ...names);
    if (at !== -1 && value !== undefined) row[at] = value;
  }
  return row;
}

// ---- session log --------------------------------------------------------------------------------------------------------------

/** One session in the log, as written: its heading, and everything under it up to the next session. */
export interface LoggedSession {
  number: number;
  heading: string;
  body: string;
}

const SESSION_HEADING = /^##\s+Session\s+(\d+)\b/i;

export function parseSessions(text: string): LoggedSession[] {
  const lines = text.split("\n");
  const sessions: LoggedSession[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = SESSION_HEADING.exec(lines[i]!);
    if (!match) continue;
    let end = lines.findIndex((line, j) => j > i && /^##\s/.test(line));
    if (end === -1) end = lines.length;
    // A trailing rule between entries belongs to neither.
    const body = lines.slice(i + 1, end).join("\n").replace(/\n+---\s*$/, "").trim();
    sessions.push({ number: Number(match[1]), heading: lines[i]!.replace(/^##\s+/, "").trim(), body });
    i = end - 1;
  }
  return sessions;
}

export interface SessionEntry {
  /** The next number if left out. */
  number?: number;
  /** The real date, YYYY-MM-DD. */
  date: string;
  /** The date and time in the story. */
  fictionDate?: string;
  summary: string;
  /** Key rolls and how they came out. */
  rolls?: string;
  /** What changed: karma, nuyen, gear, condition, notoriety. */
  consequences?: string;
}

/** The log with a session added at the end; the sessions already in it are never touched, and a number may be used once. */
export function withSession(text: string, entry: SessionEntry): { text: string; number: number } {
  const existing = parseSessions(text);
  const number = entry.number ?? Math.max(0, ...existing.map((s) => s.number)) + 1;
  if (existing.some((s) => s.number === number)) throw new Error(`Session ${number} is already in the log, which is append-only`);
  const block = [
    `## Session ${number} — ${entry.date}${entry.fictionDate ? ` (in fiction: ${oneLine(entry.fictionDate)})` : ""}`,
    "",
    entry.summary.trim(),
    ...(entry.rolls?.trim() ? ["", `**Key rolls:** ${entry.rolls.trim()}`] : []),
    ...(entry.consequences?.trim() ? ["", `**Consequences:** ${entry.consequences.trim()}`] : []),
  ].join("\n");
  const start = text.trim() === "" ? "# Session Log\n\nAppend-only. Newest session at the bottom.\n\n---" : text.replace(/\s*$/, "");
  return { text: `${start}\n\n${block}\n`, number };
}

// ---- the files on disk --------------------------------------------------------------------------------------------------------

/** A campaign's three memory files, read and written one change at a time. */
export class CampaignMemory {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  private path(name: string) {
    return join(this.dir, name);
  }

  /** Runs `job` after every earlier change has finished, whether or not it succeeded. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(name: string): Promise<string> {
    try {
      return await readFile(this.path(name), "utf8");
    } catch (err) {
      if (isMissing(err)) return "";
      throw new Error(`${this.path(name)} could not be read: ${(err as Error).message}`);
    }
  }

  private async write(name: string, text: string): Promise<void> {
    await mkdir(dirname(this.path(name)), { recursive: true });
    const tmp = `${this.path(name)}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, this.path(name));
  }

  async threads(): Promise<Thread[]> {
    await this.chain;
    return parseThreads(await this.read(MEMORY_FILES.bible));
  }

  setThread(thread: { title: string; text: string }): Promise<void> {
    return this.enqueue(async () => this.write(MEMORY_FILES.bible, withThread(await this.read(MEMORY_FILES.bible), thread)));
  }

  async npcs(): Promise<Npc[]> {
    await this.chain;
    return parseNpcs(this.path(MEMORY_FILES.npcs), await this.read(MEMORY_FILES.npcs));
  }

  setNpc(npc: Partial<Npc> & { name: string }): Promise<void> {
    return this.enqueue(async () => this.write(MEMORY_FILES.npcs, withNpc(this.path(MEMORY_FILES.npcs), await this.read(MEMORY_FILES.npcs), npc)));
  }

  async sessions(): Promise<LoggedSession[]> {
    await this.chain;
    return parseSessions(await this.read(MEMORY_FILES.log));
  }

  /** Adds a session to the log and says which number it got. */
  logSession(entry: SessionEntry): Promise<number> {
    return this.enqueue(async () => {
      const { text, number } = withSession(await this.read(MEMORY_FILES.log), entry);
      await this.write(MEMORY_FILES.log, text);
      return number;
    });
  }
}
