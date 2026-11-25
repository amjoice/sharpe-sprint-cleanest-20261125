# Sharpe Sprint — Cleanest Paper Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/amjoice/sharpe-sprint-cleanest-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/amjoice/sharpe-sprint-cleanest-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for the make.fun bounty [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532): a paper-trading bot for a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

A fresh pump.fun curve jumps fast, then fades; buying the launch or chasing momentum loses. The exception is breadth + velocity at age 3–4 slots: coins with 8+ trades in their first few slots, several distinct buyers and real SOL behind them often spike again within the next ~20 slots, then fade hard.

- **Main tier:** enter only that narrow signal (age 3–4 slots, 8+ trades, 4+ distinct non-creator buyers, net flow ≥ 0.3 SOL, price near its window high, no creator sell, no single sell ≥ 1 SOL). Stake 0.1 SOL, pyramid +0.05 SOL on a confirmed step up. Exit on +4% take profit, −6% stop, trailing stop, 12-slot time limit, creator sell, a big sell, or reversed flow.
- **Probe tier:** tiny 0.01 SOL buys of looser-filter launches, paced by block time toward 21 distinct coins, so the run meets the guardrail of 20+ round trips. Probes share the same exits and never pyramid.

The bot is fully deterministic (no clock, no randomness) and runs as `node main.ts` on Node 22 with no build step and no dependencies. `vendor/makefun-bot.ts` is the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte.

## Layout

- `main.ts` — entrypoint: hands the strategy to the SDK's `runBot`.
- `strategy.ts` — the strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — kit SDK shim (not authored code).
