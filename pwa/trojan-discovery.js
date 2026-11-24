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

export function sourcesFor(birdeyeKey) {
  const sources = endpoints.map(([name, path, interval]) => ({ name, interval, load: async signal => {
    const rows = await fetchJson(dex + path, {}, signal);
    if (!Array.isArray(rows)) throw new Error("Virheellinen syöte");
    return rows.filter(row => row?.chainId === "solana").map(row => row.tokenAddress);
  } }));
  for (const feed of ["new_pools", "trending_pools"]) {
    sources.push({ name: `GeckoTerminal ${feed}`, interval: 30000,
      load: async signal => (await discoverMarkets(feed, { liquidity: 0, volume: 0 }, signal)).map(row => row.token) });
  }
  if (birdeyeKey) sources.push({ name: "Birdeye", interval: 60000, load: async signal => {
    const base = "https://public-api.birdeye.so/defi";
    const options = { headers: { "X-API-KEY": birdeyeKey, "x-chain": "solana" } };
    let result;
    try {
      result = await fetchJson(base + "/v3/token/list?sort_by=volume_24h_usd&sort_type=desc&offset=0&limit=30", options, signal);
    } catch (error) {
      if (![400, 404, 422].includes(error.status)) throw error;
      result = await fetchJson(base + "/token_trending?offset=0&limit=20", options, signal);
    }
    const rows = result?.data?.items ?? result?.data?.tokens;
    if (result?.success === false || !Array.isArray(rows)) throw new Error("Virheellinen Birdeye-syöte");
    return rows.map(row => row?.address);
  } });
  return sources;
}

export async function marketBatch(tokens, signal) {
  if (!tokens.length || tokens.length > 30 || tokens.some(token => typeof token !== "string" || !address.test(token))) {
    throw new Error("Virheellinen minttien erähaku");
  }
  const requested = new Set(tokens);
  const rows = await fetchJson(`${dex}/tokens/v1/solana/${tokens.join(",")}`, {}, signal);
  if (!Array.isArray(rows)) throw new Error("Virheellinen tokenien hintaerä");
  const best = new Map();
  for (const raw of rows) {
    const market = normalizePair(raw);
    if (!market || !requested.has(market.token)) continue;
    if (!best.has(market.token) || market.liquidity > best.get(market.token).market.liquidity) {
      best.set(market.token, { market, raw });
    }
  }
  return best;
}

export function watchPumpPortal(signal, emit, status) {
  if (signal.aborted) return;
  let socket;
  let retry;
  let timer;
  let failures = 0;
  function connect() {
    socket = new WebSocket("wss://pumpportal.fun/api/data");
    timer = setTimeout(() => socket.close(), 15000);
    socket.onopen = () => {
      clearTimeout(timer);
      status("yhdistetty");
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
    };
    socket.onmessage = event => {
      if (signal.aborted || typeof event.data !== "string" || event.data.length > 8192) return;
      try {
        const row = JSON.parse(event.data);
        if (typeof row?.mint === "string" && address.test(row.mint) &&
            (row.txType === undefined || row.txType === "create")) {
          failures = 0;
          emit(row.mint);
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
  stats = { found: 0, analyzed: 0, approved: 0, rejected: 0, dropped: 0 };

  add(tokens, source, now) {
    const discovered = [];
    for (const token of new Set(tokens)) {
      if (typeof token !== "string" || !address.test(token)) continue;
      const item = this.items.get(token);
      if (item) {
        if (!item.sources.has(source)) {
          item.sources.add(source);
          item.due = Math.min(item.due, now);
        }
        if (source !== "PumpPortal") item.lastSeen = now;
        continue;
      }
      if (this.items.size >= 600) {
        this.stats.dropped++;
        continue;
      }
      this.items.set(token, { token, sources: new Set([source]), due: now, seen: now, lastSeen: now, attempts: 0 });
      this.stats.found++;
      discovered.push(token);
    }
    return discovered;
  }

  take(now) {
    for (const [mint, entry] of this.items) {
      if (now - (entry.sources.size === 1 && entry.sources.has("PumpPortal") ? entry.seen : entry.lastSeen) >= 300000) this.items.delete(mint);
    }
    return [...this.items.values()].filter(item => item.due <= now && !item.inFlight)
      .sort((a, b) => Number(b.attempts === 0) - Number(a.attempts === 0) ||
        (b.priority ?? 0) - (a.priority ?? 0) || a.due - b.due).slice(0, 30).map(item => { item.inFlight = true; return item; });
  }

  finish(item, result, raw, now) {
    item.inFlight = false;
    if (!item.attempts) this.stats.analyzed++;
    if (result === "approve" && !item.approved) { this.stats.approved++; item.approved = true; }
    if (result === "reject" && !item.rejected) { this.stats.rejected++; item.rejected = true; }
    item.decision = result;
    item.attempts++;
    item.priority = raw ? candidateQuality(raw, item.sources, now).score : 0;
    item.due = now + (result === "watch" ? 10000 : result === "approve" ? 15000 : 60000);
  }

  release(batch, now) {
    for (const item of batch) if (item.inFlight) { item.inFlight = false; item.due = now + 3000; }
  }

  snapshot(now) {
    const entries = [...this.items.values()];
    return { ...this.stats, queued: entries.filter(item => item.due <= now && !item.inFlight).length,
      waiting: entries.filter(item => item.decision === "watch" && item.due > now).length };
  }
}
