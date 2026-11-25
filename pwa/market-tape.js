// SPDX-License-Identifier: BUSL-1.1
import { address, normalizePair } from "./markets.js";
import { fetchJson } from "./network.js";

const gecko = "https://api.geckoterminal.com/api/v2/networks/solana";
const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value) : undefined;
const windows = ["m5", "h1", "h6", "h24"];
const fields = row => Object.fromEntries(windows.map(key => [key, number(row?.[key])]));
const mintId = id => typeof id === "string" && id.startsWith("solana_") && address.test(id.slice(7)) ? id.slice(7) : undefined;

export function geckoPairs(result, at) {
  if (!Array.isArray(result?.data)) throw new Error("Virheellinen GeckoTerminal-poolivastaus");
  const tokens = new Map((result.included ?? []).map(item => [item.id, item.attributes]));
  return result.data.flatMap(row => {
    const attr = row.attributes;
    const base = row.relationships?.base_token?.data?.id;
    const quote = row.relationships?.quote_token?.data?.id;
    const raw = {
      chainId: "solana", pairAddress: attr?.address, baseToken: { ...tokens.get(base), address: mintId(base) },
      quoteToken: { address: mintId(quote) }, priceUsd: attr?.base_token_price_usd,
      liquidity: { usd: number(attr?.reserve_in_usd) }, volume: fields(attr?.volume_usd),
      priceChange: fields(attr?.price_change_percentage), txns: attr?.transactions,
      pairCreatedAt: Date.parse(attr?.pool_created_at), marketCap: number(attr?.market_cap_usd)
    };
    const market = normalizePair(raw);
    return market && raw.quoteToken.address ? [{ raw, market, observedAt: at, provider: "GeckoTerminal" }] : [];
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
  const retry = new Map();
  const remember = rows => {
    for (const row of rows) {
      const old = cached.get(row.market.token);
      if (old?.observedAt === row.observedAt && old.market.liquidity >= row.market.liquidity) continue;
      cached.set(row.market.token, row);
    }
    for (const map of [cached, retry]) while (map.size > 500) map.delete(map.keys().next().value);
  };
  const canRefresh = token => !active && Date.now() >= next && Date.now() >= (retry.get(token) ?? 0);
  const tradeCache = new Map();
  let nextTrades = 0, tradeBusy = false;
  const tradeKey = (pool, token) => `${pool}:${token}`;
  const canTrade = (pool, token, now) => !tradeBusy && now >= nextTrades &&
    now - (tradeCache.get(tradeKey(pool, token))?.at ?? 0) >= 12000;
  return {
    canRefresh,
    canTrade,
    trades(pool, token) { return tradeCache.get(`${pool}:${token}`)?.rows ?? []; },
    async refreshTrades(pool, token) {
      const now = Date.now(), key = tradeKey(pool, token);
      if (!address.test(pool) || !address.test(token) || !canTrade(pool,token,now)) return false;
      tradeBusy = true; nextTrades = now + 8000;
      tradeCache.set(key, {at:now, rows:tradeCache.get(key)?.rows ?? []});
      while(tradeCache.size>100) tradeCache.delete(tradeCache.keys().next().value);
      try {
        const data = await fetchJson(`${gecko}/pools/${pool}/trades`, {}, signal);
        if (!Array.isArray(data?.data)) return false;
        const rows = new Map((tradeCache.get(key)?.rows ?? []).map(t => [t.id,t]));
        const previous = rows.size;
        for (const row of data.data) {
          const a = row.attributes; if (!a || !row.id) continue;
          const buy = a.to_token_address === token, sell = a.from_token_address === token;
          if (buy === sell) continue;
          const t = {id:row.id, at:Date.parse(a.block_timestamp), price:number(buy?a.price_to_in_usd:a.price_from_in_usd), usd:number(a.volume_in_usd), side:buy?'buy':'sell'};
          if (Number.isFinite(t.at) && t.price > 0 && t.usd > 0) rows.set(t.id,t);
        }
        tradeCache.set(key,{at:now,rows:[...rows.values()].filter(t=>t.at>=now-300000).sort((a,b)=>a.at-b.at).slice(-3000)});
        return rows.size > previous;
      } catch(e) { if(e.status===429) nextTrades=Date.now()+Math.max(60000,e.retryAfterMs??0); throw e; }
      finally { tradeBusy=false; }
    },
    async poolPrices(pools) {
      if (!pools.length || !canRefresh("")) return [];
      active = true;
      next = Date.now() + 8000;
      try {
        const payload = await fetchJson(`${gecko}/pools/multi/${pools.map(pool => pool.pool).join(",")}?include=base_token`, {}, signal);
        const rows = geckoPairs(payload, Date.now());
        remember(rows);
        const requested = new Set(pools.map(pool => `${pool.pool}:${pool.token}`));
        return rows.filter(({ market }) => requested.has(`${market.pool}:${market.token}`))
          .map(({ market, observedAt }) => ({ ...market, at: observedAt }));
      } catch (error) {
        if (error.status === 429) next = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
        throw error;
      } finally { active = false; }
    },
    async feed(feed) {
      const data = await fetchJson(`${gecko}/${feed}?include=base_token&page=1`, {}, signal);
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
        const data = await fetchJson(`${gecko}/tokens/${token}/pools?include=base_token&page=1`, {}, signal);
        remember(geckoPairs(data, Date.now()).filter(row => row.market.token === token));
      } catch (error) {
        if (error.status === 429) next = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
        throw error;
      } finally { active = false; }
    }
  };
}
