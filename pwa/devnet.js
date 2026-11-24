// SPDX-License-Identifier: BUSL-1.1
import { rpcCall } from "./network.js";
import { memoMessage } from "./wallet-standard.js";

const endpoint = "https://api.devnet.solana.com";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const call = (method, params, signal) => rpcCall(method, params, signal, endpoint);
const b64 = bytes => btoa(String.fromCharCode(...bytes));

function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let result = "";
  while (value) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  const first = bytes.findIndex(byte => byte !== 0);
  return "1".repeat(first < 0 ? bytes.length : first) + result;
}

async function checkCluster(signal) {
  if (await call("getGenesisHash", [], signal) !== genesis) {
    throw new Error("Solana RPC ei ole Devnet.");
  }
}

export async function newDevnetWallet() {
  const keys = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return Object.freeze({ address: base58(publicKey), signMemo: async blockhash => {
    const message = memoMessage(publicKey, blockhash);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, message));
    return { message, signature };
  } });
}

export async function devnetBalance(address, signal) {
  await checkCluster(signal);
  return (await call("getBalance", [address, { commitment: "confirmed" }], signal))?.value;
}

export async function submitDevnetMemo(wallet, record, signal) {
  await checkCluster(signal);
  const latest = await call("getLatestBlockhash", [{ commitment: "confirmed" }], signal);
  const blockhash = latest?.value?.blockhash;
  const expires = latest?.value?.lastValidBlockHeight;
  if (!Number.isSafeInteger(expires) || expires <= 0) throw new Error("Devnet blockhash puuttuu.");
  const { message, signature } = await wallet.signMemo(blockhash);
  const fee = (await call("getFeeForMessage", [b64(message), { commitment: "confirmed" }], signal))?.value;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10000) throw new Error("Devnet-maksu ylittää testirajan.");
  const transaction = b64(Uint8Array.of(1, ...signature, ...message));
  const result = await call("simulateTransaction", [transaction, {
    encoding: "base64", sigVerify: true, commitment: "confirmed"
  }], signal);
  if (result?.value?.err !== null) {
    throw new Error(`Devnet-simulaatio hylättiin: ${JSON.stringify(result?.value?.err ?? "puuttuva vastaus")}`);
  }
  const pending = { signature: base58(signature), expires, payer: wallet.address, state: "pending" };
  await record(pending);
  signal?.throwIfAborted();
  const submitted = await call("sendTransaction", [transaction, {
    encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0
  }], signal);
  if (submitted !== pending.signature) throw new Error("RPC:n allekirjoitus ei vastaa paikallista tapahtumaa.");
  return pending;
}

export async function reconcileDevnet(record, signal) {
  await checkCluster(signal);
  const result = await call("getSignatureStatuses", [[record.signature], {
    searchTransactionHistory: true
  }], signal);
  if (!Array.isArray(result?.value) || result.value.length !== 1) {
    throw new Error("Devnet RPC palautti virheellisen tilatiedon.");
  }
  const status = result.value[0];
  if (status?.confirmationStatus === "finalized") {
    return { ...record, state: status.err ? "failed" : "finalized", slot: status.slot };
  }
  if (status === null) {
    const height = await call("getBlockHeight", [{ commitment: "finalized" }], signal);
    if (Number.isSafeInteger(height) && height > record.expires) return { ...record, state: "expired" };
  }
  return record;
}
