import assert from "node:assert/strict";
import test from "node:test";
import { fullRugCheck } from "./trojan-security.js";
import { analyzeEntryRoute, routeQuality } from "./trojan-entry.js";
import { decodePool, verifyPools } from "./trojan-pools.js";
import { publicKeyBytes } from "./wallet-standard.js";

const wsol = "So11111111111111111111111111111111111111112";
const token = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pool = "11111111111111111111111111111111";
const cpmm = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const safe = () => ({ score_normalised: 10, token: { mintAuthority: null, freezeAuthority: null },
  risks: [], topHolders: Array.from({ length: 10 }, () => ({ pct: 2 })), totalLPProviders: 10,
  totalMarketLiquidity: 40000, lpLockedPct: 95 });

test("full RugCheck evaluates holder concentration and LP locks and fails closed for missing data", () => {
  assert.equal(fullRugCheck(safe(), { minRegularLock: 90 }).status, "approve");
  const concentrated = { ...safe(), topHolders: [{ pct: 55 }] };
  assert.equal(fullRugCheck(concentrated).status, "reject");
  assert.match(fullRugCheck(concentrated).reasons.join(), /omistajan/);
  assert.equal(fullRugCheck({ ...safe(), lpLockedPct: 5 }, { minRegularLock: 90 }).status, "reject");
  assert.equal(fullRugCheck({ ...safe(), topHolders: [] }).status, "watch");
  assert.equal(fullRugCheck({ ...safe(), totalMarketLiquidity: 0 }).status, "reject");
});

test("RugCheck distinguishes its disabled authority sentinel from a fee or graph risk",()=>{
  const transferFee={pct:0,maxAmount:0,authority:"11111111111111111111111111111111"};
  const normal=fullRugCheck({...safe(),transferFee});
  assert.ok(!normal.reasons.includes("Siirtomaksuvaltuus aktiivinen"));
  const active=fullRugCheck({...safe(),transferFee:{...transferFee,authority:"real-authority"}});
  assert.ok(active.reasons.includes("Siirtomaksuvaltuus aktiivinen"));
  assert.equal(fullRugCheck({...safe(),transferFee:{...transferFee,pct:10}}).status,"reject");
  assert.equal(fullRugCheck({...safe(),transferFee,graphInsidersDetected:3}).status,"reject");
});

test("pool decoder enforces owner, discriminator, status and RPC mint binding", async t => {
  const bytes = new Uint8Array(413);
  bytes.set([247, 237, 227, 245, 215, 195, 222, 70]);
  bytes.set(publicKeyBytes(token), 168);
  bytes.set(publicKeyBytes(wsol), 200);
  assert.equal(decodePool(cpmm, bytes).protocol, "Raydium CPMM");
  assert.equal(decodePool(pool, bytes).status, "unsupported");
  assert.equal(decodePool(cpmm, bytes.subarray(1)).status, "reject");
  bytes[329] = 4;
  assert.equal(decodePool(cpmm, bytes).status, "reject");
  bytes[329] = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).method, "getMultipleAccounts");
    return Response.json({ id: 1, result: { value: [
      { owner: cpmm, executable: false, data: [Buffer.from(bytes).toString("base64"), "base64"] }
    ] } });
  });
  assert.equal((await verifyPools([{ token, pool, quoteToken: wsol }]))[0].status, "approve");
  assert.equal((await verifyPools([{ token: pool, pool, quoteToken: wsol }]))[0].status, "reject");
});

test("Jupiter v2 checks amounts, route quality, impact and simulation drift without sending", async t => {
  let drift = false;
  const methods = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!url.includes("jup.ag")) {
      const request = JSON.parse(options.body);
      methods.push(request.method);
      assert.equal(request.method, "simulateTransaction");
      assert.equal(request.params[1].sigVerify, false);
      return Response.json({ id: 1, result: { value: { err: null } } });
    }
    const params = new URL(url).searchParams;
    const taker = params.has("taker");
    assert.equal(params.get("amount"), "50000000");
    return Response.json({ inputMint: wsol, outputMint: token, inAmount: params.get("amount"),
      outAmount: taker && drift ? "10200" : "10000", otherAmountThreshold: taker && drift ? "10098" : "9900",
      transaction: taker ? "A".repeat(100) : null, priceImpactPct: "0.001",
      routePlan: [{ percent: 100, swapInfo: { label: "mock" } }] });
  });
  assert.equal(routeQuality({ priceImpactPct: 0.04, routePlan: [{ swapInfo: {} }] }).allowed, false);
  assert.equal((await analyzeEntryRoute(token, 5, { solUsd: 100 })).simulation, "skipped");
  assert.equal((await analyzeEntryRoute(token, 5, { solUsd: 100, taker: pool })).simulation, "passed");
  drift = true;
  assert.equal((await analyzeEntryRoute(token, 5, { solUsd: 100, taker: pool })).allowed, false);
  assert.deepEqual(methods, ["simulateTransaction"]);
});

test("Jupiter v2 signed impact keeps the same risk cap in both quote formats", () => {
  const routePlan = [{ swapInfo: {}, percent: 100, bps: 10000 }];
  assert.equal(routeQuality({ priceImpactPct:"-0.00025", priceImpact:-.025, routePlan }).allowed,true);
  assert.equal(routeQuality({ priceImpactPct:"-0.00025", routePlan }).impact,.025);
  assert.equal(routeQuality({ priceImpact:-.025, routePlan }).impact,.025);
  assert.equal(routeQuality({ priceImpactPct:"-0.04", routePlan }).allowed,false);
  assert.equal(routeQuality({ priceImpact:-4, routePlan }).allowed,false);
  assert.equal(routeQuality({ priceImpactPct:"-0.001", routePlan:[] }).allowed,false);
});
