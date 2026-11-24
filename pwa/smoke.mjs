import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCREENER_PWA_URL ?? "http://127.0.0.1:8018/";
const browser = await chromium.launch({ executablePath: process.env.SCREENER_CHROMIUM });
const marketUrl = "https://api.dexscreener.com/token-pairs/v1/solana/So11111111111111111111111111111111111111112";
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
let socketClosed;
const closed = new Promise(resolve => { socketClosed = resolve; });
await context.routeWebSocket("wss://api.mainnet-beta.solana.com/", socket => {
  socket.onClose(socketClosed);
  socket.onMessage(message => {
    assert.equal(JSON.parse(message).method, "slotSubscribe");
    socket.send(JSON.stringify({ method: "slotNotification", params: { result: { slot: 12345 } } }));
  });
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const status = page.locator("#status");

async function select(mode) {
  await page.locator("#mode").selectOption(mode);
}

try {
  await page.goto(base);
  const manifest = await page.evaluate(async () => {
    const url = document.querySelector('link[rel="manifest"]').href;
    const response = await fetch(url);
    return { ...(await response.json()), url };
  });
  assert.equal(manifest.display, "standalone");
  assert.equal(new URL(manifest.start_url, manifest.url).href, base);
  for (const icon of manifest.icons) {
    const response = await context.request.get(new URL(icon.src, manifest.url).href);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"], /image\/png/);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.waitForFunction(() => !document.querySelector("#demo").disabled);
  assert.equal(await page.locator("#mode").inputValue(), "paper");
  await page.locator("#demo").click();
  await status.getByText("Testisarja valmis.").waitFor();
  assert.equal(await page.locator("#trades li").count(), 2);
  assert.match(await page.locator("#trades").innerText(), /Myynti[\s\S]*Osto/);
  const perf = await page.evaluate(async () => {
    const response = await fetch("./engine.wasm");
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    const start = performance.now();
    const total = instance.exports.benchmark(100_000);
    return { total, ms: performance.now() - start, imports: WebAssembly.Module.imports(
      await WebAssembly.compile(await (await fetch("./engine.wasm")).arrayBuffer())
    ).length };
  });
  assert.equal(perf.total, 5_000_000);
  assert.equal(perf.imports, 0);
  console.log("Chromium WASM, 100,000 RSI calculations:", perf.ms.toFixed(2), "ms");

  await select("live");
  assert.equal(await page.locator("#live").isDisabled(), true);
  assert.equal(await page.locator("#trades li").count(), 0);
  await select("paper");
  await page.locator("#balance").getByText(/1\s000/).waitFor();
  await page.getByText("Strategia ja riskirajat").click();
  await page.locator('[name="exposureUsd"]').fill("250");
  await page.getByRole("button", { name: "Tallenna asetukset" }).click();
  await status.getByText("Asetukset tallennettu.").waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.equal(await page.locator('[name="exposureUsd"]').inputValue(), "250");
  await context.setOffline(true);
  await page.reload();
  await page.locator("#demo").click();
  await status.getByText("Testisarja valmis.").waitFor();
  assert.equal(await page.locator("#trades li").count(), 4);
  await context.setOffline(false);
  console.log("Paper Trading: 2 trades, persistence across reload, offline shell, separate mode");

  const marketRequest = page.waitForRequest(marketUrl);
  await page.route(marketUrl, route => route.fulfill({
    json: [{ chainId: "solana", baseToken: { address: marketUrl.split("/").at(-1) },
      priceUsd: "150", liquidity: { usd: 100000 } }]
  }));
  await page.locator("#live").click();
  await marketRequest;
  await status.getByText(/Viimeisin haku/).waitFor();
  assert.match(await page.locator("#price").innerText(), /150/);
  await page.locator("#slot").getByText("12345").waitFor();
  assert.equal(await page.locator("#mode").isDisabled(), true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await status.getByText(/Pysäytetty sivulta/).waitFor();
  assert.equal(await page.locator("#mode").isDisabled(), false);
  assert.equal(await page.locator("#slot").innerText(), "—");
  let closeTimer;
  try {
    await Promise.race([closed, new Promise((resolve, reject) => {
      closeTimer = setTimeout(() => reject(new Error("WebSocket stayed open after pagehide")), 3000);
    })]);
  } finally {
    clearTimeout(closeTimer);
  }
  await page.unroute(marketUrl);
  console.log("DEX Screener fixture parsed, mode frozen while running, stopped on pagehide");

  const walletContext = await browser.newContext({ serviceWorkers: "block" });
  await walletContext.addInitScript(() => {
    const listeners = new Map();
    window.phantom = { solana: {
      isPhantom: true,
      async connect() {
        return { publicKey: { toString: () => "11111111111111111111111111111111" } };
      },
      on(name, listener) { listeners.set(name, listener); }
    } };
    window.mockDisconnect = () => listeners.get("disconnect")();
  });
  const walletPage = await walletContext.newPage();
  await walletPage.route("https://api.mainnet-beta.solana.com/", route => {
    const rpc = route.request().postDataJSON();
    assert.equal(rpc.method, "getBalance");
    assert.equal(rpc.params[0], "11111111111111111111111111111111");
    return route.fulfill({ json: { id: 1, result: { value: 2_000_000_000 } } });
  });
  await walletPage.goto(base);
  await walletPage.locator("#mode").selectOption("live");
  await walletPage.locator("#connect").click();
  await walletPage.locator("#balance").getByText(/2 SOL/).waitFor();
  assert.equal(await walletPage.locator("#live").isDisabled(), true);
  await walletPage.evaluate(() => window.mockDisconnect());
  await walletPage.locator("#status").getByText(/yhteys katkesi/).waitFor();
  assert.equal(await walletPage.locator("#live").isDisabled(), true);
  console.log("Phantom adapter fixture: read-only getBalance and disconnect");

  const standardContext = await browser.newContext({ serviceWorkers: "block" });
  await standardContext.addInitScript(() => {
    // Public RFC 8032 test vector. This key is used only by the in-memory fixture.
    const address = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
    const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const d = "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A";
    const publicKey = Uint8Array.from(atob(x.replaceAll("_", "/") + "="), char => char.charCodeAt(0));
    const account = {
      address, publicKey, chains: ["solana:mainnet", "solana:devnet"],
      features: ["solana:signTransaction"]
    };
    const wallet = { accounts: [account], features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signTransaction": {
        supportedTransactionVersions: ["legacy"],
        async signTransaction({ chain, transaction }) {
          if (chain !== "solana:devnet") throw new Error("Invalid probe chain");
          const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d, x },
            "Ed25519", false, ["sign"]);
          const signedTransaction = transaction.slice();
          signedTransaction.set(new Uint8Array(
            await crypto.subtle.sign("Ed25519", key, transaction.subarray(65))
          ), 1);
          return [{ signedTransaction }];
        }
      }
    } };
    window.addEventListener("wallet-standard:app-ready", event => event.detail.register(wallet));
  });
  const standardPage = await standardContext.newPage();
  await standardPage.route("https://api.mainnet-beta.solana.com/", route => {
    assert.equal(route.request().postDataJSON().method, "getBalance");
    return route.fulfill({ json: { id: 1, result: { value: 2_000_000_000 } } });
  });
  const devnetCalls = [];
  await standardPage.route("https://api.devnet.solana.com/", route => {
    devnetCalls.push(route.request().postDataJSON().method);
    return route.fulfill({ json: { id: 1, result: {
      value: { blockhash: "11111111111111111111111111111111" }
    } } });
  });
  await standardPage.goto(base);
  await standardPage.locator("#mode").selectOption("live");
  await standardPage.locator("#connect").click();
  await standardPage.locator("#balance").getByText(/2 SOL/).waitFor();
  await standardPage.locator("#sign-probe").click();
  await standardPage.locator("#status").getByText(/Devnet-allekirjoitus varmennettu/).waitFor();
  assert.deepEqual(devnetCalls, ["getLatestBlockhash"]);
  console.log("Wallet Standard fixture: signed and verified Devnet memo without broadcasting");

  const liveContext = await browser.newContext({ serviceWorkers: "block" });
  await liveContext.routeWebSocket("wss://api.mainnet-beta.solana.com/", () => {});
  const livePage = await liveContext.newPage();
  await livePage.route("**/live-adapter.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `export function createLiveAdapter() {
      let book = { cash: 100, sol: 0, walletSol: 2, trades: [] };
      return {
        ready: true, connect: async () => "mock-wallet", onWalletChange() {},
        snapshot: async () => book,
        async execute({ order, price }) {
          if (order.side !== "Osto" || order.usd !== 100 || price !== 142) {
            throw new Error("Unexpected simulated order");
          }
          book = { ...book, cash: 0, sol: order.usd / price, count: 1,
            trades: [{ side: order.side, price }] };
          return book;
        }
      };
    }`
  }));
  await livePage.route(marketUrl, route => route.fulfill({ status: 503 }));
  await livePage.goto(base);
  await livePage.locator("#mode").selectOption("live");
  assert.equal(await livePage.locator("#live").isDisabled(), true);
  await livePage.locator("#connect").click();
  await livePage.locator("#balance").getByText(/2 SOL/).waitFor();
  livePage.once("dialog", dialog => dialog.dismiss());
  await livePage.locator("#live").click();
  assert.equal(await livePage.locator("#mode").isDisabled(), false);
  livePage.once("dialog", dialog => dialog.accept());
  await livePage.locator("#live").click();
  await livePage.locator("#status").getByText(/HTTP 503/).waitFor();
  assert.equal(await livePage.locator("#mode").isDisabled(), false);
  await livePage.unroute(marketUrl);
  const prices = [151, 148, 145, 142];
  await livePage.route(marketUrl, route => route.fulfill({
    json: [{ chainId: "solana", baseToken: { address: marketUrl.split("/").at(-1) },
      priceUsd: String(prices.shift() ?? 142), liquidity: { usd: 100000 } }]
  }));
  await livePage.clock.install();
  livePage.once("dialog", dialog => dialog.accept());
  await livePage.locator("#live").click();
  for (const expected of [151, 148, 145, 142]) {
    await livePage.locator("#price").getByText(new RegExp(String(expected))).waitFor();
    await livePage.locator("#status").getByText(/Viimeisin haku/).waitFor();
    if (expected !== 142) await livePage.clock.runFor(30001);
  }
  assert.equal(await livePage.locator("#trades li").count(), 1);
  await livePage.locator("#stop").click();
  await livePage.locator("#mode").selectOption("paper");
  await livePage.locator("#balance").getByText(/1\s000/).waitFor();
  assert.equal(await livePage.locator("#trades li").count(), 0);
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#emergency").click();
  await page.locator("#run-state").getByText("Lukittu").waitFor();
  assert.equal(await page.locator("#scan").isDisabled(), true);
  await page.reload();
  await page.locator("#run-state").getByText("Lukittu").waitFor();
  assert.equal(await page.locator("#demo").isDisabled(), true);
  await page.locator("#emergency").click();
  await page.locator("#run-state").getByText("Pysäytetty").waitFor();
  assert.equal(await page.locator("#scan").isEnabled(), true);
  console.log("320px dashboard, persistent emergency stop and explicit rearm");
  assert.deepEqual(errors, []);
  console.log("Live adapter fixture: wallet, confirmation, failure stop, shared strategy/risk and separate book");
} finally {
  await browser.close();
}
