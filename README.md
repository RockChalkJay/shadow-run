# Shadow Run

A local web app that runs Shadowrun 6th Edition sessions with Claude as the Game Master, played by a group around one laptop.

- The GM runs through the `claude` CLI in headless mode (`claude -p`), so it uses your Claude login rather than an API key.
- Dice can be rolled physically and reported in the app, or rolled in the app with an animation.
- Key story beats get a generated scene image in a hand-painted 1980s arcade-animation style.

## Trying the table

```
npm run dev:server      # the table, on ws://127.0.0.1:8787/ws
npm run play            # in another terminal: play at it from the command line
```

The GM here is a short script, so nothing uses your Claude usage yet; Claude takes over as the GM in a later change. Type `/help` in the client for its commands: `/start` begins the session, `/app` rolls a pending roll with the app's dice, and `/dice 6 5 3 1` reports dice you rolled at the table.

Each campaign lives in `campaigns/<name>/` (git-ignored; pick one with `SHADOWRUN_CAMPAIGN`, default `default`): `party.json`, `state.json` and `transcript.jsonl`. The first run writes a demo `party.json` there; edit it to play your own characters. Stop and restart the server and the table picks up where it left off.

The server answers only this machine. It refuses connections that do not come from loopback, requests whose `Host` does not name loopback, and browsers whose `Origin` is not the web app's, so a web page you visit cannot drive the table.

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
npm run spike:gm    # two real GM turns: streaming, a request_roll tool call, session resume
```

`spike:gm` talks to the real CLI, so it uses a little of your Claude usage.
