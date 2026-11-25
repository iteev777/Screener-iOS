// SPDX-License-Identifier: BUSL-1.1
// Paper-only feedback. Shadow marks and realized position returns are kept separate.
const horizon = 120000;
const maxLabelDelay = 180000;
const maxPending = 96;
const maxSamples = 240;
const keyOf = ({ token, pool }) => `${token}:${pool}`;
const allowedTracks = new Set(["rolling", "short", "early"]);
export const scoreBand = (anchor, value) =>
  Math.max(50, anchor - 4, Math.min(100, anchor + 6, Number.isFinite(value) ? value : anchor));

export function mergeLearning(previous, next, now = Date.now()) {
  if (previous?.version !== 1) return next;
  const samples = [...new Map([...previous.samples, ...next.samples].map(row =>
    [`${row.type}:${row.key}:${row.at}`, row])).values()].sort((a,b) => a.at-b.at).slice(-maxSamples);
  const lastLabel = new Map(samples.filter(row => row.type === "shadow").map(row => [row.key, row.at]));
  const pending = [...new Map([...previous.pending, ...next.pending].map(row => [keyOf(row), row])).values()]
    .filter(row => row.at > (lastLabel.get(keyOf(row)) ?? 0) && now - row.at <= horizon + maxLabelDelay)
    .sort((a,b) => a.at-b.at).slice(-maxPending);
  return { version: 1, samples, pending, paperKeys: [...new Set([...previous.paperKeys, ...next.paperKeys])].slice(-200) };
}

export function paperLearning(snapshot, policy) {
  const pending = new Map((snapshot?.version === 1 ? (snapshot.pending ?? []) : [])
    .filter(row => allowedTracks.has(row.track) && Number.isFinite(row.at) && row.price > 0 && row.liquidity > 0)
    .slice(-maxPending).map(row => [keyOf(row), row]));
  const samples = snapshot?.version === 1 ? (snapshot.samples ?? []).filter(row =>
    allowedTracks.has(row.track) && Number.isFinite(row.net) && Number.isFinite(row.at) &&
    (row.type === "paper" || row.type === "shadow")).slice(-maxSamples) : [];
  const paperKeys = new Set(snapshot?.version === 1 ? (snapshot.paperKeys ?? []).slice(-200) : []);
  const feeFloor = policy.feeBps / 10000;
  const slipFloor = policy.slippageBps / 10000;
  let generation = 0;
  let savedGeneration = 0;

  function append(sample) {
    samples.push(sample);
    if (samples.length > maxSamples) samples.shift();
    generation++;
  }

  return {
    proveSafety(market, safe) {
      const sample = pending.get(keyOf(market));
      if (!sample || sample.verified === safe) return;
      sample.verified = safe;
      generation++;
    },
    observe(market, now, track, score, calibratable, verified = false) {
      if (!allowedTracks.has(track) || !Number.isFinite(score) || !Number.isFinite(market.price) ||
          market.price <= 0 || market.liquidity < policy.minLiquidity || !(market.liquidity > 0) ||
          !Number.isFinite(now) || pending.has(keyOf(market)) || pending.size >= maxPending) return;
      // At most one sample per pool per horizon, including after an app reload.
      if (samples.some(s => s.type === "shadow" && s.key === keyOf(market) && s.at + horizon > now)) return;
      const { token, pool, price, liquidity } = market;
      pending.set(keyOf(market), { token, pool, price, liquidity, at: now, track, score, calibratable, verified });
      generation++;
    },
    due(now) {
      for (const [key, sample] of pending) if (now - sample.at > horizon + maxLabelDelay) { pending.delete(key); generation++; }
      return [...pending.values()].filter(sample => now - sample.at >= horizon).slice(0, 15);
    },
    mark(market, at) {
      const key = keyOf(market);
      const sample = pending.get(key);
      if (!sample || at - sample.at < horizon || at - sample.at > horizon + maxLabelDelay ||
          !Number.isFinite(market.price) || market.price <= 0 || !(market.liquidity > 0)) return false;
      pending.delete(key);
      const ticket = Math.min(policy.orderUsd, policy.momentumMaxUsd);
      const entrySlip = Math.max(slipFloor, ticket / (sample.liquidity / 2 + ticket));
      const exitSlip = Math.max(slipFloor, ticket / (market.liquidity / 2 + ticket));
      const net = market.price * (1 - exitSlip) * (1 - feeFloor) ** 2 / (sample.price * (1 + entrySlip)) - 1;
      append({ type: "shadow", key, track: sample.track, score: sample.score, calibratable: sample.calibratable, verified: sample.verified, net, at });
      return true;
    },
    recordTrades(trades) {
      const opened = new Map();
      for (const trade of [...trades].reverse()) {
        if (trade.strategy !== 8) continue;
        const key = keyOf(trade);
        if (trade.side === "Osto") {
          opened.set(key, { ...trade, pnl: 0 });
          continue;
        }
        const entry = opened.get(key);
        if (!entry || !Number.isFinite(trade.realizedPnl)) continue;
        entry.pnl += trade.realizedPnl;
        if (!trade.closed) continue;
        opened.delete(key);
        const fillKey = `${key}:${entry.at}:${trade.at}`;
        if (paperKeys.has(fillKey) || !(entry.notional > 0) || !Number.isFinite(entry.score)) continue;
        paperKeys.add(fillKey);
        if (paperKeys.size > 200) paperKeys.delete(paperKeys.values().next().value);
        append({ type: "paper", key, track: entry.track ?? "rolling", score: entry.score, net: entry.pnl / entry.notional, at: trade.at });
      }
    },
    calibration(anchor, now) {
      const tracks = {};
      for (const track of allowedTracks) {
        const recent = samples.filter(s => s.track === track && s.at >= now - 86400000 && s.at <= now);
        const paper = recent.filter(s => s.type === "paper");
        // Lower only on repeated net-positive moves near the entry floor. Unfilled
        // quotes are evidence about price movement; they never prove execution.
        const shadow = [...new Map(recent.filter(s =>
          s.type === "shadow" && s.calibratable && s.verified && s.score >= anchor - 8 && s.score < anchor + 4
        ).map(s => [s.key, s])).values()];
        const mean = rows => rows.reduce((sum,row) => sum + Math.max(-.15, Math.min(.15, row.net)), 0) / rows.length;
        const wins = rows => rows.filter(s => s.net > 0).length / rows.length;
        const offset = paper.length >= 12 && mean(paper) < -.005 ? 6
          : shadow.length >= 18 && mean(shadow) < -.01 ? 3
          : shadow.length >= 18 && wins(shadow) >= .65 && mean(shadow) > .02 ? -4 : 0;
        tracks[track] = { threshold: scoreBand(anchor, anchor + offset), shadow: shadow.length, paper: paper.length };
      }
      return { tracks, shadow: samples.filter(s => s.type === "shadow").length,
        paper: samples.filter(s => s.type === "paper").length, pending: pending.size };
    },
    get dirty() { return generation !== savedGeneration; },
    get generation() { return generation; },
    saved(version) { savedGeneration = version; },
    snapshot: () => ({ version: 1, samples: [...samples], pending: [...pending.values()], paperKeys: [...paperKeys] })
  };
}
