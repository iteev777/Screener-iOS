import { rpcCall } from "./network.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function publicKeyBytes(text) {
  if (typeof text !== "string" || text.length < 32 || text.length > 44) {
    throw new Error("Virheellinen Solana-osoite.");
  }
  let number = 0n;
  for (const char of text) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Virheellinen base58-arvo.");
    number = number * 58n + BigInt(index);
  }
  const bytes = new Uint8Array(32);
  let i = bytes.length;
  while (number && i > 0) {
    bytes[--i] = Number(number & 255n);
    number >>= 8n;
  }
  const leadingZeros = text.match(/^1*/)[0].length;
  if (number || i !== leadingZeros) throw new Error("Virheellinen Solana-avain.");
  return bytes;
}

export function discoverWallets(target = window) {
  const wallets = new Set();
  const api = { register: (...values) => {
    for (const wallet of values) wallets.add(wallet);
    return () => values.forEach(wallet => wallets.delete(wallet));
  } };
  target.addEventListener("wallet-standard:register-wallet", event => {
    if (typeof event.detail === "function") event.detail(api);
  });
  target.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return () => [...wallets];
}

const chain = "solana:devnet";
const devnet = "https://api.devnet.solana.com";
const memoProgram = publicKeyBytes("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const memo = new TextEncoder().encode("Screener PWA: signature test only");

export function memoMessage(owner, blockhash) {
  return Uint8Array.of(1, 0, 1, 2, ...owner, ...memoProgram,
    ...publicKeyBytes(blockhash), 1, 1, 0, memo.length, ...memo);
}

export async function signDevnetProbe(wallet, expectedAddress, signal) {
  const signer = wallet.features["solana:signTransaction"];
  if (!signer?.supportedTransactionVersions?.includes("legacy")) {
    throw new Error("Lompakko ei tue testitransaktion allekirjoitusta.");
  }
  const account = wallet.accounts.find(item =>
    item.address === expectedAddress && item.chains.includes(chain) &&
    item.features.includes("solana:signTransaction")
  );
  if (!account) throw new Error("Valittu tili ei tue Solana Devnetiä.");
  const owner = publicKeyBytes(account.address);
  if (owner.some((byte, i) => byte !== account.publicKey[i])) {
    throw new Error("Lompakon julkinen avain ei vastaa yhdistettyä tiliä.");
  }
  const data = await rpcCall("getLatestBlockhash", [{ commitment: "confirmed" }], signal, devnet);
  signal?.throwIfAborted();
  const message = memoMessage(owner, data?.value?.blockhash);
  const transaction = Uint8Array.of(1, ...new Uint8Array(64), ...message);
  const [result] = await signer.signTransaction({ account, chain, transaction });
  signal?.throwIfAborted();
  const signed = result?.signedTransaction;
  if (!(signed instanceof Uint8Array) || signed.length !== transaction.length || signed[0] !== 1 ||
      message.some((byte, i) => signed[65 + i] !== byte)) {
    throw new Error("Lompakko muutti testitransaktion sisältöä.");
  }
  const key = await crypto.subtle.importKey("raw", owner, "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, signed.subarray(1, 65), message)) {
    throw new Error("Lompakon antama allekirjoitus ei kelpaa.");
  }
}
