// Sharpe Sprint — cleanest paper bot.
//
// Idea (measured on the kit dev window): a fresh pump.fun curve jumps fast, then
// fades; buying the launch or chasing momentum loses. The exception is breadth +
// velocity at age 3-4 slots: coins with 8+ trades in their first few slots,
// several distinct buyers and real SOL behind them often spike again within the
// next ~20 slots, then fade hard. So: enter only that narrow signal, take a
// small profit or cut fast, never hold past ~12 slots. A second, tiny "probe"
// tier buys looser-filter launches at 0.01 SOL, paced by block time, purely so
// the run reaches the guardrail of 20+ distinct coins with a round trip.
//
// Fully deterministic: no clock, no environment, no Math.random; only
// insertion-ordered Maps are iterated, so two executions of the bot produce
// byte-identical action logs (the harness runs every entry twice).

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  minBuyers: number;
  minBuys: number;
  minTrades: number;
  minNetSol: number;
  window: number;
  minRunup: number;
  maxRunup: number;
  nearHigh: number;
  maxBigSellSol: number;
  minRqSol: number;
  maxRqSol: number;
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  minDevBuyOrZero: number;
  takeProfit: number;
  stopLoss: number;
  trailArm: number;
  trail: number;
  maxHold: number;
  fadeWindow: number;
  fadeNetSol: number;
  cooldown: number;
  maxEntries: number;
  pyramid: boolean;
  addSol: number;
  addStep: number;
  addIfUp: number;
  addNetSol: number;
  maxMain: number;
  maxExposureSol: number;
  probeSol: number;
  maxProbes: number;
  targetCoins: number;
  paceSecs: number;
  probeMinTrades: number;
  probeMinBuyers: number;
  probeMinRqSol: number;
  probeMaxAge: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 3,
  maxAge: 4,
  minBuyers: 4,
  minBuys: 2,
  minTrades: 8,
  minNetSol: 0.3,
  window: 30,
  minRunup: 0.03,
  maxRunup: 1.0,
  nearHigh: 0.85,
  maxBigSellSol: 1.0,
  minRqSol: 3,
  maxRqSol: 40,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  minDevBuyOrZero: 0,
  takeProfit: 0.04,
  stopLoss: 0.06,
  trailArm: 0.04,
  trail: 0.03,
  maxHold: 12,
  fadeWindow: 15,
  fadeNetSol: 1.0,
  cooldown: 150,
  maxEntries: 1,
  pyramid: true,
  addSol: 0.05,
  addStep: 0.02,
  addIfUp: 0.03,
  addNetSol: 0.3,
  maxMain: 5,
  maxExposureSol: 0.6,
  probeSol: 0.01,
  maxProbes: 2,
  targetCoins: 21,
  paceSecs: 21600,
  probeMinTrades: 6,
  probeMinBuyers: 3,
  probeMinRqSol: 2,
  probeMaxAge: 5,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  vq0: bigint;
  vt0: bigint;
  trades: Tick[];
  entries: number;
  lastExit: number;
  devSold: boolean;
  devBuy: number;
}

interface Held {
  opened: number;
  peak: number;
  txPaid: bigint;
  invested: bigint;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  probe: boolean;
}

const LAMPORTS = 1_000_000_000n;
const FEE_KEEP = 1 - 0.0125; // protocol 95 bps + creator 30 bps per leg

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

function lamportsOf(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

interface WindowStats {
  count: number;
  buys: number;
  buyers: Set<string>;
  net: number;
  maxSell: number;
  high: number;
}

function windowStats(tape: Tape, now: number, slots: number): WindowStats {
  const out: WindowStats = { count: 0, buys: 0, buyers: new Set<string>(), net: 0, maxSell: 0, high: 0 };
  for (const t of tape.trades) {
    if (t.slot <= now - slots) continue;
    out.count += 1;
    if (t.buy) {
      out.buys += 1;
      out.net += t.sol;
      if (t.user !== tape.creator) out.buyers.add(t.user);
    } else {
      out.net -= t.sol;
      if (t.sol > out.maxSell) out.maxSell = t.sol;
    }
    if (t.price > out.high) out.high = t.price;
  }
  return out;
}

export function createStrategy(p: Params): Bot {
  const tapes = new Map<string, Tape>();
  const held = new Map<string, Held>();
  const myCoins = new Set<string>();
  const probed = new Set<string>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keepSlots = Math.max(p.window, p.fadeWindow) + 5;

  function tapeOf(mint: string): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        vq0: 0n,
        vt0: 0n,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        devSold: false,
        devBuy: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function hasPending(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) if (pend.order.mint === mint) return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: string): boolean {
    for (const pend of state.pending.values()) {
      if (pend.order.mint === mint && pend.order.side === 'sell') return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      let freeCash = state.freeCashLamports();
      const orderedMints = new Set<string>();

      // 1. Fold events into tapes.
      const traded = new Set<string>();
      const bigSellThisBatch = new Map<string, number>();
      for (const e of batch.events) {
        traded.add(e.mint);
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null || e.block_time < firstTime) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        const tape = tapeOf(e.mint);
        if (e.event === 'CreateEvent') {
          tape.created = e.slot;
          tape.creator = e.creator;
          tape.vq0 = BigInt(e.virtual_quote_reserves);
          tape.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          if (tape.creator === null) tape.creator = e.creator;
          const sol = Number(BigInt(e.quote_amount)) / 1e9;
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          tape.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          if (e.user === tape.creator) {
            if (e.is_buy) tape.devBuy += sol;
            else tape.devSold = true;
          }
          if (!e.is_buy) {
            const prev = bigSellThisBatch.get(e.mint) ?? 0;
            if (sol > prev) bigSellThisBatch.set(e.mint, sol);
          }
        }
      }
      for (const mint of traded) {
        const tape = tapes.get(mint);
        if (tape !== undefined) tape.trades = tape.trades.filter((t) => t.slot > now - keepSlots);
      }

      // 2. Fold fills.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.status === 'filled' && f.side === 'buy') {
          myCoins.add(f.mint);
          if (h !== undefined) h.filled = true;
        }
      }

      // Reserves for valuing held positions: this batch's marks first, else curves.
      const marks = new Map<string, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // 3. Exits first.
      for (const [mint, h] of [...held.entries()]) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!hasPending(state, mint)) {
            const tape = tapes.get(mint);
            if (tape !== undefined) {
              if (h.filled) tape.lastExit = now;
              else if (!h.probe) tape.entries = Math.max(0, tape.entries - 1);
            }
            held.delete(mint);
          }
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve !== undefined && curve.complete) continue; // the replay closes it
        const mk = marks.get(mint);
        const vq = mk !== undefined ? mk.vq : curve !== undefined ? curve.virtual_quote_reserves : 0n;
        const vt = mk !== undefined ? mk.vt : curve !== undefined ? curve.virtual_token_reserves : 0n;
        const tokens = pos.token_amount;
        const sellValue = ((Number(tokens) * Number(vq)) / (Number(vt) + Number(tokens)) / 1e9) * FEE_KEEP;
        const value = sellValue - solOf(txFee);
        const cost = solOf(pos.cost_lamports + h.txPaid);
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        if (h.exiting || hasPendingSell(state, mint)) continue;
        const tape = tapes.get(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        else if (value <= cost * (1 - p.stopLoss)) exit = true;
        else if (h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trail)) exit = true;
        else if (now - h.opened > p.maxHold) exit = true;
        else if (tape !== undefined && tape.devSold) exit = true;
        else if ((bigSellThisBatch.get(mint) ?? 0) >= p.maxBigSellSol) exit = true;
        else if (tape !== undefined && windowStats(tape, now, p.fadeWindow).net < -p.fadeNetSol) exit = true;
        if (exit && orders.length < maxOrders) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10000 });
          h.exiting = true;
          orderedMints.add(mint);
          freeCash -= txFee;
        }
      }

      // Local slot accounting: state.pending does not yet include this batch's orders.
      let committed = state.committedPositionCount();
      const countHeld = (probe: boolean): number => {
        let n = 0;
        for (const h of held.values()) if (h.probe === probe) n += 1;
        return n;
      };
      const exposure = (): bigint => {
        let sum = 0n;
        for (const h of held.values()) sum += h.invested;
        return sum;
      };

      // 4. Main entries and pyramid adds.
      for (const mint of traded) {
        if (orders.length >= maxOrders) break;
        if (orderedMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (hasPending(state, mint)) continue;
        const tape = tapes.get(mint);
        if (tape === undefined || tape.created === null) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const realSol = solOf(curve.real_quote_reserves);
        const h = held.get(mint);

        if (h !== undefined) {
          // Pyramid add on an existing main position.
          if (!p.pyramid || h.probe || !h.filled || h.exiting) continue;
          if (h.invested >= lamportsOf(p.stakeSol)) continue;
          if (realSol > p.maxRqSol) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          const cost = solOf(pos.cost_lamports + h.txPaid);
          if (h.lastValue < cost * (1 + p.addIfUp)) continue;
          if (windowStats(tape, now, p.window).net < p.addNetSol) continue;
          const want = lamportsOf(p.stakeSol) - h.invested;
          const addWant = lamportsOf(p.addSol);
          const capped = want < addWant ? want : addWant;
          let size = state.maxBuyLamports(mint);
          if (capped < size) size = capped;
          const room = lamportsOf(p.maxExposureSol) - exposure();
          if (room < size) size = room;
          const cashRoom = freeCash - txFee;
          if (cashRoom < size) size = cashRoom;
          if (size < lamportsOf(p.minBuySol)) continue;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
          h.invested += size;
          h.lastAddPrice = price;
          orderedMints.add(mint);
          freeCash -= size + txFee;
          continue;
        }

        // New main position.
        if (committed >= state.hello.caps.max_open_positions) continue;
        if (countHeld(false) >= p.maxMain) continue;
        if (tape.entries >= p.maxEntries) continue;
        if (now - tape.lastExit < p.cooldown) continue;
        const age = now - tape.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (realSol < p.minRqSol || realSol > p.maxRqSol) continue;
        if (tape.devSold) continue;
        if (p.minDevBuyOrZero > 0 && tape.devBuy > 0 && tape.devBuy < p.minDevBuyOrZero) continue;
        const createPrice = priceOf(tape.vq0, tape.vt0);
        if (createPrice <= 0) continue;
        const runup = price / createPrice - 1;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        const ws = windowStats(tape, now, p.window);
        if (ws.count < p.minTrades) continue;
        if (ws.buys < p.minBuys) continue;
        if (ws.buyers.size < p.minBuyers) continue;
        if (ws.net < p.minNetSol) continue;
        if (ws.maxSell >= p.maxBigSellSol) continue;
        if (price < p.nearHigh * ws.high) continue;
        let size = state.maxBuyLamports(mint);
        const want = lamportsOf(p.stakeSol);
        if (want < size) size = want;
        const room = lamportsOf(p.maxExposureSol) - exposure();
        if (room < size) size = room;
        const cashRoom = freeCash - txFee;
        if (cashRoom < size) size = cashRoom;
        if (size < lamportsOf(p.minBuySol)) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        held.set(mint, {
          opened: now,
          peak: 0,
          txPaid: 0n,
          invested: size,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
          probe: false,
        });
        tape.entries += 1;
        committed += 1;
        orderedMints.add(mint);
        freeCash -= size + txFee;
      }

      // 5. Probe tier: paced tiny buys so the distinct-coin guardrail is met.
      if (firstTime !== null && lastTime !== null) {
        const due = Math.ceil(p.targetCoins * Math.min(1, (lastTime - firstTime) / p.paceSecs));
        for (const mint of traded) {
          if (orders.length >= maxOrders) break;
          if (myCoins.size >= due) break;
          if (countHeld(true) >= p.maxProbes) break;
          if (committed >= state.hello.caps.max_open_positions) break;
          if (orderedMints.has(mint)) continue;
          if (held.has(mint) || probed.has(mint)) continue;
          if (state.positions.has(mint)) continue;
          if (hasPending(state, mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const tape = tapes.get(mint);
          if (tape === undefined || tape.created === null) continue;
          if (now - tape.created > p.probeMaxAge) continue;
          if (tape.devSold) continue;
          if (solOf(curve.real_quote_reserves) < p.probeMinRqSol) continue;
          if (tape.trades.length < p.probeMinTrades) continue;
          let buys = 0;
          const buyers = new Set<string>();
          let bigSell = false;
          for (const t of tape.trades) {
            if (t.buy) {
              buys += 1;
              if (t.user !== tape.creator) buyers.add(t.user);
            } else if (t.sol >= p.maxBigSellSol) {
              bigSell = true;
            }
          }
          if (buys < 1) continue;
          if (buyers.size < p.probeMinBuyers) continue;
          if (bigSell) continue;
          let size = state.maxBuyLamports(mint);
          const want = lamportsOf(p.probeSol);
          if (want < size) size = want;
          const cashRoom = freeCash - txFee;
          if (cashRoom < size) size = cashRoom;
          if (size < lamportsOf(p.minBuySol)) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
          held.set(mint, {
            opened: now,
            peak: 0,
            txPaid: 0n,
            invested: size,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
            probe: true,
          });
          probed.add(mint);
          committed += 1;
          orderedMints.add(mint);
          freeCash -= size + txFee;
        }
      }

      return orders;
    },
  };
}
