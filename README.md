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

Each campaign lives in `campaigns/<name>/` (git-ignored): `party.json`, `state.json` and `transcript.jsonl`, plus an optional `premise.md` that tells the GM what the session is about. The first run writes a demo `party.json`; edit it to play your own characters. Stop and restart the server and the table picks up where it left off.

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

