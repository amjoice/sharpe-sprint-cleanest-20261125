// Sharpe Sprint entrypoint — wires the tuned breadth-and-velocity strategy
// into the replay harness. All trading logic lives in strategy.ts; this file
// only constructs the bot with the swept parameter set and hands it to the
// SDK loop, which owns the stdin/stdout wire protocol. Keeping the glue thin
// means the graded behavior is exactly the strategy's deterministic onBatch.

import { createStrategy as buildSprintBot, DEFAULT_PARAMS as sprintSettings } from './strategy.ts';
import { runBot as startReplayLoop } from './vendor/makefun-bot.ts';

// Build one bot instance for the whole run so its per-mint tapes and open
// positions persist across batches, as the strategy design requires.
const sprintBot = buildSprintBot(sprintSettings);

// Start answering batches until the harness sends done and flattens us.
await startReplayLoop(sprintBot);
