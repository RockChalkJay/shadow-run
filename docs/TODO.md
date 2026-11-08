# TODO

Bugs found while testing and ideas for future functionality. Add an item under the right heading, tick it when it is done, and move it to Done with the PR or commit that finished it. Remove the example lines once there are real entries.

## Bugs

- [ ] **Example bug title** — what happens, how to reproduce it, where it was seen

## Ideas / Future functionality

- [ ] **Test mode for manual testing** — a configuration where every character's attributes and gear can be set, so scenarios can be set up and turns replayed over and over for extensive manual testing. A scenario is a saved snapshot that can be reloaded. The dice are scriptable. Open question: whether the GM should be scripted too.
- [ ] **Restart a campaign and rewind to any point** — restart a campaign from the beginning. Eventually go back to any time in the campaign so any decision can be retried.

## Done
- [x] **Rework the Roll card layout for choosing dice to reroll** — the current layout is unintuitive when picking which dice to reroll with Edge. The "I rolled the new dice myself" checkbox and the label "Pick the dice by clicking them." are in the wrong order. The label wording is correct, but where it sits makes it unapparent that clicking the dice is how a reroll is set up. Clicking the dice is a good way to choose a reroll and should stay; the order of the checkbox and label needs to make that clear. Done in the reroll-layout PR: the prompt now sits directly under the tools, before the checkbox.
- [x] **Send the rules the screen reads in the snapshot** — the browser repeats two ruleset values as constants: the hit minimum that lights a die as a hit (`web/src/Dice.tsx`) and the stun carry-over rate in `web/src/damage.ts`, which decides whether Not Dead Yet is offered. If an owner edits the ruleset, the screen and server would disagree. The snapshot should carry these values. Done in the snapshot-rules PR: the snapshot carries `rules` and the screen reads them.
