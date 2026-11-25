import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium, devices, webkit } from "playwright";
import { publicKeyBytes } from "./wallet-standard.js";

const view = (page, pageName) => page.locator(`#dashboard-nav [data-view="${pageName}"]`).click();
const emulatedWebKit = process.env.SCREENER_BROWSER === "webkit";
const browser = await (emulatedWebKit ? webkit.launch() : chromium.launch({ executablePath: process.env.SCREENER_CHROMIUM }));
const site = process.env.SCREENER_PWA_URL ?? "http://127.0.0.1:8018/";
const wsol = "So11111111111111111111111111111111111111112";
const market = [
  ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "11111111111111111111111111111111", "FIRST"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z", "SECOND"]
];

try {
  const page = await browser.newPage(emulatedWebKit ? devices["iPhone 13"] : { viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  const profile = process.env.SCREENER_SCANNER_PROFILE;
  const sniper = profile === "sniper";
  const momentum = profile === "momentum";
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(site).origin) return route.continue();
    return route.fulfill({ json: [], headers: { "Access-Control-Allow-Origin": "*" } });
  });
  let notificationCount = 0;
  let dropping = false;
  let fail = false;
  const attemptedSizes=[];
  await page.route("https://api.geckoterminal.com/api/v2/networks/solana/**", route =>
    route.fulfill({ json: { data: (dropping ? [] : market).map(([token, pool]) => ({
      attributes: { address: pool, base_token_price_usd: "100", reserve_in_usd: "100000",
        volume_usd: { h24: "30000" } },
      relationships: { base_token: { data: { id: `solana_${token}` } } }
    })), included: market.map(([token, , symbol]) => ({
      type: "token", id: `solana_${token}`, attributes: { symbol }
    })) } }));
  for (const endpoint of ["wss://solana-rpc.publicnode.com/", "wss://api.mainnet-beta.solana.com/"]) {
    await page.routeWebSocket(endpoint, socket => {
      socket.onMessage(data => {
        const message = JSON.parse(data);
        if (message.method !== "logsSubscribe") return;
        notificationCount++;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.id }));
        socket.send(JSON.stringify({ method: "logsNotification", params: {
          subscription: message.id, result: { context: { slot: 100 }, value: { err: null } }
        } }));
      });
    });
  }
  await page.routeWebSocket("wss://pumpportal.fun/api/data", socket => {
    socket.onMessage(data => {
      const { method } = JSON.parse(data);
      if (momentum && method === "subscribeMigration") return;
      assert.equal(method, "subscribeNewToken");
      for (const [mint] of market) socket.send(JSON.stringify({ txType: "create", mint }));
    });
  });
  await page.route("https://api.dexscreener.com/**/v1", route =>
    route.fulfill({ json: (dropping ? [] : market).map(([tokenAddress]) => ({ chainId: "solana", tokenAddress })) }));
  await page.route("https://api.dexscreener.com/tokens/v1/solana/**", route =>
    route.fulfill({ json: (dropping ? [] : market).filter(([token]) => route.request().url().includes(token)).map(([token, pool, symbol]) => ({
      chainId: "solana", pairAddress: pool, baseToken: { address: token, symbol }, quoteToken: { address: wsol },
      priceUsd: "100", liquidity: { usd: 100000 }, volume: { h24: 200000, h6: 200000, h1: 80000, m5: 25000 },
      pairCreatedAt: Date.now() - 30 * 60000,
      priceChange: { m5: momentum?7:2, h1: 1, h6: 3, h24: 4 }, txns: { m5: { buys: 90, sells: 10 } }
    })) }));
  await page.route("https://api.dexscreener.com/latest/dex/pairs/solana/**", route => {
    const selected = market.filter(([, pool]) => route.request().url().includes(pool));
    assert.ok(selected.length > 0);
    if (fail) return route.fulfill({ status: 503 });
    return route.fulfill({ json: { pairs: selected.map(([token, pool, symbol]) => ({
      chainId: "solana", pairAddress: pool, baseToken: { address: token, symbol }, quoteToken: { address: wsol },
      priceUsd: dropping ? "80" : "100", liquidity: { usd: 100000 }, volume: { h24: 30000 }
    })) } });
  });
  await page.route("https://api.mainnet-beta.solana.com/", route => {
    const { method, params } = route.request().postDataJSON();
    assert.equal(method, "getMultipleAccounts");
    if (params[1].encoding === "base64") {
      const owner = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
      const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
      const pack = (data, program) => ({ executable: false, owner: program, data: [Buffer.from(data).toString("base64"), "base64"] });
      const poolState = pool => {
        const listed=market.find(row=>row[1]===pool);
        if (!listed) return null;
        const bytes = new Uint8Array(413);
        bytes.set([247, 237, 227, 245, 215, 195, 222, 70]);
        bytes.set(publicKeyBytes(listed[0]), 168);
        bytes.set(publicKeyBytes(wsol), 200);
        bytes.set(publicKeyBytes(market[1][1]), 72);
        bytes.set(publicKeyBytes(market[0][0]), 104);
        return pack(bytes, owner);
      };
      const vault = mint => {
        const bytes = new Uint8Array(165);
        bytes.set(publicKeyBytes(mint));
        new DataView(bytes.buffer).setBigUint64(64, 500_000_000_000n, true);
        bytes[108] = 1;
        return pack(bytes, tokenProgram);
      };
      const mint = new Uint8Array(82);
      mint[44] = 6;
      mint[45] = 1;
      const config = new Uint8Array(116);
      config.set(createHash("sha256").update("account:AmmConfig").digest().subarray(0, 8));
      const [pool, , , base, quote] = params[0];
      const value = params[0].length === 6 ? [poolState(pool), vault(base), vault(quote),
        pack(mint, tokenProgram), pack(mint, tokenProgram), pack(config, owner)] : params[0].map(poolState);
      return route.fulfill({ json: { id: 1, result: { context: { slot: 1 }, value } } });
    }
    return route.fulfill({ json: { id: 1, result: { value: params[0].map(() => ({
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      data: { parsed: { type: "mint", info: { isInitialized: true, mintAuthority: null, freezeAuthority: null } } }
    })) } } });
  });
  await page.route("https://api.rugcheck.xyz/v1/tokens/**", route =>
    route.fulfill({ json: { score_normalised: 1, risks: [], token: { mintAuthority: null, freezeAuthority: null },
      topHolders: Array.from({ length: 10 }, () => ({ pct: 1 })), totalLPProviders: 4 } }));
  await page.route(`https://api.dexscreener.com/token-pairs/v1/solana/${wsol}`, route =>
    route.fulfill({ json: [{ chainId: "solana", baseToken: { address: wsol }, priceUsd: "100",
      liquidity: { usd: 100000 } }] }));
  await page.route("https://api.jup.ag/swap/v2/order?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const amount=BigInt(params.get("amount"));
    const slippage=BigInt(params.get("slippageBps"));
    const resized=momentum && params.get("inputMint")===wsol && params.get("outputMint")===market[0][0];
    if (resized) attemptedSizes.push(amount);
    const out = params.get("inputMint") === wsol ? amount/1000n
      : amount*1000n*(dropping?78n:98n)/100n;
    return route.fulfill({ json: { inputMint: params.get("inputMint"), outputMint: params.get("outputMint"),
      inAmount: params.get("amount"), outAmount: String(out), otherAmountThreshold: String(out*(10000n-slippage)/10000n),
      priceImpactPct: resized && amount>120_000_000n ? ".06" : "0.001",
      routePlan: [{ percent: 100, swapInfo: { label: "fixture" } }], transaction: null } });
  });
  await page.goto(site);
  await view(page, "settings");
  await page.locator("#rule-json").fill(JSON.stringify({
    entry: { metric: "price", compare: "gt", value: 1 },
    exit: { metric: "price", compare: "lt", value: 1 }
  }));
  await page.getByRole("button", { name: "Tallenna ehtopuut" }).click();
  await page.locator("#status").getByText("Ehtopuut tallennettu.").waitFor();
  await view(page, "settings");
  await page.locator('[name="strategy"]').selectOption(momentum ? "8" : sniper ? "6" : "3");
  await page.getByRole("button", { name: "Tallenna asetukset" }).click();
  await page.locator("#status").getByText("Asetukset tallennettu.").waitFor();
  await page.clock.install();
  const analyst = page.waitForEvent("worker", { predicate:worker=>worker.url().endsWith("/analyst-worker.js") });
  await page.locator("#scan").click();
  await analyst;
  await view(page, "monitoring");
  await page.locator("#agent-cards article").last().waitFor();
  assert.equal(await page.locator("#agent-cards article").count(), 5);
  for (let i = 0; i < 20; i++) {
    await page.clock.runFor(3001);
    if (await page.locator("#scan-positions li").count() === 2) break;
  }
  await view(page, "positions");
  if (await page.locator("#scan-positions li").count() !== 2) {
    throw new Error(JSON.stringify(await page.evaluate(() => ({
      events: document.getElementById("scan-events").textContent,
      queue: document.getElementById("scan-queue").textContent,
      status: document.getElementById("scan-status").textContent
    }))));
  }
  await page.locator("#scan-positions").getByText(/SECOND/).waitFor();
  await page.clock.runFor(1500);
  await view(page, "tokens");
  await page.locator("#scan-counts").getByText(/Löydetyt 2.*Hyväksytyt 2/).waitFor();
  assert.equal(await page.locator("#scan-positions li").count(), 2);
  if (sniper) {
    await page.getByText("Tokenien analyysiloki").click();
    await page.locator("#scan-events").getByText(/Hyväksytty.*Jupiter-reitti hyväksytty/).first().waitFor();
  }
  if (momentum) {
    const state = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("screener-paper");
      request.onerror = reject;
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("books").objectStore("books").get("scan-portfolio");
        read.onerror = reject;
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    }));
    assert.equal(state.trades.length, 2);
    assert.ok(attemptedSizes.some(size=>size>120_000_000n) && attemptedSizes.some(size=>size<=120_000_000n));
    assert.ok(state.trades.find(row=>row.token===market[0][0]).notional<=12);
    assert.ok(state.trades.every(trade => trade.strategy === 8 && trade.score >= 80 && trade.feeUsd > 0));
    assert.ok(state.history.length > 0);
    assert.ok(notificationCount > 0);
    assert.ok(state.trades.every(trade => trade.executionDelayMs >= 1000));
  } else assert.match(await page.locator("#scan-balance").innerText(), sniper ? /990/ : /800/);
  fail = true;
  await page.clock.runFor(6001);
  await view(page, "tokens");
  await page.locator("#scan-status").getByText(/uudelleen.*503/).waitFor();
  fail = false;
  dropping = true;
  await page.clock.setSystemTime(Date.now() + 121000);
  for (let i=0;i<8;i++) {
    await page.clock.runFor(3001);
    if (!(await page.locator("#scan-positions li").count())) break;
  }
  await view(page, "positions");
  await page.locator("#scan-trades").getByText(/Myynti.*SECOND/).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("#scan-positions li").length === 0);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.locator("#status").getByText(/Verkkoyhteys katkesi/).waitFor();
  assert.equal(await page.locator("#stop").isDisabled(), true);
  if (momentum) {
    await page.waitForFunction(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("screener-paper");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("books").objectStore("books").get("paper-momentum-learning");
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          db.close();
          resolve(read.result?.samples.filter(sample => sample.type === "paper").length === 2);
        };
      };
    }));
  }
  await page.reload();
  await view(page, "positions");
  await page.locator("#scan-trades").getByText(/Myynti.*SECOND/).waitFor();
  assert.equal(await page.locator("#scan-trades li").count(), 4);
  await view(page, "filtering");
  await page.locator("#agent-feed").getByText(/EXIT.*SECOND/).waitFor();
  assert.deepEqual(errors, []);
  console.log(`${momentum ? "Aggressive Momentum" : sniper ? "Trojan Sniper" : "Custom strategy"}: automatic two-market paper orders, shared capital, retry, risk exits and reload persistence`);
} finally {
  await browser.close();
}
