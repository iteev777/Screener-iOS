// SPDX-License-Identifier: BUSL-1.1
import { address, aggregateCandles, discoverMarkets, fetchCandles, fetchTrojanCandles, normalizePair, timeframes } from "./markets.js";
import { currentMarket, fetchJson, rpcCall } from "./network.js";
import { applyPaperFill, orderFor, reasons, strategySettings } from "./policy.js";
import { ruleSignal } from "./rules.js";
import { copyGroup } from "./copy.js";
import { analystWorker } from "./candidate-analyst.js";
import { marketTape, preferMarket, completeTape } from "./market-tape.js";
import { poolStream } from "./pool-stream.js";
import { momentumExit, momentumSize, shortMomentum, momentumSignal, earlyMomentum } from "./momentum.js";
import { fullRugCheck } from "./trojan-security.js";
import { analyzeEntryRoute } from "./trojan-entry.js";
import { verifyPools, verifyPoolReserves, estimateBinSwap, estimateTickSwap } from "./trojan-pools.js";
import { learnedScore, marketSegment, signalFeatures } from "./paper-signal-model.js";
import { paperLearning, scoreBand } from "./momentum-learning.js";
import { CandidateQueue, marketBatch, invalidateMarket, sourcesFor, watchPumpPortal } from "./trojan-discovery.js";

export const scanLimit = 12;
const batchLimit = 30;
const maxTickAge = 20000;
const paperExecutionDelay = 1000;
export const scanKey = "scan-portfolio";
const classicTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const day = at => Math.floor(at / 86400000);
export const positionKey = market => `${market.token}:${market.pool}`;

export function newPortfolio(capital = 1000) {
  return { cash: capital, initialCash: capital, realized: 0, positions: {}, trades: [], lossToday: 0 };
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

export function marketSnapshot(tick) {
  if (!tick) return undefined;
  const { price, liquidity, volume, volume5, volumeHour, transactions, change5, changeHour, marketCap, created, pool, name, symbol } = tick;
  return { price, liquidity, volume, volume5, volumeHour, transactions, change5, changeHour, marketCap, created, pool, name, symbol };
}

function recordDecision(portfolio, tick, state, reason) {
  portfolio.decisions ??= [];
  const last = portfolio.decisions.find(row => row.mint === tick.token);
  if (last?.state === state && last.reason === reason && tick.at - last.at < 60000) return;
  portfolio.decisions.unshift({ at: tick.at, mint: tick.token, status: state, state, reason,
    score: tick.score, market: marketSnapshot(tick) });
  portfolio.decisions.length = Math.min(200, portfolio.decisions.length);
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
      const previousTrade = position ? undefined : portfolio.trades.find(trade => trade.token === tick.token);
      const book = { sol: 0, cost: 0, lastTradeAt: previousTrade?.at, ...position, cash: portfolio.cash, realized: portfolio.realized,
        lossToday: portfolio.lossToday, lossDay: portfolio.lossDay, buyDay: portfolio.buyDay, buysToday: portfolio.buysToday, trades: [], count: 0 };
      const selectedStrategy = position?.strategy ?? tick.tradeStrategy ?? policy.strategy;
      const trojan = selectedStrategy >= 5;
      const momentum = selectedStrategy === 8;
      const profilePolicy = strategySettings(policy, selectedStrategy);
      const orderUsd = momentum ? momentumSize(book.cash, tick.score, tick.liquidity, {
        ...policy, momentumScore: scoreBand(policy.momentumScore, tick.scoreFloor), orderUsd: Math.min(policy.orderUsd, book.cash * (policy.balanceFraction ?? 10) / 100)
      }) : trojan ? Math.round(Math.min(profilePolicy.orderUsd, book.cash * (policy.balanceFraction ?? 10) / 100) * 100) / 100 : policy.orderUsd;
      const executionPolicy = trojan ? { ...profilePolicy, strategy: selectedStrategy, orderUsd, lossUsd: policy.lossUsd } : policy;
      const signal = tick.manual ? 0 : decide(tick, book);
      const order = position && tick.manual ? { side: "Myynti", sol: book.sol, reason: 10, detail: "Käyttäjä sulki paperiposition" }
        : position && momentum ? momentumExit(book, tick, executionPolicy)
        : orderFor(engine, signal, book, tick, executionPolicy);
      if (exits && order?.side !== "Myynti") continue;
      if (!exits && order?.side === "Myynti") continue;
      const exposure = Object.values(portfolio.positions).reduce((sum, item) => sum + item.cost, 0);
      const duplicate = Object.entries(portfolio.positions).some(([other, item]) =>
        other !== key && item.market.token === tick.token);
      const positions = Object.values(portfolio.positions);
      const profileCount = trojan ? positions.filter(item => item.strategy === selectedStrategy).length : 0;
      const profileAllowed = !trojan || (orderUsd >= 1 &&
        Boolean(position || (positions.length < (policy.maxTotalPositions ?? 15) && profileCount < (selectedStrategy === 6 ? policy.maxSniperPositions ?? 10 : policy.maxMainPositions ?? 10))));
      const afterPreviousTrade = !previousTrade || (tick.observedAt ?? tick.at) > previousTrade.at;
      const buyAllowed = afterPreviousTrade && orderUsd > 0 && profileAllowed && eligible(tick.token) && ((Number.isFinite(tick.volume) && tick.volume >= 0) ||
        (momentum && tick.track === "early" && tick.shortVolume > 0)) && !duplicate &&
        (position || Object.keys(portfolio.positions).length < (policy.maxPools ?? scanLimit)) &&
        exposure + (order?.usd ?? orderUsd) <= policy.exposureUsd;
      if (order && (exits || (!tick.exitsOnly && buyAllowed &&
          (tick.routeExpires === undefined || Date.now() <= tick.routeExpires)))) {
        order.detail ??= order.side === "Osto" ? tick.analysisReason ?? "Strategian ostosignaali" : undefined;
        applyPaperFill(book, order, tick, executionPolicy);
        portfolio.cash = book.cash;
        portfolio.realized = book.realized;
        portfolio.lossToday = book.lossToday;
        portfolio.buyDay = book.buyDay;
        portfolio.buysToday = book.buysToday;
        portfolio.totalTrades = (portfolio.totalTrades ?? portfolio.trades.length) + 1;
        const entry = position ? position.cost / position.sol : book.cost / book.sol;
        portfolio.trades.unshift({ ...book.trades[0], strategy: selectedStrategy, symbol: tick.symbol, token: tick.token, pool: tick.pool,
          track: tick.track ?? position?.track, segment:tick.segment ?? position?.segment, features:tick.features ?? position?.features, score: tick.score ?? position?.score, entryReason: position?.entryReason ?? tick.analysisReason,
          verification: tick.verification, market: marketSnapshot(tick), entryPrice: entry,
          peakReturn: Math.max(position?.peak ?? tick.price, tick.price) / entry - 1,
          worstReturn: Math.min(position?.worst ?? tick.price, tick.price) / entry - 1 });
        recordDecision(portfolio, tick, order.side === "Osto" ? "BUY" : book.sol > 0 ? "PARTIAL SELL" : "EXIT",
          order.detail ?? reasons[order.reason]);
        portfolio.trades.length = Math.min(portfolio.trades.length, 200);
      } else if (!exits && signal === 1 && !position) {
        const reason = !afterPreviousTrade ? "Hinta saatiin ennen edellistä kauppaa"
          : day(tick.at) === book.lossDay && book.lossToday >= policy.lossUsd ? "Päivän tappioraja"
          : day(tick.at) === book.buyDay && book.buysToday >= policy.maxDailyBuys ? "Päivän ostoraja"
          : previousTrade && tick.at < previousTrade.at + policy.cooldownSeconds * 1000 ? "Saman tokenin kauppajäähy"
          : !eligible(tick.token) ? "Oston turvallisuuskelpoisuus puuttuu"
          : tick.routeExpires != null && Date.now() > tick.routeExpires ? "Osto- ja myyntireitti vanheni"
          : !profileAllowed || positions.length >= (policy.maxPools ?? scanLimit) ? "Positioraja"
          : duplicate ? "Token on jo toisessa avoimessa poolissa"
          : tick.liquidity < executionPolicy.minLiquidity ? "Likviditeetin alaraja"
          : orderUsd <= 0 || book.cash < orderUsd ? "Kassa tai positiokoon alaraja"
          : exposure + (order?.usd ?? orderUsd) > policy.exposureUsd ? "Kokonaisaltistuksen raja"
          : "Oston markkina- tai kelpoisuustieto puuttuu";
        recordDecision(portfolio, tick, "REJECT", reason);
      } else if (position) recordDecision(portfolio, tick, "HOLD", "Poistumisehdot eivät täyty");
      if (book.sol > 0) {
        const { sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool, lastTradeAt } = book;
        portfolio.positions[key] = { strategy: selectedStrategy, sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool,
          name: tick.name ?? position?.name, track: tick.track ?? position?.track, segment:tick.segment ?? position?.segment, features:tick.features ?? position?.features, score: tick.score ?? position?.score,
          entryReason: position?.entryReason ?? tick.analysisReason,
          worst: Math.min(position?.worst ?? tick.price, tick.price),
          liquidity: tick.liquidity, change5: tick.change5, lastTradeAt, peak: Math.max(book.peak ?? tick.price, tick.price), mark: tick.price,
          lastTickAt: tick.at, market: { token: tick.token, pool: tick.pool, symbol: tick.symbol, quoteToken: tick.quoteToken ?? position?.market?.quoteToken } };
      } else if (position) {
        delete portfolio.positions[key];
      }
    }
  }
  if (input.length) {
    const at = portfolio.lastScanAt;
    const equity = portfolio.cash + Object.values(portfolio.positions).reduce((sum, position) => sum + position.sol * position.mark, 0);
    portfolio.history ??= [];
    if (at - (portfolio.history.at(-1)?.at ?? 0) >= 60000 || portfolio.trades[0]?.at === at) {
      portfolio.history.push({ at, equity });
      if (portfolio.history.length > 1440) portfolio.history.shift();
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
    signal, load, commit, report, telemetry, event, diagnostic, jupiterKey, simulationWallet, learningState, saveLearning }) {
  const queue = new CandidateQueue();
  const analyzeInWorker = analystWorker(signal);
  const scanProfile = policy.strategy === 6 ? "sniper" : undefined;
  const momentum = policy.strategy === 8;
  const tape = momentum ? marketTape(signal) : undefined;
  const learning = momentum ? paperLearning(learningState, policy) : undefined;
  let learnedTradeCount;
  let nextShadowSafety = 0;
  let calibration = learning?.calibration(policy.momentumScore, Date.now());
  const depthHistory = new Map();
  const threshold = track => calibration?.tracks[track].threshold ?? policy.momentumScore;
  const watched = new Map();
  const heldPools = new Set();
  let poolEventAt = 0;
  let streamWake;
  let approvalVersion = 0;
  function nextEntryAt(tick) {
    const ready = tick.signalAt + paperExecutionDelay;
    return Number.isFinite(ready) && ready < tick.routeExpires ? ready : Infinity;
  }
  let poolStatus = "odottaa poolia";
  const startPoolStream = momentum ? poolStream(signal, pool => {
    const row = watched.get(pool);
    const now = Date.now();
    if (row && now - row.last >= 4500) {
      row.last = now;
      invalidateMarket(row.item.token, signal, now);
      wake(row.item, 100);
    }
    if (heldPools.has(pool) && now - poolEventAt >= 1500) {
      poolEventAt = now;
      streamWake?.();
    }
  }, status => { poolStatus = status; }) : () => {};
  const sources = sourcesFor(birdeyeKey, tape).map(source => ({ ...source, due: 0, failures: 0 }));
  const histories = new Map();
  const mintCache = new Map();
  const rugCache = new Map();
  const routeCache = new Map();
  let solQuote;
  let nextJupiter = 0;
  let nextQuote = 0;
  async function requestQuote(work) {
    while (!signal.aborted && Date.now() < nextQuote) await pause(nextQuote - Date.now(), signal);
    signal.throwIfAborted();
    nextQuote = Date.now() + 1100;
    try { return await work(); }
    catch (error) {
      if (error.status === 429) nextQuote = Math.max(nextQuote, Date.now() + Math.max(60000, error.retryAfterMs ?? 0));
      throw error;
    }
  }
  const publish = (mint, status, reason, score, quality, market) => {
    if (signal.aborted) return;
    const at = Date.now();
    if (status === "found") recent.found.push(at);
    if (status === "approve") recent.signals.push(at);
    if (status === "watch" || status === "reject") {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (reasons.size > 100) reasons.delete(reasons.keys().next().value);
    }
    event?.({ at, mint, status, reason, score, quality, market });
  };
  const add = (tokens, source) => {
    const discovered = queue.add(tokens, source, Date.now());
    for (const token of discovered) publish(token, "found", source, undefined, undefined, marketSnapshot(queue.sniperItems.get(token) ?? queue.items.get(token)));
  };
  let cursors = new Map();
  let pump = "yhdistetään";
  let sourceError = "";
  let processing = 0;
  const routePending=new Set();
  const marketRanks = new WeakMap();
  let routeActive=0, routeLimit=2;
  const sellPoolCache=new Map(), sellPoolPending=new Set();
  const poolCache=new Map(), poolPending=new Set(), rugPending=new Set(), mintPending=new Set();
  let poolActive=0;
  let activeWorkers = 0;
  const workerLimit = Math.max(1, Math.min(24, Math.floor(policy.analysisWorkers ?? 24)));
  let adaptiveLimit = Math.min(4, workerLimit);
  let marketCooldown = 0;
  let dexRetryAt = 0;
  let nextMarketRequest = 0;
  let lastScale = 0;
  let rugActive = 0;
  let rugCooldown = 0;
  let analysisMs = 0;
  let analysisTotal = 0;
  let discoveryMs = 0;
  let discoverySamples = 0;
  let lastTelemetry = 0;
  let tradeCount = 0;
  let lastFillAt = 0;
  let lastFill = "";
  let peakWorkers = 0;
  const recent = { found: [], analyzed: [], signals: [] };
  const reasons = new Map();
  let candleIndex = 0;
  const candles = new Map();
  let approvedTicks = [];
  let copySignals = new Map();
  let copyAt = 0;
  const usedPrices = new Map();
  const show = () => {
    const at = Date.now();
    if (signal.aborted || at - lastTelemetry < 1000) return;
    lastTelemetry = at;
    for (const key of Object.keys(recent)) recent[key] = recent[key].filter(time => time > at - 60000);
    telemetry?.({ ...queue.snapshot(at, scanProfile), processing, activeWorkers, peakWorkers, workerLimit, adaptiveLimit,
      foundPerMinute: recent.found.length, analyzedPerMinute: recent.analyzed.length, signalsPerMinute: recent.signals.length,
      analysisTotal, averageAnalysisMs: Math.round(analysisMs / (analysisTotal || 1)),
      averageDiscoveryMs: Math.round(discoveryMs / (discoverySamples || 1)), tradeCount, lastFill,
      pump, sourceError, learning: calibration, reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8),
      sources: sources.map(source => ({ name: source.name, count: source.count, busy: Boolean(source.busy), error: source.error })),
      apis: { "Pool WebSocket": poolStatus, "DEX": at < Math.max(dexRetryAt, marketCooldown) ? "Tauolla" : "Valmis", "RugCheck": at < rugCooldown ? "Tauolla" : rugActive ? "Haetaan" : "Valmis",
        "Solana RPC": mintPending.size || poolPending.size ? "Tarkistetaan" : "Valmis", "Jupiter": routeActive ? "Haetaan" : "Valmis" }
    });
  };
  watchPumpPortal(signal, mint => add([mint], "PumpPortal"), status => {
    pump = status;
    show();
  }, momentum ? mint => {
    add([mint], "PumpPortal");
    const item = queue.sniperItems.get(mint) ?? queue.items.get(mint);
    if (item) wake(item, 100);
    diagnostic?.({ token: mint, stage: "stream", outcome: "migration" });
  } : undefined);

  async function discover() {
    while (!signal.aborted) {
      const now = Date.now();
      const selected = sources.filter(source => !source.busy && source.due <= now)
        .sort((a, b) => a.due - b.due).slice(0, 9 - sources.filter(s => s.busy).length);
      for (const source of selected) {
        source.busy = true;
        void (async () => {
        try {
          const tokens = await source.load(signal);
          if (!signal.aborted) {
            // Large general catalogs are fallbacks, behind the transactional discovery feeds.
            const admitted = source.interval >= 3600000 ? tokens.slice(0, 60) : tokens;
            add(admitted, source.name);
          }
          source.failures = 0;
          source.count = tokens.length;
          source.error = "";
        } catch (error) {
          if (signal.aborted) return;
          sourceError = `${source.name}: ${error.message}`;
          source.failures++;
          source.error = error.message;
          source.retryAt = Date.now() + (error.retryAfterMs ?? 0);
        } finally {
          source.due = Date.now() + Math.min(Math.max(300000, source.interval), source.interval * 2 ** Math.min(source.failures, 4));
          source.due = Math.max(source.due, source.retryAt ?? 0);
          if (!source.failures) source.due = Date.now() + source.interval;
          source.busy = false;
          show();
        }
        })();
      }
      show();
      await pause(1000, signal);
    }
  }

  async function pricesWithFallback(markets) {
    if (!tape || !markets.length) return scanPrices(markets, signal);
    let prices = [];
    let failure;
    try { prices = await scanPrices(markets, signal); }
    catch (error) { failure = error; }
    const found = new Set(prices.map(positionKey));
    const missing = markets.filter(market => !found.has(positionKey(market)));
    try { prices.push(...await tape.poolPrices(missing)); }
    catch (error) { failure ??= error; }
    if (!prices.length && failure) throw failure;
    return prices;
  }

  const wake = (item, delay = 500) => {
    if (signal.aborted) return;
    const due = Date.now() + delay;
    if (item.inFlight) item.wakeAt = Math.min(item.wakeAt ?? Infinity, due);
    else item.due = Math.min(item.due, due);
  };

  async function analyzeBatch(batch, started) {
    try {
      let markets = new Map();
      try {
        if (Date.now() >= dexRetryAt) markets = await marketBatch(batch.map(item => item.token), signal);
      }
      catch (error) {
        if (!tape || signal.aborted) throw error;
        markets = new Map();
        sourceError = `DEX: ${error.message}`;
        if (error.status === 429) dexRetryAt = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
      }
      if (signal.aborted) return;
      const now = Date.now();
      if (tape) {
        for (const item of batch) {
          const primary = markets.get(item.token);
          const alternate = preferMarket(primary, tape.get(item.token), now);
          if (alternate) {
            markets.set(item.token, alternate);
            learning.mark(alternate.market, alternate.observedAt);
          }
        }
        const needsData = batch.find(item => tape.canRefresh(item.token) && !completeTape(markets.get(item.token)) &&
          (item.sources.has("PumpPortal") || item.sources.size >= 2 || markets.has(item.token)));
        if (needsData) void tape.refresh(needsData.token).then(() => {
          if (Date.now() - (tape.get(needsData.token)?.observedAt ?? 0) < 2000) wake(needsData);
        }).catch(error => { if (!signal.aborted) sourceError = `GeckoTerminal: ${error.message}`; });
      }
      const inputs = batch.map(item => ({
        token: item.token, raw: markets.get(item.token)?.raw, sources: [...item.sources]
      }));
      const missing = [];
      const scores = new Map();
      for (const input of inputs) {
        const saved = input.raw && marketRanks.get(input.raw);
        if (saved?.sources === input.sources.join() && now - saved.at < 4000) scores.set(input.token, saved.rank);
        else missing.push(input);
      }
      const rankedNew = missing.length ? await analyzeInWorker(missing, policy, now) : [];
      for (const [index, rank] of rankedNew.entries()) {
        const { raw, sources } = missing[index];
        scores.set(rank.token, rank);
        if (raw) marketRanks.set(raw, { at: now, sources: sources.join(), rank });
      }
      const ranked = batch.filter(item => scores.has(item.token)).map(item => ({
        ...scores.get(item.token), item, pair: markets.get(item.token)
      })).sort((a, b) => (b.quality?.score ?? 0) - (a.quality?.score ?? 0));
      if (signal.aborted) return;
      let shadowCandidate;
      for (const cache of [mintCache, rugCache, routeCache]) {
        for (const [token, value] of cache) if (value.expires <= now) cache.delete(token);
      }
      if (momentum) {
        const promising = ranked.filter(row => row.pair && row.quality?.tier !== "reject" &&
          row.decision !== "reject" && row.pair.market.liquidity >= policy.minLiquidity);
        const target = promising.filter(row => tape.canTrade(row.pair.market.pool, row.item.token, now))
          .sort((a, b) => {
            const priority = row => {
              const age = now - row.pair.market.created;
              return row.quality.score + (age >= 0 && age < 600000 ? 25 : 0);
            };
            return priority(b) - priority(a);
          })[0];
        if (target) void tape.refreshTrades(target.pair.market.pool, target.item.token).then(changed => {
          if (changed) wake(target.item);
        }).catch(error => { if (!signal.aborted) sourceError = `Trade tape: ${error.message}`; });
        for (const row of promising) {
          const { market, observedAt } = row.pair;
          const position = positionKey(market);
          const previous = depthHistory.get(position);
          if (!previous || observedAt > previous.at) {
            depthHistory.set(position, { at: observedAt, liquidity: market.liquidity,
              previous: previous && observedAt - previous.at <= 30000 ? previous.liquidity : undefined });
          }
          const depth = depthHistory.get(position);
          const windows = shortMomentum(tape.trades(market.pool, market.token), now);
          const segment = marketSegment(market, now);
          const withEvidence = (strategy, track, structural, window) => {
            const features = signalFeatures(market, window);
            const score = structural ? learnedScore(calibration?.weights,track,segment,features,strategy.score) : strategy.score;
            const scoreFloor = threshold(track);
            const decision = structural ? score >= scoreFloor ? "approve" : "watch" : strategy.decision;
            return { ...strategy, decision, code: structural && decision === "watch" ? "score" : strategy.code,
              score, track, scoreFloor, segment, features };
          };
          const rolling = withEvidence(row.strategy, "rolling", ["score","signal"].includes(row.strategy.code));
          const shortSignal = momentumSignal(windows,row.quality.score,threshold("short"));
          const short = withEvidence({ ...shortSignal, reason:"Lyhyen aikavälin momentum" }, "short", shortSignal.structural, windows[15]);
          const earlySignal = earlyMomentum(windows,market,row.quality.score,threshold("early"),policy,depth?.previous);
          const early = withEvidence({ ...earlySignal, shortVolume:windows[15]?.volume }, "early",
            earlySignal.code === "early-flow" || earlySignal.code === "score", windows[15]);
          const options = [rolling, short, early];
          const weakFlow = rolling.code === "buy-pressure" && Number.isFinite(market.transactions?.m5?.buys) &&
            market.transactions.m5.buys < market.transactions.m5.sells;
          const calibrated = options.filter(pick => pick.decision === "approve" && (pick.track === "rolling" || !weakFlow))
            .sort((a,b) => (b.score - b.scoreFloor) - (a.score - a.scoreFloor))[0];
          row.strategy = calibrated ?? rolling;
          row.decision = row.strategy.decision ?? row.decision;
          const observation = calibrated ?? options.find(pick => pick.code === "score" && Number.isFinite(pick.score)) ??
            options.find(pick => Number.isFinite(pick.score) && pick.score > 0);
          if (observation) {
            const measurable = observation.code === "score" || observation.decision === "approve";
            const safe = mintCache.get(market.token)?.ok === true && rugCache.get(market.token)?.ok === true;
            learning.observe(market, observedAt, observation.track, observation.score, measurable && !weakFlow, safe,
              {features:observation.features, segment:observation.segment, missed:!calibrated});
            if (measurable && !weakFlow) learning.proveSafety(market, safe);
            if (now >= nextShadowSafety && !shadowCandidate && !weakFlow && !safe &&
                observation.code === "score" && observation.score >= policy.momentumScore - 8 &&
                mintCache.get(market.token)?.ok !== false && rugCache.get(market.token)?.ok !== false) {
              shadowCandidate = row;
            }
          }
          if (!calibrated && ["missing-tape","missing-flow","thin-flow","missing-baseline"].includes(rolling.code) &&
              early.code !== "short-data") {
            row.strategy = early;
          }
        }
        while (depthHistory.size > 500) depthHistory.delete(depthHistory.keys().next().value);
        for (const row of ranked) {
          if (!row.pair || !(row.decision === "approve" || row.strategy?.code === "score" ||
              (row.decision === "watch" && row.quality?.score >= 45 && row.item.sources.has("PumpPortal")))) continue;
          const pool = row.pair.market.pool;
          const previous = watched.get(pool);
          watched.delete(pool);
          watched.set(pool, { item: row.item, last: previous?.last ?? 0, seen: now });
        }
        for (const [pool, row] of watched) if (now - row.seen > 30000) watched.delete(pool);
        while (watched.size > 24) watched.delete(watched.keys().next().value);
        startPoolStream([...heldPools, ...[...watched.keys()].reverse()]);
      }
      if (momentum) for (const row of ranked) {
        if (row.decision === "approve" && row.pair.market.liquidity < policy.minLiquidity) {
          row.decision = "watch";
          row.strategy = { ...row.strategy, code: "liquidity-floor", reason: "Poolin likviditeetti alittaa riskirajan" };
        }
      }
      const possible = ranked.filter(row => row.decision === "approve").sort((a,b)=>((b.strategy?.score??0)+(b.profile==="sniper"?12:0))-((a.strategy?.score??0)+(a.profile==="sniper"?12:0)));
      if (shadowCandidate) nextShadowSafety = now + 20000;
      const verificationCandidates = shadowCandidate && !possible.includes(shadowCandidate)
        ? [...possible, shadowCandidate] : possible;
      for(const [key,value] of poolCache)if(value.expires<=Date.now())poolCache.delete(key);
      const poolJobs=policy.strategy>=5?possible.filter(({pair, item})=> (!momentum || (mintCache.get(item.token)?.ok && rugCache.get(item.token)?.ok)) && !poolCache.has(positionKey(pair.market))&&!poolPending.has(positionKey(pair.market))).slice(0,Math.max(0,2-poolActive)):[];
      void Promise.all(poolJobs.map(async ({pair, item})=>{
        const market=pair.market,key=positionKey(market);poolPending.add(key);poolActive++;
        try{let [pool]=await verifyPools([market],signal);if(pool.status==="approve")pool={...pool,...await verifyPoolReserves(market,signal)};poolCache.set(key,{...pool,expires:Date.now()+8000});}
        catch(error){poolCache.set(key,{status:"watch",reason:error.message,expires:Date.now()+5000});}
        finally{poolPending.delete(key);poolActive--; if (poolCache.get(key)?.status === "approve") wake(item);}
      }));
      const needMint = verificationCandidates.filter(row => !mintCache.has(row.item.token)&&!mintPending.has(row.item.token)).map(row => row.item.token);
      for(const token of needMint)mintPending.add(token);
      void (async()=>{try {
        if(!needMint.length)return;
        const checked = await scanMints(needMint, signal);
        if (signal.aborted) return;
        for (const token of needMint) mintCache.set(token, { ok: checked.get(token) === true, expires: Date.now() + 300000 });
        for (const { item } of verificationCandidates) if (needMint.includes(item.token)) wake(item);
      } catch (error) {
        sourceError = `Minttitarkistus: ${error.message}`;
      }finally{for(const token of needMint)mintPending.delete(token);}})();
      const rugCeiling = policy.rugScore || (policy.strategy >= 5 ? 30 : 0);
      if (rugCeiling > 0 && !signal.aborted && Date.now() >= rugCooldown) {
        const needRug = verificationCandidates.filter(({ item }) => !rugCache.has(item.token) && !rugPending.has(item.token)).slice(0, Math.max(0, Math.min(2, 4 - rugActive)));
        rugActive += needRug.length;
        void Promise.all(needRug.map(async ({ item }) => {
          rugPending.add(item.token);
          try {
            const suffix = policy.strategy >= 5 ? "report" : "report/summary";
            const raw = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${item.token}/${suffix}`, {}, signal);
            const check = policy.strategy >= 5 ? fullRugCheck(raw, { scoreLimit: rugCeiling }) : null;
            rugCache.set(item.token, { ok: check ? check.status === "approve" ? true :
              check.status === "watch" ? null : false : rugEligible(raw, rugCeiling),
              reason: check?.reasons.join("; ").slice(0, 200), expires: Date.now() + (check?.status === "watch" ? 30000 : 300000) });
            if (check?.status !== "watch") wake(item);
          } catch (error) {
            rugCache.set(item.token, { ok: null, expires: now + 30000 });
            sourceError = `RugCheck: ${error.message}`;
            if (error.status === 429) rugCooldown = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
          } finally { rugActive--; rugPending.delete(item.token); }
        }));
      }
      if (signal.aborted) return;
      if (policy.strategy >= 5 && routeActive < routeLimit && Date.now() >= nextJupiter) {
        const next = possible.find(({ item, pair }) => mintCache.get(item.token)?.ok &&
          rugCache.get(item.token)?.ok && poolCache.get(positionKey(pair.market))?.expires>Date.now() && !routeCache.has(positionKey(pair.market)) && !routePending.has(positionKey(pair.market)));
        if (next) {
          const market = next.pair.market;
          const routeKey=positionKey(market);
          routePending.add(routeKey);routeActive++;
          nextJupiter=Date.now()+2050;
          void (async () => {
          try {
            const pool = poolCache.get(positionKey(market));
            if(!pool || pool.expires<=Date.now())throw new Error("Poolitarkistus vanhentui");
            if (pool.status !== "approve") {
              routeCache.set(positionKey(market), { ...pool, stage: "pool", expires: Date.now() + 30000 });
            } else {
              if (!solQuote || Date.now() - solQuote.at > 15000) solQuote = await currentMarket(signal);
              const orderUsd = policy.strategy === 8 ? Math.min(policy.momentumMaxUsd, policy.orderUsd)
                : strategySettings(policy, next.profile === "sniper" ? 6 : 5).orderUsd;
              const depth = assessEntryDepth(pool,market,orderUsd,solQuote.price,policy[next.profile+"MaxImpact"]??5);
              if(depth.status==="reject"||depth.status==="watch"){
                routeCache.set(positionKey(market),{...depth,stage:"pool",expires:Date.now()+15000});
              } else {
              const route = await analyzeEntryRoute(market.token, orderUsd, {
                signal, solUsd: solQuote.price, apiKey: jupiterKey, taker: simulationWallet || undefined,
                slippageBps: 100, checkExit: policy.strategy === 8, requestQuote
              });
              routeCache.set(positionKey(market), { status: route.allowed ? "approve" : "reject",
                entryImpactPct: route.impact,
                reason: `${pool.protocol} · ${depth.reason} · ${route.reason} (${route.score}/100)${route.simulation ? ` · simulaatio ${route.simulation}` : ""}`,
                checkedAt: Date.now(), expires: Date.now() + (route.allowed ? 8000 : 30000) });
              }
            }
          } catch (error) {
            if(error.status===429 || /429|rate limit/i.test(error.message)){routeLimit=1;nextJupiter=Math.max(nextJupiter,Date.now()+Math.max(60000, error.retryAfterMs ?? 0));}
            routeCache.set(positionKey(market), { status: "watch", reason: error.message, expires: Date.now() + 15000 });
          } finally {
            routePending.delete(routeKey);routeActive--;
            wake(next.item);
          }
          })();
        }
      }
      if (signal.aborted) return;
      const candidates = [];
      for (const { item, pair, decision, quality, strategy, profile } of ranked) {
        const authority = mintCache.get(item.token)?.ok;
        const report = rugCache.get(item.token);
        const rug = rugCeiling > 0 ? report?.ok : true;
        const cachedRoute = pair && policy.strategy >= 5 ? routeCache.get(positionKey(pair.market)) : null;
        const route = cachedRoute?.expires > Date.now() ? cachedRoute : null;
        let checked = decision;
        let stage = strategy?.code === "liquidity-floor" ? "liquidity" : pair ? "momentum" : "market";
        let reason = strategy?.reason ?? (pair ? "Markkinadata tarkistettu"
          : tape?.get(item.token) ? "Viimeisin poolin noteeraus vanheni" : "Poolin hintadata puuttuu");
        if (decision === "approve") {
          if (authority === false) { stage = "mint"; checked = "reject"; reason = "Mintin omistaja tai minttaus-/jäädytysvaltuus"; }
          else if (rug === false) { stage = "rug"; checked = "reject"; reason = report.reason || "RugCheck hylkäsi"; }
          else if (authority !== true || rug !== true) { stage = authority !== true ? "mint" : "rug"; checked = "watch"; reason = report?.reason || "Odotetaan turvallisuustarkistusta"; }
          else if (policy.strategy >= 5) {
            const pool = poolCache.get(positionKey(pair.market));
            stage = route ? (route.stage ?? (route.status === "approve" ? "eligible" : "route")) : pool?.status === "approve" ? "route" : "pool";
            checked = route?.status === "unsupported" ? "watch" : route?.status ?? "watch";
            reason = route?.reason ?? (pool?.status !== "approve" && pool?.reason) ?? "Odotetaan pooli- ja Jupiter-analyysiä";
            if (reason === false) reason = "Odotetaan Jupiter-tarjousta";
          }
        } else if (quality?.tier === "reject") reason = "Virheellinen markkinadata";
        if (momentum) diagnostic?.({ token: item.token, stage, outcome: checked, reason,
          strategyCode: strategy?.code, track: strategy?.track, score: strategy?.score, provider: pair?.provider ?? (pair ? "DEX Screener" : null) });
        if (!item.attempts) {
          discoverySamples++;
          discoveryMs += Date.now() - item.seen;
        }
        analysisTotal++;
        analysisMs += Date.now() - started;
        recent.analyzed.push(Date.now());
        if (item.decision !== checked || item.reason !== reason) {
          publish(item.token, checked, reason, strategy?.score, quality?.score, marketSnapshot(pair?.market));
        }
        const sameReason = item.reason === reason;
        item.reason = reason;
        const retryDelay = momentum && checked === "watch" && stage === "market"
          ? Math.min(45000, (item.sources.has("PumpPortal") ? 5000 : 10000) *
            2 ** Math.min(sameReason ? item.streak ?? 0 : 0, 3))
          : undefined;
        queue.finish(item, checked, pair?.raw, now, retryDelay);
        if (decision === "approve" && checked === "watch" && authority === true && rug === true &&
            !route && !routePending.has(positionKey(pair.market)) && poolCache.get(positionKey(pair.market))?.status === "approve") {
          item.due = Math.min(item.due, Math.max(Date.now() + 500, nextJupiter));
        }
        if (checked === "approve") {
          if (route) item.due = Math.min(item.due, route.expires);
          candidates.push({ ...pair.market, score: strategy?.score, scoreFloor: strategy?.scoreFloor, track: strategy?.track, segment:strategy?.segment, features:strategy?.features, shortVolume: strategy?.shortVolume, analysisReason: strategy?.reason, verification: reason, tradeStrategy: policy.strategy === 8 ? 8 : policy.strategy >= 5 ? (profile === "sniper" ? 6 : 5) : policy.strategy, at: pair.observedAt, priority: item.priority, routeExpires: route?.expires, signalAt: route?.checkedAt, entryImpactPct: route?.entryImpactPct });
        }
      }
      const previousApproval = new Map(approvedTicks.map(tick => [positionKey(tick), tick.signalAt]));
      approvedTicks = [...candidates, ...approvedTicks.filter(tick => !batch.some(item => item.token === tick.token))]
        .filter(tick => now - tick.at <= maxTickAge)
        .sort((a, b) => b.priority - a.priority).slice(0, 120);
      if (momentum && candidates.some(tick => previousApproval.get(positionKey(tick)) !== tick.signalAt)) {
        approvalVersion++;
        streamWake?.();
      }
    } catch (error) {
      if (!signal.aborted) {
        sourceError = `Analyysihaku: ${error.message}`;
        adaptiveLimit = Math.max(1, Math.floor(adaptiveLimit / 2));
        marketCooldown = Date.now() + (error.status === 429 ? Math.max(60000, error.retryAfterMs ?? 0) : 3000);
      }
    } finally {
      queue.release(batch, Date.now());
      processing -= batch.length;
      activeWorkers--;
      show();
    }
  }

  async function analyze() {
    const pending = new Set();
    const availableCores = globalThis.navigator?.hardwareConcurrency ?? 4;
    const deviceLimit = Math.min(workerLimit, Math.max(4, availableCores * 4));
    while (!signal.aborted) {
      const now = Date.now();
      if (now - lastScale >= 5000 && now >= marketCooldown) {
        lastScale = now;
        const demand = Math.max(1, Math.ceil(queue.snapshot(now, scanProfile).queued / batchLimit) + activeWorkers);
        adaptiveLimit = Math.min(deviceLimit, demand, adaptiveLimit + 1);
      }
      if (activeWorkers < adaptiveLimit && now >= marketCooldown && now >= nextMarketRequest) {
        const batch = queue.take(now, scanProfile);
        if (batch.length) {
          nextMarketRequest = now + 350;
          processing += batch.length;
          activeWorkers++;
          peakWorkers = Math.max(peakWorkers, activeWorkers);
          const task = analyzeBatch(batch, now).finally(() => pending.delete(task));
          pending.add(task);
        }
      }
      show();
      await pause(pending.size ? 125 : 250, signal);
    }
    await Promise.allSettled(pending);
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
      const cycleApproval = approvalVersion;
      try {
        const portfolio = await load();
        const held = Object.values(portfolio.positions).map(position => position.market);
        heldPools.clear();
        for (const market of held) heldPools.add(market.pool);
        if (momentum) startPoolStream([...heldPools, ...[...watched.keys()].reverse()]);
        for(const [key,value] of sellPoolCache)if(value.expires<=Date.now())sellPoolCache.delete(key);
        for(const market of held.filter(m=>m.quoteToken&&!sellPoolCache.has(positionKey(m))&&!sellPoolPending.has(positionKey(m))).slice(0,Math.max(0,2-sellPoolPending.size))){
          const key=positionKey(market);sellPoolPending.add(key);
          void verifyPoolReserves(market,signal).then(pool=>{if(!signal.aborted)sellPoolCache.set(key,{...pool,expires:Date.now()+8000});}).catch(()=>{if(!signal.aborted)sellPoolCache.set(key,{expires:Date.now()+10000});}).finally(()=>sellPoolPending.delete(key));
        }
        const now = Date.now();
        const candidates = approvedTicks.filter(tick => now >= tick.at && now - tick.at <= maxTickAge &&
          (tick.routeExpires === undefined || now <= tick.routeExpires));
        for (const [key, at] of usedPrices) if (now - at > maxTickAge) usedPrices.delete(key);
        const limit = policy.maxPools ?? scanLimit;

        const candidateByPool = new Map(candidates.map(item => [positionKey(item), item]));
        const candidateTokens = new Set(candidates.map(item => item.token));

        let prices = [];
        let priceError;
        try {
          prices = await pricesWithFallback(held);
        } catch (error) {
          priceError = error;
        }
        if (signal.aborted) return;
        if (tape && prices.length) {
          const now = Date.now();
          const next = prices.find(tick => tape.canTrade(tick.pool, tick.token, now));
          if (next) void tape.refreshTrades(next.pool, next.token).then(changed => {
            if (changed) streamWake?.();
          }).catch(error => { if (!signal.aborted) sourceError = `Position kauppavirta: ${error.message}`; });
          for (const tick of prices) {
            tick.shortWindow = shortMomentum(tape.trades(tick.pool,tick.token), now)[15];
          }
        }
        // Prioritize risk exits before computing candidate indicators.
        let exitBook;
        if(prices.length && policy.strategy>=5 && !rules && !copyWallets?.length){
          const exitAt = Math.max(Date.now(), (portfolio.lastScanAt ?? 0) + 1);
          exitBook = await commit(prices.filter(t=>exitAt>=t.at&&exitAt-t.at<=maxTickAge).map(t=>({...t,sellPool:sellPoolCache.get(positionKey(t)),observedAt:t.at,at:exitAt,exitsOnly:true})),()=>0,()=>false);
        }
        // Recompute available slots after risk exits so a different token can use the freed capital in this cycle.
        const currentBook = exitBook ?? portfolio;
        const heldKeys = new Set(Object.keys(currentBook.positions));
        const tracked = new Set(universe(currentBook, candidates, limit).map(positionKey));
        for (const cache of [histories, candles]) {
          for (const key of cache.keys()) if (!tracked.has(key)) cache.delete(key);
        }
        const justExited = new Set(held.filter(market => !heldKeys.has(positionKey(market))).map(market => market.token));
        const ticks = [...(policy.strategy>=5&&!rules&&!copyWallets?.length?[]:prices), ...candidates.filter(tick => tracked.has(positionKey(tick)) &&
          !heldKeys.has(positionKey(tick)) && !justExited.has(tick.token) && usedPrices.get(positionKey(tick)) !== tick.at)];
        if (momentum && ticks.length) {
          const entries = ticks.filter(tick => Date.now() >= nextEntryAt(tick) && Date.now() < tick.routeExpires);
          ticks.length = 0;
          if (entries.length) {
            try {
              const refreshed = await pricesWithFallback(entries);
              const byKey = new Map(refreshed.map(tick => [positionKey(tick), tick]));
              for (const signalTick of entries) {
                const current = byKey.get(positionKey(signalTick));
                if (current && current.price <= signalTick.price * 1.01 && current.price >= signalTick.price * .97 && current.at <= signalTick.routeExpires) {
                  ticks.push({ ...signalTick, ...current });
                } else diagnostic?.({ token: signalTick.token, stage: "execution", outcome: "watch",
                  reason: !current ? "Tuore toteutushinta puuttuu" : current.at > signalTick.routeExpires
                    ? "Jupiter-reitti vanheni hintahaun aikana" : "Hinta muuttui liikaa ennen toteutusta" });
              }
            } catch (error) {
              if (!signal.aborted) sourceError = `Toteutushinta: ${error.message}`;
            }
          }
        }
        const at = Math.max(Date.now(), (exitBook?.lastScanAt ?? portfolio.lastScanAt ?? 0) + 1);
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
        for (const tick of fresh) if (momentum && decisions.get(positionKey(tick)) === 0) {
          diagnostic?.({ token: tick.token, stage: "technical", outcome: "watch", reason: "Moniaikavälivahvistus" });
        }
        const updated = await commit(fresh.map(tick => ({
          ...tick, observedAt: tick.at, at,
          tradeStrategy: candidateByPool.get(positionKey(tick))?.tradeStrategy,
          routeExpires: candidateByPool.get(positionKey(tick))?.routeExpires,
          entryImpactPct: candidateByPool.get(positionKey(tick))?.entryImpactPct,
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
        const tradeCountAfterCommit = updated.totalTrades ?? updated.trades.length;
        if (learning && tradeCountAfterCommit !== learnedTradeCount) {
          learnedTradeCount = tradeCountAfterCommit;
          learning.recordTrades(updated.trades ?? []);
        }
        for (const tick of fresh) {
          if (!heldKeys.has(positionKey(tick)) && Object.hasOwn(updated.positions, positionKey(tick))) {
            usedPrices.set(positionKey(tick), tick.at);
          }
        }
        if (momentum) for (const decision of updated.decisions ?? []) {
          if (decision.at !== at) break;
          if (decision.status === "REJECT") diagnostic?.({ token: decision.mint, stage: "portfolio",
            outcome: "reject", reason: decision.reason });
        }
        if (copy === copySignals && fresh.length) copySignals = new Map();
        if (signal.aborted) return;
        tradeCount = updated.totalTrades ?? updated.trades.length;
        if (updated.trades[0]?.at > lastFillAt) {
          lastFillAt = updated.trades[0].at;
          lastFill = `${updated.trades[0].side} · ${updated.trades[0].symbol}`;
        }
        failures = priceError ? failures + 1 : 0;
        const message = priceError ? `Skannaus yrittää uudelleen: ${priceError.message}`
          : `Hinnat ${prices.length}/${held.length} avoimelle poolille`;
        report(message, updated, [...prices, ...fresh]);
      } catch (error) {
        if (signal.aborted) return;
        report(`Skannaus yrittää uudelleen: ${error.message}`);
        failures++;
      }
      if (momentum && !failures && approvalVersion !== cycleApproval) continue;
      const interval = failures ? Math.min(60000, 3000 * 2 ** Math.min(failures, 5)) : 3000;
      if (!momentum || failures || signal.aborted) await pause(interval, signal);
      else {
        const wait = new AbortController();
        streamWake = () => wait.abort();
        signal.addEventListener("abort", streamWake, { once: true });
        const now = Date.now();
        const next = approvedTicks.reduce((soonest, tick) => {
          const ready = nextEntryAt(tick);
          return ready > now ? Math.min(soonest, ready) : soonest;
        }, now + interval);
        await pause(next - now, wait.signal);
        signal.removeEventListener("abort", streamWake);
        streamWake = undefined;
      }
    }
  }

  async function learn() {
    try {
      while (!signal.aborted) {
        await pause(10000, signal);
        if (signal.aborted) break;
        try {
          const due = learning.due(Date.now());
          if (due.length) {
            const quotes = Date.now() < dexRetryAt ? await tape.poolPrices(due) : await pricesWithFallback(due);
            for (const tick of quotes) learning.mark(tick, tick.at);
          }
          calibration = learning.calibration(policy.momentumScore, Date.now());
          if (learning.dirty && saveLearning) {
            const state = learning.snapshot();
            const generation = learning.generation;
            await saveLearning(state);
            learning.saved(generation);
          }
        } catch (error) {
          if (!signal.aborted) sourceError = `Paper-oppiminen: ${error.message}`;
        }
      }
    } finally {
      if (learning.dirty && saveLearning) {
        try { await saveLearning(learning.snapshot()); }
        catch (error) { report(`Paper-oppimisen tallennus epäonnistui: ${error.message}`); }
      }
    }
  }

  await Promise.all([discover(), analyze(), enrich(), positions(), ...(learning ? [learn()] : [])]);
}

export function assessEntryDepth(pool,market,usd,solUsd,maxImpact=5){
  if(!["Raydium CLMM","Orca Whirlpool","Meteora DLMM"].includes(pool.protocol))return {status:"pass",reason:"Poolitarkistus"};
  const sol="So11111111111111111111111111111111111111112";
  if(market.quoteToken!==sol)return {status:"pass",reason:"Syvyysarvio ei tue vastavaluuttaa; Jupiter tarkistaa reitin"};
  if(!Number.isFinite(solUsd)||solUsd<=0||!Number.isFinite(usd)||usd<=0||!Number.isInteger(pool.feeBps))return {status:"watch",reason:"Syvyysarvion syöte puuttuu"};
  // Pool mint order must be known, not inferred from market display order.
  if(!pool.baseMint||!pool.quoteMint)return {status:"watch",reason:"Poolin minttijärjestys puuttuu"};
  const xForY=pool.baseMint===sol;
  if((xForY?pool.quoteMint:pool.baseMint)!==market.token)return {status:"watch",reason:"Poolin mintit eivät täsmää"};
  const input=BigInt(Math.ceil(usd/solUsd*1e9));
  const estimate=(pool.protocol==="Meteora DLMM"?estimateBinSwap:estimateTickSwap)(pool,input,xForY,pool.feeBps);
  if(!estimate.complete)return {status:"watch",reason:"Varmennettu array-syvyys ei riitä"};
  const decimals=xForY?pool.quote.decimals:pool.base.decimals;
  const received=Number(estimate.outputRaw)/10**decimals;
  const expected=Number(input)/1e9*(xForY?pool.spotRatio:1/pool.spotRatio);
  if(!Number.isFinite(expected)||expected<=0||!Number.isFinite(received)||received<=0)return {status:"watch",reason:"Syvyysarvio virheellinen"};
  const impact=100*(1-received/expected);
  if(impact>maxImpact)return {status:"reject",reason:"Arvioitu kokonaiskustannus yli "+maxImpact+" %"};
  return {status:"pass",reason:"Syvyysarvio "+Math.max(0,impact).toFixed(2)+" %"};
}
