# Campaign memory files

A campaign remembers what happened between sessions in three markdown files in its folder (`campaigns/<name>/`), laid out the way a table keeps a campaign by hand. You can write them yourself, edit them in any editor, or drop in files you already keep: the game only rewrites the two places named below and adds to the log, and every other word of a file stays as you wrote it.

| File | What it holds | What the game changes |
| --- | --- | --- |
| `campaign-bible.md` | setting and tone, the standing plot threads, factions | the numbered list under `## Standing Plot Threads` |
| `npc-tracker.md` | a table of the characters the party has met | the first table in the file |
| `session-log.md` | one entry for each session played | adds an entry at the end, and never changes one already there |

## The bible

Threads are numbered items under a heading called `Standing Plot Threads`, each with its title in bold (a numbered line without bold is left alone, and is not read as a thread):

```
## Standing Plot Threads

1. **The Train Fallout** — active, just starting. A corp has noticed the team.
2. **Gang Beef** — dormant/background. Will flare up now and then.
```

A thread with the same title (capitals do not matter) is rewritten in place and keeps its number; a new one goes after the last. Lines under the item that are indented belong to it. Everything else in the file, including numbered lines in other sections, is left alone. If the heading is not there, it is added at the end.

## The NPC tracker

The first table in the file that has a `Name` column is the tracker (other tables are left alone). It needs that column; `Role/Affiliation`, `Status`, `Stats` and `Notes` are used when they are there, and any other column is kept. The status legend is the book-keeping you already use: Alive, Dead, Burned, Ally, Enemy or Unknown, and any words are kept. A `Stats` column ("PR 5, Body 5, Willpower 4") is added before `Notes` the first time one is needed, so that a returning character is rolled with the same numbers. A placeholder row such as `(none logged yet)` is replaced by the first real one. The table is written back tidy (one line to a row, `|` inside a cell escaped); the text around it is not touched.

If the table cannot be rewritten safely (a row with more cells than the header, or no `Name` column), the game names the file and line, changes nothing, and waits for you to fix it.

## The session log

Append-only. Each session is an entry:

```
## Session 3 — 2026-11-12 (in fiction: Tue 14 Mar 2081, evening)

What happened.

**Key rolls:** ...

**Consequences:** karma, nuyen, gear, condition, notoriety.
```

The number is the next after the highest in the file, and a number is used once. A line in what is written that starts with `#` is escaped, so it cannot be read as another session. A heading like `## Prior History` before the first session is kept and is not a session.

## Scenarios

`npm run scenario:save` and a scenario start carry these three files with the rest of the game, so a scenario begins with the memory it was saved with.

## What the GM does with them

The GM keeps the notes with three tools, and is told in its instructions when to use them:

- `note_npc` writes a named character into the tracker (role, status, stats such as "PR 3, Body 3, Willpower 4", notes) or updates what is written; only what it gives is changed. A named character the GM first brings into a fight or hurts is also listed at once, with the Body and Willpower it gave, even if it never writes them up. Nameless grunts are not listed.
- `note_thread` writes a plot thread as its title, a status (active, dormant, resolved) and a sentence or two, or updates the one of that title.
- `recall` reads the notes back: one character, everyone, the threads, or the last few sessions.

When the GM starts a new conversation (the first turn of a campaign, or after its earlier session was lost) it is told what the notes hold before anything else: the threads, a line for each character, and how the last session ended, cut to a few thousand characters, with `recall` for the rest. A GM whose conversation goes on is not told again. If the notes cannot be read or saved (a table that cannot be rewritten, say), the GM is told only that they cannot be used and to carry on, and the table's story shows the reason.

## Sessions

A session ends when the table says so, not when the server stops, and ending one is a save point, not a stop: the story carries straight on. The web page's "Save progress" button and `/wrapup` in the command-line client (`npm run play`) ask the GM to write the session up: it leaves the scene exactly where it stands, says nothing to the players, and calls `end_session` with a summary that ends with where the scene stands, the date in the story, key rolls and consequences, and the system adds the real date and the next number to `session-log.md`. A fight in progress carries over. It waits if rolls are still waiting for dice (answer or skip them first) or the GM is in the middle of a turn. If the GM does not write the session up, the session stays open and the story says so; save again to retry. Once the GM has written the session up, nothing more happens in it: the dice, damage and combat tools are refused, and if its turn then fails the session is over anyway, so it is never logged twice.

What the run earned goes on the characters' sheets at the same moment: the GM's write-up carries, for each player character, the Karma, nuyen, gear and contacts the story earned and their own part in the run, and the game applies them as described in `character-sheet.md`, saves a dated copy of each old sheet first, adds the run to every character's history, tells the table what changed, and gives the GM the updated sheets. The GM can read a character's earlier runs back with `recall` (`history`, 5 by default and up to 20, newest first), since it is only told the latest five.

The next session begins with the next thing a player says: the number is the one after the highest in the log, it is a new conversation for the GM, which is told what the notes hold and picks the scene up where the last summary says it stood, answering what was said in the same turn, and everyone's Edge starts again at their Edge attribute. Wounds, burned Edge and the fight, if one was on, stay as they were. The web page offers a note about what the story should pick up with, which goes with that first message (`mission` on `player.say`; after the first session begins it is ignored); `/start <mission>` does the same for the first session in the command-line client.
