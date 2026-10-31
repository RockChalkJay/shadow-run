# Shadow Run

A local web app that runs Shadowrun 6th Edition sessions with Claude as the Game Master, played by a group around one laptop.

- The GM runs through the `claude` CLI in headless mode (`claude -p`), so it uses your Claude login rather than an API key.
- Dice can be rolled physically and reported in the app, or rolled in the app with an animation.
- Key story beats get a generated scene image in a hand-painted 1980s arcade-animation style.

## Who it is for

One owner, on their own machine, with their own Claude login. The group plays around that one laptop and everything is typed on the owner's keyboard. There is no remote or multi-device mode, and no player logs in with their own account.

## Rules

The numbers the engine plays by are in `server/src/data/sr6/ruleset.json`. Edit that file to change a rule; it is checked each time the rules load. Its `unverified` list names the rules that came from conflicting or secondary sources, so check those against your copy of the core rulebook. Entries marked "fixed in code" are not settings yet: if the rulebook disagrees with one, it needs a code change.

## Development

Requires Node 24+ and the `claude` CLI logged in to your Claude account.

```
npm install
npm test            # unit tests; a fake `claude` binary replays recorded streams
npm run typecheck
npm run spike:gm    # two real GM turns: streaming, a request_roll tool call, session resume
```

`spike:gm` talks to the real CLI, so it uses a little of your Claude usage.
