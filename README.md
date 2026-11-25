[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/maelaozera/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/maelaozera/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Tiny Bot — Beat Buy-and-Hold on Solana

A make.fun entry for the `u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1`
competition: a tiny paper-trading bot for hourly Solana prices that beats
buy-and-hold.

## Strategy

Cross-sectional momentum rotation, long only:

- Hold the **top 3 symbols by trailing 24-bar (24-hour) return**, rebalanced
  every 12 bars, equal-weighted and capped at 25% of equity per position.
- **Flip-out:** a held symbol that falls to the worst rank rotates out
  immediately, without waiting for the next rebalance.
- **Stop-loss:** any position worth under 92% of its cost is sold.
- No regime filter, no leverage, no shorts: the rules use round numbers
  that were stable across every 72-bar slice of the dev window.

## How to run

`main.ts` (Node 22, standard library only) speaks the
`agent-fun/bars-replay/v1` line protocol on stdin/stdout. Grade it with
the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

The run is fully deterministic: no clock, no randomness, no network, no
environment reads — two executions produce byte-identical action logs.

## Files

- `main.ts` — the bot (protocol + strategy, single file)
- `LICENSE` — MIT
