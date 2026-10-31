# Shadow Run

A local web app that runs Shadowrun 6th Edition sessions with Claude as the Game Master, played by a group around one laptop.

- The GM runs through the `claude` CLI in headless mode (`claude -p`), so it uses your Claude login rather than an API key.
- Dice can be rolled physically and reported in the app, or rolled in the app with an animation.
- Key story beats get a generated scene image in a hand-painted 1980s arcade-animation style.

## Who it is for

One owner, on their own machine, with their own Claude login. The group plays around that one laptop and everything is typed on the owner's keyboard. There is no remote or multi-device mode, and no player logs in with their own account.

## Rules

The engine follows the Shadowrun 6th Edition core rulebook. Its numbers are in `server/src/data/sr6/ruleset.json`, and the Edge boosts, actions and burns with their costs are in `server/src/data/sr6/edge.json`. Both name the rulebook PDF page each value comes from, so any of them can be checked. Edit the files to change a rule; they are validated each time the rules load. The `unverified` list in the ruleset names the few rulings the engine makes where the book is silent.

Keep your copy of the rulebook in `docs/rules/`. Git ignores that folder, so the PDFs are never committed or published.

## Development

Requires Node 24+ and the `claude` CLI logged in to your Claude account.

```
npm install
npm test            # unit tests; a fake `claude` binary replays recorded streams
npm run typecheck
npm run spike:gm    # two real GM turns: streaming, a request_roll tool call, session resume
```

`spike:gm` talks to the real CLI, so it uses a little of your Claude usage.
