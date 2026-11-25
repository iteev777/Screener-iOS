// SPDX-License-Identifier: BUSL-1.1
// A bounded model adjustment is accepted only if an unseen chronological slice
// confirms the direction of the same feature. Regulations and risk gates stay external.
const features = ["buying", "pace", "move", "liquidity"];
const bounded = value => Math.max(-.15, Math.min(.15, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
export function chronologicalSplit(rows) {
  const origin=row=>row.observedAt??row.at;
  const ordered=[...rows].sort((a,b)=>origin(a)-origin(b));
  const count=Math.floor(ordered.length*2/3);
  const holdout=ordered.slice(count);
  const cutoff=holdout.length?origin(holdout[0]):Infinity;
  return [ordered.slice(0,count).filter(row=>row.at<=cutoff),holdout];
}

export function marketSegment(market, now) {
  const age = now - market.created;
  const lifecycle = Number.isFinite(age) && age >= 0 ? age < 600000 ? "new" : "listed" : "unknown";
  const trend = Number.isFinite(market.changeHour)
    ? market.changeHour > 5 ? "rising" : market.changeHour < -5 ? "falling" : "quiet"
    : "unknown";
  return `${lifecycle}/${trend}`;
}

export function signalFeatures(market, window) {
  const tape = market.transactions?.m5;
  const count = tape?.buys + tape?.sells;
  const normalize = (number, floor, width) => Number.isFinite(number) ?
    Math.max(0, Math.min(1, (number - floor) / width)) : null;
  return {
    buying: normalize(window?.pressure ?? (count > 0 ? tape.buys / count : undefined), 0, 1),
    pace: normalize(window?.pace ?? (market.volumeHour > 0 ? market.volume5 * 12 / market.volumeHour : undefined),0,3),
    move: normalize(window?.move ?? market.change5, -5, 10),
    liquidity: normalize(Math.log10(market.liquidity), 3, 3)
  };
}

export function fitSignalWeights(samples, now) {
  const groups = new Map();
  for (const row of samples) {
    if (!row.features || !row.segment || row.at > now || row.at < now - 86400000 ||
        (row.type !== "paper" && !(row.executable && [120,180].includes(row.horizon) && row.verified && row.calibratable))) continue;
    const cohort = `${row.type}/${row.track}/${row.segment}`;
    if (!groups.has(cohort)) groups.set(cohort, []);
    groups.get(cohort).push(row);
  }
  const trained = {};
  for (const [cohort, rows] of groups) {
    const unique = [...new Map(rows.sort((a,b) => a.at-b.at).map(row => [row.key, row])).values()]
      .sort((a,b) => a.at-b.at);
    if (unique.length < 36) continue;
    const [train,holdout]=chronologicalSplit(unique);
    const weights = {};
    for (const feature of features) {
      const effect = (subset, min) => {
        const high = subset.filter(row => Number.isFinite(row.features[feature]) && row.features[feature] >= .6);
        const low = subset.filter(row => Number.isFinite(row.features[feature]) && row.features[feature] <= .4);
        return high.length >= min && low.length >= min
          ? mean(high.map(row => bounded(row.net))) - mean(low.map(row => bounded(row.net))) : 0;
      };
      const trainEffect = effect(train, 6);
      const checked = effect(holdout, 3);
      if (Math.abs(trainEffect) >= .015 && Math.abs(checked) >= .01 && Math.sign(trainEffect) === Math.sign(checked))
        weights[feature] = Math.sign(checked) * 2;
    }
    if (Object.keys(weights).length) trained[cohort] = { weights, train: train.length, holdout: holdout.length };
  }
  return trained;
}

export function fitExecutionRegimes(samples, now) {
  const groups=new Map();
  for (const row of samples) {
    if (!row.segment || row.at>now || row.at<now-86400000 ||
        (row.type!=="paper" && !(row.executable && row.verified && [60,120,180,300].includes(row.horizon)))) continue;
    const key=`${row.track}/${row.segment}`;
    const group=groups.get(key)??new Map();
    const observation=group.get(row.key);
    const observed=row.observedAt??row.at;
    if (!observation || observed>observation.observed) group.set(row.key,{observed,at:row.at,labels:new Map([[row.horizon??0,row.net]])});
    else if (observed===observation.observed) {
      observation.labels.set(row.horizon??0,row.net);
      observation.at=Math.max(row.at,observation.at);
    }
    groups.set(key,group);
  }
  const result={};
  for (const [key,group] of groups) {
    const rows=[...group.values()].map(row=>({...row,observedAt:row.observed}));
    const outcomes=rows.map(row=>({...row,net:row.labels.get(0)??row.labels.get(180)??row.labels.get(120)}))
      .filter(row=>Number.isFinite(row.net));
    if (outcomes.length<36) continue;
    const split=chronologicalSplit(outcomes);
    if (split[0].length<18||split[1].length<12) continue;
    const estimates=split.map(part=>mean(part.map(row=>bounded(row.net))));
    if (estimates.some(value=>Math.abs(value)<.005) || Math.sign(estimates[0])!==Math.sign(estimates[1])) continue;
    const positive=estimates[0]>0;
    const early=rows.flatMap(row=>{
      const a=row.labels.get(60), b=row.labels.get(180);
      return Number.isFinite(a)&&Number.isFinite(b)?[{...row,net:bounded(a)-bounded(b)}]:[];
    });
    const earlyExit=early.length>=36 && chronologicalSplit(early)
      .every(part=>part.length>=12 && mean(part.map(row=>row.net))>.01);
    result[key]={ samples:outcomes.length, scale:positive?1:.65,
      payoffPct:positive?Math.min(6,2+100*Math.min(...estimates)):.85,
      holdSeconds:earlyExit?60:positive?180:90, profitScale:earlyExit||!positive?.75:1 };
  }
  return result;
}

export function learnedScore(model, track, segment, input, score) {
  if (!Number.isFinite(score)) return score;
  const weights = (model?.[`paper/${track}/${segment}`] ?? model?.[`shadow/${track}/${segment}`])?.weights;
  if (!weights) return score;
  const delta = Object.entries(weights).reduce((sum,[name,value]) =>
    sum + (Number.isFinite(input[name]) ? value * (2 * input[name] - 1) : 0), 0);
  return Math.max(0, Math.min(100, score + Math.max(-4, Math.min(4, delta))));
}
