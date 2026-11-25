// SPDX-License-Identifier: BUSL-1.1
// A bounded model adjustment is accepted only if an unseen chronological slice
// confirms the direction of the same feature. Regulations and risk gates stay external.
const features = ["buying", "pace", "move", "liquidity"];
const bounded = value => Math.max(-.15, Math.min(.15, value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

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
        (row.type !== "paper" && !(row.executable && row.horizon === 120 && row.verified && row.calibratable))) continue;
    const cohort = `${row.type}/${row.track}/${row.segment}`;
    if (!groups.has(cohort)) groups.set(cohort, []);
    groups.get(cohort).push(row);
  }
  const trained = {};
  for (const [cohort, rows] of groups) {
    const unique = [...new Map(rows.sort((a,b) => a.at-b.at).map(row => [row.key, row])).values()]
      .sort((a,b) => a.at-b.at);
    if (unique.length < 36) continue;
    const split = Math.floor(unique.length * 2 / 3);
    const train = unique.slice(0, split);
    const holdout = unique.slice(split);
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

export function learnedScore(model, track, segment, input, score) {
  if (!Number.isFinite(score)) return score;
  const weights = (model?.[`paper/${track}/${segment}`] ?? model?.[`shadow/${track}/${segment}`])?.weights;
  if (!weights) return score;
  const delta = Object.entries(weights).reduce((sum,[name,value]) =>
    sum + (Number.isFinite(input[name]) ? value * (2 * input[name] - 1) : 0), 0);
  return Math.max(0, Math.min(100, score + Math.max(-4, Math.min(4, delta))));
}
