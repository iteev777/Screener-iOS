// SPDX-License-Identifier: BUSL-1.1
// Browser port of Trojan V2 candidate_quality.py and ai_analyzer.py at b3b82fe.
const numeric = value => (typeof value === "number" || (typeof value === "string" && value.trim())) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
const points = (value, bands) => bands.find(([threshold]) => value !== null && value >= threshold)?.[1] ?? 0;
const windows = ["m5", "h1", "h6", "h24"];
function flow(pair, window) {
  return ["buys", "sells"].map(side => numeric(pair.txns?.[window]?.[side]));
}

export function candidateQuality(pair, sources, now) {
  const liquidity = numeric(pair.liquidity?.usd);
  const price = numeric(pair.priceUsd);
  const [v5, v1, v6, v24] = windows.map(window => numeric(pair.volume?.[window]));
  const [c5, c1, c6, c24] = windows.map(window => numeric(pair.priceChange?.[window]));
  const created = numeric(pair.pairCreatedAt);
  const age = created ? Math.max(0, (now - created) / 60000) : null;
  const ratios = windows.slice(0, 2).map(window => flow(pair, window))
    .filter(([a, b]) => a !== null && b !== null && a >= 0 && b >= 0 && a + b > 0)
    .map(([a, b]) => a / (a + b));
  const reject = (liquidity !== null && liquidity <= 0) || (price !== null && price <= 0) ||
    numeric(pair.fdv) < 0 || numeric(pair.marketCap) < 0;
  const score = Math.min(100,
    points(liquidity, [[15000, 25], [5000, 17], [1500, 9], [Number.MIN_VALUE, 2]]) +
    points(v5, [[25000, 20], [5000, 15], [1000, 8], [Number.MIN_VALUE, 2]]) +
    points(v1, [[20000, 7], [3000, 4], [Number.MIN_VALUE, 1]]) +
    points(v6, [[50000, 4], [Number.MIN_VALUE, 2]]) +
    points(v24, [[100000, 4], [Number.MIN_VALUE, 2]]) +
    (ratios.length ? 20 * ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0) +
    points(sources.size, [[4, 10], [2, 7], [1, 3]]) +
    (age === null ? 0 : age < 2 ? 4 : age <= 1440 ? 10 : age <= 10080 ? 7 : 4) +
    (c5 === null || c5 < -15 ? 0 : c5 > 40 ? 1 : c5 > 0 ? 5 : 3) +
    Number(c1 !== null && c1 >= -5 && c1 <= 25) * 2 + Number(c6 > 0) + Number(c24 > 0));
  const rounded = Math.round(score * 100) / 100;
  return { score: rounded, tier: reject ? "reject" : rounded >= 75 ? "strong" : rounded >= 45 ? "watch" : "weak" };
}

export function trojanDecision(pair, sources, profile, now, settings = {}) {
  const result = (decision, reason, score = 0) => ({ decision, reason, score });
  const sniper = profile === "sniper";
  const limit=(name,fallback)=>settings[profile+name]??fallback;
  const liquidity = numeric(pair.liquidity?.usd);
  const v24 = numeric(pair.volume?.h24);
  const v5 = numeric(pair.volume?.m5);
  const [m5, h1, h24] = ["m5", "h1", "h24"].map(w => numeric(pair.priceChange?.[w]));
  const created = numeric(pair.pairCreatedAt);
  if (liquidity === null || v24 === null || liquidity < limit("MinLiquidity",sniper?2500:8000)) {
    return result("watch", "Odotetaan likviditeettiä tai volyymia");
  }
  if (v24 < 0 || v5 < 0 || [m5, h1, h24].some(v => v !== null && (v < -100 || v > 100000))) {
    return result("reject", "Virheellinen markkinadata");
  }
  if(v24<limit("MinVolume24",0)||(v5??0)<limit("MinVolume5",0)||sources.size<limit("MinSources",1))return result("watch","Volyymi tai lähdemäärä alle rajan");
  if(limit("MaxAge",0)>0&&(!created||(now-created)/60000>limit("MaxAge",0)))return result("reject","Poolin ikäraja");
  const five = flow(pair, "m5");
  const short = !five.includes(null);
  const [buys, sells] = short ? five : flow(pair, "h1");
  const total = buys + sells;
  if (![buys, sells].every(v => Number.isSafeInteger(v) && v >= 0) ||
      total < (short ? limit("MinTrades",sniper?3:4) : limit("MinTradesHour",5)) || [m5, h1, h24].includes(null) || m5 <= limit("MinChange5",0)) {
    return result("watch", "Odotetaan kauppoja ja positiivista 5 min käännettä");
  }
  if (m5 > limit("MaxChange5",8) || h1 < limit("MinChange1h",-25) || h1 > limit("MaxChange1h",35) || h24 < limit("MinChange24",-70)) return result("reject", "Liian voimakas hintaliike");
  if (total <= 0 || buys <= sells) return result("watch", "Odotetaan ostopainetta");
  if (v24 / Math.max(liquidity, 1) > limit("MaxVolumeRatio",15) || created > now + 300000) {
    return result("reject", "Poikkeava volyymisuhde tai aikaleima");
  }
  if (created > 0 && (now - created) / 60000 < limit("MinAge",sniper?0:5)) return result("watch", "Odotetaan poolin ikää");
  const pressure = buys / total;
  if (pressure < Math.max(.52, limit("MinPressure", 52) / 100)) return result("reject", "Heikko ostopaine");
  const score = Math.min(100, points(liquidity, [[100000, 25], [50000, 22], [20000, 18], [0, 12]]) +
    points(v5 ?? v24, [[5000, 15], [1000, 11], [100, 7], [0, 3]]) +
    points(pressure, [[.75, 25], [.65, 21], [.58, 16], [.52, 10]]) +
    (m5 <= 2 ? 20 : m5 <= 5 ? 15 : 8) + (h1 >= -12 && h1 <= 8 ? 10 : h1 <= 15 ? 5 : 0) +
    points(sources.size, [[3, 5], [2, 3]]));
  return result(score >= limit("MinScore",sniper?75:70) ? "approve" : score >= 50 ? "watch" : "reject",
    "Trojan V2 dip-reversal", score);
}
