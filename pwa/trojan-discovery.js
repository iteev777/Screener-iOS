// SPDX-License-Identifier: BUSL-1.1
// Browser adapters for Trojan V2 scanner.py, sniper_scanner.py and discovery/.
import { fetchJson } from "./network.js";
import { address, discoverMarkets, normalizePair } from "./markets.js";
import { candidateQuality } from "./trojan-analysis.js";

const dex = "https://api.dexscreener.com";
const endpoints = [
  ["Latest Profiles", "/token-profiles/latest/v1", 15000],
  ["Latest Boosts", "/token-boosts/latest/v1", 15000],
  ["Top Boosts", "/token-boosts/top/v1", 30000],
  ["Community Takeovers", "/community-takeovers/latest/v1", 30000]
];

function items(payload) {
  if (Array.isArray(payload)) return payload;
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  return ["items","tokens","token_list","results"].map(k => data?.[k]).find(Array.isArray) ?? [];
}
function metadata(row) {
  return { name: row?.name ?? row?.tokenMeta?.name, symbol: row?.symbol ?? row?.tokenMeta?.symbol,
    creator: row?.creator ?? row?.traderPublicKey, icon: row?.icon ?? row?.logoURI ?? row?.logo,
    priceUsd: row?.usdPrice ?? row?.priceUsd, liquidityUsd: row?.liquidity_usd ?? row?.liquidity,
    marketCap: row?.mcap ?? row?.marketCap, fdv: row?.fdv, volume24h: row?.volume_24h_usd ?? row?.v24hUSD };
}
export function sourcesFor(birdeyeKey, tape) {
  const sources = endpoints.map(([name, path, interval]) => ({ name, interval, load: async signal => {
    const rows = await fetchJson(dex + path, {}, signal);
    if (!Array.isArray(rows)) throw new Error("Virheellinen syöte");
    return rows.filter(row => row?.chainId === "solana").map(row => ({...metadata(row),token:row.tokenAddress}));
  } }));
  for (const feed of ["new_pools", "trending_pools"]) {
    sources.push({ name: `GeckoTerminal ${feed}`, interval: 30000,
      load: async signal => tape ? (await tape.feed(feed)).map(({ market }) => ({...metadata(market), token: market.token}))
        : (await discoverMarkets(feed, { liquidity: 0, volume: 0 }, signal)).map(row => ({...metadata(row),token:row.token})) });
  }
  if (birdeyeKey) sources.push({ name: "Birdeye", interval: 60000, load: async signal => {
    const base = "https://public-api.birdeye.so/defi";
    const options = { headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana" } };
    let result;
    try {
      result = await fetchJson(base + "/v3/token/list?sort_by=volume_24h_usd&sort_type=desc&offset=0&limit=100", options, signal);
    } catch (error) {
      if (![400, 404, 422].includes(error.status)) throw error;
      result = await fetchJson(base + "/token_trending?offset=0&limit=20", options, signal);
    }
    const rows = result?.data?.items ?? result?.data?.tokens;
    if (result?.success === false || !Array.isArray(rows)) throw new Error("Virheellinen Birdeye-syöte");
    return rows.map(row => ({...metadata(row),token:row?.address ?? row?.tokenAddress}));
  } });
  const feed = (name, url, interval, mint, options = {}) => ({
    name, interval, load: async signal => items(await fetchJson(url, options, signal))
      .map(row => ({ ...metadata(row), token: mint(row) })).filter(row => address.test(row.token ?? ""))
  });
  for (const endpoint of ["new_tokens","recent","trending","verified"])
    sources.push(feed("RugCheck " + endpoint, "https://api.rugcheck.xyz/v1/stats/" + endpoint, 45000, r => r?.mint ?? r?.address));
  for (const endpoint of ["recent","toporganicscore/1h?limit=100","toptraded/1h?limit=100","toptrending/1h?limit=100"])
    sources.push(feed("Jupiter " + endpoint, "https://lite-api.jup.ag/tokens/v2/" + endpoint, 30000, r => r?.id ?? r?.mint ?? r?.address));
  sources.push(feed("CoinGecko", "https://api.coingecko.com/api/v3/coins/list?include_platform=true", 3600000, r => r?.platforms?.solana));
  sources.push(feed("DeFiLlama", "https://api.llama.fi/protocols", 3600000, r =>
    r?.chains?.some(c => String(c).toLowerCase() === "solana") ? r?.address?.replace(/^solana:/i,"") : null));
  if (birdeyeKey) sources.push({name:"Birdeye Meme Listing", interval:30000, load: async signal => {
    const options = {headers:{"X-API-KEY":birdeyeKey,"x-chain":"solana"}};
    const base = "https://public-api.birdeye.so/defi";
    let raw;
    try { raw = await fetchJson(base + "/v2/tokens/new_listing?limit=20&meme_platform_enabled=true",options,signal); }
    catch (e) { if (![400,404,422].includes(e.status)) throw e;
      raw = await fetchJson(base + "/token_trending?sort_by=rank&sort_type=asc&interval=1h&limit=20",options,signal); }
    if (raw?.success === false) throw new Error("Birdeye listing failure");
    return items(raw).map(r => ({...metadata(r),token:r.address ?? r.tokenAddress}));
  }});
  return sources;
}

const marketCaches=new WeakMap();
export function invalidateMarket(token, signal, at) {
  const cache = marketCaches.get(signal);
  const entry = cache?.get(token);
  if (entry?.value && at - entry.value.observedAt >= 3000) cache.delete(token);
}
export async function marketBatch(tokens, signal) {
  if (!tokens.length || tokens.length > 30 || tokens.some(token => typeof token !== "string" || !address.test(token))) {
    throw new Error("Virheellinen minttien erähaku");
  }
  let cache=signal ? marketCaches.get(signal) : undefined;if(!cache){cache=new Map();if(signal)marketCaches.set(signal,cache);}
  const now=Date.now(),best=new Map();
  for(const [key,value] of cache)if(value.expires<=now)cache.delete(key);
  const missing=[...new Set(tokens)].filter(token=>{const hit=cache.get(token);if(hit){if(hit.value)best.set(token,hit.value);return false;}return true;});
  if(!missing.length)return best;
  const requested = new Set(missing);
  const rows = await fetchJson(`${dex}/tokens/v1/solana/${missing.join(",")}`, {}, signal);
  if (!Array.isArray(rows)) throw new Error("Virheellinen tokenien hintaerä");
  for (const raw of rows) {
    const market = normalizePair(raw);
    if (!market || !requested.has(market.token)) continue;
    if (!best.has(market.token) || market.liquidity > best.get(market.token).market.liquidity) {
      best.set(market.token, { market, raw, observedAt: Date.now() });
    }
  }
  for(const token of missing)cache.set(token,{value:best.get(token),expires:now+(best.has(token)?5000:3000)});
  while(cache.size>3000)cache.delete(cache.keys().next().value);
  return best;
}

export function watchPumpPortal(signal, emit, status, migrate) {
  if (signal.aborted) return;
  let socket;
  let retry;
  let timer;
  let failures = 0;
  const seen = new Set();
  function connect() {
    socket = new WebSocket("wss://pumpportal.fun/api/data");
    timer = setTimeout(() => socket.close(), 15000);
    socket.onopen = () => {
      clearTimeout(timer);
      status("yhdistetty");
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      if (migrate) socket.send(JSON.stringify({ method: "subscribeMigration" }));
    };
    socket.onmessage = event => {
      if (signal.aborted || typeof event.data !== "string" || event.data.length > 8192) return;
      try {
        const row = JSON.parse(event.data);
        if (migrate && row?.txType === "migration" && address.test(row.mint ?? "")) { migrate(row.mint); return; }
        if (typeof row?.mint === "string" && address.test(row.mint) &&
            (row.txType === undefined || row.txType === "create")) {
          failures = 0;
          if (seen.has(row.mint)) return;
          seen.add(row.mint);
          if (seen.size > 10000) seen.delete(seen.values().next().value);
          emit({token:row.mint,name:row.name,symbol:row.symbol,creator:row.traderPublicKey});
        }
      } catch { /* Ignore malformed feed frames. */ }
    };
    socket.onclose = () => {
      clearTimeout(timer);
      if (signal.aborted) return;
      status("yhdistetään uudelleen");
      retry = setTimeout(connect, Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)));
    };
  }
  signal.addEventListener("abort", () => {
    clearTimeout(retry);
    clearTimeout(timer);
    socket?.close();
  }, { once: true });
  connect();
}

export class CandidateQueue {
  items = new Map();
  sniperItems = new Map();
  entries() { return [...this.items.values(), ...this.sniperItems.values()]; }
  stats = { found: 0, analyzed: 0, approved: 0, rejected: 0, dropped: 0 };

  add(tokens, source, now) {
    const discovered = [];
    for (const value of tokens) {
      const token = typeof value === "string" ? value : value?.token;
      const details = typeof value === "object" && value ? Object.fromEntries(Object.entries(metadata(value)).filter(([,v]) => v !== undefined && v !== null)) : {};
      if (typeof token !== "string" || !address.test(token)) continue;
      const item = this.sniperItems.get(token) ?? this.items.get(token);
      if (item) {
        for (const [key,val] of Object.entries(details)) if (val && !item[key]) item[key] = val;
        if (!item.sources.has(source)) {
          item.sources.add(source);
          item.due = Math.min(item.due, now);
        }
        if (source === "PumpPortal" && this.items.has(token) && this.sniperItems.size < 1000) {
          this.items.delete(token); this.sniperItems.set(token, item);
        }
        if (source !== "PumpPortal") item.lastSeen = now;
        continue;
      }
      const target = source === "PumpPortal" ? this.sniperItems : this.items;
      if (target.size >= 1000) {
        this.stats.dropped++;
        continue;
      }
      target.set(token, { ...details, token, sources: new Set([source]), due: now, seen: now, lastSeen: now, attempts: 0 });
      this.stats.found++;
      discovered.push(token);
    }
    return discovered;
  }

  take(now, profile) {
    for (const map of [this.items, this.sniperItems]) for (const [mint, entry] of map) {
      const sniper = entry.sources.size === 1 && entry.sources.has("PumpPortal");
      if (!entry.inFlight && now - (sniper ? entry.seen : entry.lastSeen) >= (sniper ? 300000 : 600000)) map.delete(mint);
    }
    const rank=item=>(item.priority??0)+(item.sources.has("PumpPortal")?20:0)+(item.attempts===0?15:0)+Math.min(120,Math.max(0,now-item.due)/1000)+Math.min(10,item.sources.size*2);
    return this.entries().filter(item => item.due <= now && !item.inFlight && (profile !== "sniper" || item.sources.has("PumpPortal")))
      .sort((a,b)=>rank(b)-rank(a)||a.due-b.due).slice(0, 30).map(item => { item.inFlight = true; return item; });
  }

  finish(item, result, raw, now) {
    item.inFlight = false;
    if (!item.attempts) this.stats.analyzed++;
    if (result === "approve" && !item.approved) { this.stats.approved++; item.approved = true; }
    if (result === "reject" && !item.rejected) { this.stats.rejected++; item.rejected = true; }
    item.streak=item.decision===result?(item.streak??0)+1:1;
    item.decision = result;
    item.attempts++;
    item.priority = raw ? candidateQuality(raw, item.sources, now).score : 0;
    item.due = now + (result === "watch" ? 10000 : result === "approve" ? 15000 : Math.min(180000,60000*item.streak));
  }

  release(batch, now) {
    for (const item of batch) if (item.inFlight) { item.inFlight = false; item.due = now + 3000; }
  }

  snapshot(now, profile) {
    const entries = this.entries().filter(item => profile !== "sniper" || item.sources.has("PumpPortal"));
    return { ...this.stats, mainQueue: this.items.size, sniperQueue: this.sniperItems.size, queued: entries.filter(item => item.due <= now && !item.inFlight).length,
      waiting: entries.filter(item => item.decision === "watch" && item.due > now).length };
  }
}
