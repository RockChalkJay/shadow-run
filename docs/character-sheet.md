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

## What is not stored

The boxes the sheet works out from the numbers (Initiative, Composure, Judge Intentions, Memory, Lift/Carry, Defense Rating, the condition monitors) are not part of the file, since they follow from the attributes and armor. How hurt a character is, their treatments and any Edge rank they have burned are kept in the campaign's `state.json`, not in the sheet.

## Text or a list

`gear` and `qualities` took only text in the first version of the sheet, and still do: a sheet that has `"gear": "Ares Predator VI, medkit."` is as valid as it was. Write a list of entries instead when you want each item to have a rating and notes.

## Limits

A list holds at most 50 entries (a character's `history` 100) and a note at most 300 characters. The GM is told about the first 15 entries of each list and how many more there are, with each note cut to 120 characters, the backstory cut to 600 and only the latest five runs of the history shown, so a long list does not crowd out the rest of the prompt. These sections tell the GM about the character; they do not change how dice, damage or combat are worked out.

## Checking a file as you type

[`character.schema.json`](character.schema.json) is a JSON Schema for the file, made from the same definition the server checks with (`npm run character:schema` writes it again after the sheet changes). Point your editor at it for `characters/*.json` and it will mark mistakes as you type. Do not add a `"$schema"` line to the sheet itself: the server rejects fields it does not know.
