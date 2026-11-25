// SPDX-License-Identifier: BUSL-1.1
import { address, aggregateCandles, discoverMarkets, fetchCandles, fetchTrojanCandles, normalizePair, orientPair, timeframes } from "./markets.js";
import { currentMarket, fetchJson, rpcCall } from "./network.js";
import { applyPaperFill, orderFor, reasons, strategySettings } from "./policy.js";
import { ruleSignal } from "./rules.js";
import { copyGroup } from "./copy.js";
import { analystWorker } from "./candidate-analyst.js";
import { marketTape, preferMarket, completeTape } from "./market-tape.js";
import { poolStream } from "./pool-stream.js";
import { momentumExit, momentumBudget, momentumPayoff, shortMomentum, momentumSignal, earlyMomentum, snapshotMomentum } from "./momentum.js";
import { fullRugCheck } from "./trojan-security.js";
import { analyzeCounterfactualExit, analyzeEntryRoute } from "./trojan-entry.js";
import { verifyPools, verifyPoolReserves, estimateBinSwap, estimateTickSwap } from "./trojan-pools.js";
import { learnedScore, marketSegment, signalFeatures } from "./paper-signal-model.js";
import { paperLearning, scoreBand } from "./momentum-learning.js";
import { CandidateQueue, marketBatch, marketEvidence, invalidateMarket, sourcesFor, watchPumpPortal } from "./trojan-discovery.js";
import { marketResolver, pumpTrades, tokenProgram2022 } from "./market-resolver.js";

export const scanLimit = 12;
const batchLimit = 30;
const maxTickAge = 20000;
const paperExecutionDelay = 1000;
export const scanKey = "scan-portfolio";
const classicTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const day = at => Math.floor(at / 86400000);
export const positionKey = market => `${market.token}:${market.pool}`;
const poolTokenDecimals = (depth, token) => depth?.tokenDecimals ??
  (depth?.baseMint===token ? depth.base?.decimals : depth?.quoteMint===token ? depth.quote?.decimals : undefined);
function routeEntryPrice(route, market, depth) {
  const decimals=poolTokenDecimals(depth,market.token);
  const quotePrice=Number(route.proof?.inLamports)*route.solUsd/1e9/(Number(route.proof?.tokenRaw)/10**decimals);
  return quotePrice>0 && Number.isFinite(quotePrice) && Math.abs(quotePrice/market.price-1)<=.05 ? quotePrice : null;
}
const marketReasons = {
  "not-indexed":"DEX-haku ei palauttanut tokenille poolia",
  "pool-unconfirmed":"Bonding curve tai mintti ei vielä näy vahvistettuna RPC:ssä",
  "curve-complete":"Bonding curve on suljettu ja migraatiopooli odottaa tunnistusta",
  "curve-mismatch":"PumpPortal-osoite ei vastaa mintin kanonista bonding curve -osoitetta",
  "invalid-pair":"Palvelun pooliosoite tai tokenpari on virheellinen",
  "missing-price":"Tunnistetun poolin USD-hinta puuttuu",
  "zero-price":"Lähde ilmoitti nollahinnan",
  "missing-liquidity":"Tunnistetun poolin likviditeettitieto puuttuu",
  "empty-liquidity":"Poolin todellinen myyntilikviditeetti on nolla",
  "invalid-values":"Poolin hinta tai likviditeetti on virheellinen",
  "missing-quote-usd":"Vastavaluutalle ei saatu tuoretta USD-hintaa",
  "unsupported-quote":"Bonding curven vastavaluuttaa ei tueta"
};

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
  return result.pairs.flatMap(raw => [...new Set([raw?.baseToken?.address,raw?.quoteToken?.address])]
    .filter(token=>identities.has(`${token}:${raw?.pairAddress}`)).map(token=>normalizePair(orientPair(raw,token))))
    .filter(Boolean)
    .map(pair => ({ ...pair, at }));
}

export function mintEligible(account) {
  return mintVerification(account).ok === true;
}

function mintVerification(account) {
  if (!account) return {ok:null,reason:"Minttitili puuttuu vahvistetusta RPC-vastauksesta"};
  const data = account?.data?.parsed;
  if (!data?.info || !Object.hasOwn(data.info,"isInitialized"))
    return {ok:null,reason:"RPC:n mintin kentät puuttuvat"};
  if (data.type !== "mint" || data.info.isInitialized !== true)
    return {ok:false,reason:"SPL-minttitili on alustamaton tai virheellinen"};
  for (const [field,label] of [["mintAuthority","Minttausvaltuus"],["freezeAuthority","Jäädytysvaltuus"]]) {
    const key=data.info[field];
    if (key===null) continue;
    if (typeof key==="string" && address.test(key)) return {ok:false,reason:`${label} on aktiivinen`};
    return {ok:null,reason:`${label} vahvistamatta RPC:ssä`};
  }
  if (account.owner === classicTokenProgram) return {ok:true};
  if (account.owner !== tokenProgram2022) return {ok:false,reason:"Mintin omistava ohjelma ei ole tuettu SPL Token"};
  // Token-2022 allows extensions that can freeze or change balances. Only the
  // two metadata extensions are admitted. RugCheck still validates metadata risks.
  if (!Array.isArray(data.info.extensions)) return {ok:null,reason:"Token-2022-laajennusten tiedot puuttuvat"};
  const unsupported=data.info.extensions.filter(row=>!["metadataPointer","tokenMetadata"].includes(row?.extension));
  return unsupported.length ? {ok:false,reason:`Token-2022-riskilaajennus: ${unsupported.map(row=>row?.extension??"tuntematon").join(", ").slice(0,160)}`} : {ok:true};
}

export async function scanMints(tokens, signal, detail = false) {
  if (!tokens.length) return new Map();
  const response = await rpcCall("getMultipleAccounts", [tokens, {
    commitment: "confirmed", encoding: "jsonParsed"
  }], signal);
  if (!Array.isArray(response?.value) || response.value.length !== tokens.length) {
    throw new Error("Virheellinen minttien riskitarkistus.");
  }
  return new Map(tokens.map((token,i)=>[token,
    detail ? mintVerification(response.value[i]) : mintEligible(response.value[i])]));
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
      const size=momentum ? momentumBudget(book.cash,tick.score,tick.liquidity,scoreBand(policy.momentumScore,tick.scoreFloor),policy,tick.riskScale) : 0;
      const orderUsd = momentum ? Math.min(size,tick.quotedBudget??Infinity)
        : trojan ? Math.round(Math.min(profilePolicy.orderUsd, book.cash * (policy.balanceFraction ?? 10) / 100) * 100) / 100 : policy.orderUsd;
      const executionPolicy = trojan ? { ...profilePolicy, strategy: selectedStrategy, orderUsd, lossUsd: policy.lossUsd } : policy;
      const signal = tick.manual ? 0 : decide(tick, book);
      let order = position && tick.manual ? { side: "Myynti", sol: book.sol, reason: 10, detail: "Käyttäjä sulki paperiposition" }
        : position && momentum ? momentumExit(book, tick, executionPolicy)
        : orderFor(engine, signal, book, tick, executionPolicy);
      if (exits && order?.side !== "Myynti") continue;
      if (!exits && order?.side === "Myynti") continue;
      const noExitQuote = exits && tick.requireExitQuote && (!tick.exitQuote || tick.exitQuote.expires < Date.now() ||
        Math.abs(order.sol-tick.exitQuote.quantity)>order.sol*1e-8);
      if (noExitQuote) order=undefined;
      const exposure = Object.values(portfolio.positions).reduce((sum, item) => sum + item.cost, 0);
      const duplicate = Object.entries(portfolio.positions).some(([other, item]) =>
        other !== key && item.market.token === tick.token);
      const positions = Object.values(portfolio.positions);
      const profileCount = trojan ? positions.filter(item => item.strategy === selectedStrategy).length : 0;
      const profileAllowed = !trojan || (orderUsd >= 1 &&
        Boolean(position || (positions.length < (policy.maxTotalPositions ?? 15) && profileCount < (selectedStrategy === 6 ? policy.maxSniperPositions ?? 10 : policy.maxMainPositions ?? 10))));
      const afterPreviousTrade = !previousTrade || (tick.observedAt ?? tick.at) > previousTrade.at;
      const hasVolume = Number.isFinite(tick.volume) && tick.volume >= 0 ||
        momentum && (tick.shortVolume > 0 || tick.volume5 > 0);
      const buyAllowed = afterPreviousTrade && orderUsd > 0 && profileAllowed && eligible(tick.token) && hasVolume && !duplicate &&
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
      } else if (position) recordDecision(portfolio,tick,"HOLD",noExitQuote
        ? tick.exitReason??"Odotetaan tuoretta Jupiter-myyntitarjousta" : "Poistumisehdot eivät täyty");
      if (book.sol > 0) {
        const { sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool, lastTradeAt } = book;
        portfolio.positions[key] = { strategy: selectedStrategy, sol, cost, openedAt, added, profitTaken, entryLiquidity, entryPool,
          name: tick.name ?? position?.name, track: tick.track ?? position?.track, segment:tick.segment ?? position?.segment, features:tick.features ?? position?.features, score: tick.score ?? position?.score,
          entryReason: position?.entryReason ?? tick.analysisReason,
          exitPlan:position?.exitPlan??tick.exitPlan,
          worst: Math.min(position?.worst ?? tick.price, tick.price),
          liquidity: tick.liquidity, change5: tick.change5, lastTradeAt, peak: Math.max(book.peak ?? tick.price, tick.price), mark: tick.price,
          lastTickAt: tick.at, market: { token: tick.token, pool: tick.pool, symbol: tick.symbol,
            quoteToken: tick.quoteToken ?? position?.market?.quoteToken, provider:tick.provider ?? position?.market?.provider,
            decimals:tick.decimals ?? position?.market?.decimals } };
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
  const resolver = momentum ? marketResolver(signal) : undefined;
  const learning = momentum ? paperLearning(learningState, policy) : undefined;
  let learnedTradeCount;
  let nextShadowSafety = 0;
  let calibration = learning?.calibration(policy.momentumScore, Date.now());
  const depthHistory = new Map();
  const lastReprice=new Map();
  const threshold = track => calibration?.tracks[track].threshold ?? policy.momentumScore;
  const watched = new Map();
  const heldPools = new Set();
  const heldTokens = new Set();
  let poolEventAt = 0;
  let streamWake;
  let approvalVersion = 0;
  function nextEntryAt(tick) {
    const ready = tick.signalAt + paperExecutionDelay;
    return Number.isFinite(ready) && ready < tick.routeExpires ? ready : Infinity;
  }
  let poolStatus = "odottaa poolia";
  const startPoolStream = momentum ? poolStream(signal, (pool, notification) => {
    const row = watched.get(pool);
    const now = Date.now();
    if (row?.market?.provider === "Pump.fun RPC" &&
        tape.recordTrades(pool,row.item.token,pumpTrades(notification,row.market,now),now)) wake(row.item,100);
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
  function refreshStreams() {
    const watchedByPriority = [...watched.entries()].sort((a,b)=>b[1].priority-a[1].priority || b[1].seen-a[1].seen);
    const pump = watchedByPriority.filter(([,row])=>row.market.provider==="Pump.fun RPC").slice(0,2);
    startPoolStream([...heldPools,...pump.map(([pool])=>pool),...watchedByPriority.map(([pool])=>pool)]);
  }
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
    const at=Date.now();
    const discovered = queue.add(tokens, source, at);
    if (source==="PumpPortal") for (const value of tokens) {
      if (!value?.curveHint) continue;
      const item=queue.sniperItems.get(value.token) ?? queue.items.get(value.token);
      if (item) item.curveCreatedAt ??= at;
    }
    for (const token of discovered) {
      const item = queue.sniperItems.get(token) ?? queue.items.get(token);
      diagnostic?.({token,stage:"discovery",outcome:"approve",provider:source});
      publish(token, "found", source, undefined, undefined, marketSnapshot(item));
    }
  };
  let cursors = new Map();
  let pump = "yhdistetään";
  let sourceError = "";
  let processing = 0;
  const routePending=new Set();
  const marketRanks = new WeakMap();
  let routeActive=0, routeLimit=2;
  const sellPoolCache=new Map(), sellPoolPending=new Set();
  const sellQuotes=new Map();
  let selling=0;
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
    const pump=markets.filter(market=>market.provider==="Pump.fun RPC");
    const reserve=markets.find(market=>market.provider==="Pool RPC");
    const gecko=markets.filter(market=>market.provider==="GeckoTerminal");
    const [dex,pumpRead,geckoRead,poolRead]=await Promise.allSettled([
      scanPrices(markets.filter(market=>!pump.includes(market)),signal), resolver.readCurves(pump,true),
      tape.poolPrices(gecko), reserve && resolver.readPool(resolver.pool(reserve.token)?.value?.raw ?? {
        chainId:"solana",pairAddress:reserve.pool,baseToken:{address:reserve.token,symbol:reserve.symbol},
        quoteToken:{address:reserve.quoteToken}
      },true)
    ]);
    const prices=dex.status==="fulfilled" ? dex.value : [];
    if (geckoRead.status==="fulfilled") prices.push(...geckoRead.value);
    if (poolRead.status==="fulfilled" && poolRead.value) {
      prices.push({...poolRead.value.market,at:poolRead.value.observedAt});
    }
    const at=Date.now();
    for (const market of pump) {
      const current=resolver.curve(market.token)?.value;
      if (current?.market.pool===market.pool && at-current.observedAt<=maxTickAge) {
        prices.push({...current.market,at:current.observedAt});
      }
    }
    const found=new Map(prices.map(tick=>[positionKey(tick),tick]));
    const migrated=pump.filter(market=>!found.has(positionKey(market)) && resolver.curve(market.token)?.state==="curve-complete");
    if (migrated.length) try {
      const replacements=await marketBatch(migrated.map(market=>market.token),signal);
      for (const original of migrated) {
        const replacement=replacements.get(original.token);
        if (replacement?.market.pool && replacement.market.pool!==original.pool) {
          found.set(positionKey(original),{...replacement.market,...original,price:replacement.market.price,
            liquidity:replacement.market.liquidity,at:replacement.observedAt,dataPool:replacement.market.pool});
        }
      }
    } catch (error) { if (!signal.aborted) sourceError=`Migraatiopooli: ${error.message}`; }
    const missing=markets.filter(market=>!found.has(positionKey(market)) && !pump.includes(market) && !gecko.includes(market));
    let failure=[dex,pumpRead,geckoRead,poolRead].find(work=>work.status==="rejected")?.reason;
    try { for (const tick of await tape.poolPrices(missing)) found.set(positionKey(tick),tick); }
    catch (error) { failure ??= error; }
    if (!found.size && failure) throw failure;
    return [...found.values()];
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
          const cached = marketEvidence(item.token,signal)?.value;
          const primary = markets.get(item.token) ?? (cached && now-cached.observedAt<=15000 ? cached : undefined);
          const listed = preferMarket(primary, tape.get(item.token), now);
          const alternative = resolver.pool(item.token)?.value ?? resolver.curve(item.token)?.value;
          const alternate = preferMarket(listed, alternative, now);
          if (alternate) {
            markets.set(item.token, alternate);
            learning.mark(alternate.market, alternate.observedAt);
          }
        }
        const missing = batch.filter(item=>!markets.has(item.token));
        const failed = (provider,error) => { if (!signal.aborted) sourceError = `${provider}: ${error.message}`; };
        const pumpCandidates = batch.filter(item=>resolver.canCurve(item,now) &&
          (!markets.has(item.token) || markets.get(item.token)?.provider==="Pump.fun RPC"));
        if (pumpCandidates.length) void resolver.readCurves(pumpCandidates).then(items=>items.forEach(item=>wake(item,100)))
          .catch(error=>failed("Pump.fun RPC",error));
        const unknown = missing.filter(item=>!resolver.canCurve(item,now) && !item.curveHint && !item.poolHint && resolver.canHint(item,now));
        if (unknown.length) void resolver.search(unknown).then(items=>items.forEach(item=>wake(item,100)))
          .catch(error=>failed("Jupiter-tokenihaku",error));
        const knownPools = missing.filter(item=>!item.curveHint && (item.poolHint || resolver.poolHint(item.token)) && tape.canRefresh(item.token))
          .slice(0,15).map(item=>({token:item.token,pool:item.poolHint || resolver.poolHint(item.token)}));
        if (knownPools.length) void tape.poolPrices(knownPools).then(rows=>{
          const observed = new Set(rows.map(row=>row.token));
          for (const item of missing) if (observed.has(item.token)) wake(item,100);
        }).catch(error=>failed("GeckoTerminal",error));
        const needsData = batch.find(item => !item.curveHint && tape.canRefresh(item.token) && !completeTape(markets.get(item.token)) &&
          (item.sources.size >= 2 || markets.has(item.token)));
        if (needsData) void tape.refresh(needsData.token).then(() => {
          if (Date.now() - (tape.get(needsData.token)?.observedAt ?? 0) < 2000) wake(needsData,100);
        }).catch(error=>failed("GeckoTerminal",error));
        const withReserves=missing.find(item=>["missing-price","missing-liquidity"].includes(marketEvidence(item.token,signal)?.state));
        if (withReserves) void resolver.readPool(marketEvidence(withReserves.token,signal).raw)
          .then(price=>{if(price)wake(withReserves,100);}).catch(error=>failed("Pool RPC",error));
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
      let shadowCandidate, virtualCandidate;
      for (const cache of [mintCache, rugCache, routeCache]) {
        for (const [token, value] of cache) if (value.expires <= now) cache.delete(token);
      }
      if (momentum) {
        if (diagnostic) for (const row of ranked) {
          for (const [gate,blocked] of Object.entries(row.strategy?.gates??{})) {
            diagnostic({token:row.item.token,stage:`rolling-filter/${gate}`,outcome:blocked?"watch":"approve",reason:blocked?gate:undefined});
          }
        }
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
            const quotes=[...(previous?.quotes??[]).filter(row=>observedAt-row.at<=60000),
              {at:observedAt,provider:row.pair.provider,price:market.price,liquidity:market.liquidity}].slice(-12);
            depthHistory.set(position, { at: observedAt, liquidity: market.liquidity,
              previous: previous && observedAt - previous.at <= 30000 ? previous.liquidity : undefined,quotes });
          }
          const depth = depthHistory.get(position);
          const windows = shortMomentum(tape.trades(market.pool, market.token), now);
          const recent=windows[15], olderVolume=windows[30]?.volume-recent?.volume;
          const fastEvidence=recent && {...recent,pace:olderVolume>0?recent.volume/olderVolume:undefined};
          const segment = marketSegment(market, now);
          const withEvidence = (strategy, track, structural, window) => {
            const features = signalFeatures(market, window);
            const score = structural ? learnedScore(calibration?.weights,track,segment,features,strategy.score) : strategy.score;
            const scoreFloor = threshold(track);
            const decision = structural ? score >= scoreFloor ? "approve" : "watch" : strategy.decision;
            const regime=calibration?.regimes?.[`${track}/${segment}`];
            return { ...strategy, decision, code: structural && decision === "watch" ? "score" : strategy.code,
              score,track,scoreFloor,segment,features,regime,expectedPct:momentumPayoff(market,strategy.observedMove,window,policy,regime) };
          };
          const rolling = withEvidence(row.strategy, "rolling", ["score","signal"].includes(row.strategy.code));
          const shortSignal = momentumSignal(windows,row.quality.score,threshold("short"));
          const short = withEvidence({ ...shortSignal, shortVolume:recent?.volume, reason:"Lyhyen aikavälin momentum" }, "short", shortSignal.structural, fastEvidence);
          const earlySignal = earlyMomentum(windows,market,row.quality.score,threshold("early"),policy,depth?.previous);
          const early = withEvidence({ ...earlySignal, shortVolume:recent?.volume }, "early",
            earlySignal.code === "early-flow" || earlySignal.code === "score", fastEvidence);
          const snapshot=snapshotMomentum(depth?.quotes??[],market,row.quality.score,threshold("short"),policy);
          const quoteSignal=withEvidence(snapshot,"short",snapshot.structural,snapshot.window);
          diagnostic?.({token:market.token,stage:"early-tape",outcome:early.decision,reason:early.reason,score:early.score});
          diagnostic?.({token:market.token,stage:"quote-signal",outcome:quoteSignal.decision,reason:quoteSignal.reason,score:quoteSignal.score});
          const options = [rolling, short, early,quoteSignal];
          const weakFlow = rolling.code === "buy-pressure" && Number.isFinite(market.transactions?.m5?.buys) &&
            market.transactions.m5.buys < market.transactions.m5.sells;
          const calibrated = options.filter(pick => pick.decision === "approve" && (pick.track === "rolling" || !weakFlow))
            .sort((a,b)=>b.expectedPct-a.expectedPct || (b.score-b.scoreFloor)-(a.score-a.scoreFloor))[0];
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
            if (!weakFlow && observation.code === "score" && observation.score >= policy.momentumScore - 8) {
              if (safe && !virtualCandidate && learning.routeWanted(market,now)) virtualCandidate = {...row,strategy:observation};
              else if (now >= nextShadowSafety && !shadowCandidate && !safe &&
                  mintCache.get(market.token)?.ok !== false && rugCache.get(market.token)?.ok !== false) shadowCandidate = row;
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
              (row.decision === "watch" && row.item.sources.has("PumpPortal") &&
                (row.quality?.score >= 45 || row.pair.market.liquidity >= policy.minLiquidity * .5)))) continue;
          const pool = row.pair.market.pool;
          const previous = watched.get(pool);
          watched.delete(pool);
          watched.set(pool, { item: row.item, market:row.pair.market, last:previous?.last ?? 0,
            seen:now, priority:(row.decision==="approve"?30:0)+(row.quality?.score??0) });
        }
        for (const [pool, row] of watched) if (now - row.seen > 30000) watched.delete(pool);
        while (watched.size > 24) watched.delete(watched.keys().next().value);
        refreshStreams();
      }
      if (momentum) for (const row of ranked) {
        if (row.pair && row.decision !== "reject" && row.pair.market.liquidity < policy.minLiquidity) {
          row.decision = "watch";
          row.strategy = { ...row.strategy, code: "liquidity-floor", reason: "Poolin likviditeetti alittaa riskirajan" };
        }
      }
      const possible = ranked.filter(row => row.decision === "approve" && (!momentum || !heldTokens.has(row.item.token))).sort((a,b)=>((b.strategy?.score??0)+(b.profile==="sniper"?12:0))-((a.strategy?.score??0)+(a.profile==="sniper"?12:0)));
      if (shadowCandidate) nextShadowSafety = now + 20000;
      const verificationCandidates = shadowCandidate && !possible.includes(shadowCandidate)
        ? [...possible, shadowCandidate] : possible;
      for(const [key,value] of poolCache)if(value.expires<=Date.now())poolCache.delete(key);
      const routeCandidates = virtualCandidate && !heldTokens.has(virtualCandidate.item.token) && !possible.includes(virtualCandidate) ? [...possible,virtualCandidate] : possible;
      const poolJobs=policy.strategy>=5?routeCandidates.filter(({pair, item})=>
        mintCache.get(item.token)?.ok !== false && rugCache.get(item.token)?.ok !== false &&
        !poolCache.has(positionKey(pair.market))&&!poolPending.has(positionKey(pair.market))).slice(0,Math.max(0,2-poolActive)):[];
      void Promise.all(poolJobs.map(async ({pair, item})=>{
        const market=pair.market,key=positionKey(market);poolPending.add(key);poolActive++;
        try{let [pool]=await verifyPools([market],signal);if(pool.status==="approve")pool={...pool,...await verifyPoolReserves(market,signal)};poolCache.set(key,{...pool,expires:Date.now()+(pool.status==="approve"?8000:15000)});}
        catch(error){poolCache.set(key,{status:"watch",reason:error.message,expires:Date.now()+5000});}
        finally{poolPending.delete(key);poolActive--; wake(item);}
      }));
      const needMint = verificationCandidates.filter(row => !mintCache.has(row.item.token)&&!mintPending.has(row.item.token)).map(row => row.item.token);
      for(const token of needMint)mintPending.add(token);
      void (async()=>{try {
        if(!needMint.length)return;
        const checked = await scanMints(needMint,signal,true);
        if (signal.aborted) return;
        for (const token of needMint) {
          const result=checked.get(token);
          mintCache.set(token,{...result,expires:Date.now()+(result.ok==null?12000:300000)});
        }
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
            if (check) diagnostic?.({token:item.token,stage:"rug-evidence",outcome:check.status,
              reason:check.reasons.join(" · "),evidence:check.findings});
            rugCache.set(item.token, { ok: check ? check.status === "approve" ? true :
              check.status === "watch" ? null : false : rugEligible(raw, rugCeiling),
              reason: check?.reasons.join("; ").slice(0, 200), expires: Date.now() + (check?.status === "watch" ? 30000 : 300000) });
            if (check?.status !== "watch") wake(item);
          } catch (error) {
            rugCache.set(item.token, { ok: null, reason:`RugCheck-todiste puuttuu (${error.message})`, expires: now + 30000 });
            sourceError = `RugCheck: ${error.message}`;
            if (error.status === 429) rugCooldown = Date.now() + Math.max(60000, error.retryAfterMs ?? 0);
          } finally { rugActive--; rugPending.delete(item.token); }
        }));
      }
      if (signal.aborted) return;
      if (policy.strategy >= 5 && routeActive < routeLimit && Date.now() >= nextJupiter) {
        const ready = ({item,pair}) => mintCache.get(item.token)?.ok===true && rugCache.get(item.token)?.ok===true &&
          poolCache.get(positionKey(pair.market))?.status==="approve";
        const ordered=momentum ? [...routeCandidates].sort((a,b)=>Number(ready(b))-Number(ready(a))) : routeCandidates;
        const next = ordered.find(({ item, pair, decision }) => {
          const key=positionKey(pair.market), pool=poolCache.get(key);
          const mint=mintCache.get(item.token)?.ok, rug=rugCache.get(item.token)?.ok;
          return !routeCache.has(key) && !routePending.has(key) && (momentum
            ? mint!==false && rug!==false && (decision==="approve" || pool?.status==="approve")
            : mint && rug && pool?.expires>Date.now());
        });
        if (next) {
          const market = next.pair.market;
          const routeKey=positionKey(market);
          routePending.add(routeKey);routeActive++;
          nextJupiter=Date.now()+2050;
          void (async () => {
          try {
            const pool = poolCache.get(routeKey);
            if (!momentum && (!pool || pool.expires<=Date.now())) throw new Error("Poolitarkistus vanhentui");
            if (!momentum && pool.status !== "approve") {
              routeCache.set(routeKey, { ...pool, stage: "pool", expires: Date.now() + 30000 });
            } else {
              if (momentum) solQuote = await resolver.solPrice();
              else if (!solQuote || Date.now() - solQuote.at > 15000) solQuote = await currentMarket(signal);
              const plan=next.strategy;
              let orderUsd = momentum ? momentumBudget((await load()).cash,plan.score,market.liquidity,
                Math.min(plan.score,plan.scoreFloor??policy.momentumScore),policy,plan.regime?.scale)
                : strategySettings(policy, next.profile === "sniper" ? 6 : 5).orderUsd;
              if (!(orderUsd>0)) throw new Error("Laskettu Paper-positio alittaa vähimmäiskoon");
              const depth = momentum ? null : assessEntryDepth(pool,market,orderUsd,solQuote.price,policy[next.profile+"MaxImpact"]??5);
              if(depth?.status==="reject"||depth?.status==="watch"){
                routeCache.set(positionKey(market),{...depth,stage:"pool",expires:Date.now()+15000});
              } else {
              const initialBudget=orderUsd;
              const economics=momentum?{expectedPct:plan.expectedPct,liquidity:market.liquidity,
                feeBps:policy.feeBps,slippageBps:Math.max(policy.slippageBps,35),lossPct:policy.momentumStop??5,
                observeOnly:next.decision!=="approve"}:undefined;
              const options={
                signal, solUsd: solQuote.price, apiKey: jupiterKey, taker: simulationWallet || undefined,
                slippageBps:momentum?Math.max(35,Math.min(100,policy.slippageBps)):100,checkExit:momentum,economics,requestQuote
              };
              let route=await analyzeEntryRoute(market.token,orderUsd,options);
              const smaller=Math.floor(orderUsd*.5*100)/100;
              if (momentum && route.resize && smaller>=policy.momentumMinUsd && Date.now()>=nextQuote-1100) {
                diagnostic?.({token:market.token,stage:"route-size",outcome:"retry",reason:route.reason,
                  evidence:{orderUsd,smaller,roundTripBps:route.roundTripBps}});
                orderUsd=smaller;
                route=await analyzeEntryRoute(market.token,orderUsd,options);
                diagnostic?.({token:market.token,stage:"route-size",outcome:route.allowed?"approve":"reject",
                  reason:route.reason,evidence:{initialBudget,orderUsd,net:route.expectedNetPct}});
              }
              const checkedAt = Date.now();
              const outcome = route.allowed ? "approve" : "reject";
              const reason = `${route.reason} (${route.score}/100)${route.simulation ? ` · simulaatio ${route.simulation}` : ""}`;
              routeCache.set(routeKey, { status:outcome, entryImpactPct:route.impact, roundTripBps:route.roundTripBps,
                proof:route.proof,solUsd:solQuote.price,orderUsd,lossPct:route.lossPct,expectedNetPct:route.expectedNetPct,
                buyImpact:route.buyImpact,sellImpact:route.sellImpact,feeBps:route.feeBps,
                reason:momentum ? reason : `${pool.protocol} · ${depth.reason} · ${reason}`,
                checkedAt,expires:checkedAt+(route.allowed?8000:12000) });
              diagnostic?.({token:market.token,stage:"preflight",outcome,reason,
                evidence:{orderUsd,buyImpact:route.buyImpact??route.impact,sellImpact:route.sellImpact,
                  cost:route.lossPct,feeBps:route.feeBps,net:route.expectedNetPct}});
              }
            }
          } catch (error) {
            if(error.status===429 || /429|rate limit/i.test(error.message)){routeLimit=1;nextJupiter=Math.max(nextJupiter,Date.now()+Math.max(60000, error.retryAfterMs ?? 0));}
            routeCache.set(positionKey(market), { status: "watch", reason: error.message, expires: Date.now() + 15000 });
            diagnostic?.({token:market.token,stage:"preflight",outcome:"watch",reason:error.message});
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
        const mintReport=mintCache.get(item.token);
        const authority = mintReport?.ok;
        const report = rugCache.get(item.token);
        const rug = rugCeiling > 0 ? report?.ok : true;
        const cachedRoute = pair && policy.strategy >= 5 ? routeCache.get(positionKey(pair.market)) : null;
        let route = cachedRoute?.expires > Date.now() ? cachedRoute : null;
        let quotePrice;
        const pool = pair && poolCache.get(positionKey(pair.market));
        let checked = decision;
        let stage = strategy?.code === "liquidity-floor" ? "liquidity" : pair ? "momentum" : "market";
        const dex = marketEvidence(item.token,signal), curve = resolver?.curve(item.token);
        const expired = !pair && (dex?.value || tape?.get(item.token) || curve?.value || resolver?.pool(item.token)?.value);
        const state = expired ? "stale" : curve?.state && curve.state!=="priced" && curve.state!=="pool-unconfirmed" ? curve.state : dex?.state ?? curve?.state;
        let reason = strategy?.reason ?? (pair ? "Markkinadata tarkistettu" :
          expired ? "Viimeisin poolin noteeraus vanheni" : marketReasons[state] ?? "Hintalähteestä ei saatu tuoretta vastausta");
        if (momentum) {
          const priceKnown = Boolean(pair || dex?.state==="missing-liquidity" && now-dex.at<=15000 ||
            curve?.price>0 && now-curve.at<=15000);
          const poolKnown = Boolean(pair || dex?.raw || curve && !["pool-unconfirmed","curve-mismatch","invalid-pair"].includes(curve.state));
          const provider = pair?.provider ?? (state===curve?.state ? "Pump.fun RPC" : "DEX Screener");
          diagnostic?.({token:item.token,stage:"pool-identification",outcome:poolKnown?"approve":"watch",reason:poolKnown?undefined:reason,provider});
          diagnostic?.({token:item.token,stage:"price",outcome:priceKnown?"approve":"watch",reason:priceKnown?undefined:reason,provider});
          if (priceKnown) diagnostic?.({token:item.token,stage:"market-analysis",outcome:pair && decision==="approve"?"approve":decision==="reject"?"reject":"watch",
            reason:decision==="approve"?undefined:reason,provider});
        }
        if (decision === "approve") {
          if (authority === false) { stage = "mint"; checked = "reject"; reason = mintReport.reason; }
          else if (rug === false) { stage = "rug"; checked = "reject"; reason = report.reason || "RugCheck hylkäsi"; }
          else if (authority !== true || rug !== true) { stage = authority !== true ? "mint" : "rug"; checked = "watch"; reason = (stage==="mint"?mintReport?.reason:report?.reason) || "Odotetaan turvallisuustarkistusta"; }
          else if (policy.strategy >= 5) {
            if (momentum) {
              if (pool?.status !== "approve" || pool.expires <= Date.now()) {
                stage = "pool";
                checked = pool?.status === "reject" ? "reject" : "watch";
                reason = pool?.reason ?? "Odotetaan ketjun pooli- ja reservitarkistusta";
              } else {
                diagnostic?.({token:item.token,stage:"safety",outcome:"approve"});
                diagnostic?.({token:item.token,stage:"signal",outcome:"approve",reason:strategy?.reason});
                stage = "route";
                checked = route?.status ?? "watch";
                reason = route?.reason ?? "Odotetaan Jupiterin osto- ja myyntireittiä";
                if (route?.status === "approve") {
                  const depth = assessEntryDepth(pool,pair.market,route.orderUsd,route.solUsd,policy[profile+"MaxImpact"]??5);
                  if (depth.status === "reject" || depth.status === "watch") {
                    checked=depth.status;
                    reason=depth.reason;
                  } else if (!(quotePrice=routeEntryPrice(route,pair.market,pool))) {
                    checked="watch";
                    reason="Jupiterin tarjoushinta ei täsmää analysoituun pooliin tai mintin desimaalit puuttuvat";
                  } else if ((1-route.lossPct/100)*(1+strategy.expectedPct/100)<1.0015) {
                    checked="watch";
                    reason="Signaalin odotettu nettoliike heikkeni tarjouksen jälkeen";
                  } else {
                    stage="eligible";
                    route={...route,expires:Math.min(route.expires,pool.expires)};
                    reason=`${pool.protocol} · ${depth.reason} · ${route.reason}`;
                  }
                }
                diagnostic?.({token:item.token,stage:"route-check",outcome:checked,reason:checked==="approve"?undefined:reason});
              }
            } else {
              stage = route ? (route.stage ?? (route.status === "approve" ? "eligible" : "route")) : pool?.status === "approve" ? "route" : "pool";
              checked = route?.status === "unsupported" ? "watch" : route?.status ?? "watch";
              reason = route?.reason ?? (pool?.status !== "approve" && pool?.reason) ?? "Odotetaan pooli- ja Jupiter-analyysiä";
              if (reason === false) reason = "Odotetaan Jupiter-tarjousta";
            }
          }
        } else if (quality?.tier === "reject") reason = "Virheellinen markkinadata";
        if (momentum && pair && authority === true && rug === true && pool?.status === "approve" &&
            pool.expires>Date.now() && route?.proof) {
          const depth=assessEntryDepth(pool,pair.market,route.orderUsd,route.solUsd,policy[profile+"MaxImpact"]??5);
          if (depth.status === "pass" && routeEntryPrice(route,pair.market,pool)) {
            learning.proveRoute(pair.market,route.proof,route.checkedAt,route.status==="reject");
          }
        }
        if (momentum && decision === "approve" && ["mint","rug","pool"].includes(stage)) {
          diagnostic?.({token:item.token,stage:"safety",outcome:checked,reason});
        }
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
        const retryDelay = momentum && stage==="route" && route?.status==="reject" ? Math.max(1000,route.expires-now)
          : momentum && checked === "watch" && stage === "market"
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
          const exitPlan=momentum?{costPct:route.lossPct,payoffPct:strategy.expectedPct,
            holdSeconds:strategy.regime?.holdSeconds??(strategy.track==="rolling"?240:120),
            profitScale:strategy.regime?.profitScale??1}:undefined;
          candidates.push({ ...pair.market, provider:pair.provider, decimals:poolTokenDecimals(pool,item.token), score: strategy?.score, scoreFloor: strategy?.scoreFloor, track: strategy?.track, segment:strategy?.segment, features:strategy?.features, shortVolume: strategy?.shortVolume, analysisReason: strategy?.reason, verification: reason, tradeStrategy: policy.strategy === 8 ? 8 : policy.strategy >= 5 ? (profile === "sniper" ? 6 : 5) : policy.strategy, at: pair.observedAt, priority: item.priority, routeExpires: route?.expires, signalAt: route?.checkedAt, entryImpactPct: route?.entryImpactPct, entryQuotePrice:quotePrice,quotedBudget:momentum?route.orderUsd:undefined,riskScale:strategy?.regime?.scale,exitPlan });
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
        for (const key of sellQuotes.keys()) if (!Object.hasOwn(portfolio.positions,key)) sellQuotes.delete(key);
        heldPools.clear();
        heldTokens.clear();
        for (const market of held) {
          heldPools.add(market.pool);
          heldTokens.add(market.token);
        }
        if (momentum) refreshStreams();
        for(const [key,value] of sellPoolCache)if(value.expires<=Date.now())sellPoolCache.delete(key);
        for(const market of held.filter(m=>m.quoteToken&&!sellPoolCache.has(positionKey(m))&&!sellPoolPending.has(positionKey(m))).slice(0,Math.max(0,2-sellPoolPending.size))){
          const key=positionKey(market);sellPoolPending.add(key);
          void verifyPoolReserves(market,signal).then(pool=>{if(!signal.aborted)sellPoolCache.set(key,{...pool,expires:Date.now()+8000});}).catch(()=>{if(!signal.aborted)sellPoolCache.set(key,{expires:Date.now()+10000});}).finally(()=>sellPoolPending.delete(key));
        }
        const now = Date.now();
        for (const [key,at] of lastReprice) if (now-at>maxTickAge) lastReprice.delete(key);
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
        if (momentum) {
          const valid = new Set(prices.filter(tick=>Date.now()-tick.at<=maxTickAge).map(positionKey));
          for (const market of held) diagnostic?.({token:market.token,stage:"position",
            outcome:valid.has(positionKey(market))?"approve":"watch",
            reason:valid.has(positionKey(market))?undefined:priceError?.message??"Tuore positiomerkintä puuttuu"});
        }
        if (tape && prices.length) {
          const now = Date.now();
          const next = prices.find(tick => tape.canTrade(tick.pool, tick.token, now));
          if (next) void tape.refreshTrades(next.pool, next.token).then(changed => {
            if (changed) streamWake?.();
          }).catch(error => { if (!signal.aborted) sourceError = `Position kauppavirta: ${error.message}`; });
          for (const tick of prices) {
            tick.shortWindow = shortMomentum(tape.trades(tick.dataPool??tick.pool,tick.token), now)[15];
          }
        }
        // Prioritize risk exits before computing candidate indicators.
        let exitBook;
        if(prices.length && policy.strategy>=5 && !rules && !copyWallets?.length){
          const exitAt = Math.max(Date.now(), (portfolio.lastScanAt ?? 0) + 1);
          const ticks = prices.filter(t=>exitAt>=t.at&&exitAt-t.at<=maxTickAge).map(t=>({...t,
            sellPool:sellPoolCache.get(positionKey(t)),observedAt:t.at,at:exitAt,exitsOnly:true}));
          for (const tick of ticks) {
            const key=positionKey(tick), position=portfolio.positions[key];
            if (!momentum || position?.strategy!==8) continue;
            tick.requireExitQuote=true;
            const order=momentumExit(position,tick,strategySettings(policy,8));
            if (!order) continue;
            const previous=sellQuotes.get(key);
            if (previous?.expires >= Date.now()) {
              if (previous.quantity===order.sol && previous.price && (order.reason!==5 ||
                  previous.price*(1-policy.feeBps/10000)>position.cost/position.sol*1.002)) tick.exitQuote=previous;
              else if (previous.price) tick.exitReason="Myyntitarjouksen nettotuotto alittaa voittoehdon";
              else tick.exitReason=previous.reason;
            } else if (!selling && Date.now()>=nextQuote) {
              const depth=tick.sellPool;
              const decimals=poolTokenDecimals(depth,tick.token) ?? position.market.decimals;
              const raw=Number.isInteger(decimals) ? Math.floor(order.sol*10**decimals) : 0;
              if (raw>0 && Number.isSafeInteger(raw)) {
                selling++;
                nextJupiter=Math.max(nextJupiter,Date.now()+1100);
                void Promise.all([analyzeCounterfactualExit(tick.token,String(raw),{signal,apiKey:jupiterKey,requestQuote,economic:true}),
                  resolver.solPrice()]).then(([quote,reference])=>{
                  if (signal.aborted) return;
                  const quotePrice=Number(quote.lamports)*reference.price/1e9/(raw/10**decimals);
                  const floor=Number(quote.minLamports)*reference.price/1e9/(raw/10**decimals);
                  if (quote.allowed && quotePrice>0 && Number.isFinite(quotePrice)) {
                    const price=Math.min(quotePrice*(1-Math.max(.01,policy.slippageBps/10000)),floor>0?floor:Infinity);
                    sellQuotes.set(key,{quantity:order.sol,price,expires:Date.now()+6000});
                  } else sellQuotes.set(key,{reason:quote.reason??"Jupiter-myyntireitti ei kelpaa",expires:Date.now()+5000});
                }).catch(error=>{
                  if (!signal.aborted) sellQuotes.set(key,{reason:error.message,expires:Date.now()+5000});
                }).finally(()=>{selling--;streamWake?.();});
              } else tick.exitReason="Odotetaan varmennettuja mintin desimaaleja myyntitarjousta varten";
            }
            if (!tick.exitQuote) diagnostic?.({token:tick.token,stage:"paper-exit",outcome:"watch",
              reason:tick.exitReason??"Odotetaan tuoretta Jupiter-myyntitarjousta"});
          }
          exitBook = await commit(ticks,()=>0,()=>false);
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
                const key=positionKey(signalTick);
                const current=byKey.get(key);
                const fresh=current && !current.dataPool && current.at>=signalTick.signalAt;
                const moved=fresh && (current.price>signalTick.price*1.01 || current.price<signalTick.price*.97);
                if (fresh && !moved && current.at<=signalTick.routeExpires) {
                  ticks.push({ ...signalTick, ...current });
                  continue;
                }
                diagnostic?.({token:signalTick.token,stage:"execution",outcome:"watch",
                  reason:!fresh?"Tuore saman poolin toteutushinta puuttuu":current.at>signalTick.routeExpires
                    ?"Jupiter-reitti vanheni hintahaun aikana":"Hinta muuttui liikaa ennen toteutusta",
                  evidence:{signal:signalTick.price,current:current?.price,age:Date.now()-signalTick.signalAt}});
                if (!moved) continue;
                const item=queue.sniperItems.get(signalTick.token)??queue.items.get(signalTick.token);
                const at=Date.now();
                if (!item || at-(lastReprice.get(key)??0)<5000 ||
                    routeCache.get(key)?.checkedAt!==signalTick.signalAt) continue;
                // The old ticket no longer matches market data. Recheck the
                // strategy and obtain a separate quote for the new price.
                lastReprice.set(key,at);
                routeCache.delete(key);
                approvedTicks=approvedTicks.filter(tick=>positionKey(tick)!==key || tick.signalAt!==signalTick.signalAt);
                invalidateMarket(signalTick.token,signal,at,true);
                wake(item,50);
                diagnostic?.({token:signalTick.token,stage:"execution-reprice",outcome:"watch",
                  reason:"Muuttunut hinta käynnisti uuden analyysin ja tarjouksen"});
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
        if (momentum) for (const trade of updated.trades.slice(0,Math.max(0,tradeCountAfterCommit-tradeCount))) {
          diagnostic?.({token:trade.token,stage:trade.side==="Osto"?"paper-entry":"paper-exit",
            outcome:trade.side==="Osto" || trade.closed?"approve":"partial",reason:trade.detail});
          if (trade.closed) diagnostic?.({token:trade.token,stage:"learning",outcome:"approve",reason:"Suljetun position nettotulos"});
        }
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
    let virtualBusy = false;
    let nextMark=0;
    let nextFit=0;
    try {
      while (!signal.aborted) {
        await pause(3000, signal);
        if (signal.aborted) break;
        try {
          const now=Date.now();
          const shadow = !virtualBusy && routeActive===0 && now>=nextQuote ? learning.virtualDue(now)[0] : undefined;
          if (shadow) {
            virtualBusy=true;
            void Promise.all([analyzeCounterfactualExit(shadow.token,shadow.virtualEntry.tokenRaw,
              {signal,apiKey:jupiterKey,requestQuote,economic:true}), resolver.solPrice()]).then(([quote,sol])=>{
              if (signal.aborted) return;
              const recorded=learning.finishVirtual(shadow,quote,Date.now(),sol.price);
              diagnostic?.({token:shadow.token,stage:"virtual-learning",outcome:recorded?"approve":"reject",
                reason:recorded?undefined:quote.reason??"Tarjouksen toteutusikkuna vanheni",evidence:{horizon:shadow.next}});
            }).catch(error=>{
              if (!signal.aborted) diagnostic?.({token:shadow.token,stage:"virtual-learning",outcome:"watch",reason:error.message});
            }).finally(()=>{virtualBusy=false;});
          }
          if (now>=nextMark) {
            nextMark=now+10000;
            const due=learning.due(now);
            if (due.length) {
              const quotes=Date.now()<dexRetryAt?await tape.poolPrices(due):await pricesWithFallback(due);
              for (const tick of quotes) learning.mark(tick,tick.at);
            }
          }
          if (now>=nextFit) {
            nextFit=now+9000;
            calibration=learning.calibration(policy.momentumScore,Date.now());
          }
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
