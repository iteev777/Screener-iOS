// SPDX-License-Identifier: BUSL-1.1
import { address, aggregateCandles, discoverMarkets, fetchCandles, fetchTrojanCandles, normalizePair, timeframes } from "./markets.js";
import { currentMarket, fetchJson, rpcCall } from "./network.js";
import { applyPaperFill, orderFor } from "./policy.js";
import { ruleSignal } from "./rules.js";
import { copyGroup } from "./copy.js";
import { candidateQuality, trojanDecision } from "./trojan-analysis.js";
import { fullRugCheck } from "./trojan-security.js";
import { analyzeEntryRoute } from "./trojan-entry.js";
import { verifyPools } from "./trojan-pools.js";
import { CandidateQueue, marketBatch, sourcesFor, watchPumpPortal } from "./trojan-discovery.js";

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
    tick.at > (portfolio.lastScanAt ?? 0) &&
    (tick.observedAt === undefined || (Date.now() >= tick.observedAt && Date.now() - tick.observedAt <= maxTickAge)) &&
    (!tick.exitsOnly || portfolio.positions[positionKey(tick)]));
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
      const trojan = policy.strategy >= 5;
      const orderUsd = trojan ? Math.round(Math.min(5, policy.orderUsd, book.cash * .1) * 100) / 100 : policy.orderUsd;
      const executionPolicy = trojan ? { ...policy, orderUsd, lossUsd: Math.min(50, policy.lossUsd) } : policy;
      const order = orderFor(engine, decide(tick, book), book, tick, executionPolicy);
      if (exits && order?.side !== "Myynti") continue;
      if (!exits && order?.side === "Myynti") continue;
      const exposure = Object.values(portfolio.positions).reduce((sum, item) => sum + item.cost, 0);
      const duplicate = Object.entries(portfolio.positions).some(([other, item]) =>
        other !== key && item.market.token === tick.token);
      const positions = Object.values(portfolio.positions);
      const profileCount = trojan ? positions.filter(item => item.strategy === policy.strategy).length : 0;
      const profileAllowed = !trojan || (orderUsd >= 1 &&
        Boolean(position || (positions.length < 15 && profileCount < 10)));
      const buyAllowed = profileAllowed && eligible(tick.token) && Number.isFinite(tick.volume) && tick.volume >= (policy.scanMinVolume ?? 10000) && !duplicate &&
        (position || Object.keys(portfolio.positions).length < (policy.maxPools ?? scanLimit)) &&
        exposure + orderUsd <= policy.exposureUsd;
      if (order && (exits || (!tick.exitsOnly && buyAllowed &&
          (tick.routeExpires === undefined || Date.now() <= tick.routeExpires)))) {
        applyPaperFill(book, order, tick, executionPolicy);
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
        portfolio.positions[key] = { strategy: position?.strategy ?? policy.strategy, sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool,
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

// Technical confirmation follows Trojan V2 indicators.py and strategy.py.
export function technicalEntry(engine, candles) {
  const recent = candles.slice(-64);
  if (recent.length < 22) return true;
  function indicators(rows) {
    const closes = rows.map(candle => candle.close);
    new Float64Array(engine.memory.buffer, engine.sample_buffer(), closes.length).set(closes);
    return { rsi: engine.indicator(2, closes.length, 14),
      trend: Math.sign(engine.indicator(1, closes.length, 9) - engine.indicator(1, closes.length, 21)) };
  }
  const { rsi, trend } = indicators(recent);
  if (rsi < 25 || rsi > 80) return false;
  const prior = recent.slice(-21, -1);
  const volume = prior.reduce((sum, candle) => sum + candle.volume, 0) / 20;
  const last = recent.at(-1);
  const breakout = last.close > Math.max(...prior.map(candle => candle.high)) && volume > 0 && last.volume / volume >= 1.5;
  if (trend !== 1 && !breakout) return false;
  const trends = [trend];
  const minuteTimes = new Set(candles.map(candle => candle.time));
  for (const seconds of [180, 300, 900, 1800, 3600, 14400]) {
    const rows = aggregateCandles(candles, 60, seconds).filter(candle => {
      if (candle.time < candles[0].time || candle.time + seconds > last.time + 60) return false;
      for (let offset = 0; offset < seconds; offset += 60) {
        if (!minuteTimes.has(candle.time + offset)) return false;
      }
      return true;
    });
    if (rows.length >= 22) trends.push(indicators(rows).trend);
  }
  return trends.filter(t => t === -1).length <= trends.filter(t => t === 1).length;
}

export async function runScanner({ engine, policy, rules, timeframe, copyWallets, birdeyeKey,
    signal, load, commit, report, telemetry, event, jupiterKey, simulationWallet }) {
  const queue = new CandidateQueue();
  const sources = sourcesFor(birdeyeKey).map(source => ({ ...source, due: 0, failures: 0 }));
  const histories = new Map();
  const mintCache = new Map();
  const rugCache = new Map();
  const routeCache = new Map();
  let solQuote;
  let nextJupiter = 0;
  const publish = (mint, status, reason, score, quality) => {
    if (!signal.aborted) event?.({ at: Date.now(), mint, status, reason, score, quality });
  };
  const add = (tokens, source) => {
    const discovered = queue.add(tokens, source, Date.now());
    for (const token of discovered) publish(token, "found", source);
  };
  let cursors = new Map();
  let pump = "yhdistetään";
  let sourceError = "";
  let processing = 0;
  let routeBusy = false;
  let candleIndex = 0;
  const candles = new Map();
  let approvedTicks = [];
  let copySignals = new Map();
  let copyAt = 0;
  const usedPrices = new Map();
  const show = () => { if (!signal.aborted) telemetry?.({ ...queue.snapshot(Date.now()), processing, pump, sourceError }); };
  watchPumpPortal(signal, mint => add([mint], "PumpPortal"), status => {
    pump = status;
    show();
  });

  async function discover() {
    while (!signal.aborted) {
      const now = Date.now();
      const selected = sources.filter(source => source.due <= now)
        .sort((a, b) => a.due - b.due).slice(0, 2);
      await Promise.all(selected.map(async source => {
        try {
          const tokens = await source.load(signal);
          if (!signal.aborted) add(tokens, source.name);
          source.failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          sourceError = `${source.name}: ${error.message}`;
          source.failures++;
        } finally {
          source.due = Date.now() + Math.min(300000, source.interval * 2 ** Math.min(source.failures, 4));
        }
      }));
      show();
      await pause(1000, signal);
    }
  }

  async function analyze() {
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      const batch = queue.take(started);
      if (!batch.length) {
        show();
        await pause(500, signal);
        continue;
      }
      processing += batch.length;
      show();
      try {
        const markets = await marketBatch(batch.map(item => item.token), signal);
        if (signal.aborted) return;
        const now = Date.now();
        const ranked = batch.map(item => {
          const pair = markets.get(item.token);
          const quality = pair && candidateQuality(pair.raw, item.sources, now);
          const profile = policy.strategy === 6 ? "sniper" : "main";
          const strategy = policy.strategy >= 5 && pair
            ? trojanDecision(pair.raw, item.sources, profile, now) : null;
          const decision = !pair || (profile === "sniper" && !item.sources.has("PumpPortal")) ? "watch"
            : quality.tier === "reject" ? "reject" : strategy?.decision ?? "approve";
          return { item, pair, quality, decision, strategy };
        }).sort((a, b) => (b.quality?.score ?? 0) - (a.quality?.score ?? 0));
        for (const cache of [mintCache, rugCache, routeCache]) {
          for (const [token, value] of cache) if (value.expires <= now) cache.delete(token);
        }
        const possible = ranked.filter(row => row.decision === "approve");
        const needMint = possible.filter(row => !mintCache.has(row.item.token)).map(row => row.item.token);
        try {
          const checked = await scanMints(needMint, signal);
          if (signal.aborted) return;
          for (const token of needMint) mintCache.set(token, { ok: checked.get(token) === true, expires: now + 300000 });
        } catch (error) {
          sourceError = `Minttitarkistus: ${error.message}`;
        }
        const rugCeiling = policy.rugScore || (policy.strategy >= 5 ? 30 : 0);
        if (rugCeiling > 0 && !signal.aborted) {
          const needRug = possible.filter(({ item }) => mintCache.get(item.token)?.ok && !rugCache.has(item.token)).slice(0, 2);
          await Promise.all(needRug.map(async ({ item }) => {
            try {
              const suffix = policy.strategy >= 5 ? "report" : "report/summary";
              const raw = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${item.token}/${suffix}`, {}, signal);
              const check = policy.strategy >= 5 ? fullRugCheck(raw, { scoreLimit: rugCeiling }) : null;
              rugCache.set(item.token, { ok: check ? check.status === "approve" ? true :
                check.status === "watch" ? null : false : rugEligible(raw, rugCeiling),
                reason: check?.reasons.join("; ").slice(0, 200), expires: now + (check?.status === "watch" ? 30000 : 300000) });
            } catch (error) {
              rugCache.set(item.token, { ok: null, expires: now + 30000 });
              sourceError = `RugCheck: ${error.message}`;
            }
          }));
        }
        if (signal.aborted) return;
        if (policy.strategy >= 5 && !routeBusy && Date.now() >= nextJupiter) {
          const next = possible.find(({ item, pair }) => mintCache.get(item.token)?.ok &&
            rugCache.get(item.token)?.ok && !routeCache.has(positionKey(pair.market)));
          if (next) {
            const market = next.pair.market;
            routeBusy = true;
            try {
              const [pool] = await verifyPools([market], signal);
              if (pool.status !== "approve") {
                routeCache.set(positionKey(market), { ...pool, expires: Date.now() + 30000 });
              } else {
                if (!solQuote || Date.now() - solQuote.at > 15000) solQuote = await currentMarket(signal);
                const route = await analyzeEntryRoute(market.token, Math.min(5, policy.orderUsd), {
                  signal, solUsd: solQuote.price, apiKey: jupiterKey, taker: simulationWallet || undefined,
                  slippageBps: 100
                });
                routeCache.set(positionKey(market), { status: route.allowed ? "approve" : "reject",
                  reason: `${pool.protocol} · ${route.reason} (${route.score}/100)${route.simulation ? ` · simulaatio ${route.simulation}` : ""}`,
                  expires: Date.now() + (route.allowed ? 8000 : 30000) });
              }
            } catch (error) {
              routeCache.set(positionKey(market), { status: "watch", reason: error.message, expires: Date.now() + 15000 });
            } finally {
              nextJupiter = Date.now() + 2050;
              routeBusy = false;
            }
          }
        }
        if (signal.aborted) return;
        const candidates = [];
        for (const { item, pair, decision, quality, strategy } of ranked) {
          const authority = mintCache.get(item.token)?.ok;
          const report = rugCache.get(item.token);
          const rug = rugCeiling > 0 ? report?.ok : true;
          const route = pair && policy.strategy >= 5 ? routeCache.get(positionKey(pair.market)) : null;
          let checked = decision;
          let reason = strategy?.reason ?? (pair ? "Markkinadata tarkistettu" : "Poolin hintadata puuttuu");
          if (decision === "approve") {
            if (authority === false) { checked = "reject"; reason = "Mintin omistaja tai minttaus-/jäädytysvaltuus"; }
            else if (rug === false) { checked = "reject"; reason = report.reason || "RugCheck hylkäsi"; }
            else if (authority !== true || rug !== true) { checked = "watch"; reason = report?.reason || "Odotetaan turvallisuustarkistusta"; }
            else if (policy.strategy >= 5) {
              checked = route?.status === "unsupported" ? "watch" : route?.status ?? "watch";
              reason = route?.reason ?? "Odotetaan pooli- ja Jupiter-analyysiä";
            }
          } else if (quality?.tier === "reject") reason = "Virheellinen markkinadata";
          if (item.decision !== checked || item.reason !== reason) {
            publish(item.token, checked, reason, strategy?.score, quality?.score);
          }
          item.reason = reason;
          queue.finish(item, checked, pair?.raw, now);
          if (checked === "approve") {
            if (route) item.due = Math.min(item.due, route.expires);
            candidates.push({ ...pair.market, at: now, priority: item.priority, routeExpires: route?.expires });
          }
        }
        approvedTicks = [...candidates, ...approvedTicks.filter(tick => !batch.some(item => item.token === tick.token))]
          .filter(tick => now - tick.at <= maxTickAge)
          .sort((a, b) => b.priority - a.priority).slice(0, 120);
        failures = 0;
      } catch (error) {
        if (!signal.aborted) sourceError = `Analyysihaku: ${error.message}`;
        failures++;
      } finally {
        queue.release(batch, Date.now());
        processing -= batch.length;
        show();
      }
      await pause(failures ? Math.min(60000, 3000 * 2 ** Math.min(failures, 5)) : 500, signal);
    }
  }

  async function enrich() {
    if (!rules?.candles && !copyWallets?.length && policy.strategy < 5) return;
    while (!signal.aborted) {
      try {
        const current = universe(await load(), approvedTicks, policy.maxPools);
        if ((rules?.candles || policy.strategy >= 5) && current.length) {
          const stale = current.filter(tick => (candles.get(positionKey(tick))?.fetched ?? 0) + 30000 <= Date.now());
          if (stale.length) {
            const tick = stale[candleIndex++ % stale.length];
            const data = policy.strategy >= 5 ? await fetchTrojanCandles(tick, signal)
              : await fetchCandles(tick, timeframe, signal);
            if (!signal.aborted) candles.set(positionKey(tick), { data, fetched: Date.now() });
          }
        }
        if (copyWallets?.length && current.length) {
          const batch = await copyGroup(copyWallets, new Set(current.map(row => row.token)), cursors, Date.now(), signal);
          cursors = batch.cursors;
          copySignals = batch.directions;
          copyAt = Date.now();
          if (batch.failures.length) sourceError = `Copy Trading: ${batch.failures[0].message}`;
        }
      } catch (error) {
        if (!signal.aborted) sourceError = error.message;
      }
      await pause(copyWallets?.length ? 10000 : 5000, signal);
    }
  }

  async function positions() {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const portfolio = await load();
        const held = Object.values(portfolio.positions).map(position => position.market);
        const now = Date.now();
        const candidates = approvedTicks.filter(tick => now >= tick.at && now - tick.at <= maxTickAge &&
          (tick.routeExpires === undefined || now <= tick.routeExpires));
        for (const [key, at] of usedPrices) if (now - at > maxTickAge) usedPrices.delete(key);
        const limit = policy.maxPools ?? scanLimit;
        const selected = universe(portfolio, candidates, limit);
        const heldKeys = new Set(held.map(positionKey));
        const tracked = new Set(selected.map(positionKey));
        const candidateByPool = new Map(candidates.map(item => [positionKey(item), item]));
        const candidateTokens = new Set(candidates.map(item => item.token));
        const active = tracked;
        for (const cache of [histories, candles]) {
          for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
        }
        let prices = [];
        let priceError;
        try {
          prices = await scanPrices(held, signal);
        } catch (error) {
          priceError = error;
        }
        if (signal.aborted) return;
        const ticks = [...prices, ...candidates.filter(tick => tracked.has(positionKey(tick)) &&
          !heldKeys.has(positionKey(tick)) && usedPrices.get(positionKey(tick)) !== tick.at)];
        const at = Date.now();
        const fresh = ticks.filter(tick => at >= tick.at && at - tick.at <= maxTickAge);
        for (const tick of fresh) {
          const key = positionKey(tick);
          const previous = histories.get(key);
          if (previous?.at === tick.at) continue;
          histories.set(key, { at: tick.at, values: [...(previous?.values ?? []), tick.price].slice(-64) });
        }
        const decisions = new Map();
        if (!rules && !copyWallets?.length) {
          for (const tick of fresh) {
            const key = positionKey(tick);
            if (policy.strategy >= 5) {
              if (heldKeys.has(key) || !candidateByPool.has(key)) continue;
              const snapshot = candles.get(key);
              let technicalOk = true;
              if (snapshot) {
                const closed = snapshot.data.filter(c => c.time + 60 <= at / 1000);
                const last = closed.at(-1);
                if (last && at / 1000 - last.time <= 180) {
                  if (snapshot.lastTechnical !== last.time) {
                    snapshot.lastTechnical = last.time;
                    snapshot.technicalOk = technicalEntry(engine, closed);
                    if (!snapshot.technicalOk) publish(tick.token, "watch", "Tekninen moniaikavälivahvistus ei täyty");
                  }
                  technicalOk = snapshot.technicalOk;
                }
              }
              decisions.set(key, technicalOk ? 1 : 0);
              continue;
            }
            const values = histories.get(key).values;
            if (values.length >= 4) {
              new Float64Array(engine.memory.buffer, engine.sample_buffer(), values.length).set(values);
              decisions.set(key, engine.entry(values.length, policy.strategy));
            }
          }
        }
        // Risk exits use fresh prices immediately, independent of discovery/safety I/O.
        if (signal.aborted) return;
        const copy = Date.now() - copyAt <= 20000 ? copySignals : new Map();
        const updated = await commit(fresh.map(tick => ({
          ...tick, observedAt: tick.at, at,
          routeExpires: candidateByPool.get(positionKey(tick))?.routeExpires,
          exitsOnly: heldKeys.has(positionKey(tick)) && !candidateByPool.has(positionKey(tick))
        })), (tick, book) => {
          const key = positionKey(tick);
          if (copyWallets?.length) return copy.get(tick.token) ?? 0;
          if (rules) {
            const seconds = timeframes[timeframe][2];
            const completed = (candles.get(key)?.data ?? []).filter(candle => candle.time + seconds <= tick.at / 1000);
            const available = completed.length && tick.at / 1000 - completed.at(-1).time <= seconds * 3;
            return ruleSignal(rules, { engine, tick, book, candles: available ? completed : [], orderUsd: policy.orderUsd });
          }
          return decisions.get(key) ?? 0;
        }, token => candidateTokens.has(token));
        for (const tick of fresh) {
          if (!heldKeys.has(positionKey(tick)) && Object.hasOwn(updated.positions, positionKey(tick))) {
            usedPrices.set(positionKey(tick), tick.at);
          }
        }
        if (copy === copySignals && fresh.length) copySignals = new Map();
        if (signal.aborted) return;
        failures = priceError ? failures + 1 : 0;
        const message = priceError ? `Skannaus yrittää uudelleen: ${priceError.message}`
          : `Hinnat ${prices.length}/${held.length} avoimelle poolille`;
        report(message, updated, fresh);
      } catch (error) {
        if (signal.aborted) return;
        report(`Skannaus yrittää uudelleen: ${error.message}`);
        failures++;
      }
      await pause(failures ? Math.min(60000, 3000 * 2 ** Math.min(failures, 5)) : 3000, signal);
    }
  }

  await Promise.all([discover(), analyze(), analyze(), enrich(), positions()]);
}
