import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { rankCandidates } from "./candidate-analyst.js";
import { momentumEntry, momentumExit, momentumSize } from "./momentum.js";
import { defaults } from "./policy.js";
import { advancePortfolio, newPortfolio } from "./scanner.js";

const now = Date.now();
const pair = {
  pairCreatedAt: now - 15 * 60000, priceUsd: "1", liquidity: { usd: 100000 },
  volume: { m5: 25000, h1: 80000, h6: 120000, h24: 200000 },
  priceChange: { m5: 4, h1: 7, h6: 10, h24: 12 },
  txns: { m5: { buys: 90, sells: 10 }, h1: { buys: 140, sells: 40 } }
};
const sources = new Set(["PumpPortal", "GeckoTerminal"]);
const policy = { ...defaults, strategy: 8, feeBps: 0, slippageBps: 0, profitShare: 50, minLiquidity: 1000 };
const wasm = await readFile(new URL("./engine.wasm", import.meta.url));
const { instance: { exports: engine } } = await WebAssembly.instantiate(wasm);
const tick = (price, at, overrides) => ({
  token: "A", pool: "P", symbol: "A", price, at, liquidity: 100000, volume: 100000, score: 95,
  change5: 3, changeHour: 8, volume5: 25000, volumeHour: 80000, transactions: pair.txns, ...overrides
});

test("momentum ranks verified tape but cannot substitute missing data or a vertical candle", () => {
  const good = momentumEntry(pair, sources, 80, now);
  assert.equal(good.decision, "approve");
  assert.ok(good.score >= 80);
  assert.equal(momentumEntry({ ...pair, txns: null }, sources, 80, now).decision, "watch");
  assert.equal(momentumEntry({ ...pair, priceChange: { m5: 50, h1: 7 } }, sources, 80, now).decision, "reject");
  assert.deepEqual(rankCandidates([{ token: "A", raw: pair, sources: [...sources] }], policy, now)[0].strategy, good);
  assert.equal(rankCandidates([{ token: "B", sources: [] }], policy, now)[0].decision, "watch");
});

test("position size respects signal, cash, order, and liquidity caps", () => {
  assert.equal(momentumSize(1000, 95, 100000, policy), 17.5);
  assert.equal(momentumSize(40, 95, 100000, policy), 3.5);
  assert.equal(momentumSize(1000, 95, 500, policy), 0);
  assert.equal(momentumSize(1000, 79, 100000, policy), 0);
});

test("strong momentum holds past take-profit, and weakness or trailing can exit", () => {
  const book = { cost: 100, sol: 100, peak: 1.2, entryLiquidity: 100000, openedAt: now };
  assert.equal(momentumExit(book, tick(1.5, now + 1000), policy), undefined);
  assert.equal(momentumExit(book, tick(1.2, now + 1000, { transactions: { m5: { buys: 2, sells: 8 } } }), policy).sol, 50);
  assert.equal(momentumExit(book, tick(1.1, now + 1000), policy).reason, 3);
  assert.equal(momentumExit(book, tick(1.18, now + 1000, { liquidity: 40000 }), policy).reason, 8);
});

test("executor keeps persistent fill evidence, blocks stale buys and closes a held position manually", () => {
  const book = newPortfolio(250);
  const apply = (ticks, eligible = () => true) => advancePortfolio(book, ticks, engine, policy, () => 1, eligible);
  apply([tick(1, now, { observedAt: now - 25000 })]);
  assert.equal(book.cash, 250);
  apply([tick(1, now, { analysisReason: "Ostovoima kasvoi" })], () => false);
  assert.equal(book.cash, 250);
  apply([tick(1, now + 1, { analysisReason: "Ostovoima kasvoi" })]);
  assert.equal(book.trades[0].detail, "Ostovoima kasvoi");
  assert.equal(book.decisions[0].state, "BUY");
  const cashAfterBuy = book.cash;
  apply([tick(1.2, now + 2, { manual: true, exitsOnly: true })], () => false);
  assert.ok(book.cash > cashAfterBuy);
  assert.ok(book.trades[0].realizedPnl > 0);
  assert.equal(book.trades[0].reason, 10);
  assert.equal(book.trades[0].market.price, 1.2);
  assert.equal(book.history.length, 3);
  assert.deepEqual(Object.keys(book.positions), []);
  assert.equal(book.decisions[0].state, "EXIT");
  assert.equal(book.totalTrades, 2);
});

test("momentum preflight verifies a reciprocal Jupiter route without posting or signing", async t => {
  const { analyzeEntryRoute } = await import("./trojan-entry.js");
  const { mint: sol } = await import("./network.js");
  const token = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const calls = [];
  let returnFraction = 98n;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, undefined);
    const query = new URL(url).searchParams;
    const inputMint = query.get("inputMint");
    const outputMint = query.get("outputMint");
    const amount = BigInt(query.get("amount"));
    assert.ok(!query.has("taker"));
    calls.push([inputMint, outputMint, amount]);
    const outAmount = inputMint === sol ? amount * 2n : amount * returnFraction / 200n;
    return Response.json({ inputMint, outputMint, inAmount: String(amount), outAmount: String(outAmount),
      priceImpactPct: "0.001", routePlan: [{ swapInfo: {}, percent: 100 }] });
  });
  const approved = await analyzeEntryRoute(token, 5, { solUsd: 100, checkExit: true });
  assert.equal(approved.allowed, true);
  assert.equal(approved.roundTripBps, 200);
  assert.deepEqual(calls, [[sol, token, 50_000_000n], [token, sol, 100_000_000n]]);
  returnFraction = 90n;
  assert.equal((await analyzeEntryRoute(token, 5, { solUsd: 100, checkExit: true })).allowed, false);
});

test("Sniper leaves non-PumpPortal items in the independent discovery list", async () => {
  const { CandidateQueue } = await import("./trojan-discovery.js");
  const queue = new CandidateQueue();
  const regular = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const sniper = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
  queue.add([regular], "DEX", now);
  queue.add([sniper], "PumpPortal", now);
  assert.deepEqual(queue.take(now, "sniper").map(item => item.token), [sniper]);
  assert.equal(queue.snapshot(now, "sniper").queued, 0);
  assert.equal(queue.snapshot(now).queued, 1);
  assert.equal(queue.take(now)[0].token, regular);
});

test("Trojan watches balanced order flow instead of misclassifying it as a hard reject", async () => {
  const { trojanDecision } = await import("./trojan-analysis.js");
  const balanced = { ...pair, txns: { m5: { buys: 8, sells: 8 } } };
  for (const profile of ["main", "sniper"]) assert.equal(trojanDecision(balanced, sources, profile, now).decision, "watch");
});

test("an exit prevents re-buying the same token from an older quote or during per-token cooldown", () => {
  const book = newPortfolio();
  const settings = { ...policy, cooldownSeconds: 60 };
  const apply = ticks => advancePortfolio(book, ticks, engine, settings, () => 1, () => true);
  apply([tick(1, now - 4000)]);
  apply([tick(.9, now - 3000)]);
  assert.equal(book.positions["A:P"], undefined);
  apply([tick(1, now - 2000, { observedAt: now - 5000 })]);
  assert.equal(book.decisions[0].reason, "Hinta saatiin ennen edellistä kauppaa");
  apply([tick(1, now - 1000)]);
  assert.equal(book.decisions[0].reason, "Saman tokenin kauppajäähy");
  assert.equal(book.totalTrades, 2);
});
