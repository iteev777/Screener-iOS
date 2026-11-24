import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.SCREENER_CHROMIUM });
const site = process.env.SCREENER_PWA_URL ?? "http://127.0.0.1:8018/";
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let sends = 0;
  await page.route("https://api.devnet.solana.com/", async route => {
    const { method, params } = route.request().postDataJSON();
    if (method === "sendTransaction") {
      assert.equal(params[1].maxRetries, 0);
      sends++;
      return route.fulfill({ status: 503 });
    }
    if (method === "getSignatureStatuses") assert.equal(params[0].length, 1);
    const result = {
      getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      getBalance: { value: 1000000 },
      getLatestBlockhash: { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } },
      getFeeForMessage: { value: 5000 },
      simulateTransaction: { value: { err: null } },
      getSignatureStatuses: { value: [{ confirmationStatus: "finalized", err: null, slot: 1 }] }
    };
    assert.ok(Object.hasOwn(result, method));
    return route.fulfill({ json: { id: 1, result: result[method] } });
  });
  await page.goto(site);
  await page.locator("#mode").selectOption("live");
  await page.getByText("Devnet-tapahtumatesti").click();
  await page.locator("#devnet-create").click();
  await page.locator("#devnet-wallet").getByText(/[1-9A-HJ-NP-Za-km-z]{32,44}/).waitFor();
  await page.locator("#devnet-send").click();
  await page.locator("#devnet-status").getByText("HTTP 503").waitFor();
  await page.locator("#devnet-history").getByText(/pending/).waitFor();
  assert.equal(await page.locator("#devnet-send").isDisabled(), true);
  await page.reload();
  await page.locator("#mode").selectOption("live");
  await page.getByText("Devnet-tapahtumatesti").click();
  assert.equal(await page.locator("#devnet-wallet").innerText(), "");
  await page.locator("#devnet-sync").click();
  await page.locator("#devnet-history").getByText(/finalized/).waitFor();
  assert.equal(sends, 1);
  console.log("Devnet-only memo journal survives reload, reconciles ambiguous send and never resends");
} finally {
  await browser.close();
}
