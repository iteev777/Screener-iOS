// SPDX-License-Identifier: BUSL-1.1
// Read-only portion of Trojan V2 entry_intelligence.py and live_execution.py.
import { fetchJson, currentMarket, mint, rpcCall } from "./network.js";
import { address } from "./markets.js";
import { publicKeyBytes } from "./wallet-standard.js";
const endpoint = "https://api.jup.ag/swap/v2/order";
const integer = value => /^\d{1,20}$/.test(String(value ?? "")) && BigInt(value) <= 18446744073709551615n
  ? BigInt(value) : null;

export function routeQuality(quote) {
  const fraction = quote?.priceImpactPct;
  const raw = fraction ?? quote?.priceImpact;
  const normalized = Number(raw);
  const fee = Number(quote?.feeBps ?? 0);
  const route = quote?.routePlan;
  if (raw == null || raw === "" || !Number.isFinite(normalized) ||
      !Number.isFinite(fee) || fee < 0 || !Array.isArray(route) || !route.length ||
      route.some(step => !step?.swapInfo || (step.percent != null &&
        (!Number.isFinite(Number(step.percent)) || Number(step.percent) < 0 || Number(step.percent) > 100)))) {
    return { allowed: false, score: 0, reason: "Jupiter-reittidata puuttuu tai on virheellinen" };
  }
  // Jupiter Swap v2 reports signed impact. Its string priceImpactPct is a
  // fraction and the numeric priceImpact fallback is in percentage points.
  // Bound the magnitude in either direction before accepting an order.
  const impact = Math.abs(normalized) * (fraction == null ? 1 : 100);
  const split = route.some(step => step.percent != null && Number(step.percent) < 100);
  const score = Math.round((100 - Math.min(55, impact * 15) - Math.min(20, route.length * 4) -
    Math.min(15, fee * .5) - (split ? 2 : 0)) * 100) / 100;
  return { allowed: impact <= 3 && score >= 55, score, impact, fee, hops: route.length, split,
    reason: impact > 3 ? "Jupiter-hintavaikutus yli 3 %" : score < 55 ? "Jupiter-reittipisteet alle 55" : "Jupiter-reitti hyväksytty" };
}

function quoteRequest({ signal, apiKey, slippageBps, requestQuote }) {
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  return async (inputMint, outputMint, quantity, extra = {}) => {
    const query = new URLSearchParams({ inputMint, outputMint, amount:quantity, slippageBps, ...extra });
    const quote = await requestQuote(() => fetchJson(`${endpoint}?${query}`, {headers}, signal));
    const out = integer(quote?.outAmount);
    const min = quote?.otherAmountThreshold == null && out !== null
      ? out * BigInt(10000-slippageBps)/10000n : integer(quote?.otherAmountThreshold);
    if (quote?.inputMint !== inputMint || quote.outputMint !== outputMint || integer(quote.inAmount) !== quantity ||
        out === null || min === null || min <= 0n || min > out || min < out*BigInt(10000-slippageBps)/10000n) {
      const error = new Error(quote?.errorMessage ?? "Jupiter-tarjous ei vastaa pyyntöä");
      throw error;
    }
    return {quote,out};
  };
}

export async function analyzeCounterfactualExit(token, amount, {signal,apiKey,requestQuote}) {
  const quantity=integer(amount);
  if (!address.test(token) || token === mint || !quantity) throw new Error("Virheellinen Jupiter-myyntitarjous");
  const request=quoteRequest({signal,apiKey,slippageBps:100,requestQuote});
  const {quote,out}=await request(token,mint,quantity);
  const quality=routeQuality(quote);
  if (quote.transaction || !quality.allowed) return {allowed:false,reason:quality.reason};
  return {allowed:true,lamports:out.toString(),impact:quality.impact,minLamports:integer(quote.otherAmountThreshold)?.toString()};
}

export async function analyzeEntryRoute(token, usd, { signal, apiKey, taker, slippageBps = 100, solUsd, checkExit = false, requestQuote = work => work() } = {}) {
  if (!address.test(token) || token === mint || !(usd > 0) || !Number.isFinite(usd) ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error("Virheellinen Jupiter-ostopyyntö");
  if (taker) publicKeyBytes(taker);
  const price = solUsd ?? (await currentMarket(signal)).price;
  const amount = Math.round(usd / price * 1e9);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Virheellinen WSOL-ostomäärä");
  const request = quoteRequest({signal,apiKey,slippageBps,requestQuote});
  const { quote, out } = await request(mint,token,BigInt(amount));
  if (quote.transaction) throw new Error("Jupiter palautti odottamattoman transaktion");
  const quality = routeQuality(quote);
  if (!quality.allowed) return quality;
  if (checkExit) {
    const reverse = await request(token,mint,out);
    if (reverse.quote.transaction || !routeQuality(reverse.quote).allowed) {
      return { ...quality, allowed: false, reason: "Jupiterin myyntireitti hylättiin" };
    }
    const loss = (BigInt(amount) - reverse.out) * 10000n;
    if (loss > BigInt(amount) * 500n) {
      return { ...quality, allowed: false, reason: "Jupiterin osto- ja myyntireitin kokonaisvaikutus yli 5 %" };
    }
    quality.reason += " · Myyntireitti tarkistettu";
    quality.roundTripBps = Number(loss / BigInt(amount));
    quality.proof = {inLamports:String(amount), tokenRaw:out.toString(), quoteUsd:price,
      entrySlip:slippageBps/10000};
  }
  if (!taker) return { ...quality, simulation: "skipped" };
  const { quote: simulatedQuote, out: simulatedOut } = await request(mint,token,BigInt(amount),{ taker });
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
