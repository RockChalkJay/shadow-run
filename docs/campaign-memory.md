# Campaign memory files

A campaign remembers what happened between sessions in three markdown files in its folder (`campaigns/<name>/`), laid out the way a table keeps a campaign by hand. You can write them yourself, edit them in any editor, or drop in files you already keep: the game only rewrites the two places named below and adds to the log, and every other word of a file stays as you wrote it.

| File | What it holds | What the game changes |
| --- | --- | --- |
| `campaign-bible.md` | setting and tone, the standing plot threads, factions | the numbered list under `## Standing Plot Threads` |
| `npc-tracker.md` | a table of the characters the party has met | the first table in the file |
| `session-log.md` | one entry for each session played | adds an entry at the end, and never changes one already there |

## The bible

Threads are numbered items under a heading called `Standing Plot Threads`:

```
## Standing Plot Threads

1. **The Train Fallout** — active, just starting. A corp has noticed the team.
2. **Gang Beef** — dormant/background. Will flare up now and then.
```

A thread with the same title (capitals do not matter) is rewritten in place and keeps its number; a new one goes after the last. Lines under the item that are indented belong to it. Everything else in the file, including numbered lines in other sections, is left alone. If the heading is not there, it is added at the end.

## The NPC tracker

The first table in the file is the tracker. It needs a `Name` column; `Role/Affiliation`, `Status`, `Stats` and `Notes` are used when they are there, and any other column is kept. The status legend is the book-keeping you already use: Alive, Dead, Burned, Ally, Enemy or Unknown, and any words are kept. A `Stats` column ("PR 5, Body 5, Willpower 4") is added before `Notes` the first time one is needed, so that a returning character is rolled with the same numbers. A placeholder row such as `(none logged yet)` is replaced by the first real one. The table is written back tidy (one line to a row, `|` inside a cell escaped); the text around it is not touched.

If the table cannot be rewritten safely (a row with more cells than the header, or no `Name` column), the game names the file and line, changes nothing, and waits for you to fix it.

## The session log

Append-only. Each session is an entry:

```
## Session 3 — 2026-11-12 (in fiction: Tue 14 Mar 2081, evening)

What happened.

**Key rolls:** ...

**Consequences:** karma, nuyen, gear, condition, notoriety.
```

The number is the next after the highest in the file, and a number is used once. A heading like `## Prior History` before the first session is kept and is not a session.

## Scenarios

`npm run scenario:save` and a scenario start carry these three files with the rest of the game, so a scenario begins with the memory it was saved with.

Nothing yet tells the GM about these files or writes them during play; that comes in later changes.
