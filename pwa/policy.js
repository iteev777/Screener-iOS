export const defaults = Object.freeze({
  maxMainPositions: 10, maxSniperPositions: 10, maxTotalPositions: 15, balanceFraction: 10, dcaDrop: 5,
  strategy: 0, orderUsd: 100, exposureUsd: 200, lossUsd: 50, stop: 5, profit: 10, profitShare: 100, finalProfit: 20,
  trailing: 5, breakEven: 5, holdMinutes: 240, cooldownSeconds: 60,
  feeBps: 20, slippageBps: 15, dca: 0, interval: 30, minLiquidity: 10000, rugScore: 0, maxPools: 12, maxDailyBuys: 20, scanMinVolume: 10000
});

const limits = {
  maxMainPositions: [1,30], maxSniperPositions: [1,30], maxTotalPositions: [1,30], balanceFraction: [1,100], dcaDrop: [0.1,49],
  strategy: [0, 7], orderUsd: [1, 500], exposureUsd: [1, 1000], lossUsd: [1, 1000],
  stop: [0.1, 50], profit: [0.1, 500], profitShare: [1, 100], finalProfit: [0.1, 500], trailing: [0, 50], breakEven: [0, 100],
  holdMinutes: [1, 1440], cooldownSeconds: [0, 3600], feeBps: [0, 500],
  slippageBps: [0, 500], dca: [0, 1], interval: [15, 300], minLiquidity: [0, 1e9], rugScore: [0, 100], maxPools: [1, 30], maxDailyBuys: [1, 100], scanMinVolume: [0, 1e9]
};

export function validateSettings(input) {
  const settings = {};
  for (const [name, [min, max]] of Object.entries(limits)) {
    const value = input[name] ?? defaults[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Asetus ${name}: sallittu alue ${min}–${max}.`);
    }
    settings[name] = value;
  }
  if (![settings.strategy, settings.dca, settings.maxPools, settings.maxDailyBuys, settings.maxMainPositions, settings.maxSniperPositions, settings.maxTotalPositions].every(Number.isInteger) ||
      settings.orderUsd > settings.exposureUsd ||
      (settings.profitShare < 100 && settings.finalProfit <= settings.profit)) {
    throw new Error("Tarkista strategia, lisäostot, enimmäispositio ja voittotavoitteiden järjestys.");
  }
  return settings;
}

export const reasons = ["", "Stop loss", "Break-even", "Trailing stop", "Aikaraja",
  "Take profit", "Strategia", "Lisäosto"];

export function orderFor(engine, signal, book, tick, settings) {
  const { price, at, liquidity } = tick;
  const held = book.sol > 0;
  if (held) {
    const average = book.cost / book.sol;
    const exit = engine.exit(price, average, Math.max(book.peak ?? price, price),
      Math.max(0, (at - (book.openedAt ?? at)) / 1000), settings.stop,
      book.profitTaken ? settings.finalProfit : settings.profit, settings.trailing, settings.breakEven, settings.holdMinutes * 60, signal);
    if (exit) {
      const fraction = exit === 5 && !book.profitTaken ? settings.profitShare / 100 : 1;
      return { side: "Myynti", sol: book.sol * fraction, reason: exit };
    }
  }
  const day = Math.floor(at / 86400000);
  const loss = book.lossDay === day ? book.lossToday ?? 0 : 0;
  const buys = book.buyDay === day ? book.buysToday ?? 0 : 0;
  const dca = held && settings.dca && !book.added && !book.profitTaken && signal === 1 &&
    price <= (book.cost / book.sol) * (1 - settings.dcaDrop / 100) && price > (book.cost / book.sol) * (1 - settings.stop / 100);
  if (((!held && signal === 1) || dca) && loss < settings.lossUsd &&
      buys < settings.maxDailyBuys &&
      liquidity >= settings.minLiquidity &&
      at >= (book.lastTradeAt ?? 0) + settings.cooldownSeconds * 1000 &&
      book.cash >= settings.orderUsd && (held ? book.cost : 0) + settings.orderUsd <= settings.exposureUsd) {
    return { side: "Osto", usd: settings.orderUsd, reason: dca ? 7 : 6 };
  }
}

export function applyPaperFill(book, order, tick, settings) {
  const { price, at } = tick;
  const slip = settings.slippageBps / 10000;
  const fee = settings.feeBps / 10000;
  const buy = order.side === "Osto";
  const fill = price * (1 + (buy ? slip : -slip));
  if (buy) {
    const day = Math.floor(at / 86400000);
    book.buysToday = (book.buyDay === day ? book.buysToday ?? 0 : 0) + 1;
    book.buyDay = day;
    const held = book.sol > 0;
    book.cash -= order.usd;
    book.sol += order.usd * (1 - fee) / fill;
    book.cost = (held ? book.cost : 0) + order.usd;
    book.openedAt = held ? book.openedAt : at;
    book.added = held;
    if (!held) {
      book.profitTaken = false;
      book.entryLiquidity = tick.liquidity;
      book.entryPool = tick.pool;
    }
    book.peak = held ? Math.max(book.peak ?? price, price) : price;
  } else {
    const sold = Math.min(order.sol, book.sol);
    const proceeds = sold * fill * (1 - fee);
    const cost = book.cost * (sold / book.sol);
    const result = proceeds - cost;
    book.cash += proceeds;
    book.realized = (book.realized ?? 0) + result;
    const day = Math.floor(at / 86400000);
    book.lossToday = (book.lossDay === day ? book.lossToday ?? 0 : 0) + Math.max(0, -result);
    book.lossDay = day;
    book.sol -= sold;
    book.cost -= cost;
    book.profitTaken = order.reason === 5 || Boolean(book.profitTaken);
    if (book.sol === 0) {
      book.peak = 0;
      book.added = false;
    }
  }
  book.lastTradeAt = at;
  book.count = (book.count ?? 0) + 1;
  book.trades.unshift({ side: order.side, price: fill, reason: order.reason, at,
    quantity: buy ? order.usd * (1 - fee) / fill : order.sol });
  book.trades = book.trades.slice(0, 200);
}
