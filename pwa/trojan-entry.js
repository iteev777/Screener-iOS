// SPDX-License-Identifier: BUSL-1.1
// Read-only portion of Trojan V2 entry_intelligence.py and live_execution.py.
import { fetchJson, currentMarket, mint, rpcCall } from "./network.js";
import { address } from "./markets.js";
import { publicKeyBytes } from "./wallet-standard.js";
const endpoint = "https://api.jup.ag/swap/v2/order";
const integer = value => /^\d{1,20}$/.test(String(value ?? "")) && BigInt(value) <= 18446744073709551615n
  ? BigInt(value) : null;

export function routeQuality(quote) {
  const raw = quote?.priceImpactPct ?? quote?.priceImpact;
  const normalized = Number(raw);
  const fee = Number(quote?.feeBps ?? 0);
  const route = quote?.routePlan;
  if (raw == null || raw === "" || !Number.isFinite(normalized) || normalized < 0 ||
      !Number.isFinite(fee) || fee < 0 || !Array.isArray(route) || !route.length ||
      route.some(step => !step?.swapInfo || (step.percent != null &&
        (!Number.isFinite(Number(step.percent)) || Number(step.percent) < 0 || Number(step.percent) > 100)))) {
    return { allowed: false, score: 0, reason: "Jupiter-reittidata puuttuu tai on virheellinen" };
  }
  const impact = normalized <= 1 ? normalized * 100 : normalized;
  const split = route.some(step => step.percent != null && Number(step.percent) < 100);
  const score = Math.round((100 - Math.min(55, impact * 15) - Math.min(20, route.length * 4) -
    Math.min(15, fee * .5) - (split ? 2 : 0)) * 100) / 100;
  return { allowed: impact <= 3 && score >= 55, score, impact, fee, hops: route.length, split,
    reason: impact > 3 ? "Jupiter-hintavaikutus yli 3 %" : score < 55 ? "Jupiter-reittipisteet alle 55" : "Jupiter-reitti hyväksytty" };
}

export async function analyzeEntryRoute(token, usd, { signal, apiKey, taker, slippageBps = 100, solUsd } = {}) {
  if (!address.test(token) || token === mint || !(usd > 0) || !Number.isFinite(usd) ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error("Virheellinen Jupiter-ostopyyntö");
  if (taker) publicKeyBytes(taker);
  const price = solUsd ?? (await currentMarket(signal)).price;
  const amount = Math.round(usd / price * 1e9);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Virheellinen WSOL-ostomäärä");
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  const request = async extra => {
    const query = new URLSearchParams({ inputMint: mint, outputMint: token, amount, slippageBps, ...extra });
    const quote = await fetchJson(`${endpoint}?${query}`, { headers }, signal);
    const out = integer(quote?.outAmount);
    const min = quote?.otherAmountThreshold == null && out !== null
      ? out * BigInt(10000 - slippageBps) / 10000n : integer(quote?.otherAmountThreshold);
    if (quote?.inputMint !== mint || quote.outputMint !== token || integer(quote.inAmount) !== BigInt(amount) ||
        out === null || min === null || min <= 0n || min > out || min < out * BigInt(10000 - slippageBps) / 10000n) {
      throw new Error("Jupiter-tarjous ei vastaa pyyntöä");
    }
    return { quote, out };
  };
  const { quote, out } = await request({});
  if (quote.transaction) throw new Error("Jupiter palautti odottamattoman transaktion");
  const quality = routeQuality(quote);
  if (!quality.allowed) return quality;
  if (!taker) return { ...quality, simulation: "skipped" };
  const { quote: simulatedQuote, out: simulatedOut } = await request({ taker });
  if (!routeQuality(simulatedQuote).allowed ||
      (simulatedOut > out ? simulatedOut - out : out - simulatedOut) * 10000n > out * BigInt(slippageBps)) {
    return { ...quality, allowed: false, reason: "Jupiter-simulaation tuotto poikkeaa tarjouksesta" };
  }
  const packet = simulatedQuote.transaction;
  if (typeof packet !== "string" || packet.length < 80 || packet.length > 1644) {
    throw new Error("Jupiterin simulaatiopaketti puuttuu");
  }
  const result = await rpcCall("simulateTransaction", [packet, {
    encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true,
    innerInstructions: false
  }], signal);
  return result?.value?.err === null ? { ...quality, simulation: "passed" }
    : { ...quality, allowed: false, reason: "Jupiter-simulaatio epäonnistui" };
}
