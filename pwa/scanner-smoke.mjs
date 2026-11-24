import assert from "node:assert/strict";
import { chromium } from "playwright";
import { publicKeyBytes } from "./wallet-standard.js";

const browser = await chromium.launch({ executablePath: process.env.SCREENER_CHROMIUM });
const site = process.env.SCREENER_PWA_URL ?? "http://127.0.0.1:8018/";
const wsol = "So11111111111111111111111111111111111111112";
const market = [
  ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "11111111111111111111111111111111", "FIRST"],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z", "SECOND"]
];

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const sniper = process.env.SCREENER_SCANNER_PROFILE === "sniper";
  let dropping = false;
  let fail = false;
  await page.route("https://api.geckoterminal.com/api/v2/networks/solana/**", route =>
    route.fulfill({ json: { data: (dropping ? [] : market).map(([token, pool]) => ({
      attributes: { address: pool, base_token_price_usd: "100", reserve_in_usd: "100000",
        volume_usd: { h24: "30000" } },
      relationships: { base_token: { data: { id: `solana_${token}` } } }
    })), included: market.map(([token, , symbol]) => ({
      type: "token", id: `solana_${token}`, attributes: { symbol }
    })) } }));
  await page.routeWebSocket("wss://pumpportal.fun/api/data", socket => {
    socket.onMessage(data => {
      assert.equal(JSON.parse(data).method, "subscribeNewToken");
      for (const [mint] of market) socket.send(JSON.stringify({ txType: "create", mint }));
    });
  });
  await page.route("https://api.dexscreener.com/**/v1", route =>
    route.fulfill({ json: market.map(([tokenAddress]) => ({ chainId: "solana", tokenAddress })) }));
  await page.route("https://api.dexscreener.com/tokens/v1/solana/**", route =>
    route.fulfill({ json: market.filter(([token]) => route.request().url().includes(token)).map(([token, pool, symbol]) => ({
      chainId: "solana", pairAddress: pool, baseToken: { address: token, symbol }, quoteToken: { address: wsol },
      priceUsd: "100", liquidity: { usd: 100000 }, volume: { h24: 30000, m5: 5000 },
      priceChange: { m5: 2, h1: 1, h24: 4 }, txns: { m5: { buys: 9, sells: 3 } }
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
      const value = params[0].map(pool => {
        const bytes = new Uint8Array(413);
        bytes.set([247, 237, 227, 245, 215, 195, 222, 70]);
        bytes.set(publicKeyBytes(market.find(row => row[1] === pool)[0]), 168);
        bytes.set(publicKeyBytes(wsol), 200);
        return { executable: false, owner: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
          data: [Buffer.from(bytes).toString("base64"), "base64"] };
      });
      return route.fulfill({ json: { id: 1, result: { value } } });
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
    return route.fulfill({ json: { inputMint: params.get("inputMint"), outputMint: params.get("outputMint"),
      inAmount: params.get("amount"), outAmount: "10000", otherAmountThreshold: "9900",
      priceImpactPct: "0.001", routePlan: [{ percent: 100, swapInfo: { label: "fixture" } }], transaction: null } });
  });
  await page.goto(site);
  await page.locator("summary").getByText("Oma ehtopuu", { exact: true }).click();
  await page.locator("#rule-json").fill(JSON.stringify({
    entry: { metric: "price", compare: "gt", value: 1 },
    exit: { metric: "price", compare: "lt", value: 1 }
  }));
  await page.getByRole("button", { name: "Tallenna ehtopuut" }).click();
  await page.locator("#status").getByText("Ehtopuut tallennettu.").waitFor();
  await page.getByText("Strategia ja riskirajat").click();
  await page.locator('[name="strategy"]').selectOption(sniper ? "6" : "3");
  await page.getByRole("button", { name: "Tallenna asetukset" }).click();
  await page.locator("#status").getByText("Asetukset tallennettu.").waitFor();
  await page.clock.install();
  await page.locator("#scan").click();
  for (let i = 0; i < 20; i++) {
    await page.clock.runFor(3001);
    if (await page.locator("#scan-positions li").count() === 2) break;
  }
  await page.locator("#scan-positions").getByText(/SECOND/).waitFor();
  await page.locator("#scan-counts").getByText(/Löydetyt 2.*Hyväksytyt 2/).waitFor();
  assert.equal(await page.locator("#scan-positions li").count(), 2);
  if (sniper) {
    await page.getByText("Tokenien analyysiloki").click();
    await page.locator("#scan-events").getByText(/Hyväksytty.*Jupiter-reitti hyväksytty/).first().waitFor();
  }
  assert.match(await page.locator("#scan-balance").innerText(), sniper ? /990/ : /800/);
  fail = true;
  await page.clock.runFor(6001);
  await page.locator("#scan-status").getByText(/uudelleen.*503/).waitFor();
  fail = false;
  dropping = true;
  await page.clock.setSystemTime(Date.now() + 121000);
  await page.clock.runFor(6001);
  await page.locator("#scan-trades").getByText(/Myynti.*SECOND/).waitFor();
  assert.equal(await page.locator("#scan-positions li").count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.locator("#status").getByText(/Verkkoyhteys katkesi/).waitFor();
  assert.equal(await page.locator("#stop").isDisabled(), true);
  await page.reload();
  await page.getByText("Automaattinen Paper-salkku").click();
  await page.locator("#scan-trades").getByText(/Myynti.*SECOND/).waitFor();
  assert.equal(await page.locator("#scan-trades li").count(), 4);
  assert.deepEqual(errors, []);
  console.log(`${sniper ? "Trojan Sniper" : "Custom strategy"}: automatic two-market paper orders, shared capital, retry, risk exits and reload persistence`);
} finally {
  await browser.close();
}
