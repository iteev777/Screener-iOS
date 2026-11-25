// SPDX-License-Identifier: BUSL-1.1
// Real read-only data, in-memory simulation. Requires Node 24+.
import { appendFileSync, readFileSync } from "node:fs";
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
const stages = new Map();
const outcomes = new Map();
const calibration = new Map();
const closed = [];
const positionResults = new Map();
let processed = 0;
let fees = 0;
let delay = 0;
let delayedEntries = 0;
let peakEquity = policy.paperCapital;
let maxDrawdown = 0;
const equity = () => book.cash + Object.values(book.positions).reduce((sum, row) => sum + row.sol * row.mark, 0);
function recordPaper() {
  const newCount = (book.totalTrades ?? 0) - processed;
  for (const trade of book.trades.slice(0, newCount).reverse()) {
    fees += trade.feeUsd;
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
try {
  await runScanner({ engine, policy, timeframe: "1m", signal: controller.signal, load: async () => book,
    commit: async (ticks, decide, eligible) => {
      advancePortfolio(book, ticks, engine, policy, decide, eligible);
      recordPaper();
      return book;
    },
    diagnostic({ token, stage, outcome, reason, score, strategyCode }) {
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
    event: event => { if (event.status === "found" && event.reason === "PumpPortal") totalPump++; },
    telemetry(stats) {
      last = stats;
      peakWorkers = Math.max(peakWorkers, stats.peakWorkers);
      maxQueue = Math.max(maxQueue, stats.queued);
      if (Date.now() >= next) {
        next = Date.now() + 60000;
        log({ seconds: Math.floor((Date.now() - started) / 1000), ...stats, totalPump });
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
log({ final: true, strategy, seconds: (Date.now() - started) / 1000, last, totalPump, peakWorkers, maxQueue,
  stages: Object.fromEntries([...stages].map(([key, tokens]) => [key, tokens.size])),
  topReasons: [...outcomes].map(([key, tokens]) => [key, tokens.size]).sort((a, b) => b[1] - a[1]).slice(0, 30),
  thresholds: Object.fromEntries([70, 72, 76, 80, 84, 88].map(threshold =>
    [threshold, [...calibration.values()].filter(score => score >= threshold).length])),
  trades: book.totalTrades ?? 0, closed: closed.length, open: Object.keys(book.positions).length,
  winRate: closed.length ? closed.filter(position => position.pnl > 0).length / closed.length : null,
  averageHoldMs: closed.length ? closed.reduce((sum, position) => sum + position.heldMs, 0) / closed.length : null,
  equity: equity(), netReturn: equity() / policy.paperCapital - 1, maxDrawdown, fees,
  averageEntryDelayMs: delayedEntries ? delay / delayedEntries : null, cash: book.cash, realized: book.realized, samples: pairs.size, http: Object.fromEntries(http) });
