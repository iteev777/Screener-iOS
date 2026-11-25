import assert from "node:assert/strict";
import test from "node:test";
import { candidateQuality, trojanDecision } from "./trojan-analysis.js";
import { CandidateQueue, marketBatch, sourcesFor } from "./trojan-discovery.js";

const now = 1800000000000;
const mint = "So11111111111111111111111111111111111111112";
const pool = "11111111111111111111111111111111";
const provenance = new Set(["PumpPortal", "Latest Profiles"]);
const pair = { chainId: "solana", baseToken: { address: mint }, pairAddress: pool, priceUsd: "10",
  liquidity: { usd: 50000 }, volume: { m5: 5000, h1: 21000, h6: 55000, h24: 110000 },
  txns: { m5: { buys: 9, sells: 3 }, h1: { buys: 30, sells: 10 } },
  priceChange: { m5: 2, h1: 1, h6: 3, h24: 4 }, pairCreatedAt: now - 600000 };

test("Trojan quality scoring and Main/Sniper reversal thresholds", () => {
  assert.deepEqual(candidateQuality(pair, provenance, now), { score: 96, tier: "strong" });
  assert.equal(trojanDecision(pair, provenance, "main", now).score, 95);
  const young = { ...pair, pairCreatedAt: now - 60000 };
  assert.equal(trojanDecision(young, provenance, "main", now).decision, "watch");
  assert.equal(trojanDecision(young, provenance, "sniper", now).decision, "approve");
  assert.equal(trojanDecision({ ...pair, priceChange: {} }, provenance, "main", now).decision, "watch");
  const rising = { ...pair, priceChange: { ...pair.priceChange, m5: 9 } };
  const decision = trojanDecision(rising, provenance, "main", now);
  assert.equal(decision.decision, "approve");
  assert.ok(decision.score < trojanDecision(pair, provenance, "main", now).score);
  assert.notEqual(trojanDecision({ ...rising, txns: { m5: { buys: 1, sells: 9 } } }, provenance, "main", now).decision, "approve");
  assert.notEqual(trojanDecision({ ...rising, liquidity: { usd: 100 } }, provenance, "main", now).decision, "approve");
  assert.notEqual(trojanDecision({ ...rising, priceChange: { ...rising.priceChange, m5: 200000 } }, provenance, "main", now).decision, "approve");
});

test("discovery merges sources and retries incomplete metadata outside the pool allowance", () => {
  const queue = new CandidateQueue();
  queue.add([mint, mint, pool], "Latest Profiles", now);
  queue.add([mint], "PumpPortal", now);
  assert.equal(queue.snapshot(now).found, 2);
  const batch = queue.take(now);
  const entry = batch.find(item => item.token === mint);
  assert.equal(queue.take(now).length, 0, 'reserved tokens cannot be claimed twice');
  assert.deepEqual([...entry.sources], ["Latest Profiles", "PumpPortal"]);
  queue.finish(entry, "watch", undefined, now);
  assert.equal(queue.snapshot(now).waiting, 1);
  assert.equal(queue.take(now + 9999).length, 0);
  queue.release(batch, now);
  const retry = queue.take(now + 9999);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].token, pool);
  assert.deepEqual(queue.take(now + 10000).map(item => item.token), [mint]);
});

test("browser adapters choose highest-liquidity Solana base pair and configure all sources", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.match(url, /tokens\/v1\/solana/);
    return Response.json([pair, { ...pair, liquidity: { usd: 51000 } }, { ...pair, chainId: "ethereum" }]);
  });
  assert.equal((await marketBatch([mint])).get(mint).market.liquidity, 51000);
  assert.deepEqual(sourcesFor("key").map(source => source.name), ["Latest Profiles", "Latest Boosts",
    "Top Boosts", "Community Takeovers", "GeckoTerminal new_pools", "GeckoTerminal trending_pools", "Birdeye", "RugCheck new_tokens", "RugCheck recent", "RugCheck trending", "RugCheck verified", "Jupiter recent", "Jupiter toporganicscore/1h?limit=100", "Jupiter toptraded/1h?limit=100", "Jupiter toptrending/1h?limit=100", "CoinGecko", "DeFiLlama", "Birdeye Meme Listing"]);
});
