import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discoverMarkets, fetchCandles, normalizeCandles, searchMarkets } from "./markets.js";
import { evaluateRule, validateRules } from "./rules.js";
import { classifySwap, copySignal, usdc } from "./copy.js";
import { formatAtomic, toAtomic, validateQuote } from "./jupiter.js";

const asset = "So11111111111111111111111111111111111111112";
const pool = "11111111111111111111111111111111";
const owner = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const original = { chainId: "solana", baseToken: { address: asset, symbol: "SOL" },
  pairAddress: pool, priceUsd: "100", liquidity: { usd: 100000 }, volume: { h24: 5000 } };
const binary = await readFile(new URL("./engine.wasm", import.meta.url));
const { instance: { exports: engine } } = await WebAssembly.instantiate(binary);

test("search keeps one liquid Solana pool per token and rejects incompatible rows", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.match(url, /latest\/dex\/search\?q=SOL/);
    return Response.json({ pairs: [
      { ...original, liquidity: { usd: 30000 } }, original,
      { ...original, chainId: "ethereum" },
      { ...original, baseToken: { address: owner }, volume: { h24: 1 } }
    ] });
  });
  const markets = await searchMarkets("SOL", { liquidity: 10000, volume: 200 });
  assert.equal(markets.length, 1);
  assert.equal(markets[0].liquidity, 100000);
});

test("discovers new Solana pools with token metadata and liquidity bounds", async t => {
  const id = `solana_${asset}`;
  t.mock.method(globalThis, "fetch", async url => {
    assert.match(url, /solana\/new_pools/);
    return Response.json({
      data: [{ attributes: { address: pool, base_token_price_usd: "100", reserve_in_usd: "50000",
        volume_usd: { h24: "20000" } }, relationships: { base_token: { data: { id } } } }],
      included: [{ id, type: "token", attributes: { symbol: "WSOL" } }]
    });
  });
  const markets = await discoverMarkets("new_pools", { liquidity: 10000, volume: 200 });
  assert.equal(markets[0].token, asset);
  assert.equal(markets[0].symbol, "WSOL");
  assert.equal((await discoverMarkets("new_pools", { liquidity: 60000, volume: 0 })).length, 0);
});

test("OHLCV validates candle consistency and requests the explicit token", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    const request = new URL(url);
    assert.equal(request.pathname, `/api/v2/networks/solana/pools/${pool}/ohlcv/minute`);
    assert.equal(request.searchParams.get("token"), asset);
    assert.equal(request.searchParams.get("aggregate"), "1");
    return Response.json({ data: { attributes: { ohlcv_list: [
      [600, 10, 12, 9, 11, 3], [300, 9, 10, 8, 9, 2],
      [900, 9, 8, 7, 9, 2], [600, 10, 13, 9, 12, 8]
    ] } } });
  });
  assert.deepEqual((await fetchCandles({ token: asset, pool }, "5m")).map(x => x.close), [9, 12]);
});

test("nested rules compare WASM indicators and propagate missing data", () => {
  const candles = normalizeCandles([[300, 1, 1, 1, 1, 2], [600, 3, 3, 3, 3, 4]]);
  const rule = validateRules({ entry: { op: "AND", children: [
    { metric: "price", compare: "gt", value: { metric: "sma", period: 2 } },
    { op: "NOT", children: [{ metric: "liquidity", compare: "lt", value: 1000 }] }
  ] }, exit: { metric: "liquidity", compare: "gt", value: 1 } }).entry;
  const context = { engine, tick: { price: 2.5, liquidity: 1000 }, candles };
  assert.equal(evaluateRule(rule, context), true);
  assert.equal(evaluateRule(rule, { ...context, candles: [] }), null);
  assert.equal(evaluateRule(rule, { ...context, candles: [], tick: { liquidity: 999 } }), false);
  assert.throws(() => validateRules({ entry: { op: "NOT", children: [] }, exit: rule }));
});

function swap() {
  const balance = (mint, amount, decimals) => ({ mint, owner, uiTokenAmount: { amount, decimals } });
  return { blockTime: 1900000000,
    transaction: { message: { accountKeys: [{ pubkey: owner, signer: true }],
      instructions: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }] } },
    meta: { err: null, preTokenBalances: [balance(usdc, "100000000", 6)],
      postTokenBalances: [balance(usdc, "25000000", 6), balance(asset, "500000000", 9)] } };
}

test("copy classifier requires an actual signer and opposing confirmed token deltas", () => {
  const tx = swap();
  assert.deepEqual(classifySwap(tx, owner, asset), { direction: 1, usd: 75, quantity: 0.5, at: tx.blockTime * 1000 });
  tx.transaction.message.accountKeys[0].signer = false;
  assert.equal(classifySwap(tx, owner, asset), undefined);
  tx.transaction.message.accountKeys[0].signer = true;
  tx.transaction.message.instructions = [];
  assert.equal(classifySwap(tx, owner, asset), undefined);
});

test("copy starts from a cursor and ignores old trades and missing cursor gaps", async t => {
  const tx = swap();
  let list = [{ signature: "old", blockTime: tx.blockTime - 1 }];
  const methods = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    methods.push(method);
    tx.transaction.signatures = [params[0]];
    return Response.json({ id: 1, result: method === "getTransaction" ? tx : list });
  });
  const at = tx.blockTime * 1000;
  assert.deepEqual(await copySignal(owner, asset, undefined, at), { cursor: "old", signal: 0 });
  assert.deepEqual(methods, ["getSignaturesForAddress"]);
  list = [{ signature: "new", blockTime: tx.blockTime }, ...list];
  assert.deepEqual(await copySignal(owner, asset, "old", at), { cursor: "new", signal: 1 });
  assert.equal((await copySignal(owner, asset, "old", at + 121000)).signal, 0);
  await assert.rejects(copySignal(owner, asset, "missing", at), /tapahtumaväli/);
});

test("Jupiter validates exact raw amounts, mints and minimum output", () => {
  assert.equal(toAtomic("1.000001", 6), "1000001");
  assert.throws(() => toAtomic("1.0000001", 6));
  assert.throws(() => toAtomic("18446744073709551616", 0));
  const request = { inputMint: usdc, outputMint: asset, amount: "1000000", slippageBps: 50 };
  const valid = { ...request, inAmount: request.amount, outAmount: "2000000", otherAmountThreshold: "1990000",
    swapMode: "ExactIn", routePlan: [{}] };
  assert.equal(formatAtomic(validateQuote(valid, request).minimum, 9), "0.001990000");
  assert.throws(() => validateQuote({ ...valid, otherAmountThreshold: "1989999" }, request));
  assert.throws(() => validateQuote({ ...valid, outputMint: owner }, request));
});

test("unsigned Jupiter preparation validates the payer and uses simulation as its only execution method", async t => {
  const { simulateSwap, validateUnsignedSwap } = await import("./jupiter.js");
  const { publicKeyBytes } = await import("./wallet-standard.js");
  const payer = owner;
  const bytes = Uint8Array.of(1, ...new Uint8Array(64), 1, 0, 1, 2,
    ...publicKeyBytes(payer), ...publicKeyBytes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    ...new Uint8Array(32), 1, 1, 0, 1, 10);
  const packet = Buffer.from(bytes).toString("base64");
  validateUnsignedSwap(packet, payer);
  assert.throws(() => validateUnsignedSwap(packet, pool));
  const signed = bytes.slice();
  signed[1] = 1;
  assert.throws(() => validateUnsignedSwap(Buffer.from(signed).toString("base64"), payer));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("solana.com")) {
      const { method, params } = JSON.parse(options.body);
      requests.push(method);
      if (method === "getTokenSupply") return Response.json({ id: 1, result: { value: { decimals: 9 } } });
      assert.equal(method, "simulateTransaction");
      assert.equal(params[0], packet);
      assert.equal(params[1].sigVerify, false);
      return Response.json({ id: 1, result: { value: { err: "InvalidAccountForFee", unitsConsumed: 0 } } });
    }
    if (url.includes("/quote?")) {
      requests.push("quote");
      assert.equal(new URL(url).searchParams.get("asLegacyTransaction"), "true");
      return Response.json({ inputMint: asset, outputMint: usdc, inAmount: "1000000", outAmount: "200",
        otherAmountThreshold: "199", swapMode: "ExactIn", slippageBps: 50, routePlan: [{}] });
    }
    requests.push("unsigned swap");
    const build = JSON.parse(options.body);
    assert.equal(build.userPublicKey, payer);
    assert.equal(build.asLegacyTransaction, true);
    return Response.json({ swapTransaction: packet });
  });
  const result = await simulateSwap({ token: asset, side: "sell", value: "0.001", payer });
  assert.equal(result.error, "InvalidAccountForFee");
  assert.deepEqual(requests, ["getTokenSupply", "quote", "unsigned swap", "simulateTransaction"]);
});

test("batch Copy Trading reads each confirmation once for all tracked tokens", async t => {
  const { copyBatch } = await import("./copy.js");
  const tx = swap();
  tx.transaction.signatures = ["new"];
  const tracked = new Set([asset, pool]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { method } = JSON.parse(options.body);
    calls.push(method);
    return Response.json({ id: 1, result: method === "getTransaction" ? tx :
      [{ signature: "new", blockTime: tx.blockTime }, { signature: "old", blockTime: tx.blockTime - 1 }] });
  });
  const result = await copyBatch(owner, tracked, "old", tx.blockTime * 1000);
  assert.equal(result.cursor, "new");
  assert.deepEqual([...result.directions], [[asset, 1]]);
  assert.deepEqual(calls, ["getSignaturesForAddress", "getTransaction"]);
});

test("UTC aggregation drops duplicate writes before computing open, high, low, close and volume", async () => {
  const { aggregateCandles } = await import("./markets.js");
  const c = (time, open, close, volume) => ({ time, open, close,
    high: Math.max(open, close), low: Math.min(open, close), volume });
  assert.deepEqual(aggregateCandles([
    c(360, 4, 8, 9), c(300, 3, 4, 2), c(360, 4, 5, 3), c(600, 9, 7, 2)
  ], 60, 300), [c(300, 3, 5, 5), c(600, 9, 7, 2)]);
  assert.throws(() => aggregateCandles([], 300, 60));
});

test("copy group scopes cursors per wallet and suppresses conflicting signals", async t => {
  const { copyGroup } = await import("./copy.js");
  const wallets = [owner, pool];
  const blockTime = swap().blockTime;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === "getSignaturesForAddress") {
      result = [{ signature: params[0], blockTime }, { signature: "old", blockTime: blockTime - 1 }];
    } else {
      const wallet = params[0];
      result = swap();
      result.transaction.signatures = [wallet];
      result.transaction.message.accountKeys[0].pubkey = wallet;
      for (const key of ["preTokenBalances", "postTokenBalances"]) {
        for (const balance of result.meta[key]) balance.owner = wallet;
      }
      if (wallet !== owner) {
        [result.meta.preTokenBalances, result.meta.postTokenBalances] =
          [result.meta.postTokenBalances, result.meta.preTokenBalances];
      }
    }
    return Response.json({ id: 1, result });
  });
  const result = await copyGroup(wallets, new Set([asset]), new Map(wallets.map(wallet => [wallet, "old"])), blockTime * 1000);
  assert.deepEqual([...result.cursors.values()], wallets);
  assert.equal(result.directions.get(asset), 0);
  assert.deepEqual(result.failures, []);
});

test("browser VWAP and ATR call the shared Rust implementations", () => {
  const candles = normalizeCandles([[300, 10, 12, 9, 10, 1], [600, 11, 13, 10, 12, 3]]);
  const vwap = { metric: "vwap", period: 2, compare: "eq", value: 11.5 };
  const atr = { metric: "atrPercent", period: 1, compare: "eq", value: 25 };
  const context = { engine, tick: { price: 12 }, candles };
  assert.equal(evaluateRule(vwap, context), true);
  assert.equal(evaluateRule(atr, context), true);
});

test("custom moving-average cross honors periods and candle lookback in WASM", () => {
  const configured = { metric: "maCross", average: "SMA", fast: 2, period: 3, within: 2,
    compare: "eq", value: 1 };
  const rule = validateRules({ entry: configured, exit: configured }).entry;
  const candles = [10, 9, 8, 9, 12].map((close, i) => ({ close, high: close, low: close, time: 300 * i }));
  assert.equal(evaluateRule(rule, { engine, candles, tick: { price: 12 } }), true);
  assert.equal(evaluateRule(rule, { engine, candles: candles.slice(1), tick: { price: 12 } }), null);
});
