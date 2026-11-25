// SPDX-License-Identifier: BUSL-1.1
import { fetchJson, mint } from "./network.js";

const dex = "https://api.dexscreener.com";
const gecko = "https://api.geckoterminal.com/api/v2";
export const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const timeframes = Object.freeze({ "1m": ["minute", 1, 60], "5m": ["minute", 5, 300],
  "15m": ["minute", 15, 900], "1h": ["hour", 1, 3600], "4h": ["hour", 4, 14400], "1d": ["day", 1, 86400] });

export function normalizePair(pair) {
  if (pair?.chainId !== "solana" || !address.test(pair.baseToken?.address ?? "") ||
      !address.test(pair.pairAddress ?? "")) return;
  const price = marketNumber(pair.priceUsd);
  const liquidity = marketNumber(pair.liquidity?.usd);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(liquidity) || liquidity <= 0) return;
  return { token: pair.baseToken.address, pool: pair.pairAddress, quoteToken: pair.quoteToken?.address,
    symbol: String(pair.baseToken.symbol ?? "").slice(0, 18), price, liquidity,
    name: pair.baseToken?.name, volume5: pair.volume?.m5, volumeHour: pair.volume?.h1,
    change5: pair.priceChange?.m5, changeHour: pair.priceChange?.h1, marketCap: pair.marketCap, volume: pair.volume?.h24, change: pair.priceChange?.h24, transactions: pair.txns, created: pair.pairCreatedAt };
}

export function marketNumber(value) {
  return (typeof value === "number" || typeof value === "string" && value.trim()) &&
    Number.isFinite(Number(value)) ? Number(value) : undefined;
}

// A pair endpoint reports USD for its base. A quote-side USD price can be
// recovered only when the same response gives its base price in quote units.
export function orientPair(pair, token) {
  if (pair?.baseToken?.address === token) return pair;
  if (pair?.quoteToken?.address !== token || !address.test(pair.baseToken?.address ?? "")) return;
  const native = marketNumber(pair.priceNative);
  const price = marketNumber(pair.priceUsd);
  const swapSides = row => ({ buys: row?.sells, sells: row?.buys });
  return { ...pair, baseToken: pair.quoteToken, quoteToken: pair.baseToken,
    priceUsd: marketNumber(pair.quotePriceUsd) ?? (native > 0 && price >= 0 ? price / native : undefined),
    priceNative: native > 0 ? 1 / native : undefined, priceChange: pair.quotePriceChange,
    txns: Object.fromEntries(Object.entries(pair.txns ?? {}).map(([window, row]) => [window, swapSides(row)])),
    marketCap: undefined, fdv: undefined };
}

export function pairState(raw) {
  if (raw?.chainId !== "solana" || !address.test(raw.baseToken?.address ?? "") ||
      !address.test(raw.quoteToken?.address ?? "") || !address.test(raw.pairAddress ?? "") ||
      raw.baseToken.address === raw.quoteToken.address) return "invalid-pair";
  const price = marketNumber(raw.priceUsd), liquidity = marketNumber(raw.liquidity?.usd);
  if (price === 0) return "zero-price";
  if (liquidity === 0) return "empty-liquidity";
  if (price === undefined) return "missing-price";
  if (liquidity === undefined) return "missing-liquidity";
  if (price < 0 || liquidity < 0) return "invalid-values";
  return "priced";
}

export async function searchMarkets(query, bounds, signal) {
  const term = query.trim();
  if (!term || term.length > 100) throw new Error("Anna tokenin nimi, tunnus tai osoite.");
  const result = address.test(term)
    ? await fetchJson(`${dex}/token-pairs/v1/solana/${term}`, {}, signal)
    : (await fetchJson(`${dex}/latest/dex/search?q=${encodeURIComponent(term)}`, {}, signal))?.pairs;
  if (!Array.isArray(result)) throw new Error("Virheellinen DEX Screener -vastaus.");
  return screenMarkets(result, bounds, address.test(term) ? term : undefined);
}

function screenMarkets(source, bounds, token) {
  const rows = source.map(normalizePair).filter(pair => pair &&
    (!token || pair.token === token) && pair.liquidity >= bounds.liquidity &&
    (!bounds.volume || (Number.isFinite(pair.volume) && pair.volume >= bounds.volume)))
    .sort((a, b) => b.liquidity - a.liquidity);
  const tokens = new Set();
  return rows.filter(pair => {
    if (tokens.has(pair.token)) return false;
    tokens.add(pair.token);
    return true;
  }).slice(0, 25);
}

export async function discoverMarkets(feed, bounds, signal) {
  if (!["new_pools", "trending_pools"].includes(feed)) throw new Error("Valitse markkinalähde.");
  const result = await fetchJson(`${gecko}/networks/solana/${feed}?include=base_token&page=1`, {}, signal);
  if (!Array.isArray(result?.data)) throw new Error("Virheellinen GeckoTerminal-listaus.");
  const symbols = new Map((Array.isArray(result.included) ? result.included : [])
    .filter(item => item.type === "token").map(item => [item.id, item.attributes?.symbol]));
  return screenMarkets(result.data.map(pool => {
    const data = pool.attributes;
    const id = pool.relationships?.base_token?.data?.id;
    const token = typeof id === "string" && id.startsWith("solana_") ? id.slice(7) : undefined;
    return { chainId: "solana", pairAddress: data?.address,
      baseToken: { address: token, symbol: symbols.get(id) },
      priceUsd: data?.base_token_price_usd, liquidity: { usd: Number(data?.reserve_in_usd) },
      volume: { h24: Number(data?.volume_usd?.h24) }, pairCreatedAt: Date.parse(data?.pool_created_at) };
  }), bounds);
}

export async function poolPrice(selection, signal) {
  const response = await fetchJson(`${dex}/latest/dex/pairs/solana/${selection.pool}`, {}, signal);
  const pair = response?.pairs?.map(normalizePair).find(item =>
    item?.pool === selection.pool && item.token === selection.token
  );
  if (!pair) throw new Error("Valittua poolia tai tokenin hintaa ei löytynyt.");
  return { ...pair, at: Date.now() };
}

export function normalizeCandles(rows, limit = 64) {
  if (!Array.isArray(rows)) throw new Error("Virheellinen OHLCV-vastaus.");
  const byTime = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6 || !row.slice(0, 6).every(Number.isFinite)) continue;
    const [time, open, high, low, close, volume] = row;
    if (!Number.isSafeInteger(time) || time <= 0 || low <= 0 || volume < 0 ||
        high < Math.max(open, close) || low > Math.min(open, close)) continue;
    byTime.set(time, { time, open, high, low, close, volume });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

// UTC buckets match OhlcvAggregator::aggregate. Latest duplicate wins before summing.
export function aggregateCandles(candles, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 ||
      to < from || to % from !== 0) throw new Error("Virheellinen OHLCV-aikaväli.");
  const source = [...new Map(candles.map(candle => [candle.time, candle])).values()]
    .sort((a, b) => a.time - b.time);
  if (from === to) return source.slice(-64);
  const result = [];
  for (const candle of source) {
    const time = Math.floor(candle.time / to) * to;
    const last = result.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume += candle.volume;
    } else {
      result.push({ ...candle, time });
    }
  }
  return result.slice(-64);
}

async function loadCandles(selection, unit, aggregate, limit, signal) {
  const query = new URLSearchParams({ aggregate, limit, currency: "usd", token: selection.token });
  const response = await fetchJson(`${gecko}/networks/solana/pools/${selection.pool}/ohlcv/${unit}?${query}`, {}, signal);
  return normalizeCandles(response?.data?.attributes?.ohlcv_list, limit);
}

export async function fetchTrojanCandles(selection, signal) {
  if (!address.test(selection?.pool ?? "") || !address.test(selection?.token ?? "")) {
    throw new Error("Virheellinen OHLCV-markkina");
  }
  return loadCandles(selection, "minute", 1, 480, signal);
}

export async function fetchCandles(selection, timeframe, signal) {
  if (!address.test(selection?.pool ?? "") || !address.test(selection?.token ?? "") ||
      !Object.hasOwn(timeframes, timeframe)) throw new Error("Valitse markkina ja aikaväli.");
  const [unit, aggregate, seconds] = timeframes[timeframe];
  if (aggregate === 1) return loadCandles(selection, unit, 1, 64, signal);
  try {
    const source = await loadCandles(selection, unit, 1, Math.min(1000, 65 * aggregate), signal);
    return aggregateCandles(source, seconds / aggregate, seconds);
  } catch (error) {
    if (signal?.aborted || error.status === 429) throw error;
    return loadCandles(selection, unit, aggregate, 64, signal);
  }
}

export const solMarket = { token: mint, symbol: "SOL" };
