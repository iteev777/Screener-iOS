import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { advancePortfolio, mintEligible, newPortfolio, positionKey, rugEligible, universe } from "./scanner.js";
import { defaults } from "./policy.js";

const { instance: { exports: engine } } = await WebAssembly.instantiate(
  await readFile(new URL("./engine.wasm", import.meta.url))
);
const policy = { ...defaults, feeBps: 0, slippageBps: 0, cooldownSeconds: 0 };
const tick = (token, price = 100, at = 100000, pool = token) =>
  ({ token, pool, symbol: token, price, at, liquidity: 100000, volume: 20000 });
const enter = () => 1;
const allowed = () => true;
const run = (portfolio, ticks, settings = policy, eligible = allowed, decide = enter) =>
  advancePortfolio(portfolio, ticks, engine, settings, decide, eligible);

test("parallel markets share capital and exposure and duplicate pools cannot buy the same token", () => {
  const book = run(newPortfolio(), [tick("A"), tick("A", 100, 100000, "other"), tick("B"), tick("C")]);
  assert.equal(book.cash, 800);
  assert.equal(Object.keys(book.positions).length, 2);
  assert.deepEqual(book.trades.map(t => t.symbol), ["B", "A"]);
  assert.equal(universe(book, []).length, 2);
});

test("exits run before entries and shared realized losses block buys even if the mint check fails", () => {
  const book = run(newPortfolio(), [tick("A"), tick("B")]);
  run(book, [tick("C", 100, 200000), tick("B", 85, 200000), tick("A", 90, 200000)],
    { ...policy, lossUsd: 20 }, token => token === "C");
  assert.deepEqual(Object.keys(book.positions), []);
  assert.equal(book.realized, -25);
  assert.equal(book.cash, 975);
  assert.equal(book.trades.length, 4);
  run(book, [tick("A", 100, 200000)]);
  assert.equal(book.trades.length, 4);
});

test("held pools outlive discovery and exits release capital for another token", () => {
  const book = run(newPortfolio(), [tick("A")], { ...policy, exposureUsd: 100 });
  const candidates = Array.from({ length: 20 }, (_, i) => tick(String(i)));
  assert.equal(universe(book, candidates).length, 12);
  assert.equal(positionKey(universe(book, candidates)[0]), "A:A");
  run(book, [tick("B", 100, 200000), tick("A", 95, 200000)], { ...policy, exposureUsd: 100 });
  assert.deepEqual(Object.keys(book.positions), ["B:B"]);
  assert.equal(book.trades[1].side, "Myynti");
});

test("mint screening fails closed on unknown programs and mutable mint or freeze authorities", () => {
  const account = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: {
    parsed: { type: "mint", info: { isInitialized: true, mintAuthority: null, freezeAuthority: null } }
  } };
  assert.equal(mintEligible(account), true);
  account.data.parsed.info.freezeAuthority = "authority";
  assert.equal(mintEligible(account), false);
  assert.equal(mintEligible(null), false);
});


test("RugCheck safety gate denies danger, excess scores and missing reports", () => {
  assert.equal(rugEligible({ score_normalised: 8, risks: [] }, 10), true);
  assert.equal(rugEligible({ score_normalised: 8, risks: [{ level: "DANGER" }] }, 10), false);
  assert.equal(rugEligible({ score_normalised: 11, risks: [] }, 10), false);
  assert.equal(rugEligible({ risks: [] }, 10), false);
});

test("RPC transport fails over for reads and never retries transaction submission", async t => {
  const { rpcCall } = await import("./network.js");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url, JSON.parse(options.body).method]);
    return url.includes("mainnet-beta")
      ? new Response("", { status: 403 })
      : Response.json({ id: 1, result: { value: [] } });
  });
  assert.deepEqual(await rpcCall("getMultipleAccounts", [[]]), { value: [] });
  await assert.rejects(rpcCall("sendTransaction", ["fixture"]), /403/);
  assert.deepEqual(requests.map(([url, method]) => [new URL(url).hostname, method]), [
    ["api.mainnet-beta.solana.com", "getMultipleAccounts"],
    ["solana-rpc.publicnode.com", "getMultipleAccounts"],
    ["api.mainnet-beta.solana.com", "sendTransaction"]
  ]);
});

test("lowering configured pool count never drops held markets", () => {
  const portfolio = run(newPortfolio(), [tick("A"), tick("B")]);
  assert.deepEqual(universe(portfolio, [tick("C")], 1).map(item => item.token), ["A", "B"]);
  assert.deepEqual(universe(newPortfolio(), [tick("A"), tick("B")], 1).map(item => item.token), ["A"]);
});

test("daily purchase allowance is shared across pools and resets at UTC midnight", () => {
  const limited = { ...policy, maxDailyBuys: 1 };
  const book = run(newPortfolio(), [tick("A"), tick("B")], limited);
  assert.deepEqual(Object.keys(book.positions), ["A:A"]);
  run(book, [tick("A", 85, 200000), tick("B", 100, 200000)], limited);
  assert.equal(book.trades[0].side, "Myynti");
  assert.equal(Object.keys(book.positions).length, 0);
  run(book, [tick("C", 100, 86401000)], limited);
  assert.deepEqual(Object.keys(book.positions), ["C:C"]);
});

test("Trojan paper entries cap order notional to five dollars and 10% of available cash", () => {
  const book = newPortfolio();
  book.cash = 20;
  const settings = { ...policy, strategy: 5 };
  run(book, [tick("A")], settings);
  assert.equal(book.positions["A:A"].cost, 2);
  const low = newPortfolio();
  low.cash = 9;
  run(low, [tick("B")], settings);
  assert.deepEqual(Object.keys(low.positions), []);
});
