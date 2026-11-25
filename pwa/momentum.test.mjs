import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { rankCandidates } from "./candidate-analyst.js";
import { momentumEntry, momentumExit, momentumSize, shortMomentum, momentumSignal, momentumCalibration, snapshotMomentum } from "./momentum.js";
import { defaults } from "./policy.js";
import { advancePortfolio, newPortfolio } from "./scanner.js";

const now = Date.now();
const pair = {
  pairCreatedAt: now - 30 * 60000, priceUsd: "1", liquidity: { usd: 100000 },
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

test("rapid momentum takes partial profit and preserves trailing and liquidity exits", () => {
  const book = { cost: 100, sol: 100, peak: 1.2, entryLiquidity: 100000, openedAt: now };
  assert.equal(momentumExit(book, tick(1.5, now + 1000), policy).sol, 50);
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

test("GeckoTerminal converts real pool fields and uses only fresh, same-pool fallback", async () => {
  const { geckoPairs, preferMarket } = await import("./market-tape.js");
  const token = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const quote = "So11111111111111111111111111111111111111112";
  const pool = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
  const record = {
    attributes: { address: pool, base_token_price_usd: "2", reserve_in_usd: "55000",
      volume_usd: { m5: "4000", h1: "20000" }, price_change_percentage: { m5: "1", h1: null },
      transactions: { m5: { buys: 15, sells: 6 } } },
    relationships: { base_token: { data: { id: "solana_" + token } }, quote_token: { data: { id: "solana_" + quote } } }
  };
  const [alternate] = geckoPairs({ data: [record] }, now);
  assert.equal(alternate.market.quoteToken, quote);
  assert.equal(alternate.market.volume5, 4000);
  assert.equal(alternate.market.changeHour, undefined);
  assert.equal(alternate.market.transactions.m5.sells, 6);
  const primary = { market: { pool } };
  assert.equal(preferMarket(primary, alternate, now + 1000), alternate);
  assert.equal(preferMarket(primary, alternate, now + 16000), primary);
  assert.equal(preferMarket({ market: { pool: "other" } }, alternate, now).market.pool, "other");
  assert.equal(preferMarket(undefined, alternate, now), alternate);
});

test("young pool fallback requires real recent flow and mature pools require a comparative baseline", () => {
  const active = {
    ...pair, pairCreatedAt: now - 10 * 60000, volume: { ...pair.volume, h1: undefined },
    priceChange: { ...pair.priceChange, h1: undefined }
  };
  assert.equal(momentumEntry(active, sources, 80, now).decision, "approve");
  assert.equal(momentumEntry({ ...active, pairCreatedAt: now - 90 * 60000 }, sources, 80, now).code, "missing-baseline");
  assert.equal(momentumEntry({ ...active, txns: { m5: { buys: 3, sells: 0 } } }, sources, 80, now).code, "thin-flow");
  assert.equal(momentumEntry({ ...active, txns: {m5:{buys:4,sells:0}} },sources,80,now).code,"missing-baseline");
});

test("a partial profit releases cash and charges estimated costs before the remaining exit", () => {
  const book = newPortfolio();
  const settings = { ...policy, feeBps: 20, slippageBps: 15, momentumProfitShare: 50 };
  const execute = ticks => advancePortfolio(book, ticks, engine, settings, () => 1, () => true);
  const weak = { transactions: { m5: { buys: 4, sells: 12 } }, change5: 1 };
  execute([tick(1, now)]);
  const initialQuantity = book.positions["A:P"].sol;
  const cashAfterEntry = book.cash;
  execute([tick(1.15, now + 1000, weak)]);
  assert.equal(book.decisions[0].state, "PARTIAL SELL");
  assert.equal(book.positions["A:P"].sol, initialQuantity / 2);
  assert.ok(book.cash > cashAfterEntry);
  assert.ok(book.trades[0].feeUsd > 0 && book.trades[0].price < 1.15);
  execute([tick(1.23, now + 2000, weak)]);
  assert.equal(book.trades[0].closed, true);
  assert.equal(book.decisions[0].state, "EXIT");
  assert.equal(book.positions["A:P"], undefined);
  assert.ok(book.cash > policy.paperCapital);
});

test("short windows require timestamped trades and reject missing observations",()=>{
  assert.equal(momentumSignal(shortMomentum([],now),95).decision,"watch");
  const rows=Array.from({length:60},(_,i)=>({at:now-(59-i)*1000,price:1+i*.003,usd:i>44?400:50,side:"buy"}));
  const w=shortMomentum(rows,now);
  assert.equal(w[5].count,5);
  assert.equal(w[60].count,60);
  assert.equal(momentumSignal(w,95).decision,"approve");
});

test("consistent pool prices and aggregate activity can confirm momentum without an hourly bar",()=>{
  const history=[1,1.03,1.06].map((price,i)=>({price,liquidity:50000,at:now+i*6000,provider:"DEX"}));
  const market={created:now-60000,liquidity:50000,volume5:5000,transactions:pair.txns};
  assert.equal(snapshotMomentum(history,market,90,80,policy).decision,"approve");
  assert.equal(snapshotMomentum(history,{...market,transactions:{}},90,80,policy).code,"quote-flow");
  assert.equal(snapshotMomentum(history,{...market,liquidity:40000},90,80,policy).code,"quote-motion");
});

test("economic quoting supports executable impact above 3% while limiting net loss",async t=>{
  const {analyzeEntryRoute}=await import("./trojan-entry.js");
  const {mint:sol}=await import("./network.js");
  const token="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  let impact=".035", returned=98n;
  t.mock.method(globalThis,"fetch",async url=>{
    const query=new URL(url).searchParams, inputMint=query.get("inputMint"), input=BigInt(query.get("amount"));
    return Response.json({inputMint,outputMint:query.get("outputMint"),inAmount:String(input),
      outAmount:String(inputMint===sol?input*2n:input*returned/200n),
      priceImpactPct:inputMint===sol?impact:".006",routePlan:[{percent:100,swapInfo:{}}]});
  });
  const economics={expectedPct:4,liquidity:10000,feeBps:20,slippageBps:35,lossPct:5};
  const quote=(extra={})=>analyzeEntryRoute(token,8,{solUsd:100,checkExit:true,economics:{...economics,...extra}});
  assert.equal((await quote()).allowed,true);
  assert.equal((await analyzeEntryRoute(token,8,{solUsd:100,checkExit:true})).allowed,false);
  assert.equal((await quote({expectedPct:1})).allowed,false);
  assert.equal((await quote({expectedPct:1,observeOnly:true})).allowed,true);
  returned=94n;
  assert.equal((await quote({expectedPct:10})).allowed,false);
  impact=".06";
  assert.equal((await quote()).allowed,false);
});
test("calibration requires completed positions and never lowers baseline",()=>{
  const rows=[];
  for(let i=0;i<30;i++){
    rows.unshift({strategy:8,token:String(i),pool:"P",side:"Osto",notional:10,score:85});
    rows.unshift({strategy:8,token:String(i),pool:"P",side:"Myynti",realizedPnl:-1,closed:true});
  }
  assert.equal(momentumCalibration(rows,80).threshold,84);
  assert.equal(momentumCalibration(rows.slice(0,10),80).threshold,80);
});
