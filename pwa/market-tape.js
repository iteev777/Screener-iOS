// SPDX-License-Identifier: BUSL-1.1
import { address, normalizePair, orientPair } from "./markets.js";
import { fetchJson } from "./network.js";

const gecko = "https://api.geckoterminal.com/api/v2/networks/solana";
const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value) : undefined;
const windows = ["m5", "h1", "h6", "h24"];
const fields = row => Object.fromEntries(windows.map(key => [key, number(row?.[key])]));
const mintId = id => typeof id === "string" && id.startsWith("solana_") && address.test(id.slice(7)) ? id.slice(7) : undefined;

export function geckoPairs(result, at, wanted) {
  if (!Array.isArray(result?.data)) throw new Error("Virheellinen GeckoTerminal-poolivastaus");
  const tokens = new Map((result.included ?? []).map(item => [item.id, item.attributes]));
  return result.data.flatMap(row => {
    const attr = row.attributes;
    const base = row.relationships?.base_token?.data?.id;
    const quote = row.relationships?.quote_token?.data?.id;
    const raw = {
      chainId: "solana", pairAddress: attr?.address, baseToken: { ...tokens.get(base), address: mintId(base) },
      quoteToken: { ...tokens.get(quote), address: mintId(quote) }, priceUsd: attr?.base_token_price_usd,
      quotePriceUsd: attr?.quote_token_price_usd, priceNative: attr?.base_token_price_quote_token,
      liquidity: { usd: number(attr?.reserve_in_usd) }, volume: fields(attr?.volume_usd),
      priceChange: fields(attr?.price_change_percentage), txns: attr?.transactions,
      pairCreatedAt: Date.parse(attr?.pool_created_at), marketCap: number(attr?.market_cap_usd)
    };
    const requested = wanted ? [raw.baseToken.address, raw.quoteToken.address].filter(token =>
      token && wanted.has(`${attr?.address}:${token}`)) : [raw.baseToken.address];
    return requested.flatMap(token => {
      const pair = orientPair(raw,token), market = normalizePair(pair);
      return market && pair.quoteToken.address ? [{ raw:pair, market, observedAt:at, provider:"GeckoTerminal" }] : [];
    });
  });
}

export function completeTape(pair) {
  const tx = pair?.raw?.txns?.m5;
  return [pair?.raw?.priceChange?.m5, pair?.raw?.volume?.m5].every(Number.isFinite) &&
    Number.isSafeInteger(tx?.buys) && Number.isSafeInteger(tx?.sells);
}

export function preferMarket(primary, alternate, now) {
  const completeBaseline = pair => Number.isFinite(pair?.raw?.volume?.h1) && Number.isFinite(pair?.raw?.priceChange?.h1);
  if (!alternate || alternate.observedAt > now || now - alternate.observedAt > 15000) return primary;
  // A real price and pool identity can start tape collection even with no 5m bars.
  if (!primary) return alternate;
  if (!completeTape(alternate) ||
      (completeTape(primary) && (completeBaseline(primary) || !completeBaseline(alternate)))) return primary;
  if (primary && primary.market.pool !== alternate.market.pool) return primary;
  return alternate;
}

export function marketTape(signal) {
  const cached = new Map();
  let next = 0;
  let active = false;
  let geckoNext = 0;
  let geckoBlockedUntil = 0;
  async function read(path) {
    while (!signal.aborted && Date.now() < geckoNext && Date.now() >= geckoBlockedUntil) {
      await new Promise(resolve => setTimeout(resolve, geckoNext - Date.now()));
    }
    signal.throwIfAborted();
    if (Date.now() < geckoBlockedUntil) {
      const error = new Error("GeckoTerminalin kiintiötauko");
      error.retryAfterMs = geckoBlockedUntil - Date.now();
      throw error;
    }
    geckoNext = Date.now() + 2400;
    try { return await fetchJson(`${gecko}${path}`, {}, signal); }
    catch (error) {
      if (error.status === 429) geckoBlockedUntil = Date.now() + Math.max(30000, error.retryAfterMs ?? 0);
      throw error;
    }
  }
  const retry = new Map();
  const remember = rows => {
    for (const row of rows) {
      const old = cached.get(row.market.token);
      if (old?.observedAt === row.observedAt && old.market.liquidity >= row.market.liquidity) continue;
      cached.set(row.market.token, row);
    }
    for (const map of [cached, retry]) while (map.size > 500) map.delete(map.keys().next().value);
  };
  const canRefresh = token => !active && Date.now() >= geckoBlockedUntil && Date.now() >= next && Date.now() >= (retry.get(token) ?? 0);
  const tradeCache = new Map();
  let nextTrades = 0, tradeBusy = false;
  const tradeKey = (pool, token) => `${pool}:${token}`;
  const canTrade = (pool, token, now) => !tradeBusy && now >= geckoBlockedUntil && now >= nextTrades &&
    now - (tradeCache.get(tradeKey(pool, token))?.at ?? 0) >= 12000;
  function rememberTrades(key, incoming, now) {
    const existing = tradeCache.get(key);
    const rows = new Map((existing?.rows ?? []).filter(trade=>trade.source===incoming[0]?.source).map(trade => [trade.id,trade]));
    const previous = rows.size;
    for (const row of incoming) rows.set(row.id,row);
    tradeCache.set(key,{at:existing?.at ?? 0,rows:[...rows.values()].filter(row=>row.at>=now-300000)
      .sort((a,b)=>a.at-b.at).slice(-3000)});
    while (tradeCache.size > 100) tradeCache.delete(tradeCache.keys().next().value);
    return rows.size > previous;
  }
  return {
    canRefresh,
    canTrade,
    trades(pool, token) { return tradeCache.get(`${pool}:${token}`)?.rows ?? []; },
    recordTrades(pool, token, rows, now) {
      return rows.length > 0 && rememberTrades(tradeKey(pool,token),rows,now);
    },
    async refreshTrades(pool, token) {
      const now = Date.now(), key = tradeKey(pool, token);
      if (!address.test(pool) || !address.test(token) || !canTrade(pool,token,now)) return false;
      tradeBusy = true; nextTrades = now + 8000;
      tradeCache.set(key, {at:now, rows:tradeCache.get(key)?.rows ?? []});
      while(tradeCache.size>100) tradeCache.delete(tradeCache.keys().next().value);
      try {
        const data = await read(`/pools/${pool}/trades`);
        if (!Array.isArray(data?.data)) return false;
        const rows = [];
        for (const row of data.data) {
          const a = row.attributes; if (!a || !row.id) continue;
          const buy = a.to_token_address === token, sell = a.from_token_address === token;
          if (buy === sell) continue;
          const t = {id:row.id, at:Date.parse(a.block_timestamp), price:number(buy?a.price_to_in_usd:a.price_from_in_usd), usd:number(a.volume_in_usd), side:buy?'buy':'sell', trader:address.test(a.tx_from_address ?? "") ? a.tx_from_address : undefined};
          if (Number.isFinite(t.at) && t.price > 0 && t.usd > 0) rows.push(t);
        }
        // Use RPC tape for Pump.fun when available. Its event IDs differ from
        // Gecko's and combining both could count the same fill twice.
        if (tradeCache.get(key)?.rows.some(trade=>trade.source === "rpc" && trade.at >= now-30000)) return false;
        return rows.length > 0 && rememberTrades(key,rows,now);
      } catch(e) { if(e.status===429) nextTrades=Date.now()+Math.max(60000,e.retryAfterMs??0); throw e; }
      finally { tradeBusy=false; }
    },
    async poolPrices(pools) {
      if (!pools.length || !canRefresh("")) return [];
      active = true;
      next = Date.now() + 8000;
      try {
        const ids = [...new Set(pools.map(pool=>pool.pool))].join(",");
        const payload = await read(`/pools/multi/${ids}?include=base_token,quote_token`);
        const wanted = new Set(pools.map(pool => `${pool.pool}:${pool.token}`));
        const rows = geckoPairs(payload, Date.now(), wanted);
        remember(rows);
        return rows.map(({ market, observedAt }) => ({ ...market, at: observedAt }));
      } catch (error) {
        if (error.status === 429) next = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
        throw error;
      } finally { active = false; }
    },
    async feed(feed) {
      const data = await read(`/${feed}?include=base_token&page=1`);
      const rows = geckoPairs(data, Date.now());
      remember(rows);
      return rows;
    },
    get: token => cached.get(token),
    async refresh(token) {
      const now = Date.now();
      if (!canRefresh(token)) return;
      active = true;
      next = now + 8000;
      retry.set(token, now + 60000);
      try {
        const data = await read(`/tokens/${token}/pools?include=base_token,quote_token&page=1`);
        const wanted = new Set((Array.isArray(data?.data) ? data.data : []).map(row=>`${row.attributes?.address}:${token}`));
        const ranked = geckoPairs(data, Date.now(),wanted).sort((a,b)=>b.market.liquidity-a.market.liquidity);
        if (ranked.length) remember(ranked.slice(0,1));
      } catch (error) {
        if (error.status === 429) next = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
        throw error;
      } finally { active = false; }
    }
  };
}
