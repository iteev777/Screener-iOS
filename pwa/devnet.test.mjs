import assert from "node:assert/strict";
import test from "node:test";
import { newDevnetWallet, reconcileDevnet, submitDevnetMemo } from "./devnet.js";
import { publicKeyBytes } from "./wallet-standard.js";

const devnet = "https://api.devnet.solana.com";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const blockhash = "11111111111111111111111111111111";

test("Devnet signs the memo, journals before sending and only finalizes a checked signature", async t => {
  const wallet = await newDevnetWallet();
  let saved;
  let sends = 0;
  let encoded;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, devnet);
    const { method, params } = JSON.parse(options.body);
    let result;
    switch (method) {
      case "getGenesisHash": result = genesis; break;
      case "getLatestBlockhash": result = { value: { blockhash, lastValidBlockHeight: 99 } }; break;
      case "getFeeForMessage": result = { value: 5000 }; break;
      case "simulateTransaction": {
        assert.equal(params[1].sigVerify, true);
        encoded = params[0];
        const bytes = Buffer.from(encoded, "base64");
        const key = await crypto.subtle.importKey("raw", publicKeyBytes(wallet.address), "Ed25519", false, ["verify"]);
        assert.ok(await crypto.subtle.verify("Ed25519", key, bytes.subarray(1, 65), bytes.subarray(65)));
        result = { value: { err: null } };
        break;
      }
      case "sendTransaction":
        assert.equal(saved.state, "pending");
        assert.equal(params[0], encoded);
        assert.equal(params[1].maxRetries, 0);
        sends++;
        result = saved.signature;
        break;
      case "getSignatureStatuses":
        assert.deepEqual(params[0], [saved.signature]);
        result = { value: [{ confirmationStatus: "finalized", err: null, slot: 9 }] };
        break;
      default: assert.fail(method);
    }
    return Response.json({ id: 1, result });
  });
  const submitted = await submitDevnetMemo(wallet, async record => { saved = record; });
  assert.equal(submitted, saved);
  assert.equal((await reconcileDevnet(submitted)).state, "finalized");
  assert.equal(sends, 1);
});

test("wrong cluster and expired unresolved transactions never submit", async t => {
  let rightCluster = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, devnet);
    const { method } = JSON.parse(options.body);
    const values = {
      getGenesisHash: rightCluster ? genesis : "wrong-cluster",
      getSignatureStatuses: { value: [null] },
      getBlockHeight: 101
    };
    assert.ok(Object.hasOwn(values, method));
    return Response.json({ id: 1, result: values[method] });
  });
  await assert.rejects(submitDevnetMemo(await newDevnetWallet(), () => assert.fail()), /Devnet/);
  rightCluster = true;
  const record = { signature: "example", expires: 100, state: "pending" };
  assert.equal((await reconcileDevnet(record)).state, "expired");
});
