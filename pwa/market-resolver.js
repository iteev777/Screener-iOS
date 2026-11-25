// SPDX-License-Identifier: BUSL-1.1
import { address, marketNumber, normalizePair } from "./markets.js";
import { currentMarket, fetchJson, mint as wsol, rpcCall } from "./network.js";
import { pumpCurveAddress, pumpQuoteMint, verifyPoolReserves } from "./trojan-pools.js";
import { publicKeyBytes } from "./wallet-standard.js";

export const pumpProgram = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const tokenProgram2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const stable = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const classic = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const curveTag = [23, 183, 248, 55, 96, 216, 172, 96];
const tradeTag = [189, 219, 127, 211, 78, 230, 97, 238];
const match = (a, b) => a?.length === b.length && b.every((byte, i) => a[i] === byte);
const bytes = encoded => {
  if (typeof encoded !== "string" || encoded.length > 16384) return;
  try { return Uint8Array.from(atob(encoded), char => char.charCodeAt(0)); }
  catch { return undefined; }
};
const accountBytes = account => account?.executable === false && account.data?.[1] === "base64" ? bytes(account.data[0]) : undefined;
const keyBytes = key => {
  try { return publicKeyBytes(key); } catch { return undefined; }
};

export function curveMarket(curveAccount, mintAccount, usd) {
  const curve = accountBytes(curveAccount), mint = accountBytes(mintAccount);
  if (!curveAccount || !mintAccount) return { state:"pool-unconfirmed" };
  if (curveAccount.owner !== pumpProgram || curve?.length < 49 ||
      !match(curve?.subarray(0,8),curveTag) || ![classic,tokenProgram2022].includes(mintAccount.owner) ||
      !(mint?.length >= 82 && mint[45] === 1)) return { state:"invalid-pair" };
  if (curve[48] !== 0) return { state:"curve-complete" };
  const quoteToken = pumpQuoteMint(curve);
  if (!quoteToken) return { state:"unsupported-quote" };
  const reference = usd.get(quoteToken);
  const data = new DataView(curve.buffer,curve.byteOffset,curve.byteLength);
  const amount = offset => data.getBigUint64(offset,true);
  const decimals = mint[44], quoteDecimals = quoteToken === wsol ? 9 : 6;
  const virtualBase = Number(amount(8))/10**decimals, virtualQuote = Number(amount(16))/10**quoteDecimals;
  const realQuote = Number(amount(32))/10**quoteDecimals;
  if (!(virtualBase > 0)) return { state:"missing-price", quoteToken };
  if (virtualQuote === 0) return { state:"zero-price", quoteToken };
  const empty=!(realQuote>0) || amount(24)===0n;
  if (empty) return { state:"empty-liquidity",quoteToken,
    price:reference?.price>0 ? virtualQuote/virtualBase*reference.price : undefined };
  if (!(reference?.price > 0)) return { state:"missing-quote-usd", quoteToken };
  const price = virtualQuote / virtualBase * reference.price;
  // Only the real quote reserve is sale-side depth. Virtual capital and
  // unsold token inventory must not manufacture tradable USD liquidity.
  const liquidity = 2 * realQuote * reference.price;
  return Number.isFinite(price) && Number.isFinite(liquidity) && price > 0
    ? { state:"priced", price, liquidity, quoteToken, decimals, quoteDecimals,
      quoteUsd:reference.price, quoteAt:reference.at } : { state:"invalid-values", quoteToken };
}

// Decode only confirmed, successful TradeEvent data emitted in the active
// Pump program invocation, for the exact subscribed mint.
export function pumpTrades(notification, market, now) {
  const mint = keyBytes(market.token);
  const value = notification?.value;
  if (!mint || !Array.isArray(value?.logs) || typeof value.signature !== "string" ||
      !market.quoteUsd || now - market.quoteAt > 30000) return [];
  const rows = [], stack = [];
  for (const [index, log] of value.logs.entries()) {
    if (typeof log !== "string") continue;
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]$/.exec(log);
    if (invoke) { stack.push(invoke[1]); continue; }
    const end = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(log);
    if (end) { if (stack.pop() !== end[1]) stack.length = 0; continue; }
    if (stack.at(-1) !== pumpProgram || !log.startsWith("Program data: ")) continue;
    const raw = bytes(log.slice(14));
    if (!(raw?.length >= 97) || !match(raw.subarray(0,8),tradeTag) ||
        !match(raw.subarray(8,40),mint) || raw[56] > 1 || market.quoteToken !== wsol) continue;
    const data = new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
    const at = Number(data.getBigInt64(89,true))*1000;
    const quote = Number(data.getBigUint64(40,true))/10**market.quoteDecimals;
    const tokens = Number(data.getBigUint64(48,true))/10**market.decimals;
    if (at < now - 300000 || at > now || quote <= 0 || tokens <= 0) continue;
    const usd = quote * market.quoteUsd;
    rows.push({ id:`${value.signature}:${index}`, at, usd, price:usd/tokens, side:raw[56] ? "buy" : "sell", source:"rpc",
      trader:Array.from(raw.subarray(57,89)).join(",") });
  }
  return rows;
}

export function marketResolver(signal) {
  const quotes = new Map(), curves = new Map(), hints = new Map(), pools = new Map();
  let referenceRequest, stableRequest, curveNext = 0, hintNext = 0, poolNext = 0;
  let curveBusy = false, hintBusy = false, poolBusy = false;
  async function lookup(ids) {
    const tokens = new Set(ids);
    const rows = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${ids.join(",")}`,{},signal);
    if (!Array.isArray(rows)) throw new Error("Virheellinen Jupiter-tokenivastaus");
    return rows.filter(row => tokens.has(row?.id));
  }
  async function solPrice() {
    const cached = quotes.get(wsol);
    if (cached && Date.now() - cached.at <= 15000) return cached;
    if (!referenceRequest) referenceRequest = currentMarket(signal).catch(async () => {
      const price = marketNumber((await lookup([wsol]))[0]?.usdPrice);
      if (!(price > 0)) throw new Error("Tuore SOL-USD-vertailuhinta puuttuu");
      return {price, at:Date.now()};
    }).then(value => { quotes.set(wsol,value); return value; }).finally(() => { referenceRequest = undefined; });
    return referenceRequest;
  }
  async function stablePrice() {
    if (Date.now() - (quotes.get(stable)?.at ?? 0) <= 15000) return;
    if (!stableRequest) stableRequest = lookup([stable]).then(rows => {
      const price = marketNumber(rows[0]?.usdPrice);
      if (price > 0) quotes.set(stable,{price, at:Date.now()});
    }).finally(() => { stableRequest = undefined; });
    await stableRequest;
  }
  const canCurve = (item, now, refresh = false) => !curveBusy && now >= curveNext &&
    (item.curveHint || item.sources?.has("PumpPortal") || item.provider === "Pump.fun RPC") &&
    now - (curves.get(item.token)?.at ?? 0) >= (refresh ? 4000 : 12000);
  const canHint = (item, now) => !hintBusy && now >= hintNext && now - (hints.get(item.token)?.at ?? 0) >= 45000;
  const poolHint = token => hints.get(token)?.pool;
  const trim = map => { while (map.size > 500) map.delete(map.keys().next().value); };
  return {
    solPrice, canCurve, canHint, poolHint, curve: token => curves.get(token), pool: token => pools.get(token),
    async readPool(raw, refresh = false) {
      const now = Date.now(), token = raw?.baseToken?.address, pool = raw?.pairAddress;
      const quoteToken = raw?.quoteToken?.address;
      if (poolBusy || now < poolNext || now - (pools.get(token)?.at ?? 0) < (refresh?4000:10000) ||
          !keyBytes(token) || !keyBytes(pool) || ![wsol,stable].includes(quoteToken)) return;
      poolBusy = true;
      poolNext = now + (refresh?6500:12000);
      try {
        const [depth] = await Promise.all([verifyPoolReserves({token,pool,quoteToken},signal),
          quoteToken === wsol ? solPrice() : stablePrice()]);
        const ref = quotes.get(quoteToken);
        if (depth.status !== "approve" || !ref || Date.now()-ref.at > 20000 ||
            !depth.baseMint || !depth.quoteMint) return;
        const asBase = depth.baseMint === token;
        const reserve = side => Number(depth[`effective${side}Raw`])/10**depth[side.toLowerCase()]?.decimals;
        const ratio = asBase ? depth.spotRatio : 1/depth.spotRatio;
        const price = ratio*ref.price;
        const liquidity = 2 * Math.min(reserve(asBase?"Base":"Quote")*price,reserve(asBase?"Quote":"Base")*ref.price);
        const normalized = {...raw,priceUsd:price,liquidity:{usd:liquidity}};
        const market = normalizePair(normalized);
        if (!market) return;
        const value = {raw:normalized,market:{...market,provider:"Pool RPC"},observedAt:Date.now(),provider:"Pool RPC"};
        pools.set(token,{at:value.observedAt,value});
        trim(pools);
        return value;
      } catch (error) {
        if (error.status === 429) poolNext = Date.now()+Math.max(30000,error.retryAfterMs??0);
        throw error;
      } finally { poolBusy = false; }
    },
    async search(items) {
      const now = Date.now();
      const batch = items.filter(item => canHint(item,now) && keyBytes(item.token)).slice(0,24);
      if (!batch.length) return [];
      hintNext = now + 12000;
      hintBusy = true;
      try {
        const rows = new Map((await lookup(batch.map(item => item.token))).map(row=>[row.id,row]));
        for (const {token} of batch) {
          const row = rows.get(token), pool = row?.firstPool?.id;
          hints.set(token,{pool:pool !== token && keyBytes(pool) ? pool : undefined, at:Date.now()});
        }
        trim(hints);
        return batch.filter(item => poolHint(item.token));
      } catch (error) {
        if (error.status === 429) hintNext = Date.now() + Math.max(60000,error.retryAfterMs ?? 0);
        throw error;
      } finally { hintBusy = false; }
    },
    async readCurves(items, refresh = false) {
      const now = Date.now();
      const batch = items.filter(item => canCurve(item,now,refresh) && keyBytes(item.token)).slice(0,15);
      if (!batch.length) return [];
      curveNext = now + 4500;
      curveBusy = true;
      try {
        const pools = await Promise.all(batch.map(item => curves.get(item.token)?.pool ?? pumpCurveAddress(item.token,pumpProgram)));
        const read = rpcCall("getMultipleAccounts",[[...pools,...batch.map(item=>item.token)],
          { commitment:"confirmed", encoding:"base64" }],signal);
        const [snapshot] = await Promise.all([read, solPrice().catch(() => {})]);
        if (signal.aborted || !Number.isSafeInteger(snapshot?.context?.slot) ||
            snapshot?.value?.length !== batch.length*2) return [];
        const needsStable = snapshot.value.slice(0,batch.length).some(account =>
          match(accountBytes(account)?.subarray(83,115),publicKeyBytes(stable)));
        if (needsStable) await stablePrice().catch(() => {});
        const at = Date.now();
        const fresh = new Map([...quotes].filter(([,row])=>at-row.at<=20000));
        for (const [i,item] of batch.entries()) {
          const pool = pools[i];
          const state = item.curveHint && item.curveHint !== pool ? {state:"curve-mismatch"}
            : curveMarket(snapshot.value[i],snapshot.value[i+batch.length],fresh);
          const raw = state.state === "priced" ? {chainId:"solana",pairAddress:pool,
            baseToken:{address:item.token,symbol:item.symbol,name:item.name},quoteToken:{address:state.quoteToken},
            priceUsd:state.price,liquidity:{usd:state.liquidity},pairCreatedAt:item.curveCreatedAt} : undefined;
          const market = raw && {...normalizePair(raw), ...state, provider:"Pump.fun RPC"};
          curves.set(item.token,{...state, pool, at, value:market && {market,raw,observedAt:at,provider:market.provider}});
        }
        trim(curves);
        return batch;
      } catch (error) {
        if (error.status === 429) curveNext = Date.now() + Math.max(30000,error.retryAfterMs ?? 0);
        throw error;
      } finally { curveBusy = false; }
    }
  };
}
