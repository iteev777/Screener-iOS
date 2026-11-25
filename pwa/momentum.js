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
  const metrics = tape({ volume5: pair.volume?.m5, volumeHour: pair.volume?.h1,
    change5: pair.priceChange?.m5, changeHour: pair.priceChange?.h1, transactions: pair.txns });
  if (quality.tier === "reject") return { decision: "reject", score: 0, reason: "Virheellinen markkinadata" };
  if ([pair.volume?.m5, pair.volume?.h1].some(value => finite(value) && value < 0) ||
      [metrics.move, metrics.hour].some(value => finite(value) && value < -100)) {
    return { decision: "reject", score: 0, reason: "Virheellinen volyymi tai hintamuutos" };
  }
  if ([metrics.buying, metrics.acceleration, metrics.move, metrics.hour].some(value => !finite(value))) {
    return { decision: "watch", score: quality.score, reason: "Odotetaan 5 min ostopainetta, volyymia ja trendiä" };
  }
  const score = Math.round(clamp(quality.score * .55 + metrics.buying * 20 +
    Math.min(metrics.acceleration, 3) / 3 * 15 + (metrics.move > 0 && metrics.hour > 0 ? 10 : 0), 0, 100));
  if (metrics.move > 20 || metrics.hour < -25 || metrics.hour > 75) {
    return { decision: "reject", score, reason: "Liian voimakas hintaliike tai laskeva tuntitrendi" };
  }
  if (score < threshold || metrics.move <= 0 || metrics.buying < .58 || metrics.acceleration < 1.2 || metrics.hour < -3) {
    return { decision: "watch", score, reason: "Momentum, ostopaine tai volyymin kiihtyminen ei täytä ehtoja" };
  }
  return { decision: "approve", score, reason: `Markkinalaatu ${quality.score}/100 · ostopaine ${Math.round(metrics.buying * 100)} % · volyymitahti ${metrics.acceleration.toFixed(1)}× · 5 min ${metrics.move.toFixed(1)} %` };
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
  if (weak && move >= policy.profit && !book.profitTaken && policy.profitShare < 100)
    return exit(5, "Momentum heikkeni voitollisessa positiossa", policy.profitShare / 100);
  if (weak && finite(short) && short < 0 && finite(buying) && buying < .45 && !confirmed)
    return exit(9, "Negatiivinen momentum ja kasvava myyntipaine");
}
