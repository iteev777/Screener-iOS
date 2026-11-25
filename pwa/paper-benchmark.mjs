// SPDX-License-Identifier: BUSL-1.1
// Real read-only data, in-memory simulation. Requires Node 24+.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { advancePortfolio, newPortfolio, runScanner } from "./scanner.js";
import { defaults } from "./policy.js";
import { candidateQuality, trojanDecision } from "./trojan-analysis.js";

const strategy = Number(process.env.SCREENER_BENCH_STRATEGY ?? 8);
if (![5, 6, 7, 8].includes(strategy)) throw new Error("Use strategy 5, 6, 7, or 8.");
const duration = Math.max(900, Number(process.env.SCREENER_BENCH_SECONDS ?? 905));
if (!Number.isSafeInteger(duration) || duration > 7200) throw new Error("Duration must be 900–7200 seconds.");
const policy = { ...defaults, strategy };
const { instance: { exports: engine } } = await WebAssembly.instantiate(
  readFileSync(new URL("./engine.wasm", import.meta.url)));
const fetchRead = globalThis.fetch;
const pairs = new Map();
const methods = new Set(["getMultipleAccounts", "getBalance", "getTokenSupply", "getTransaction", "getSignaturesForAddress"]);
const http = new Map();
globalThis.fetch = async (url, options) => {
  if (options?.method && options.method !== "GET") {
    const method = JSON.parse(options.body)?.method;
    if (options.method !== "POST" || !methods.has(method)) throw new Error("Benchmark permits only read requests.");
  }
  const response = await fetchRead(url, options);
  const key = `${new URL(url).hostname} · ${response.status}`;
  http.set(key, (http.get(key) ?? 0) + 1);
  if (process.env.SCREENER_BENCH_PAIRS && response.ok && String(url).includes("/tokens/v1/solana/")) {
    try {
      for (const pair of await response.clone().json()) {
        const mint = pair.baseToken?.address;
        if (mint && !pairs.has(mint) && pairs.size < 300) pairs.set(mint, { pair, now: Date.now() });
      }
    } catch { /* The scanner validates the unchanged response. */ }
  }
  return response;
};

const controller = new AbortController();
const started = Date.now();
const timer = setTimeout(() => controller.abort(), duration * 1000);
let book = newPortfolio(policy.paperCapital);
let last;
let next = started;
let totalPump = 0;
let maxQueue = 0;
let peakWorkers = 0;
let learned;
const learningChanges = [];
let learningKey;
const stages = new Map();
const phases = ["discovery","pool-identification","price","market-analysis","safety","signal","route-check",
  "paper-entry","position","paper-exit","learning"];
const attempts = new Map();
const completions = new Map();
const sourceDiagnostics = new Map();
const uniqueFound = new Set();
const uniqueAnalyzed = new Set();
const uniqueApproved = new Set();
const uniqueRejected = new Set();
const outcomes = new Map();
const trace = process.env.SCREENER_BENCH_TRACE;
const lastDiagnostic = trace ? new Map() : null;
const calibration = new Map();
const closed = [];
const positionResults = new Map();
let processed = 0;
let fees = 0;
let slippageUsd = 0;
let buys = 0, sells = 0;
let delay = 0;
let delayedEntries = 0;
let peakEquity = policy.paperCapital;
let maxDrawdown = 0;
const equity = () => book.cash + Object.values(book.positions).reduce((sum, row) => sum + row.sol * row.mark, 0);
function recordPaper() {
  const newCount = (book.totalTrades ?? 0) - processed;
  for (const trade of book.trades.slice(0, newCount).reverse()) {
    if (trace) appendFileSync(trace,JSON.stringify({event:"fill",...trade})+"\n");
    fees += trade.feeUsd;
    const buy = trade.side === "Osto";
    if (buy) buys++; else sells++;
    if (Number.isFinite(trade.market?.price)) {
      slippageUsd += trade.quantity * Math.max(0, buy ? trade.price - trade.market.price : trade.market.price - trade.price);
    }
    if (trade.side === "Osto" && Number.isFinite(trade.executionDelayMs)) { delay += trade.executionDelayMs; delayedEntries++; }
    if (trade.side !== "Myynti") continue;
    const result = (positionResults.get(trade.token) ?? 0) + trade.realizedPnl;
    if (trade.closed) {
      closed.push({ pnl: result, heldMs: trade.heldMs });
      positionResults.delete(trade.token);
    } else positionResults.set(trade.token, result);
  }
  processed += newCount;
  const value = equity();
  peakEquity = Math.max(peakEquity, value);
  maxDrawdown = Math.max(maxDrawdown, (peakEquity - value) / peakEquity);
}
const log = value => console.log(JSON.stringify(value));
function funnel() {
  let progressed;
  return phases.map(phase=>{
    const attempted=attempts.get(phase) ?? new Set();
    const passed=completions.get(phase) ?? new Set();
    const fromPrevious=progressed?.size ?? attempted.size;
    const completed=progressed ? new Set([...passed].filter(token=>progressed.has(token))) : passed;
    progressed=completed;
    return {phase,attempted:attempted.size,passed:passed.size,fromPrevious,completed:completed.size,
      passRate:fromPrevious ? completed.size/fromPrevious : null};
  });
}
try {
  await runScanner({ engine, policy, timeframe: "1m", signal: controller.signal, load: async () => book,
    commit: async (ticks, decide, eligible) => {
      advancePortfolio(book, ticks, engine, policy, decide, eligible);
      recordPaper();
      return book;
    },
    saveLearning: async state => { learned = state; },
    diagnostic({ token, stage, outcome, reason, score, strategyCode, provider }) {
      if (trace) {
        const key=`${token}:${stage}`, value=`${outcome}:${reason??""}:${provider??""}`;
        if (lastDiagnostic.get(key)!==value) {
          if (lastDiagnostic.size>=24000) lastDiagnostic.delete(lastDiagnostic.keys().next().value);
          lastDiagnostic.set(key,value);
          appendFileSync(trace,JSON.stringify({event:"stage",at:Date.now(),token,stage,outcome,reason,score,strategyCode,provider})+"\n");
        }
      }
      if (phases.includes(stage)) {
        if (!attempts.has(stage)) attempts.set(stage,new Set());
        attempts.get(stage).add(token);
        if (outcome==="approve") {
          if (!completions.has(stage)) completions.set(stage,new Set());
          completions.get(stage).add(token);
        }
      }
      if (provider && ["price","pool-identification"].includes(stage)) {
        const key=`${stage}/${outcome} · ${provider}`;
        if (!sourceDiagnostics.has(key)) sourceDiagnostics.set(key,new Set());
        sourceDiagnostics.get(key).add(token);
      }
      if (["momentum","market","liquidity","mint","rug","pool","route","eligible"].includes(stage)) uniqueAnalyzed.add(token);
      if (stage === "eligible" && outcome === "approve") uniqueApproved.add(token);
      if (outcome === "reject" && ["market","momentum","liquidity","mint","rug","pool","route","portfolio"].includes(stage))
        uniqueRejected.add(token);
      const bucket = `${stage}/${outcome}`;
      if (!stages.has(bucket)) stages.set(bucket, new Set());
      stages.get(bucket).add(token);
      if (outcome !== "approve" && reason) {
        const key = `${bucket}: ${reason}`;
        if (!outcomes.has(key)) outcomes.set(key, new Set());
        outcomes.get(key).add(token);
      }
      if (["signal", "score"].includes(strategyCode)) calibration.set(token, Math.max(score, calibration.get(token) ?? 0));
    },
    report: (_, portfolio) => { if (portfolio) book = portfolio; },
    event(entry) {
      if (entry.status !== "found") return;
      uniqueFound.add(entry.mint);
      if (entry.reason === "PumpPortal") totalPump++;
    },
    telemetry(stats) {
      last = stats;
      if (stats.learning) {
        const key = stats.learning.modelRevision + ":" + Object.values(stats.learning.tracks).map(track => track.threshold).join("/");
        if (key !== learningKey) {
          learningChanges.push({seconds: Math.floor((Date.now()-started)/1000), ...stats.learning});
          learningKey = key;
        }
      }
      peakWorkers = Math.max(peakWorkers, stats.peakWorkers);
      maxQueue = Math.max(maxQueue, stats.queued);
      if (Date.now() >= next) {
        next = Date.now() + 60000;
        log({ seconds: Math.floor((Date.now() - started) / 1000), ...stats, totalPump, funnel:funnel() });
      }
    }
  });
} finally { clearTimeout(timer); }
if (process.env.SCREENER_BENCH_PAIRS) {
  const sources = new Set(["DEX", "PumpPortal"]);
  for (const { pair, now } of pairs.values()) {
    appendFileSync(process.env.SCREENER_BENCH_PAIRS, JSON.stringify({
      pair, now, jsMain: trojanDecision(pair, sources, "main", now).decision,
      jsSniper: trojanDecision(pair, sources, "sniper", now).decision,
      jsQuality: candidateQuality(pair, sources, now).score
    }) + "\n");
  }
}
if (process.env.SCREENER_BENCH_LEARNING && learned) {
  writeFileSync(process.env.SCREENER_BENCH_LEARNING, JSON.stringify(learned, null, 2) + "\n");
}
log({ final: true, strategy, seconds: (Date.now() - started) / 1000, last, totalPump, peakWorkers, maxQueue,
  funnel:funnel(), sourceDiagnostics:Object.fromEntries([...sourceDiagnostics].map(([key,tokens])=>[key,tokens.size])),
  stages: Object.fromEntries([...stages].map(([key, tokens]) => [key, tokens.size])),
  topReasons: [...outcomes].map(([key, tokens]) => [key, tokens.size]).sort((a, b) => b[1] - a[1]).slice(0, 30),
  reasonsByStage:Object.fromEntries([...outcomes].reduce((grouped,[key,tokens])=>{
    const split=key.indexOf(": ");
    const bucket=key.slice(0,split);
    if (!grouped.has(bucket)) grouped.set(bucket,[]);
    grouped.get(bucket).push([key.slice(split+2),tokens.size]);
    return grouped;
  },new Map()).entries()),
  thresholds: Object.fromEntries([70, 72, 76, 80, 84, 88].map(threshold =>
    [threshold, [...calibration.values()].filter(score => score >= threshold).length])),
  uniqueFound: uniqueFound.size, uniqueAnalyzed: uniqueAnalyzed.size, uniqueApproved: uniqueApproved.size, uniqueRejected: uniqueRejected.size,
  learningChanges, learnedSamples: learned?.samples.length ?? 0,
  trades: book.totalTrades ?? 0, buys, sells, closed: closed.length, open: Object.keys(book.positions).length,
  winRate: closed.length ? closed.filter(position => position.pnl > 0).length / closed.length : null,
  averageHoldMs: closed.length ? closed.reduce((sum, position) => sum + position.heldMs, 0) / closed.length : null,
  equity: equity(), netReturn: equity() / policy.paperCapital - 1,
  grossReturnEstimate: (equity() + fees + slippageUsd) / policy.paperCapital - 1,
  unrealized: equity() - policy.paperCapital - book.realized, maxDrawdown, fees, slippageUsd,
  averageEntryDelayMs: delayedEntries ? delay / delayedEntries : null, cash: book.cash, realized: book.realized, samples: pairs.size, http: Object.fromEntries(http) });
