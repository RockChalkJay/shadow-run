# The character sheet file

A character is one JSON file, `characters/<id>.json` in a campaign (or in a scenario). Its sections follow the Sixth World record sheet. Only `version`, `id`, `name`, `metatype` and `attributes` are required; everything else is optional, so a sheet can start small and grow. A full example that uses every section is [`character-example.json`](character-example.json), and the tests read it, so it cannot drift from what the server accepts.

The server checks a sheet when it starts. A misspelled field, or a number outside the book's range, stops it with a message that names the file and the field.

## Where each part of the record sheet goes

| Record sheet | In the file |
| --- | --- |
| Character, Player, Notes | `name`, `player`, `notes` (and `id`, the file's name without `.json`) |
| Personal Data: Metatype | `metatype` (`human`, `elf`, `dwarf`, `ork` or `troll`) |
| Personal Data: the rest | `personal`: `ethnicity`, `age`, `sex`, `height`, `weight`, `reputation`, `heat`, `karma`, `totalKarma`, `misc` |
| Attributes, Edge, Essence, Magic/Resonance | `attributes`; enter the final numbers, with metatype and augmentations already counted |
| Initiative dice | `initiativeDice` |
| Skills | `skills` (a rank from 1 to 12 for each of the book's skills) and `specializations` |
| Knowledge and Language skills | `knowledge`: `{ name, rating, type }`, where `type` is `knowledge` or `language` |
| Qualities | `qualities`: text, or a list of `{ name, rating, notes, type }` with `type` `positive` or `negative` |
| IDs / Lifestyles / Currency | `lifestyle`: `primary`, `nuyen`, `licenses`, `fakeIds` |
| Contacts | `contacts`: `{ name, loyalty, connection, notes }` |
| Ranged Weapons | `rangedWeapons`: `{ name, damage: { value, type }, mode, ranges: { close, near, far, extreme }, ammo, notes, primary }` |
| Melee Weapons | `meleeWeapons`: `{ name, damage: { value, type }, close, notes, primary }` |
| Armor | `armor`: `{ name, rating, notes, primary }` |
| Core Combat Info | the entry marked `"primary": true` in each of the three lists above; at most one in each |
| Augmentations | `augmentations`: `{ name, rating, notes, essence }` |
| Gear | `gear`: text, or a list of `{ name, rating, notes }` |
| Matrix Stats | `matrix`: `attack`, `sleaze`, `dataProcessing`, `firewall`, `devices`, `programs` |
| Vehicle | `vehicles`: `{ name, handling, acceleration, speedInterval, topSpeed, body, armor, pilot, sensor, seats, notes }` |
| Spells / Preparations / Rituals / Complex Forms | `spells`: `{ name, kind, typeTarget, range, duration, drain }`, where `kind` is `spell`, `preparation`, `ritual` or `complexForm` |
| Adept Powers or Other Abilities | `abilities`: `{ name, level, notes }` |
| Character History and Background | `backstory`: text, written by you and never changed by the game |
| Runs the character has been on | `history`: a list of `{ run, date, campaign, summary, goal, with, consequences }`, oldest first |

A weapon's `damage.type` is `physical` or `stun`, so a 7S weapon is `{ "value": 7, "type": "stun" }`. The `ranges` of a ranged weapon are Attack Ratings; leave out a range the weapon cannot reach.

## Importing and exporting

A character file can be moved between campaigns and scenarios, or kept as a backup, with two commands. Stop the server first and restart it after, since characters are read when it starts. A relative path is taken from where you typed the command.

```
npm run character:export -- kira --out kira.json          # one character, from the "default" campaign
npm run character:export -- --all --out party              # every character, one file each, into a folder
npm run character:export -- kira --scenario ambush         # from a scenario (or --campaign night-one)
npm run -s character:export -- kira > kira.json            # to a file by redirect; -s hides npm's own lines
npm run character:export -- kira --derived --out kira.json # also writes the record sheet's worked-out boxes

npm run character:import -- kira.json                      # into the "default" campaign
npm run character:import -- party/*.json --scenario ambush  # into a scenario, made if it is new
npm run character:import -- kira.json --force              # replace a character that is already there
npm run character:import -- kira.json --check              # check the files, write nothing
```

An export is the same file the campaign keeps in `characters/`, read and written back in full. `--derived` adds a `derived` block for a person to read: Initiative, Composure, Judge Intentions, Memory, Lift/Carry, Defense Rating, unarmed Attack Rating and the three condition-monitor sizes, worked out from the attributes and the primary armor (core rulebook, printed pp. 67-68). Movement and the Matrix and astral initiatives are not worked out, because their formulas were not checked against the book. An import ignores `derived`, and the server does not accept it in a `characters/` file, so import such a file with the command rather than copying it in.

An import writes nothing if it finds a problem first: if any file is not valid JSON or not a valid sheet, two files name one character, or a character's file is already there without `--force` (even if that file is not a valid sheet), every problem is listed and nothing is written. The files are then written one at a time. It will not write into the `scenario-<name>` folder a scenario run plays in, which is wiped on every start; import into the scenario with `--scenario`.

## Changes at the end of a run

Playing does not change a sheet file; the end of a run does. When the GM writes a session up (`end_session`, see `campaign-memory.md`) it gives what each player character earned, and the game applies it to their sheet: Karma earned is added to the Karma in hand and the total, nuyen is added or spent (never below 0), gear is added or taken out by name, contacts are added or updated by name, a line is added to the notes, and the run is added to the end of the `history` as the next number. A run can change Karma by at most 30 and nuyen by at most 500,000. If any part of an update cannot be applied for any character, nothing is applied and nothing is logged: the GM is told why and writes the session up again. Every player character's history gets the run whether or not the GM gave them a reward, from the session's summary if it gave them nothing of their own. A sheet whose `gear` is still text is left as text, and what changed in its gear goes into that run's history entry instead.

Before a sheet is changed, the file as it was is copied to `characters/history/<id>-<date>.json` (`-2`, `-3` for more on the same day), and if that copy cannot be made, that sheet is not changed. The `history` folder is not read as characters and is not carried into a scenario. To undo a change, copy an old file back over the sheet and restart the server. The Edge rank a character has burned stays in `state.json`: the sheet file keeps the Edge it had, and the game still takes the burn off when it loads the sheet. The updated sheets are what the GM is told from then on, without restarting the server.

## What is not stored

The boxes the sheet works out from the numbers (Initiative, Composure, Judge Intentions, Memory, Lift/Carry, Defense Rating, the condition monitors) are not part of the file, since they follow from the attributes and armor. How hurt a character is, their treatments and any Edge rank they have burned are kept in the campaign's `state.json`, not in the sheet.

## Text or a list

`gear` and `qualities` took only text in the first version of the sheet, and still do: a sheet that has `"gear": "Ares Predator VI, medkit."` is as valid as it was. Write a list of entries instead when you want each item to have a rating and notes.

## Limits

A list holds at most 50 entries (a character's `history` 100) and a note at most 300 characters. The GM is told about the first 15 entries of each list and how many more there are, with each note cut to 120 characters, the backstory cut to 600 and only the latest five runs of the history shown, so a long list does not crowd out the rest of the prompt. These sections tell the GM about the character; they do not change how dice, damage or combat are worked out.

## Checking a file as you type

[`character.schema.json`](character.schema.json) is a JSON Schema for the file, made from the same definition the server checks with (`npm run character:schema` writes it again after the sheet changes). Point your editor at it for `characters/*.json` and it will mark mistakes as you type. Do not add a `"$schema"` line to the sheet itself: the server rejects fields it does not know.
