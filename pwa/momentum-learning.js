// SPDX-License-Identifier: BUSL-1.1
// Paper-only feedback. Shadow marks and realized position returns are kept separate.
import { fitSignalWeights, fitExecutionRegimes, chronologicalSplit } from "./paper-signal-model.js";
const horizon = 120000;
const checkpoints = [15,30,60,120,180,300,900,3600];
const virtualCheckpoints = [15,30,60,120,180,300,900];
const virtualWindow = seconds => seconds < 60 ? 10 : seconds <= 180 ? 20 : 45;
const expiry = seconds => seconds < 60 ? 12 : seconds === 60 ? 25 : seconds === 120 ? 45 : seconds === 180 ? 30 : seconds === 300 ? 60 : 120;
const keepLong = 20;
const schemaVersions = new Set([1,2,3,4]);
const maxSamplesPerHorizon = 240;
const maxModels = 10;
const sampleId = row => `${row.type}:${row.key}:${row.horizon ?? 120}:${row.observedAt ?? row.at}:${Boolean(row.executable)}`;
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
    const vetted = rows.filter(row => row.executable && row.verified && row.calibratable).slice(-80);
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
  const lastLabel = new Map(), completedVirtual = new Map();
  for (const row of samples) if (row.type === "shadow") {
    if (row.executable) {
      const id=`${row.key}:${row.observedAt}`;
      const done=completedVirtual.get(id)??new Set();
      done.add(row.horizon);
      completedVirtual.set(id,done);
      continue;
    }
    const previous = lastLabel.get(row.key);
    const observedAt = row.observedAt ?? row.at;
    if (!previous || observedAt > previous.at || observedAt === previous.at && (row.horizon ?? 120) > previous.horizon)
      lastLabel.set(row.key,{at:observedAt,horizon:row.horizon ?? 120});
  }
  const mergedPending=new Map();
  for (const row of [...previous.pending,...next.pending]) {
    const key=keyOf(row);
    const prior=mergedPending.get(key);
    if (prior?.at>row.at) continue;
    if (prior?.at===row.at && prior.virtualEntry && !row.virtualEntry) {
      mergedPending.set(key,{...row,virtualEntry:prior.virtualEntry,virtualRemaining:prior.virtualRemaining});
    } else if (prior?.at===row.at && prior.virtualEntry?.at===row.virtualEntry?.at &&
        prior.virtualRemaining && row.virtualRemaining) {
      mergedPending.set(key,{...row,virtualRemaining:row.virtualRemaining.filter(s=>prior.virtualRemaining.includes(s))});
    } else mergedPending.set(key,row);
  }
  const pending=[...mergedPending.values()]
    .flatMap(row => {
      const labelled = lastLabel.get(keyOf(row));
      const remaining = (row.remaining ?? [120]).filter(seconds =>
        (!labelled || row.at > labelled.at || row.at === labelled.at && seconds > labelled.horizon) &&
        now - row.at <= (seconds + expiry(seconds))*1000);
      const completed=completedVirtual.get(`${keyOf(row)}:${row.at}`);
      const virtualRemaining=(row.virtualRemaining??(row.virtualDone?[]:virtualCheckpoints))
        .filter(seconds=>!completed?.has(seconds));
      return remaining.length || row.virtualEntry && virtualRemaining.length
        ? [{ ...row, remaining, virtualRemaining }] : [];
    }).sort((a,b) => a.at-b.at).slice(-maxPending);
  return { version:4,samples,pending,paperKeys:[...new Set([...previous.paperKeys,...next.paperKeys])].slice(-200),
    models:mergeModels(previous.version>=3 ? previous.models??[] : [],next.models??[]) };
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
  let models = snapshot?.version>=3 ? snapshot.models?.slice(-maxModels) ?? [] : [];
  let lastTraining = 0;
  let lastModelSignature = JSON.stringify([models.at(-1)?.weights??{},models.at(-1)?.regimes??{}]);
  const rollback = policy.momentumRollback === 1;
  const previousModel = models.at(-2) ?? {id:"baseline", settings:undefined, weights:{}};
  const activeModel = () => rollback ? previousModel : models.at(-1);

  function append(sample) {
    samples.push(sample);
    if (samples.length > 2500) samples = trimSamples(samples);
    generation++;
  }

  return {
    proveSafety(market, safe) {
      const sample = pending.get(keyOf(market));
      if (!sample || sample.verified === safe) return;
      sample.verified = safe;
      generation++;
    },
    routeWanted(market, now) {
      const row=pending.get(keyOf(market));
      return Boolean(row?.missed && row.verified && row.calibratable && !row.virtualEntry && now-row.at<=15000);
    },
    proveRoute(market, proof, at, missed = false) {
      const row=pending.get(keyOf(market));
      const positiveInteger=value=>typeof value==="string" && /^[1-9]\d{0,19}$/.test(value);
      if (!row?.verified || !row.calibratable || row.virtualEntry || !(at >= row.at && at-row.at <= 15000) ||
          !(proof?.quoteUsd > 0) || !(proof.entrySlip>=0 && proof.entrySlip<=.01) ||
          !positiveInteger(proof.inLamports) || !positiveInteger(proof.tokenRaw)) return;
      row.virtualEntry={...proof,at};
      row.virtualRemaining=[...virtualCheckpoints];
      row.missed ||= missed;
      generation++;
    },
    virtualDue(now) {
      return [...pending.values()].flatMap(row=>{
        if (!row.virtualEntry) return [];
        const elapsed=(now-row.virtualEntry.at)/1000;
        const next=(row.virtualRemaining??(row.virtualDone?[]:[120])).findLast(s=>elapsed>=s && elapsed<=s+virtualWindow(s));
        return next===undefined ? [] : [{...row,next,expires:row.virtualEntry.at+(next+virtualWindow(next))*1000}];
      }).sort((a,b)=>a.expires-b.expires);
    },
    finishVirtual(market, quote, at, solUsd) {
      const row=pending.get(keyOf(market)), entry=row?.virtualEntry;
      if (!entry) return false;
      const elapsed=(at-entry.at)/1000;
      const remaining=row.virtualRemaining??(row.virtualDone?[]:[120]);
      const next=market.next??remaining.findLast(s=>elapsed>=s && elapsed<=s+virtualWindow(s));
      if (!remaining.includes(next) || elapsed<next || elapsed>next+virtualWindow(next)) return false;
      row.virtualRemaining=remaining.filter(seconds=>seconds>next);
      generation++;
      // Route outputs already incorporate pool fees and price impact. Apply
      // the quoted slippage allowance and local fee budget conservatively.
      if (!quote?.allowed || !(solUsd>0) || !/^\d{1,20}$/.test(quote.lamports??"")) return false;
      const quoted=Number(quote.lamports), minimum=Number(quote.minLamports);
      const sellSlip=Math.max(slipFloor,.01);
      const proceeds=Math.min(quoted*(1-sellSlip),minimum>0?minimum:Infinity)*solUsd*(1-feeFloor);
      const cost=Number(entry.inLamports)*entry.quoteUsd*(1+Math.max(slipFloor,entry.entrySlip))*(1+feeFloor);
      if (!(proceeds>0 && cost>0 && Number.isFinite(proceeds/cost))) return false;
      append({type:"shadow", executable:true, key:keyOf(market), track:row.track, score:row.score, calibratable:true,
        verified:true,features:row.features,segment:row.segment,observedAt:row.at,horizon:next,missed:row.missed,
        net:proceeds/cost-1,at});
      return true;
    },
    observe(market, now, track, score, calibratable, verified = false, context = {}) {
      const key=keyOf(market);
      const previous=pending.get(key);
      if (!allowedTracks.has(track) || !Number.isFinite(score) || !Number.isFinite(market.price) ||
          market.price <= 0 || market.liquidity < policy.minLiquidity || !(market.liquidity > 0) ||
          !Number.isFinite(now) || previous && (!calibratable || previous.calibratable || now<=previous.at)) return;
      // At most one sample per pool per horizon, including after an app reload.
      if (samples.some(s => s.type === "shadow" && s.key === key && (!calibratable || s.calibratable) &&
          (s.observedAt ?? s.at)+horizon>now)) return;
      if (!previous && pending.size >= maxPending) {
        if (!calibratable) return;
        const weak = [...pending].find(([,row])=>!row.calibratable && !row.virtualEntry);
        if (!weak) return;
        pending.delete(weak[0]);
      }
      const long = calibratable && [...pending.values()].filter(row => row.remaining.some(seconds=>seconds>=900)).length < keepLong;
      const { token, pool, price, liquidity } = market;
      pending.set(key,{token,pool,price,liquidity,at:now,track,score,calibratable,verified,...context,
        remaining:long?[...checkpoints]:checkpoints.filter(s=>s<=300)});
      generation++;
    },
    due(now) {
      const ready = [];
      for (const [key, sample] of pending) {
        const remaining = sample.remaining.filter(seconds => now - sample.at <= (seconds + expiry(seconds))*1000);
        if (!remaining.length && !sample.virtualRemaining?.some(seconds=>
          now-sample.virtualEntry?.at <= (seconds+virtualWindow(seconds))*1000)) {
          pending.delete(key);
          generation++;
          continue;
        }
        if (remaining.length !== sample.remaining.length) {
          generation++;
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
      if (!sample.remaining.length && (!sample.virtualEntry || !sample.virtualRemaining?.length)) pending.delete(key);
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
        append({type:"paper",key,track:entry.track??"rolling",score:entry.score,features:entry.features,segment:entry.segment,
          net:entry.pnl/entry.notional,observedAt:entry.at,at:trade.at});
      }
    },
    calibration(anchor, now) {
      const tracks = {};
      for (const track of allowedTracks) {
        const recent = samples.filter(s => s.track === track && s.at >= now - 86400000 && s.at <= now);
        const paper=[...new Map(recent.filter(s=>s.type==="paper").map(s=>[s.key,s])).values()];
        const shadow = [...new Map(recent.filter(s =>
          s.type === "shadow" && s.executable && [120,180].includes(s.horizon) && s.calibratable && s.verified &&
          s.score >= anchor - 8 && s.score < anchor + 4
        ).map(s => [s.key, s])).values()].sort((a,b)=>a.at-b.at);
        const mean = rows => rows.reduce((sum,row) => sum + Math.max(-.15, Math.min(.15, row.net)), 0) / rows.length;
        const wins = rows => rows.filter(s => s.net > 0).length / rows.length;
        const supported=(data,minimum,condition)=>data.length>=minimum &&
          chronologicalSplit(data).every(rows=>rows.length>=6 && condition(rows));
        const offset = supported(paper,24,rows=>mean(rows)<-.005) ? 6
          : supported(shadow,18,rows=>mean(rows)<-.01) ? 3
          : supported(shadow,18,rows=>wins(rows)>=.65 && mean(rows)>.02) ? -4 : 0;
        tracks[track] = { threshold: scoreBand(anchor, anchor + offset), shadow: shadow.length, paper: paper.length };
      }
      if (!rollback && now - lastTraining >= 300000) {
        lastTraining = now;
        const weights = fitSignalWeights(samples, now);
        const regimes=fitExecutionRegimes(samples,now);
        const signature = JSON.stringify([weights,regimes]);
        const lastSettings = models.at(-1)?.settings;
        const settings = Object.fromEntries(Object.entries(tracks).map(([track,row])=>[track,row.threshold-anchor]));
        const previousSettings = lastSettings ?? {rolling:0,short:0,early:0};
        if (signature !== lastModelSignature || JSON.stringify(settings) !== JSON.stringify(previousSettings)) {
          lastModelSignature = signature;
          models = mergeModels(models, [{id:now, at:now, settings, weights, regimes}]);
          generation++;
        }
      }
      const model = activeModel();
      if (rollback) for (const [track,row] of Object.entries(tracks)) {
        row.threshold = scoreBand(anchor,anchor + (model.settings?.[track] ?? 0));
      }
      const checkpointCounts = {};
      for (const row of samples) if (row.type === "shadow" && !row.executable) checkpointCounts[row.horizon ?? 120] = (checkpointCounts[row.horizon ?? 120] ?? 0) + 1;
      const executableCounts={};
      for (const row of samples) if (row.executable) executableCounts[row.horizon]=(executableCounts[row.horizon]??0)+1;
      return { tracks, weights: model?.weights ?? {}, regimes:model?.regimes??{}, modelRevision: model?.id ?? "baseline", rollback,
        versions: models.length, checkpointCounts,
        missed: new Set(samples.filter(row => row.type === "shadow" && row.executable && row.missed && row.net > 0).map(row=>row.key)).size,
        executable: samples.filter(row=>row.executable).length,
        executableCounts,
        shadow: samples.filter(s => s.type === "shadow").length,
        paper: samples.filter(s => s.type === "paper").length, pending: pending.size };
    },
    get dirty() { return generation !== savedGeneration; },
    get generation() { return generation; },
    saved(version) { savedGeneration = version; },
    snapshot: () => ({ version:4,samples:trimSamples([...samples]),pending:[...pending.values()],paperKeys:[...paperKeys],models })
  };
}
