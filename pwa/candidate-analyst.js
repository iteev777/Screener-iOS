// SPDX-License-Identifier: BUSL-1.1
import { momentumEntry } from "./momentum.js";
import { candidateQuality, trojanDecision } from "./trojan-analysis.js";

export function rankCandidates(rows, policy, now) {
  return rows.map(({ token, raw, sources: sourceNames }) => {
    const sources = new Set(sourceNames);
    const quality = raw && candidateQuality(raw, sources, now);
    let profile = policy.strategy === 6 ? "sniper" : "main";
    let strategy = null;
    if (raw && policy.strategy === 8) strategy = momentumEntry(raw, sources, policy.momentumScore, now);
    else if (raw && policy.strategy >= 5) strategy = trojanDecision(raw, sources, profile, now, policy);
    if (policy.strategy === 7 && raw && sources.has("PumpPortal")) {
      const sniper = trojanDecision(raw, sources, "sniper", now, policy);
      if (sniper.decision === "approve" || (strategy.decision !== "approve" && sniper.score > strategy.score)) {
        profile = "sniper";
        strategy = sniper;
      }
    }
    const decision = !raw ? "watch" : quality.tier === "reject" ? "reject" : strategy?.decision ?? "approve";
    return { token, quality, decision, strategy, profile };
  });
}

export function analystWorker(signal) {
  let worker;
  let id = 0;
  const pending = new Map();
  function close() {
    worker?.terminate();
    worker = undefined;
    for (const fallback of pending.values()) fallback();
    pending.clear();
  }
  if (typeof Worker === "function") {
    try {
      worker = new Worker(new URL("./analyst-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => pending.get(data.id)?.(data.result);
      worker.onerror = close;
      worker.onmessageerror = close;
      signal.addEventListener("abort", close, { once: true });
    } catch { close(); }
  }
  return async (rows, policy, now) => {
    if (!worker) return rankCandidates(rows, policy, now);
    return new Promise(resolve => {
      const current = ++id;
      const timer = setTimeout(close, 3000);
      pending.set(current, result => {
        clearTimeout(timer);
        pending.delete(current);
        resolve(result ?? (signal.aborted ? [] : rankCandidates(rows, policy, now)));
      });
      try {
        worker.postMessage({ id: current, rows, policy, now });
      } catch { close(); }
    });
  };
}
