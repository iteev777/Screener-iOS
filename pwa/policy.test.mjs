import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyPaperFill, defaults, orderFor, validateSettings } from "./policy.js";
import { memoMessage, publicKeyBytes, signDevnetProbe } from "./wallet-standard.js";

const wasm = await readFile(new URL("./engine.wasm", import.meta.url));
const { instance: { exports: engine } } = await WebAssembly.instantiate(wasm);
const minute = 60000;
const tick = (price, at = minute, liquidity = 100000) => ({ price, at, liquidity });
const fresh = () => ({ sol: 0, cash: 1000, trades: [] });

test("validates persisted settings and caps exposure", () => {
  assert.equal(validateSettings({ strategy: 2 }).strategy, 2);
  for (const variant of [{ strategy: 7 }, { orderUsd: Infinity }, { orderUsd: 200, exposureUsd: 99 }]) {
    assert.throws(() => validateSettings(variant));
  }
});

test("paper accounts for fees and slippage and blocks new entries at the loss limit", () => {
  const book = fresh();
  const policy = { ...defaults, lossUsd: 3 };
  const enter = orderFor(engine, 1, book, tick(100), policy);
  applyPaperFill(book, enter, tick(100), policy);
  assert.equal(book.cash, 900);
  assert.ok(book.sol < 1);
  const exit = orderFor(engine, 1, book, tick(94, 2 * minute, 1), policy);
  assert.equal(exit.reason, 1);
  applyPaperFill(book, exit, tick(94, 2 * minute, 1), policy);
  assert.ok(book.realized < -6);
  assert.equal(book.sol, 0);
  assert.equal(orderFor(engine, 1, book, tick(100, 3 * minute), policy), undefined);
  assert.equal(orderFor(engine, 1, book, tick(100, 86400000 + minute), policy).side, "Osto");
});

test("limits DCA, respects the cooldown and rejects illiquid entries", () => {
  const policy = { ...defaults, dca: 1 };
  const book = fresh();
  assert.equal(orderFor(engine, 1, book, tick(100, minute, 5), policy), undefined);
  applyPaperFill(book, orderFor(engine, 1, book, tick(100), policy), tick(100), policy);
  assert.equal(orderFor(engine, 1, book, tick(97, minute + 1), policy), undefined);
  const addTick = tick(97, 2 * minute);
  const add = orderFor(engine, 1, book, addTick, policy);
  assert.equal(add.reason, 7);
  applyPaperFill(book, add, addTick, policy);
  assert.equal(book.cost, 200);
  assert.equal(orderFor(engine, 1, book, tick(96, 3 * minute), policy), undefined);
});

test("take-profit ladder sells each fraction once and preserves proportional cost", () => {
  const policy = { ...defaults, feeBps: 0, slippageBps: 0, profitShare: 30 };
  const book = fresh();
  applyPaperFill(book, orderFor(engine, 1, book, tick(100), policy), tick(100), policy);
  const first = orderFor(engine, 0, book, tick(111, 2 * minute), policy);
  assert.equal(first.sol, 0.3);
  applyPaperFill(book, first, tick(111, 2 * minute), policy);
  assert.equal(book.sol, 0.7);
  assert.equal(book.cost, 70);
  assert.equal(orderFor(engine, 0, book, tick(112, 3 * minute), policy), undefined);
  const final = orderFor(engine, 0, book, tick(120, 4 * minute), policy);
  assert.equal(final.sol, 0.7);
  applyPaperFill(book, final, tick(120, 4 * minute), policy);
  assert.equal(book.sol, 0);
  assert.ok(Math.abs(book.realized - 17.3) < 1e-9);
});

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let integer = 0n;
  let zeroes = 0;
  for (const byte of bytes) integer = (integer << 8n) + BigInt(byte);
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  let text = "";
  while (integer) {
    text = alphabet[Number(integer % 58n)] + text;
    integer /= 58n;
  }
  return "1".repeat(zeroes) + text;
}

test("Devnet signature verifies exact message and rejects mutation and invalid signatures", async t => {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const address = base58(publicKey);
  assert.deepEqual(publicKeyBytes(address), publicKey);
  assert.throws(() => publicKeyBytes("1".repeat(33)));
  const blockhash = base58(new Uint8Array(32).fill(2));
  const account = { address, publicKey, chains: ["solana:devnet"], features: ["solana:signTransaction"] };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.devnet.solana.com");
    assert.equal(JSON.parse(options.body).method, "getLatestBlockhash");
    return Response.json({ id: 1, result: { value: { blockhash } } });
  });
  let tamper;
  const wallet = { accounts: [account], features: { "solana:signTransaction": {
    supportedTransactionVersions: ["legacy"],
    async signTransaction(input) {
      assert.equal(input.chain, "solana:devnet");
      assert.equal(input.account, account);
      assert.deepEqual(input.transaction.subarray(65), memoMessage(publicKey, blockhash));
      const signedTransaction = input.transaction.slice();
      signedTransaction.set(new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, signedTransaction.subarray(65))
      ), 1);
      if (tamper === "message") signedTransaction[65] ^= 1;
      if (tamper === "signature") signedTransaction[1] ^= 1;
      return [{ signedTransaction }];
    }
  } } };
  await signDevnetProbe(wallet, address);
  tamper = "message";
  await assert.rejects(signDevnetProbe(wallet, address), /muutti/);
  tamper = "signature";
  await assert.rejects(signDevnetProbe(wallet, address), /ei kelpaa/);
});
