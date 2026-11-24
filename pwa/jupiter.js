// SPDX-License-Identifier: BUSL-1.1
import { fetchJson, rpcCall } from "./network.js";
import { usdc } from "./copy.js";
import { publicKeyBytes } from "./wallet-standard.js";

const endpoint = "https://api.jup.ag/swap/v1/quote";
const raw = /^(0|[1-9]\d{0,19})$/;

export function toAtomic(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 ||
      !/^\d{1,20}(\.\d{1,18})?$/.test(value)) throw new Error("Virheellinen määrä.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Määrässä on liikaa desimaaleja.");
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (atomic <= 0n || atomic > 18446744073709551615n) throw new Error("Määrä on sallitun alueen ulkopuolella.");
  return atomic.toString();
}

export function validateQuote(quote, request) {
  const { inputMint, outputMint, amount, slippageBps } = request;
  if (quote?.inputMint !== inputMint || quote.outputMint !== outputMint ||
      quote.inAmount !== amount || quote.swapMode !== "ExactIn" ||
      quote.slippageBps !== slippageBps || !raw.test(quote.outAmount ?? "") ||
      !raw.test(quote.otherAmountThreshold ?? "") ||
      !Array.isArray(quote.routePlan) || !quote.routePlan.length) {
    throw new Error("Jupiterin tarjous ei vastaa pyyntöä.");
  }
  const max = 18446744073709551615n;
  const out = BigInt(quote.outAmount);
  const minimum = BigInt(quote.otherAmountThreshold);
  const allowed = (out * BigInt(10000 - slippageBps)) / 10000n;
  if (out > max || minimum <= 0n || minimum > out || minimum < allowed) {
    throw new Error("Jupiterin tarjous ylittää sallitun liukuman.");
  }
  return { out, minimum };
}

async function getQuote({ token, side, value, apiKey = "", signal }, legacy) {
  if (token === usdc) throw new Error("Valitse USDC:stä poikkeava token.");
  if (!["buy", "sell"].includes(side)) throw new Error("Valitse kaupan suunta.");
  if (apiKey.length > 256) throw new Error("Virheellinen Jupiterin API-avain.");
  const supply = await rpcCall("getTokenSupply", [token, { commitment: "confirmed" }], signal);
  const decimals = supply?.value?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Tokenin desimaaleja ei voitu vahvistaa.");
  const buy = side === "buy";
  const request = { inputMint: buy ? usdc : token, outputMint: buy ? token : usdc,
    amount: toAtomic(value, buy ? 6 : decimals), slippageBps: 50 };
  const query = new URLSearchParams({ ...request, swapMode: "ExactIn",
    ...(legacy ? { asLegacyTransaction: "true" } : {}) });
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  const quote = await fetchJson(`${endpoint}?${query}`, { headers }, signal);
  const result = validateQuote(quote, request);
  return { quote, headers, result: { ...result, decimals: buy ? decimals : 6 } };
}

export async function readQuote(input) {
  return (await getQuote(input, false)).result;
}

const jupiterProgram = publicKeyBytes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

export function validateUnsignedSwap(encoded, payer) {
  if (typeof encoded !== "string" || encoded.length > 1644) throw new Error("Virheellinen swap-paketti.");
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const fail = () => { throw new Error("Swap-paketin rakenne tai maksaja ei vastaa pyyntöä."); };
  let offset = 0;
  function take(count) {
    if (offset + count > bytes.length) fail();
    const chunk = bytes.subarray(offset, offset + count);
    offset += count;
    return chunk;
  }
  function size() {
    const a = take(1)[0];
    if (a < 128) return a;
    const b = take(1)[0];
    if (b < 1 || b > 127) fail();
    return (a & 127) + b * 128;
  }
  if (bytes.length > 1232 || size() !== 1 || take(64).some(Boolean)) fail();
  const header = take(3);
  if (header[0] !== 1 || header[1] !== 0) fail();
  const count = size();
  if (count < 2 || count > 32 || header[2] >= count) fail();
  const keys = Array.from({ length: count }, () => take(32));
  const equal = (a, b) => a.every((value, i) => value === b[i]);
  if (!equal(keys[0], publicKeyBytes(payer))) fail();
  take(32);
  const instructions = size();
  let routes = 0;
  for (let i = 0; i < instructions; i++) {
    const program = take(1)[0];
    if (program >= count || take(size()).some(index => index >= count)) fail();
    const data = take(size());
    if (data.length && equal(keys[program], jupiterProgram)) routes++;
  }
  if (offset !== bytes.length || routes !== 1) fail();
}

export async function simulateSwap(input) {
  const { quote, headers, result } = await getQuote(input, true);
  const packet = await fetchJson("https://api.jup.ag/swap/v1/swap", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: input.payer,
      asLegacyTransaction: true, wrapAndUnwrapSol: true })
  }, input.signal);
  validateUnsignedSwap(packet?.swapTransaction, input.payer);
  const simulated = await rpcCall("simulateTransaction", [packet.swapTransaction, {
    encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true
  }], input.signal);
  if (!simulated?.value || !Object.hasOwn(simulated.value, "err")) {
    throw new Error("Solana RPC palautti virheellisen simulaation.");
  }
  return { ...result, error: simulated.value.err, units: simulated.value.unitsConsumed };
}

export function formatAtomic(value, decimals) {
  if (!decimals) return value.toString();
  const digits = value.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
