# Shadow Run

A local web app that runs Shadowrun 6th Edition sessions with Claude as the Game Master, played by a group around one laptop.

- The GM runs through the `claude` CLI in headless mode (`claude -p`), so it uses your Claude login rather than an API key.
- Dice can be rolled physically and reported in the app, or rolled in the app with an animation.
- Key story beats get a generated scene image in a hand-painted 1980s arcade-animation style.

## Development

Requires Node 24+ and the `claude` CLI logged in to your Claude account.

```
npm install
npm test            # unit tests; a fake `claude` binary replays recorded streams
npm run typecheck
npm run spike:gm    # two real GM turns: streaming, a request_roll tool call, session resume
```

`spike:gm` talks to the real CLI, so it uses a little of your Claude usage.
