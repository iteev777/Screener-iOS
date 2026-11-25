// SPDX-License-Identifier: BUSL-1.1
// Paper-only feedback. Shadow marks and realized position returns are kept separate.
import { fitSignalWeights } from "./paper-signal-model.js";
const horizon = 120000;
const checkpoints = [15, 30, 60, 120, 300, 900, 3600];
const expiry = seconds => seconds < 60 ? 12 : seconds === 60 ? 25 : seconds === 120 ? 75 : seconds === 300 ? 60 : 120;
const keepLong = 20;
const schemaVersions = new Set([1,2]);
const maxSamplesPerHorizon = 240;
const maxModels = 10;
const sampleId = row => `${row.type}:${row.key}:${row.horizon ?? 120}:${row.observedAt ?? row.at}`;
const maxPending = 96;

const keyOf = ({ token, pool }) => `${token}:${pool}`;
const allowedTracks = new Set(["rolling", "short", "early"]);
export const scoreBand = (anchor, value) =>
  Math.max(50, anchor - 4, Math.min(100, anchor + 6, Number.isFinite(value) ? value : anchor));

function trimSamples(rows) {
  const grouped = new Map();
  for (const row of rows.sort((a,b) => a.at-b.at)) {
    const key = row.type === "paper" ? "paper" : row.horizon ?? 120;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.values()].flatMap(rows => {
    const vetted = rows.filter(row => row.verified && row.calibratable).slice(-80);
    return [...new Map([...vetted, ...rows.slice(-(maxSamplesPerHorizon - vetted.length))]
      .map(row => [sampleId(row), row])).values()];
  }).sort((a,b) => a.at-b.at);
}

function mergeModels(previous, next) {
  return [...new Map([...previous, ...next].map(row => [row.id,row])).values()]
    .sort((a,b) => a.at-b.at).slice(-maxModels);
}

export function mergeLearning(previous, next, now = Date.now()) {
  if (!schemaVersions.has(previous?.version)) return next;
  const samples = trimSamples([...new Map([...previous.samples, ...next.samples].map(row =>
    [sampleId(row), row])).values()]);
  const lastLabel = new Map();
  for (const row of samples) if (row.type === "shadow") {
    const previous = lastLabel.get(row.key);
    const observedAt = row.observedAt ?? row.at;
    if (!previous || observedAt > previous.at || observedAt === previous.at && (row.horizon ?? 120) > previous.horizon)
      lastLabel.set(row.key,{at:observedAt,horizon:row.horizon ?? 120});
  }
  const pending = [...new Map([...previous.pending, ...next.pending].map(row => [keyOf(row), row])).values()]
    .flatMap(row => {
      const labelled = lastLabel.get(keyOf(row));
      const remaining = (row.remaining ?? [120]).filter(seconds =>
        (!labelled || row.at > labelled.at || row.at === labelled.at && seconds > labelled.horizon) &&
        now - row.at <= (seconds + expiry(seconds))*1000);
      return remaining.length ? [{ ...row, remaining }] : [];
    }).sort((a,b) => a.at-b.at).slice(-maxPending);
  return { version: 2, samples, pending, paperKeys: [...new Set([...previous.paperKeys, ...next.paperKeys])].slice(-200),
    models: mergeModels(previous.models ?? [],next.models ?? []) };
}

export function paperLearning(snapshot, policy) {
  const pending = new Map((schemaVersions.has(snapshot?.version) ? (snapshot.pending ?? []) : [])
    .filter(row => allowedTracks.has(row.track) && Number.isFinite(row.at) && row.price > 0 && row.liquidity > 0)
    .slice(-maxPending).map(row => [keyOf(row), { ...row, remaining: row.remaining ?? [120] }]));
  let samples = schemaVersions.has(snapshot?.version) ? trimSamples((snapshot.samples ?? []).filter(row =>
    allowedTracks.has(row.track) && Number.isFinite(row.net) && Number.isFinite(row.at) &&
    (row.type === "paper" || row.type === "shadow"))) : [];
  const paperKeys = new Set(schemaVersions.has(snapshot?.version) ? (snapshot.paperKeys ?? []).slice(-200) : []);
  const feeFloor = policy.feeBps / 10000;
  const slipFloor = policy.slippageBps / 10000;
  let generation = 0;
  let savedGeneration = 0;
  let models = snapshot?.models?.slice(-maxModels) ?? [];
  let lastTraining = 0;
  let lastModelSignature = JSON.stringify(models.at(-1)?.weights ?? {});
  const rollback = policy.momentumRollback === 1;
  const previousModel = models.at(-2) ?? {id:"baseline", settings:undefined, weights:{}};
  const activeModel = () => rollback ? previousModel : models.at(-1);

  function append(sample) {
    samples.push(sample);
    if (samples.length > 1920) samples = trimSamples(samples);
    generation++;
  }

  return {
    proveSafety(market, safe) {
      const sample = pending.get(keyOf(market));
      if (!sample || sample.verified === safe) return;
      sample.verified = safe;
      generation++;
    },
    observe(market, now, track, score, calibratable, verified = false, context = {}) {
      if (!allowedTracks.has(track) || !Number.isFinite(score) || !Number.isFinite(market.price) ||
          market.price <= 0 || market.liquidity < policy.minLiquidity || !(market.liquidity > 0) ||
          !Number.isFinite(now) || pending.has(keyOf(market)) || pending.size >= maxPending) return;
      // At most one sample per pool per horizon, including after an app reload.
      if (samples.some(s => s.type === "shadow" && s.key === keyOf(market) && (s.observedAt ?? s.at) + horizon > now)) return;
      const long = calibratable && [...pending.values()].filter(row => row.remaining.some(seconds=>seconds>=900)).length < keepLong;
      const { token, pool, price, liquidity } = market;
      pending.set(keyOf(market), { token, pool, price, liquidity, at: now, track, score, calibratable, verified, ...context, remaining: long ? [...checkpoints] : checkpoints.slice(0,5) });
      generation++;
    },
    due(now) {
      const ready = [];
      for (const [key, sample] of pending) {
        const remaining = sample.remaining.filter(seconds => now - sample.at <= (seconds + expiry(seconds))*1000);
        if (remaining.length !== sample.remaining.length) {
          generation++;
          if (!remaining.length) { pending.delete(key); continue; }
          sample.remaining = remaining;
        }
        const next = remaining.find(seconds => now - sample.at >= seconds*1000);
        if (next != null) ready.push({ ...sample, next });
      }
      return ready.sort((a,b) => Number(b.verified) - Number(a.verified) ||
        (a.at + (a.next + expiry(a.next))*1000) - (b.at + (b.next + expiry(b.next))*1000)).slice(0, 15);
    },
    mark(market, at) {
      const key = keyOf(market);
      const sample = pending.get(key);
      if (!sample || !Number.isFinite(market.price) || market.price <= 0 || !(market.liquidity > 0)) return false;
      const elapsed = (at - sample.at) / 1000;
      const window = sample.remaining.findLast(seconds => elapsed >= seconds && elapsed <= seconds + expiry(seconds));
      if (window === undefined) return false;
      sample.remaining = sample.remaining.filter(seconds => seconds > window);
      if (!sample.remaining.length) pending.delete(key);
      const ticket = Math.min(policy.orderUsd, policy.momentumMaxUsd);
      const entrySlip = Math.max(slipFloor, ticket / (sample.liquidity / 2 + ticket));
      const exitSlip = Math.max(slipFloor, ticket / (market.liquidity / 2 + ticket));
      const net = market.price * (1 - exitSlip) * (1 - feeFloor) ** 2 / (sample.price * (1 + entrySlip)) - 1;
      append({ type: "shadow", key, track: sample.track, score: sample.score, calibratable: sample.calibratable, verified: sample.verified, features:sample.features, segment:sample.segment,
        observedAt:sample.at, horizon:window, missed:sample.missed, net, at });
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
        append({ type: "paper", key, track: entry.track ?? "rolling", score: entry.score, features:entry.features, segment:entry.segment, net: entry.pnl / entry.notional, at: trade.at });
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
          s.type === "shadow" && (s.horizon ?? 120) === 120 && s.calibratable && s.verified && s.score >= anchor - 8 && s.score < anchor + 4
        ).map(s => [s.key, s])).values()];
        const mean = rows => rows.reduce((sum,row) => sum + Math.max(-.15, Math.min(.15, row.net)), 0) / rows.length;
        const wins = rows => rows.filter(s => s.net > 0).length / rows.length;
        const offset = paper.length >= 12 && mean(paper) < -.005 ? 6
          : shadow.length >= 18 && mean(shadow) < -.01 ? 3
          : shadow.length >= 18 && wins(shadow) >= .65 && mean(shadow) > .02 ? -4 : 0;
        tracks[track] = { threshold: scoreBand(anchor, anchor + offset), shadow: shadow.length, paper: paper.length };
      }
      if (!rollback && now - lastTraining >= 300000) {
        lastTraining = now;
        const weights = fitSignalWeights(samples, now);
        const signature = JSON.stringify(weights);
        const lastSettings = models.at(-1)?.settings;
        const settings = Object.fromEntries(Object.entries(tracks).map(([track,row])=>[track,row.threshold-anchor]));
        const previousSettings = lastSettings ?? {rolling:0,short:0,early:0};
        if (signature !== lastModelSignature || JSON.stringify(settings) !== JSON.stringify(previousSettings)) {
          lastModelSignature = signature;
          models = mergeModels(models, [{id:now, at:now, settings, weights}]);
          generation++;
        }
      }
      const model = activeModel();
      if (rollback) for (const [track,row] of Object.entries(tracks)) {
        row.threshold = scoreBand(anchor,anchor + (model.settings?.[track] ?? 0));
      }
      const checkpointCounts = {};
      for (const row of samples) if (row.type === "shadow") checkpointCounts[row.horizon ?? 120] = (checkpointCounts[row.horizon ?? 120] ?? 0) + 1;
      return { tracks, weights: model?.weights ?? {}, modelRevision: model?.id ?? "baseline", rollback,
        versions: models.length, checkpointCounts,
        missed: samples.filter(row => row.type === "shadow" && row.horizon === 120 && row.missed && row.verified && row.calibratable && row.net > 0).length,
        shadow: samples.filter(s => s.type === "shadow").length,
        paper: samples.filter(s => s.type === "paper").length, pending: pending.size };
    },
    get dirty() { return generation !== savedGeneration; },
    get generation() { return generation; },
    saved(version) { savedGeneration = version; },
    snapshot: () => ({ version: 2, samples: trimSamples([...samples]), pending: [...pending.values()], paperKeys: [...paperKeys], models })
  };
}
