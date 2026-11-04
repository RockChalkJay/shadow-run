# Shadow Run

A local web app that runs Shadowrun 6th Edition sessions with Claude as the Game Master, played by a group around one laptop.

- The GM runs through the `claude` CLI in headless mode (`claude -p`), so it uses your Claude login rather than an API key.
- Dice can be rolled physically and reported in the app, or rolled in the app with an animation.
- Key story beats get a generated scene image in a hand-painted 1980s arcade-animation style.

## Trying the table

```
npm run dev:server      # the table, with Claude as the GM on your own plan
npm run play            # in another terminal: play at it from the command line
```

Claude plays the GM through the `claude` command-line tool, so it needs to be installed and logged in to your plan. No API key is used. Type `/help` in the client for its commands: `/start` begins the session, `/app` rolls a pending roll with the app's dice, and `/dice 6 5 3 1` reports dice you rolled at the table.

Settings, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `SHADOWRUN_GM` | `claude` | `scripted` uses a short demo script instead, which spends no usage |
| `SHADOWRUN_GM_MODEL` | `sonnet` | the model that plays the GM |
| `SHADOWRUN_GM_EFFORT` | the CLI's own | `low`, `medium`, `high`, `xhigh` or `max` |
| `SHADOWRUN_CAMPAIGN` | `default` | which campaign folder to use |
| `PORT` | `8787` | where the table listens |

`npm run check:gm` plays a short scene with the real GM and checks it behaves: it asks for rolls with real stakes, keeps to the consequences it declared, refuses to be told what the dice said, and recovers when its session is lost. It uses a little of your plan's usage.

The table keeps count of everyone's health using the rulebook's condition monitors: physical, stun and overflow, with a die lost on every roll except resisting damage for each filled row of three boxes. When the GM hurts someone, the system takes the damage, the player rolls their own Body to resist it (or the system does for a non-player character), and only what gets through is applied. Skipping that roll is not allowed, and a character whose monitor is full cannot act.

Edge is tracked for each player, who starts a session (each time the server starts) with Edge points equal to their Edge attribute. A player spends it on their own rolls: the 4-Edge boost that adds the Edge attribute to the pool and makes 6s explode is chosen when answering a roll, and the boosts that change dice afterwards (reroll a die for 1, add 1 to a die for 2, buy a hit for 3, reroll every die that missed for 4) are used by asking to hold the roll, which counts the dice and waits for the player to spend Edge or keep it. Everything random in Edge, the explosions and the rerolls, can be rolled by hand and reported, or left for the app; the system checks the counts. Only one expenditure of Edge is allowed per round (in a fight), or per roll (outside one), and Edge above the attribute goes away when a fight ends. The GM is told what was spent. Edge is also gained, but only in a confrontation, which the GM runs with `start_combat` whether it is a fight, a hack or a social contest: the GM gives each attack's Attack Rating and the target's Defense Rating, and when they are four or more apart a player on the stronger side gets a point of Edge before the dice are rolled (a group of grunts counts one rating higher for each member beyond the first); the GM can also award a point with `award_edge` and a reason the players read. A player can gain at most two Edge a round and hold seven in all, and Edge above the attribute goes away when the confrontation ends. Non-player characters do not use Edge, so what an opponent's side of a rating gap would earn is dropped. Giving Edge away, healing with it and the Edge Actions come later.

Fights have an order. The GM starts one with `start_combat` and names everyone in it, and the system rolls initiative: Reaction + Intuition plus the initiative dice, with a player character's numbers taken from their sheet and a non-player character's supplied by the GM. The highest score goes first, and ties go to Edge (a grunt's Professional Rating counts as theirs), then Reaction, then Intuition, then a coin fixed when they were rolled. Grunts the GM puts in one group roll once and act together. The order stands from round to round, `next_round` advances the counter, `join_combat` lets reinforcements in without moving anyone (grunts who join together form a group of their own), and the GM is told the round and the order, with who is down, at the start of every turn. The system does not track which actions a character has spent, and wounds do not change a score, since the book gives no number for that.

Nameless opposition are grunts, as in the book: the GM names them with a Professional Rating, and each has one condition track of 8 plus half the higher of Body and Willpower (a lieutenant adds their rating), a die lost every two boxes, and dead or unconscious according to what hit them last. When damage first takes a standing grunt past their Professional Rating the system tests their nerve (Willpower + Charisma, against a threshold of 2 that is the system's own ruling) and tells the GM whether they hold or bolt. Up to five grunts can attack together as one group, which adds a die for every odd-numbered member beyond the first. Grunts cannot be healed. The shared Edge pool the book gives a group of grunts comes with Edge.

Healing needs a roll too. The GM asks for First Aid, a medkit, a healing spell or a character's own natural recovery with `request_roll`'s `healing` field, and the system sets the difficulty from the patient's Essence as the book does. When the result comes back the GM is told how many hits it has to spend with `heal` in that turn: First Aid heals a stun box per hit or a physical or overflow box per 2 hits, a medkit and healing magic a box per hit, natural recovery a box of its own track per hit, and a healer must heal overflow first. First Aid, a medkit and healing magic can each be received once until the patient is hurt again. The book's time limits (a minute, an hour, a day) are the GM's to keep, since the game tracks no time.

Attacks are settled by the GM's `attack` tool: the system rolls the attacker's pool against the defender's, an attacker with no hits misses, and a hit adds its net hits to the weapon's Damage Value before the target resists with Body. A player character rolls their own side on the screen (defending against an attack cannot be skipped); a non-player character's side is rolled by the system. It needs at least one non-player character, so a fight between two player characters is still run by hand with an opposed roll and `deal_damage`. `/status` in the client shows how hurt everyone is.

Each campaign lives in `campaigns/<name>/` (git-ignored): a `characters/` folder with one JSON file per player character, `state.json` and `transcript.jsonl`, plus an optional `premise.md` that tells the GM what the session is about. The first run writes two demo characters; edit them or add your own. Stop and restart the server and the table picks up where it left off. After editing a character or `premise.md`, restart the server: the GM learns the changes on its next turn, with the story so far intact.

A character sheet (`characters/kira.json`, named after its `id`) holds what the character is: `metatype`, every attribute (Body to Charisma, `edge`, `essence`, `magic`, `resonance`), `initiativeDice`, `skills` with ranks (the keys are `astral`, `athletics`, `biotech`, `closeCombat`, `con`, `conjuring`, `cracking`, `electronics`, `enchanting`, `engineering`, `exoticWeapons`, `firearms`, `influence`, `outdoors`, `perception`, `piloting`, `sorcery`, `stealth` and `tasking`, with ranks from 1 to 12), `specializations` (each a `skill`, a `name`, and `expertise` true for the +3 kind, otherwise +2), and free text for `gear`, `qualities` and `notes`. Enter the final numbers: the game does not apply metatype or augmentation adjustments for you. The sheet is checked when the server starts, so a misspelled field or skill is an error that names the file. How hurt a character is, and their treatments, are kept in `state.json`, so editing a sheet between sessions never changes their wounds. Characters are read in order of id. An old `party.json` is no longer read.

The server answers only this machine. It refuses connections that do not come from loopback, requests whose `Host` does not name loopback, and browsers whose `Origin` is not the web app's, so a web page you visit cannot drive the table. The GM process runs in a private folder with no settings files and none of your credentials in its environment. Claude Code still shows the model your account email, and the CLI has no switch to stop that, so the GM is told never to mention it.

## Who it is for

One owner, on their own machine, with their own Claude login. The group plays around that one laptop and everything is typed on the owner's keyboard. There is no remote or multi-device mode, and no player logs in with their own account.

## Rules

The engine follows the Shadowrun 6th Edition core rulebook. Its numbers are in `server/src/data/sr6/ruleset.json`, and the Edge boosts, actions and burns with their costs are in `server/src/data/sr6/edge.json`. Both name the rulebook PDF page each value comes from, so any of them can be checked; rules the engine applies in code are listed with their pages under `rulesInCode`. Edit the files to change a rule; they are validated each time the rules load. The `unverified` list in the ruleset names the few rulings the engine makes where the book is silent.

Keep your copy of the rulebook in `docs/rules/`. Git ignores that folder, so the PDFs are never committed or published.

## Development

Requires Node 24+ and the `claude` CLI logged in to your Claude account.

```
npm install
npm test            # unit tests; a fake `claude` binary replays recorded streams
npm run typecheck
npm run check:gm    # a short scene with the real GM (uses a little of your Claude usage)
```

