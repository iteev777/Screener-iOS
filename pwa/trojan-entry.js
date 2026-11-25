// SPDX-License-Identifier: BUSL-1.1
// Read-only portion of Trojan V2 entry_intelligence.py and live_execution.py.
import { fetchJson, currentMarket, mint, rpcCall } from "./network.js";
import { address } from "./markets.js";
import { publicKeyBytes } from "./wallet-standard.js";
const endpoint = "https://api.jup.ag/swap/v2/order";
const integer = value => /^\d{1,20}$/.test(String(value ?? "")) && BigInt(value) <= 18446744073709551615n
  ? BigInt(value) : null;

export function routeQuality(quote, { economic = false } = {}) {
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
  const ceiling = economic ? 5 : 3;
  return { allowed: impact <= ceiling && (economic || score >= 55), score, impact, fee, hops: route.length, split,
    reason: impact > ceiling ? `Jupiter-hintavaikutus yli ${ceiling} %` : !economic && score < 55
      ? "Jupiter-reittipisteet alle 55" : "Jupiter-reitti hyväksytty" };
}

export function executionEconomics(amount, received, buy, sell, budget,
    { expectedPct, liquidity, feeBps, slippageBps, lossPct, observeOnly }) {
  if ((amount - received) * 10000n > amount * 500n)
    return { allowed:false, resize:true, reason:"Jupiterin osto- ja myyntireitin kokonaisvaikutus yli 5 %" };
  const fee = feeBps / 10000;
  const slippage = slippageBps / 10000;
  const guaranteedRatio = Number(received) / Number(amount) * (1-fee)**2 * (1-slippage)**2;
  const loss = Math.max(0, (1-guaranteedRatio)*100);
  const expectedNetPct = (guaranteedRatio * (1+expectedPct/100)-1)*100;
  const result = { buyImpact:buy.impact, sellImpact:sell.impact, lossPct:loss, expectedNetPct,
    feeBps:buy.fee+sell.fee+2*feeBps, slippageBps:slippageBps*2 };
  if (!(liquidity > 0 && budget <= liquidity*.001 && loss <= Math.min(5,lossPct)))
    return { ...result, allowed:false, resize:true, reason:"Reittikulut tai poolisyvyys ylittävät toteutusrajan" };
  if (!(expectedNetPct >= .15) && !observeOnly)
    return { ...result, allowed:false, verifiable:true, resize:true, reason:"Odotettu nettoliike ei kata reittikuluja" };
  return { ...result, allowed:true, reason:"Osto- ja myyntitarjous läpäisivät nettotarkistuksen" };
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
      const error = new Error(String(quote?.errorMessage ?? "Jupiter-tarjous ei vastaa pyyntöä").slice(0,220));
      throw error;
    }
    return {quote,out};
  };
}

export async function analyzeCounterfactualExit(token, amount, {signal,apiKey,requestQuote,economic = false}) {
  const quantity=integer(amount);
  if (!address.test(token) || token === mint || !quantity) throw new Error("Virheellinen Jupiter-myyntitarjous");
  const request=quoteRequest({signal,apiKey,slippageBps:100,requestQuote});
  const {quote,out}=await request(token,mint,quantity);
  const quality=routeQuality(quote,{economic});
  if (quote.transaction || !quality.allowed) return {allowed:false,reason:quality.reason};
  return {allowed:true,lamports:out.toString(),impact:quality.impact,minLamports:integer(quote.otherAmountThreshold)?.toString()};
}

export async function analyzeEntryRoute(token, usd, { signal, apiKey, taker, slippageBps = 100, solUsd, checkExit = false,
    economics, requestQuote = work => work() } = {}) {
  if (!address.test(token) || token === mint || !(usd > 0) || !Number.isFinite(usd) ||
      !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error("Virheellinen Jupiter-ostopyyntö");
  if (taker) publicKeyBytes(taker);
  const price = solUsd ?? (await currentMarket(signal)).price;
  const amount = Math.round(usd / price * 1e9);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Virheellinen WSOL-ostomäärä");
  const request = quoteRequest({signal,apiKey,slippageBps,requestQuote});
  const { quote, out } = await request(mint,token,BigInt(amount));
  if (quote.transaction) throw new Error("Jupiter palautti odottamattoman transaktion");
  const economic = Boolean(checkExit && economics);
  const quality = routeQuality(quote,{economic});
  if (!quality.allowed) return { ...quality, resize:economic && Number.isFinite(quality.impact) };
  if (checkExit) {
    const reverse = await request(token,mint,out);
    const exit=routeQuality(reverse.quote,{economic});
    if (reverse.quote.transaction || !exit.allowed) {
      return { ...quality, allowed:false, resize:economic && !reverse.quote.transaction && Number.isFinite(exit.impact),
        reason:`Jupiter-myyntireitti: ${reverse.quote.transaction
        ? "vastauksessa on odottamaton transaktio" : exit.reason}` };
    }
    const loss = (BigInt(amount) - reverse.out) * 10000n;
    if (economic) {
      const assessment = executionEconomics(BigInt(amount),reverse.out,quality,exit,usd,economics);
      Object.assign(quality,assessment);
      if (!assessment.allowed && !assessment.verifiable) return quality;
    } else if (loss > BigInt(amount) * 500n) {
      return { ...quality, allowed: false, reason: "Jupiterin osto- ja myyntireitin kokonaisvaikutus yli 5 %" };
    }
    quality.reason += " · Myyntireitti tarkistettu";
    quality.roundTripBps = Number(loss / BigInt(amount));
    quality.proof = {inLamports:String(amount), tokenRaw:out.toString(), quoteUsd:price,
      entrySlip:slippageBps/10000};
    if (!quality.allowed) return quality;
  }
  if (!taker) return { ...quality, simulation: "skipped" };
  const { quote: simulatedQuote, out: simulatedOut } = await request(mint,token,BigInt(amount),{ taker });
  if (!routeQuality(simulatedQuote,{economic}).allowed ||
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
