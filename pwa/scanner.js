// SPDX-License-Identifier: BUSL-1.1
import { address, discoverMarkets, fetchCandles, normalizePair, timeframes } from "./markets.js";
import { fetchJson, rpcCall } from "./network.js";
import { applyPaperFill, orderFor } from "./policy.js";
import { ruleSignal } from "./rules.js";
import { copyGroup } from "./copy.js";

export const scanLimit = 12;
const batchLimit = 30;
const maxTickAge = 20000;
export const scanKey = "scan-portfolio";
const classicTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const day = at => Math.floor(at / 86400000);
export const positionKey = market => `${market.token}:${market.pool}`;

export function newPortfolio() {
  return { cash: 1000, realized: 0, positions: {}, trades: [], lossToday: 0 };
}

export function universe(portfolio, candidates, limit = scanLimit) {
  const active = Object.values(portfolio.positions).map(position => position.market);
  const pools = new Set(active.map(market => market.pool));
  for (const market of candidates) {
    if (active.length >= limit) break;
    if (!pools.has(market.pool)) {
      active.push(market);
      pools.add(market.pool);
    }
  }
  return active;
}

export async function discoverScan(policy, signal) {
  const bounds = { liquidity: policy.minLiquidity, volume: policy.scanMinVolume ?? 10000 };
  const results = await Promise.allSettled(["new_pools", "trending_pools"].map(feed =>
    discoverMarkets(feed, bounds, signal)));
  if (results.every(result => result.status === "rejected")) throw results[0].reason;
  return results.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => b.liquidity - a.liquidity);
}

export async function scanPrices(markets, signal) {
  if (!markets.length) return [];
  if (markets.length > batchLimit || markets.some(market => !address.test(market.pool))) {
    throw new Error("Virheellinen poolien erähaku.");
  }
  const identities = new Set(markets.map(positionKey));
  const ids = [...new Set(markets.map(market => market.pool))].join(",");
  const result = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${ids}`, {}, signal);
  if (!Array.isArray(result?.pairs)) throw new Error("Virheellinen markkinaerä.");
  const at = Date.now();
  return result.pairs.map(normalizePair).filter(pair => pair && identities.has(positionKey(pair)))
    .map(pair => ({ ...pair, at }));
}

export function mintEligible(account) {
  const data = account?.data?.parsed;
  return account?.owner === classicTokenProgram && data?.type === "mint" &&
    data.info?.isInitialized === true && data.info.mintAuthority === null &&
    data.info.freezeAuthority === null;
}

export async function scanMints(tokens, signal) {
  if (!tokens.length) return new Map();
  const response = await rpcCall("getMultipleAccounts", [tokens, {
    commitment: "confirmed", encoding: "jsonParsed"
  }], signal);
  if (!Array.isArray(response?.value) || response.value.length !== tokens.length) {
    throw new Error("Virheellinen minttien riskitarkistus.");
  }
  return new Map(tokens.map((token, i) => [token, mintEligible(response.value[i])]));
}

export function rugEligible(report, ceiling) {
  return Number.isFinite(report?.score_normalised) && report.score_normalised >= 0 &&
    report.score_normalised <= ceiling && report.rugged !== true && Array.isArray(report.risks) &&
    !report.risks.some(risk => typeof risk?.level !== "string" || risk.level.toLowerCase() === "danger");
}

export function advancePortfolio(portfolio, ticks, engine, policy, decide, eligible) {
  const unique = new Map(ticks.map(tick => [positionKey(tick), tick]));
  const input = [...unique.entries()].filter(([, tick]) =>
    Number.isFinite(tick.price) && tick.price > 0 && Number.isFinite(tick.at) &&
    tick.at > (portfolio.lastScanAt ?? 0));
  if (input.length) portfolio.lastScanAt = Math.max(...input.map(([, tick]) => tick.at));
  const existed = new Set(Object.keys(portfolio.positions));
  // Process exits first, regardless of provider order. Re-entry waits for the next cycle.
  for (const exits of [true, false]) {
    for (const [key, tick] of input) {
      const position = portfolio.positions[key];
      if (exits && !position || !exits && existed.has(key) && !position) continue;
      if (position && tick.at <= (position.lastTickAt ?? 0)) continue;
      const currentDay = day(tick.at);
      if (portfolio.lossDay !== currentDay) {
        portfolio.lossDay = currentDay;
        portfolio.lossToday = 0;
      }
      const book = { sol: 0, cost: 0, ...position, cash: portfolio.cash, realized: portfolio.realized,
        lossToday: portfolio.lossToday, lossDay: portfolio.lossDay, buyDay: portfolio.buyDay, buysToday: portfolio.buysToday, trades: [], count: 0 };
      const order = orderFor(engine, decide(tick, book), book, tick, policy);
      if (exits && order?.side !== "Myynti") continue;
      if (!exits && order?.side === "Myynti") continue;
      const exposure = Object.values(portfolio.positions).reduce((sum, item) => sum + item.cost, 0);
      const duplicate = Object.entries(portfolio.positions).some(([other, item]) =>
        other !== key && item.market.token === tick.token);
      const buyAllowed = eligible(tick.token) && Number.isFinite(tick.volume) && tick.volume >= (policy.scanMinVolume ?? 10000) && !duplicate &&
        (position || Object.keys(portfolio.positions).length < (policy.maxPools ?? scanLimit)) &&
        exposure + policy.orderUsd <= policy.exposureUsd;
      if (order && (exits || buyAllowed)) {
        applyPaperFill(book, order, tick, policy);
        portfolio.cash = book.cash;
        portfolio.realized = book.realized;
        portfolio.lossToday = book.lossToday;
        portfolio.buyDay = book.buyDay;
        portfolio.buysToday = book.buysToday;
        portfolio.trades.unshift({ ...book.trades[0], symbol: tick.symbol, token: tick.token, pool: tick.pool });
        portfolio.trades.length = Math.min(portfolio.trades.length, 200);
      }
      if (book.sol > 0) {
        const { sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool, lastTradeAt } = book;
        portfolio.positions[key] = { sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool,
          lastTradeAt, peak: Math.max(book.peak ?? tick.price, tick.price), mark: tick.price,
          lastTickAt: tick.at, market: { token: tick.token, pool: tick.pool, symbol: tick.symbol } };
      } else if (position) {
        delete portfolio.positions[key];
      }
    }
  }
  return portfolio;
}

export function pause(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(stop, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export async function runScanner({ engine, policy, rules, timeframe, copyWallets, signal, load, commit, report }) {
  const priceHistory = new Map();
  const candles = new Map();
  const authority = new Map();
  const rug = new Map();
  let candidates = [];
  let nextDiscovery = 0;
  let failures = 0;
  let candleIndex = 0;
  let cursors = new Map();
  while (!signal.aborted) {
    try {
      const now = Date.now();
      if (now >= nextDiscovery) {
        nextDiscovery = now + 120000;
        try {
          candidates = await discoverScan(policy, signal);
        } catch (error) {
          if (signal.aborted) return;
          candidates = [];
          report(`Poolihaku: ${error.message}`);
        }
      }
      const markets = universe(await load(), candidates, policy.maxPools);
      const active = new Set(markets.map(positionKey));
      for (const collection of [priceHistory, candles]) {
        for (const key of collection.keys()) if (!active.has(key)) collection.delete(key);
      }
      const tokens = new Set(markets.map(market => market.token));
      for (const [token, check] of authority) {
        if (!tokens.has(token) || now >= check.expires) authority.delete(token);
      }
      for (const [token, check] of rug) {
        if (!tokens.has(token) || now >= check.expires) rug.delete(token);
      }
      const ticks = await scanPrices(markets, signal);
      if (signal.aborted) return;
      const unchecked = [...new Set(ticks.map(tick => tick.token))].filter(token => !authority.has(token));
      try {
        const checked = await scanMints(unchecked, signal);
        for (const [token, allowed] of checked) authority.set(token, { allowed, expires: now + 300000 });
      } catch (error) {
        if (signal.aborted) return;
        report(`Minttitarkistus: ${error.message}`);
      }
      if (signal.aborted) return;
      if (policy.rugScore > 0) {
        const unchecked = [...tokens].filter(token => authority.get(token)?.allowed && !rug.has(token));
        for (const token of unchecked.slice(0, 2)) {
          try {
            const summary = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${token}/report/summary`, {}, signal);
            rug.set(token, { allowed: rugEligible(summary, policy.rugScore), expires: now + 300000 });
          } catch (error) {
            if (signal.aborted) return;
            // Cache a denied result briefly so failure of the first candidates doesn't starve the rest.
            rug.set(token, { allowed: false, expires: now + 60000 });
            report(`RugCheck: ${error.message}`);
          }
        }
      }
      if (signal.aborted) return;
      if (rules?.candles && ticks.length) {
        const tick = ticks[candleIndex++ % ticks.length];
        try {
          const history = await fetchCandles(tick, timeframe, signal);
          candles.set(positionKey(tick), history);
        } catch (error) {
          if (signal.aborted) return;
          report(`OHLCV: ${error.message}`);
        }
      }
      if (signal.aborted) return;
      let copyDirections;
      if (copyWallets?.length) {
        const batch = await copyGroup(copyWallets, tokens, cursors, Date.now(), signal);
        cursors = batch.cursors;
        copyDirections = batch.directions;
        for (const error of batch.failures) report(`Copy Trading: ${error.message}`);
      }
      if (signal.aborted) return;
      const signals = new Map();
      for (const tick of ticks) {
        const key = positionKey(tick);
        const history = [...(priceHistory.get(key) ?? []), tick.price].slice(-64);
        priceHistory.set(key, history);
        if (!rules && history.length >= 4) {
          new Float64Array(engine.memory.buffer, engine.sample_buffer(), history.length).set(history);
          signals.set(key, engine.entry(history.length, policy.strategy));
        }
      }
      const decide = (tick, book) => {
        const key = positionKey(tick);
        if (copyWallets?.length) return copyDirections?.get(tick.token) ?? 0;
        if (!rules) return signals.get(key) ?? 0;
        const seconds = timeframes[timeframe][2];
        const completed = (candles.get(key) ?? []).filter(c => c.time + seconds <= tick.at / 1000);
        const fresh = completed.length && tick.at / 1000 - completed.at(-1).time <= seconds * 3;
        return ruleSignal(rules, { engine, tick, book, candles: fresh ? completed : [], orderUsd: policy.orderUsd });
      };
      const decisionTime = Date.now();
      const freshTicks = ticks.filter(tick => decisionTime >= tick.at && decisionTime - tick.at <= maxTickAge);
      if (freshTicks.length < ticks.length) report("Vanhentuneet hinnat ohitettiin.");
      const portfolio = await commit(freshTicks, decide, token => authority.get(token)?.allowed === true &&
        (!(policy.rugScore > 0) || rug.get(token)?.allowed === true));
      if (signal.aborted) return;
      failures = 0;
      report(`Hinnat ${freshTicks.length}/${markets.length} · ${new Date().toLocaleTimeString("fi-FI")}`, portfolio, freshTicks);
    } catch (error) {
      if (signal.aborted) return;
      failures++;
      report(`Skannaus yrittää uudelleen: ${error.message}`);
    }
    await pause(Math.max(30000, policy.interval * 1000, Math.min(300000, 15000 * 2 ** failures)), signal);
  }
}
