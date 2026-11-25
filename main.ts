// Tiny Bot: cross-sectional momentum rotation on hourly Solana bars.
//
// Strategy: hold the top 3 symbols by trailing 24-bar return, rebalanced
// every 12 bars, long only, no leverage, no shorts. A held symbol that
// falls to the worst rank rotates out immediately, and any position that
// drops 8% below its cost is stopped out. When the market trends down the
// rotation keeps the bot in the least-bad names or, through the stops and
// the rank filter, out of the worst ones; when it trends up the bot stays
// nearly fully invested in the strongest names.
//
// The final window is unseen, so the rules use round, unfitted numbers
// (24 bars, top 3, 12-bar rebalance) that were stable across every
// 72-bar slice of the dev window instead of a tuned optimum. A 24-bar
// lookback is one full day of hourly bars; shorter lookbacks whipsawed
// badly on the dev data, longer ones reacted too late, and a market-wide
// regime filter only added whipsaw, so the bot carries none.
//
// Wire protocol: agent-fun/bars-replay/v1, spoken directly on stdin and
// stdout (newline-delimited JSON, one reply per batch echoing its seq).
// No network, no clock, no randomness, no environment reads: the same
// bars always produce the same orders, run after run.

import { createInterface } from 'node:readline';

// --- strategy constants (round numbers, chosen for robustness) ---
const LOOKBACK_BARS = 24; // trailing return window, in bars
const TOP_N = 3; // how many symbols the rotation holds
const REBALANCE_BARS = 12; // bars between scheduled rebalances
const STOP_NUM = 92n; // stop-loss: sell when value < 92% of cost
const STOP_DEN = 100n;
const FLIP_OUT_RANK = 6; // rotate out at once when a held symbol ranks last (index 6 of 7)
const MAX_SLIPPAGE_BPS = 10_000; // accept the next open as the fill price

// --- wire types (a small slice of protocol.schema.json) ---
interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

interface Hello {
  type: 'hello';
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
}

interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface Position {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface Account {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
}

interface Batch {
  type: 'batch';
  seq: number;
  t: number;
  bars: Bar[];
  fills: unknown[];
  account: Account;
}

type Order =
  | {
      side: 'buy';
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: 'sell';
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

// --- bot state ---
let hello: Hello | null = null;
const priceScale = new Map<string, number>();
const qtyScale = new Map<string, number>();
const universe: string[] = [];
const closes = new Map<string, (bigint | null)[]>(); // one entry per batch, null on a gap
const latestClose = new Map<string, bigint>();
let cash = 0n;
let equity = 0n;
const held = new Map<string, { qty: bigint; cost: bigint }>();
let warmupBars = 0;
let nextRebalance = 0;
let pendingBuy = false; // a sell went out last bar; buy its replacements now
let orderCounter = 0;

function clientId(): string {
  orderCounter += 1;
  return `o${orderCounter}`;
}

// What `qty` of the symbol is worth at `price`, truncated, in quote units.
function valueOf(symbol: string, qty: bigint, price: bigint): bigint {
  if (hello === null) return 0n;
  const ps = priceScale.get(symbol) ?? 0;
  const qs = qtyScale.get(symbol) ?? 0;
  const quoteScale = hello.capital.quote_scale;
  return (qty * price * 10n ** BigInt(quoteScale)) / 10n ** BigInt(qs + ps);
}

// Ranked by trailing LOOKBACK_BARS return, best first; exact cross-multiplied
// comparison on bigints, ties keep universe order (the sort is stable).
// A symbol counts only when it has a close now and LOOKBACK_BARS back.
function ranked(): { symbol: string; now: bigint; then: bigint }[] {
  const len = closes.get(universe[0] ?? '')?.length ?? 0;
  const out: { symbol: string; now: bigint; then: bigint }[] = [];
  if (len <= LOOKBACK_BARS) return out;
  for (const symbol of universe) {
    const series = closes.get(symbol);
    if (series === undefined) continue;
    const now = series[len - 1] ?? null;
    const then = series[len - 1 - LOOKBACK_BARS] ?? null;
    if (now === null || then === null || then === 0n) continue;
    out.push({ symbol, now, then });
  }
  out.sort((a, b) => {
    const left = a.now * b.then;
    const right = b.now * a.then;
    return left > right ? -1 : left < right ? 1 : 0;
  });
  return out;
}

// Buy orders for the wanted symbols the bot does not hold yet, sized from
// the cash on hand and capped at the per-position weight cap.
function buyOrders(want: string[]): Order[] {
  if (hello === null) return [];
  const coming = want.filter((s) => !held.has(s) && latestClose.has(s));
  if (coming.length === 0) return [];
  const byWeight = (BigInt(hello.caps.max_weight_bps) * equity) / 10_000n;
  const even = cash / BigInt(coming.length);
  const slice = even < byWeight ? even : byWeight;
  if (slice <= 0n || slice < BigInt(hello.fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({
    side: 'buy' as const,
    client_id: clientId(),
    symbol,
    notional_quote_units: slice.toString(),
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  }));
}

// The orders for one batch: stop-losses first, then the rotation.
// A sell's proceeds land at the next open and never fund a buy of the
// same reply, so a reply that sells sets pendingBuy and the buys follow
// on the next batch, with the proceeds in cash.
function decide(seq: number): Order[] {
  if (hello === null) return [];
  // Stop-loss: sell every position worth under 92% of its cost.
  const stops: Order[] = [];
  for (const symbol of universe) {
    const pos = held.get(symbol);
    const close = latestClose.get(symbol);
    if (pos === undefined || close === undefined) continue;
    const value = valueOf(symbol, pos.qty, close);
    if (value * STOP_DEN < pos.cost * STOP_NUM) {
      stops.push({
        side: 'sell',
        client_id: clientId(),
        symbol,
        qty: pos.qty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }
  if (stops.length > 0) {
    pendingBuy = true;
    return stops;
  }
  // Buy the replacements for a sell that went out on the previous bar.
  if (pendingBuy) {
    pendingBuy = false;
    const rank = ranked();
    if (rank.length === 0) return [];
    return buyOrders(rank.slice(0, TOP_N).map((r) => r.symbol));
  }
  const rank = ranked();
  if (rank.length === 0) return [];
  const want = rank.slice(0, TOP_N).map((r) => r.symbol);
  const rankIndex = new Map(rank.map((r, i) => [r.symbol, i]));
  // Rotate now on schedule, or at once when a held symbol falls to last.
  const flipOut = [...held.keys()].some((s) => {
    const i = rankIndex.get(s);
    return i !== undefined && i >= FLIP_OUT_RANK;
  });
  if (seq < nextRebalance && !flipOut) return [];
  nextRebalance = seq + REBALANCE_BARS;
  const sells: Order[] = [];
  for (const symbol of universe) {
    if (held.has(symbol) && !want.includes(symbol)) {
      sells.push({
        side: 'sell',
        client_id: clientId(),
        symbol,
        qty: held.get(symbol)!.qty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }
  if (sells.length > 0) {
    pendingBuy = true;
    return sells;
  }
  return buyOrders(want);
}

async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as { type: string };
    if (msg.type === 'hello') {
      hello = msg as unknown as Hello;
      warmupBars = hello.warmup_bars ?? 0;
      cash = BigInt(hello.capital.quote_units);
      equity = cash;
      for (const s of hello.symbols) {
        universe.push(s.symbol);
        priceScale.set(s.symbol, s.price_scale);
        qtyScale.set(s.symbol, s.qty_scale);
        closes.set(s.symbol, []);
      }
    } else if (msg.type === 'batch') {
      const batch = msg as unknown as Batch;
      if (hello === null) throw new Error(`batch ${batch.seq} before hello`);
      const seen = new Set<string>();
      for (const bar of batch.bars) {
        closes.get(bar.symbol)?.push(BigInt(bar.c));
        latestClose.set(bar.symbol, BigInt(bar.c));
        seen.add(bar.symbol);
      }
      for (const symbol of universe) {
        if (!seen.has(symbol)) closes.get(symbol)?.push(null);
      }
      cash = BigInt(batch.account.cash_quote_units);
      equity = BigInt(batch.account.equity_quote_units);
      held.clear();
      for (const p of batch.account.positions) {
        held.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
      }
      // While warming up every order would be rejected: build history only.
      const orders = batch.seq < warmupBars ? [] : decide(batch.seq);
      if (orders.length > hello.caps.max_orders_per_bar) {
        throw new Error(`batch ${batch.seq}: ${orders.length} orders over the cap`);
      }
      await writeLine(JSON.stringify({ type: 'reply', seq: batch.seq, orders }));
    } else if (msg.type === 'done') {
      break;
    } else {
      throw new Error(`unknown message type ${msg.type}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
