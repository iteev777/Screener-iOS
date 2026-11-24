import assert from "node:assert/strict";
import { chromium } from "playwright";
import { publicKeyBytes } from "./wallet-standard.js";

const base = process.env.SCREENER_PWA_URL ?? "http://127.0.0.1:8018/";
const browser = await chromium.launch({ executablePath: process.env.SCREENER_CHROMIUM });
const mint = "So11111111111111111111111111111111111111112";
const pool = "11111111111111111111111111111111";
const pair = { chainId: "solana", pairAddress: pool, baseToken: { address: mint, symbol: "WSOL" },
  priceUsd: "151", liquidity: { usd: 100000 }, volume: { h24: 20000 } };

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.routeWebSocket("wss://api.mainnet-beta.solana.com/", () => {});
  await context.route("https://api.dexscreener.com/latest/dex/**", route =>
    route.fulfill({ json: { pairs: [pair] } }));
  await context.route("https://api.geckoterminal.com/api/v2/**", route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get("token"), mint);
    const now = Math.floor(Date.now() / 300000) * 300;
    return route.fulfill({ json: { data: { attributes: { ohlcv_list: [
      [now - 600, 100, 101, 99, 100, 1], [now - 300, 110, 111, 109, 110, 2]
    ] } } } });
  });
  const owner = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
  const cash = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  await context.addInitScript(address => {
    globalThis.phantom = { solana: { isPhantom: true, on() {},
      connect: async () => ({ publicKey: { toString: () => address } }) } };
  }, owner);
  let recent = false;
  const rpcMethods = [];
  const packet = Buffer.from(Uint8Array.of(1, ...new Uint8Array(64), 1, 0, 1, 2,
    ...publicKeyBytes(owner), ...publicKeyBytes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    ...new Uint8Array(32), 1, 1, 0, 1, 10)).toString("base64");
  await context.route("https://api.mainnet-beta.solana.com/", route => {
    const { method, params } = route.request().postDataJSON();
    rpcMethods.push(method);
    const now = Math.floor(Date.now() / 1000);
    const balance = (mint, amount, decimals) => ({ mint, owner, uiTokenAmount: { amount, decimals } });
    const transaction = {
      blockTime: now,
      transaction: { signatures: [params[0]], message: { accountKeys: [{ pubkey: owner, signer: true }],
        instructions: [{ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }] } },
      meta: { err: null, preTokenBalances: [balance(mint, "500000000", 9), balance(cash, "1000000", 6)],
        postTokenBalances: [balance(cash, "75000000", 6)] }
    };
    const old = { signature: "old", blockTime: now - 1 };
    const result = {
      getBalance: { value: 2000000000 }, getTokenSupply: { value: { decimals: 9 } },
      getSignaturesForAddress: recent ? [{ signature: "new", blockTime: now }, old] : [old],
      getTransaction: transaction,
      simulateTransaction: { value: { err: "InvalidAccountForFee" } }
    };
    if (method === "simulateTransaction") assert.equal(params[0], packet);
    assert.ok(Object.hasOwn(result, method), `Unexpected RPC: ${method}`);
    return route.fulfill({ json: { id: 1, result: result[method] } });
  });
  await context.route("https://api.jup.ag/swap/v1/quote?**", route => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.has("asLegacyTransaction")) assert.equal(route.request().headers()["x-api-key"], "fixture");
    assert.equal(query.get("amount"), "1000000");
    return route.fulfill({ json: { inputMint: cash, outputMint: mint, inAmount: "1000000",
      outAmount: "6000000", otherAmountThreshold: "5970000", swapMode: "ExactIn",
      slippageBps: 50, routePlan: [{}] } });
  });
  await context.route("https://api.jup.ag/swap/v1/swap", route => {
    const request = route.request().postDataJSON();
    assert.equal(request.userPublicKey, owner);
    assert.equal(request.asLegacyTransaction, true);
    return route.fulfill({ json: { swapTransaction: packet } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByText("Markkinahaku ja OHLCV").click();
  await page.locator('[name="query"]').fill("WSOL");
  await page.getByRole("button", { name: "Hae Solana-markkinoita" }).click();
  await page.getByRole("button", { name: /WSOL ·/ }).click();
  await page.getByRole("heading", { name: "WSOL / USD" }).waitFor();
  await page.locator("#load-candles").click();
  await page.locator("#candle-status").getByText("2 kynttilää.").waitFor();
  await page.locator("summary").getByText("Oma ehtopuu", { exact: true }).click();
  await page.locator("#rule-json").fill(JSON.stringify({
    entry: { metric: "price", compare: "gt", value: { metric: "sma", period: 2 } },
    exit: { metric: "price", compare: "lt", value: 90 }
  }));
  await page.getByRole("button", { name: "Tallenna ehtopuut" }).click();
  await page.locator("#status").getByText("Ehtopuut tallennettu.").waitFor();
  await page.getByText("Strategia ja riskirajat").click();
  await page.locator('[name="strategy"]').selectOption("3");
  await page.getByRole("button", { name: "Tallenna asetukset" }).click();
  await page.locator("#status").getByText("Asetukset tallennettu.").waitFor();
  await page.locator("#live").click();
  await page.locator("#trades").getByText(/Osto/).waitFor();
  await page.locator("#position").getByText(/Avoin positio.*WSOL/).waitFor();
  await page.getByText("Avoimet paperipositiot").click();
  await page.locator("#open-positions").getByText(/WSOL/).waitFor();
  await page.locator("#stop").click();
  await page.reload();
  await page.getByRole("heading", { name: "WSOL / USD" }).waitFor();
  await page.locator("#trades").getByText(/Osto/).waitFor();
  assert.equal(await page.locator('[name="strategy"]').inputValue(), "3");
  await page.getByText("Botin toimintaloki").click();
  await page.locator("#activity").getByText(/Osto/).waitFor();
  await page.getByText("Strategia ja riskirajat").click();
  await page.locator('[name="strategy"]').selectOption("4");
  await page.getByRole("button", { name: "Tallenna asetukset" }).click();
  await page.locator("#status").getByText("Asetukset tallennettu.").waitFor();
  await page.locator("summary").getByText("Copy Trading", { exact: true }).click();
  await page.locator("#copy-wallet").fill(owner);
  await page.getByRole("button", { name: "Tallenna lompakko" }).click();
  await page.locator("#status").getByText("Copy Trading -lompakko tallennettu.").waitFor();
  await page.clock.install();
  await page.locator("#live").click();
  await page.locator("#status").getByText(/Viimeisin haku/).waitFor();
  assert.equal(await page.locator("#trades li").count(), 1);
  recent = true;
  await page.clock.runFor(30001);
  await page.locator("#trades").getByText(/Myynti/).waitFor();
  await page.locator("#stop").click();

  await page.locator("#mode").selectOption("live");
  await page.locator("#connect").click();
  await page.locator("#balance").getByText(/2 SOL/).waitFor();
  await page.locator("#sync-swaps").click();
  await page.locator("#settlements").getByText(/Myynti.*new/).waitFor();
  await page.locator('[name="value"]').fill("1");
  await page.locator('[name="apiKey"]').fill("fixture");
  await page.getByRole("button", { name: "Hae hinta-arvio" }).click();
  await page.locator("#quote-result").getByText(/0.005970000 WSOL/).waitFor();
  assert.equal(await page.locator('[name="apiKey"]').inputValue(), "");
  await page.getByRole("button", { name: "Muodosta ja simuloi swap" }).click();
  await page.locator("#quote-result").getByText(/InvalidAccountForFee/).waitFor();
  assert.equal(await page.locator("#live").isDisabled(), true);
  assert.ok(rpcMethods.includes("getTransaction"));
  assert.ok(rpcMethods.includes("simulateTransaction"));
  assert.ok(!rpcMethods.includes("sendTransaction"));
  assert.deepEqual(errors, []);
  console.log("Market, candles and WASM rules; persisted paper orders; RPC copy; live settlement import and quote");
} finally {
  await browser.close();
}
