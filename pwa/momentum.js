// SPDX-License-Identifier: BUSL-1.1
import { candidateQuality } from "./trojan-analysis.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const share = (buys, sells) => Number.isSafeInteger(buys) && Number.isSafeInteger(sells) && buys >= 0 && sells >= 0 && buys + sells > 0
  ? buys / (buys + sells) : null;

// Five-minute activity relative to the hourly rate. Missing tape remains unknown.
function tape(row) {
  const volume5 = row.volume5;
  const volumeHour = row.volumeHour;
  return { buying: share(row.transactions?.m5?.buys, row.transactions?.m5?.sells),
    acceleration: finite(volume5) && finite(volumeHour) && volumeHour > 0 ? volume5 * 12 / volumeHour : null,
    move: row.change5, hour: row.changeHour };
}

export function momentumEntry(pair, sources, threshold, now) {
  const quality = candidateQuality(pair, sources, now);
  const volume5 = pair.volume?.m5;
  const volumeHour = pair.volume?.h1;
  const metrics = tape({ volume5, volumeHour,
    change5: pair.priceChange?.m5, changeHour: pair.priceChange?.h1, transactions: pair.txns });
  const result = (decision, code, reason, score = 0) => ({ decision, code, reason, score });
  if (quality.tier === "reject" || [volume5, volumeHour].some(v => finite(v) && v < 0) ||
      [metrics.move, metrics.hour].some(v => finite(v) && v < -100))
    return result("reject", "invalid", "Virheellinen markkinadata");
  if (![metrics.move, volume5].every(finite))
    return result("watch", "missing-tape", "5 min hinta tai volyymi puuttuu");
  const flow = pair.txns?.m5;
  if (!Number.isSafeInteger(flow?.buys) || !Number.isSafeInteger(flow?.sells))
    return result("watch", "missing-flow", "5 min kauppamäärät puuttuvat");
  if (flow.buys + flow.sells < 5)
    return result("watch", "thin-flow", "Alle viisi kauppaa viimeisen 5 min aikana");
  if (metrics.move > 20 || metrics.hour < -25 || metrics.hour > 75)
    return result("reject", "extended", "Liian voimakas hintaliike tai laskeva tuntitrendi");
  const age = (now - pair.pairCreatedAt) / 60000;
  const young = Number.isFinite(age) && age >= 5 && age < 60;
  const prior = finite(volumeHour) && volumeHour >= volume5 ? volumeHour - volume5 : null;
  const baseline = prior && prior > 0 ? prior / (young ? age - 5 : 55) : null;
  const acceleration = baseline > 0 ? volume5 / 5 / baseline : null;
  const strongYoungTape = young && volume5 >= Math.max(1000, pair.liquidity.usd * .04) &&
    flow.buys + flow.sells >= 12 && metrics.buying >= .65;
  if ((!finite(metrics.hour) || !finite(acceleration)) && !strongYoungTape)
    return result("watch", "missing-baseline", "Volyymin vertailujakso tai tuntitrendi puuttuu");
  const score = Math.round(clamp(quality.score * .45 + metrics.buying * 25 +
    (finite(acceleration) ? Math.min(acceleration, 3) * 5 : 8) +
    (metrics.move > 0 ? 10 : 0) + (metrics.hour > 0 ? 5 : 0), 0, 100));
  if (metrics.move <= 0) return result("watch", "no-rebound", "5 min hintasuunta ei ole positiivinen", score);
  if (metrics.buying < .58) return result("watch", "buy-pressure", "Heikko 5 min ostopaine", score);
  if (finite(acceleration) && acceleration < 1.2 || metrics.hour < -3)
    return result("watch", "weak-momentum", "Volyymin kiihtyminen tai tuntitrendi on heikko", score);
  if (score < threshold) return result("watch", "score", "Momentumin pisteraja ei täyty", score);
  return result("approve", "signal",
    `Markkinalaatu ${quality.score}/100 · ostopaine ${Math.round(metrics.buying * 100)} % · 5 min ${metrics.move.toFixed(1)} %`, score);
}

export function momentumSize(cash, score, liquidity, policy) {
  if (![cash, score, liquidity].every(finite) || score < policy.momentumScore || liquidity <= 0) return 0;
  const weight = clamp(.5 + (score - policy.momentumScore) / 40, .5, 1);
  const ceiling = Math.min(policy.orderUsd, policy.momentumMaxUsd, cash * .10, liquidity * .001);
  const result = Math.floor(ceiling * weight * 100) / 100;
  return result >= policy.momentumMinUsd ? result : 0;
}

export function momentumTrailingDistance(change5, policy) {
  return clamp(3 + Math.abs(finite(change5) ? change5 : policy.momentumTrailing),
    policy.momentumTrailing * .6, policy.momentumTrailing);
}

export function momentumExit(book, tick, policy) {
  const average = book.cost / book.sol;
  const peak = Math.max(book.peak ?? tick.price, tick.price);
  const move = (tick.price / average - 1) * 100;
  const peakMove = (peak / average - 1) * 100;
  const at = Math.max(0, tick.at - (book.openedAt ?? tick.at));
  const { buying, acceleration, move: short, hour } = tape(tick);
  const weak = (finite(buying) && buying < .45) || (finite(short) && short < -2) ||
    (finite(acceleration) && acceleration < .65);
  const confirmed = buying >= .58 && acceleration >= 1 && short > 0 && hour >= 0;
  // Volatility can keep the configured distance or tighten it, within the approved cap.
  const distance = momentumTrailingDistance(short, policy);
  const exit = (reason, detail, fraction = 1) => ({ side: "Myynti", sol: book.sol * fraction, reason, detail });
  if (finite(tick.liquidity) && finite(book.entryLiquidity) && book.entryLiquidity > 0 &&
      tick.liquidity <= book.entryLiquidity * (1 - policy.momentumLiquidityDrop / 100))
    return exit(8, "Likviditeetti romahti suhteessa ostoon");
  if (move <= -policy.stop) return exit(1, "Kiinteä tappioraja");
  if (policy.breakEven > 0 && peakMove >= policy.breakEven && move <= 0)
    return exit(2, "Break-even-suoja");
  if ((1 - tick.price / peak) * 100 >= distance) return exit(3, "Volatiliteettiin mukautettu trailing stop");
  if (at >= policy.holdMinutes * 60000) return exit(4, "Enimmäispitoaika");
  const partial = policy.momentumProfitShare ?? 50;
  const costFloor = (policy.feeBps + policy.slippageBps) / 100;
  if (weak && move >= Math.max(policy.profit, costFloor + 1) && !book.profitTaken)
    return exit(5, "Momentum heikkeni voitollisessa positiossa", partial / 100);
  if (book.profitTaken && weak && move >= policy.finalProfit)
    return exit(5, "Jäljellä olevan osuuden voitto kotiutettu");
  if (weak && finite(short) && short < 0 && finite(buying) && buying < .45 && !confirmed)
    return exit(9, "Negatiivinen momentum ja kasvava myyntipaine");
}
