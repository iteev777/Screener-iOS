// SPDX-License-Identifier: BUSL-1.1
const metrics = new Set(["maCross", "price", "liquidity", "volume24h", "change24h", "buyPressure",
  "transactionVelocity", "positionProfit", "drawdown", "holdingMinutes", "utcHour",
  "sma", "ema", "rsi", "bollingerUpper", "bollingerLower", "vwap", "atrPercent",
  "breakoutHigh", "breakoutLow", "volumeSpike", "candleBodyPercent", "bullishCandles",
  "bearishCandles", "pullbackPercent", "candleChange", "positionAdds",
  "poolAgeMinutes", "liquidityChange", "liquidityToSize", "profitGiveback"]);
const candleMetrics = new Set(["maCross", "sma", "ema", "rsi", "bollingerUpper", "bollingerLower", "vwap",
  "atrPercent", "breakoutHigh", "breakoutLow", "volumeSpike", "candleBodyPercent",
  "bullishCandles", "bearishCandles", "pullbackPercent", "candleChange"]);
const comparisons = { gt: (a, b) => a > b, gte: (a, b) => a >= b,
  lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };

export function validateRules(input) {
  let count = 0;
  let candles = false;
  function metricSpec(value) {
    const period = value?.period ?? 14;
    if (!metrics.has(value?.metric) || !Number.isInteger(period) || period < 1 || period > 62) {
      throw new Error("Tarkista ehdon mittari ja jakso.");
    }
    candles ||= candleMetrics.has(value.metric);
    if (value.metric === "maCross") {
      const fast = value.fast ?? 5;
      const within = value.within ?? 1;
      const average = value.average ?? "EMA";
      const direction = value.direction ?? "up";
      if (!Number.isInteger(fast) || fast < 1 || fast >= period ||
          !Number.isInteger(within) || within < 1 || within + period > 64 ||
          !["EMA", "SMA"].includes(average) || !["up", "down"].includes(direction)) {
        throw new Error("Tarkista liukuvien keskiarvojen risteyksen parametrit.");
      }
      return { metric: value.metric, period, fast, within, average, direction };
    }
    return { metric: value.metric, period };
  }
  function node(value, depth) {
    if (++count > 100 || depth > 8 || !value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Virheellinen tai liian suuri ehtopuu.");
    }
    if (value.op !== undefined) {
      if (!["AND", "OR", "NOT"].includes(value.op) || !Array.isArray(value.children) ||
          !value.children.length || (value.op === "NOT" && value.children.length !== 1)) {
        throw new Error("Tarkista AND-, OR- ja NOT-ryhmät.");
      }
      return { op: value.op, children: value.children.map(child => node(child, depth + 1)) };
    }
    if (!Object.hasOwn(comparisons, value.compare)) throw new Error("Tarkista vertailuoperaattori.");
    return { ...metricSpec(value), compare: value.compare,
      value: Number.isFinite(value.value) ? value.value : metricSpec(value.value) };
  }
  if (!input || typeof input !== "object" || !input.entry || !input.exit) {
    throw new Error("Määritä entry- ja exit-ehtopuut.");
  }
  const entry = node(input.entry, 0);
  const exit = node(input.exit, 0);
  return { entry, exit, candles };
}

const pct = (a, b) => b > 0 ? 100 * (a - b) / b : NaN;
const total = data => Number.isSafeInteger(data?.buys) && data.buys >= 0 &&
  Number.isSafeInteger(data?.sells) && data.sells >= 0 ? data.buys + data.sells : NaN;
const sum = numbers => numbers.reduce((a, b) => a + b, 0);

function metricValue({ metric, period, fast, within, average: averageType, direction }, { engine, tick, book, candles, orderUsd }) {
  const held = book?.sol > 0;
  const counts = tick.transactions;
  const trades = total(counts?.m5);
  switch (metric) {
    case "price": return tick.price;
    case "liquidity": return tick.liquidity;
    case "volume24h": return tick.volume;
    case "change24h": return tick.change;
    case "buyPressure": return trades > 0 ? 100 * counts.m5.buys / trades : NaN;
    case "transactionVelocity": return total(counts?.h1) > 0 ? 12 * trades / total(counts.h1) : NaN;
    case "positionProfit": return held ? pct(tick.price, book.cost / book.sol) : NaN;
    case "drawdown": return held ? -pct(tick.price, Math.max(tick.price, book.peak ?? tick.price)) : NaN;
    case "holdingMinutes": return held && book.openedAt <= tick.at ? (tick.at - book.openedAt) / 60000 : NaN;
    case "positionAdds": return held ? Number(Boolean(book.added)) : NaN;
    case "liquidityChange":
      return held && book.entryPool === tick.pool ? pct(tick.liquidity, book.entryLiquidity) : NaN;
    case "liquidityToSize": return tick.liquidity / (held ? book.sol * tick.price : orderUsd);
    case "profitGiveback": {
      const average = held ? book.cost / book.sol : NaN;
      const peak = Math.max(tick.price, book?.peak ?? tick.price);
      return peak > average ? 100 * (peak - tick.price) / (peak - average) : NaN;
    }
    case "poolAgeMinutes": return tick.created > 0 && tick.created <= tick.at ? (tick.at - tick.created) / 60000 : NaN;
    case "utcHour": return new Date(tick.at).getUTCHours();
  }

  if (candles.length < period) return NaN;
  const recent = candles.slice(-period);
  const last = recent.at(-1);
  const high = Math.max(...recent.map(candle => candle.high));
  const average = (kind, ...fields) => {
    const length = candles.length;
    new Float64Array(engine.memory.buffer, engine.sample_buffer(), length).set(candles.map(c => c.close));
    for (const [i, field] of fields.entries()) {
      new Float64Array(engine.memory.buffer, engine.aux_buffer(i), length).set(candles.map(c => c[field]));
    }
    return engine.indicator(kind, length, period);
  };
  switch (metric) {
    case "maCross":
      new Float64Array(engine.memory.buffer, engine.sample_buffer(), candles.length).set(candles.map(c => c.close));
      return engine.ma_cross(candles.length, fast, period, within, Number(averageType === "EMA"), Number(direction === "up"));
    case "sma": return average(0);
    case "ema": return average(1);
    case "rsi": return average(2);
    case "bollingerUpper": return average(0) + 2 * average(3);
    case "bollingerLower": return average(0) - 2 * average(3);
    case "vwap": return average(4, "volume");
    case "atrPercent": return 100 * average(5, "high", "low") / tick.price;
    case "breakoutHigh": return pct(tick.price, high);
    case "breakoutLow": return pct(tick.price, Math.min(...recent.map(c => c.low)));
    case "pullbackPercent": return -pct(tick.price, high);
    case "candleBodyPercent": return Math.abs(pct(last.close, last.open));
    case "candleChange": return pct(last.close, recent[0].open);
    case "volumeSpike": {
      if (candles.length <= period) return NaN;
      return last.volume * period / sum(candles.slice(-period - 1, -1).map(c => c.volume));
    }
    case "bullishCandles":
    case "bearishCandles": {
      const direction = metric === "bullishCandles" ? 1 : -1;
      let count = 0;
      for (const candle of [...recent].reverse()) {
        if (Math.sign(candle.close - candle.open) !== direction) break;
        count++;
      }
      return count;
    }
  }
}

export function evaluateRule(rule, context) {
  if (!rule.op) {
    const value = metricValue(rule, context);
    const bound = typeof rule.value === "number" ? rule.value : metricValue(rule.value, context);
    return Number.isFinite(value) && Number.isFinite(bound) ? comparisons[rule.compare](value, bound) : null;
  }
  const results = rule.children.map(child => evaluateRule(child, context));
  if (rule.op === "NOT") return results[0] === null ? null : !results[0];
  if (rule.op === "AND" && results.includes(false)) return false;
  if (rule.op === "OR" && results.includes(true)) return true;
  return results.includes(null) ? null : rule.op === "AND";
}

export function ruleSignal(rules, context) {
  const held = context.book?.sol > 0;
  if (held && evaluateRule(rules.exit, context) === true) return -1;
  return evaluateRule(rules.entry, context) === true ? 1 : 0;
}
