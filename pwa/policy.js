import { estimateBinSwap, estimateTickSwap } from "./trojan-pools.js";
export const defaults = Object.freeze({
mainMinLiquidity:8000,sniperMinLiquidity:2500,mainMinVolume24:10000,sniperMinVolume24:10000,mainMinVolume5:0,sniperMinVolume5:0,mainMinAge:5,sniperMinAge:0,mainMaxAge:0,sniperMaxAge:0,mainMinTrades:4,sniperMinTrades:3,mainMinTradesHour:5,sniperMinTradesHour:5,mainMinPressure:52,sniperMinPressure:52,mainMinChange5:0,sniperMinChange5:0,mainMaxChange5:8,sniperMaxChange5:8,mainMinChange1h:-25,sniperMinChange1h:-25,mainMaxChange1h:35,sniperMaxChange1h:35,mainMinChange24:-70,sniperMinChange24:-70,mainMaxVolumeRatio:15,sniperMaxVolumeRatio:15,mainMinScore:70,sniperMinScore:75,mainMinSources:1,sniperMinSources:1,mainMaxImpact:5,sniperMaxImpact:5,
mainOrderUsd: 5, mainStop: 9, mainProfit: 8, mainProfitShare: 50, mainFinalProfit: 10, mainTrailing: 3.5, mainBreakEven: 0, mainHoldMinutes: 15, mainDca: 0, mainDcaDrop: 5, sniperOrderUsd: 5, sniperStop: 9, sniperProfit: 8, sniperProfitShare: 50, sniperFinalProfit: 10, sniperTrailing: 3.5, sniperBreakEven: 0, sniperHoldMinutes: 15, sniperDca: 0, sniperDcaDrop: 5,

  analysisWorkers: 24, maxMainPositions: 10, maxSniperPositions: 10, maxTotalPositions: 15, balanceFraction: 10, dcaDrop: 3,
  paperCapital: 1000, momentumScore: 80, momentumRollback: 0, momentumProfitShare: 50, momentumMinUsd: 1, momentumMaxUsd: 20, momentumTrailing: 10, momentumLiquidityDrop: 40,
  strategy: 0, orderUsd: 100, exposureUsd: 200, lossUsd: 50, stop: 5, profit: 10, profitShare: 100, finalProfit: 20,
  trailing: 5, breakEven: 5, holdMinutes: 240, cooldownSeconds: 60,
  feeBps: 20, slippageBps: 15, dca: 0, interval: 30, minLiquidity: 10000, rugScore: 0, maxPools: 12, maxDailyBuys: 20, scanMinVolume: 10000
});

const limits = {
mainMinLiquidity:[0,1000000000],sniperMinLiquidity:[0,1000000000],mainMinVolume24:[0,1000000000],sniperMinVolume24:[0,1000000000],mainMinVolume5:[0,1000000000],sniperMinVolume5:[0,1000000000],mainMinAge:[0,10000000],sniperMinAge:[0,10000000],mainMaxAge:[0,10000000],sniperMaxAge:[0,10000000],mainMinTrades:[0,1000000],sniperMinTrades:[0,1000000],mainMinTradesHour:[0,1000000],sniperMinTradesHour:[0,1000000],mainMinPressure:[0,100],sniperMinPressure:[0,100],mainMinChange5:[-100,100000],sniperMinChange5:[-100,100000],mainMaxChange5:[-100,100000],sniperMaxChange5:[-100,100000],mainMinChange1h:[-100,100000],sniperMinChange1h:[-100,100000],mainMaxChange1h:[-100,100000],sniperMaxChange1h:[-100,100000],mainMinChange24:[-100,100000],sniperMinChange24:[-100,100000],mainMaxVolumeRatio:[0,1000000],sniperMaxVolumeRatio:[0,1000000],mainMinScore:[0,100],sniperMinScore:[0,100],mainMinSources:[0,30],sniperMinSources:[0,30],mainMaxImpact:[0,100],sniperMaxImpact:[0,100],
mainOrderUsd: [1,500], mainStop: [0.1,50], mainProfit: [0.1,500], mainProfitShare: [1,100], mainFinalProfit: [0.1,500], mainTrailing: [0,50], mainBreakEven: [0,100], mainHoldMinutes: [1,1440], mainDca: [0,1], mainDcaDrop: [0.1,49], sniperOrderUsd: [1,500], sniperStop: [0.1,50], sniperProfit: [0.1,500], sniperProfitShare: [1,100], sniperFinalProfit: [0.1,500], sniperTrailing: [0,50], sniperBreakEven: [0,100], sniperHoldMinutes: [1,1440], sniperDca: [0,1], sniperDcaDrop: [0.1,49],

  analysisWorkers: [1,24], maxMainPositions: [1,30], maxSniperPositions: [1,30], maxTotalPositions: [1,30], balanceFraction: [1,100], dcaDrop: [0.1,49],
  paperCapital: [10, 1000000], momentumScore: [50, 100], momentumRollback: [0, 1], momentumProfitShare: [10, 90], momentumMinUsd: [1, 500], momentumMaxUsd: [1, 500],
  momentumTrailing: [1, 35], momentumLiquidityDrop: [10, 90],
  strategy: [0, 8], orderUsd: [1, 500], exposureUsd: [1, 1000], lossUsd: [1, 1000],
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
  if (![settings.strategy, settings.momentumRollback, settings.dca, settings.maxPools, settings.maxDailyBuys, settings.analysisWorkers, settings.maxMainPositions, settings.maxSniperPositions, settings.maxTotalPositions].every(Number.isInteger) ||
      settings.momentumMinUsd > settings.momentumMaxUsd || settings.orderUsd > settings.exposureUsd || (settings.dca && settings.dcaDrop >= settings.stop) ||
      (settings.profitShare < 100 && settings.finalProfit <= settings.profit)) {
    throw new Error("Tarkista strategia, lisäostot, enimmäispositio ja voittotavoitteiden järjestys.");
  }
  for (const p of ['main','sniper']) {
    const s = strategySettings(settings, p === 'main' ? 5 : 6);
    if (settings[p+"MinChange5"]>settings[p+"MaxChange5"] || settings[p+"MinChange1h"]>settings[p+"MaxChange1h"] || (settings[p+"MaxAge"] && settings[p+"MinAge"]>settings[p+"MaxAge"])) throw new Error("Virheelliset hakurajat "+p);
    if (!Number.isInteger(s.dca) || (s.dca && s.dcaDrop >= s.stop) || s.orderUsd > s.exposureUsd || (s.profitShare < 100 && s.finalProfit <= s.profit)) throw new Error('Virheelliset '+p+'-asetukset');
  }
  return settings;
}

export function strategySettings(policy, strategy) {
  if (strategy !== 5 && strategy !== 6) return policy;
  const prefix = strategy === 5 ? 'main' : 'sniper';
  const result = {...policy, trojanExit: true};
  for (const name of ["orderUsd","stop","profit","profitShare","finalProfit","trailing","breakEven","holdMinutes","dca","dcaDrop","minLiquidity"]) { const k = prefix + name[0].toUpperCase() + name.slice(1); result[name] = policy[k] ?? policy[name]; }
  return result;
}

export const reasons = ["", "Stop loss", "Break-even", "Trailing stop", "Aikaraja",
  "Take profit", "Strategia", "Lisäosto", "Likviditeettiraja", "Trendikäännös", "Manuaalinen sulkeminen"];

export function trojanExitReason(book, tick, settings) {
  const entry = book.cost / book.sol;
  const change = tick.price / entry - 1;
  const peak = Math.max(entry, book.peak ?? entry, tick.price);
  const peakGain = peak / entry - 1;
  if (change <= -settings.stop / 100) return 1;
  if (!book.profitTaken && change >= settings.profit / 100) return 5;
  if (peakGain >= 0.04 && change > 0 && tick.price <= peak * (1 - settings.trailing / 100) && settings.trailing > 0) return 3;
  if (settings.breakEven > 0 && peakGain >= settings.breakEven / 100 && change <= 0) return 2;
  if (change >= settings.finalProfit / 100) return 5;
  if (tick.at - (book.openedAt ?? tick.at) >= settings.holdMinutes * 60000) return 4;
  return 0;
}

export function orderFor(engine, signal, book, tick, settings) {
  const { price, at, liquidity } = tick;
  const held = book.sol > 0;
  if (held) {
    const average = book.cost / book.sol;
    const exit = settings.trojanExit ? trojanExitReason(book, tick, settings) : engine.exit(price, average, Math.max(book.peak ?? price, price),
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
  const buyUsd = dca && settings.trojanExit ? Math.min(2.5, settings.orderUsd) : settings.orderUsd;
  if (((!held && signal === 1) || dca) && loss < settings.lossUsd &&
      buys < settings.maxDailyBuys &&
      liquidity >= settings.minLiquidity &&
      at >= (book.lastTradeAt ?? 0) + settings.cooldownSeconds * 1000 &&
      book.cash >= buyUsd && (held ? book.cost : 0) + buyUsd <= settings.exposureUsd) {
    return { side: "Osto", usd: buyUsd, reason: dca ? 7 : 6 };
  }
}

export function applyPaperFill(book, order, tick, settings) {
  const { price, at } = tick;
  const model = paperExecutionCost(book,order,tick,settings);
  const {slip,fee}=model;
  const buy = order.side === "Osto";
  let realizedPnl = null;
  const openedAt = book.openedAt;
  const quantity = buy ? order.usd * (1 - fee) / (price * (1 + slip)) : Math.min(order.sol, book.sol);
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
    realizedPnl = result;
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
    realizedPnl, detail: order.detail, feeUsd: (buy ? order.usd : fill * quantity) * fee,
    notional: buy ? order.usd : fill * quantity, closed: !buy && book.sol === 0,
    executionDelayMs: tick.signalAt != null ? at - tick.signalAt : undefined, heldMs: !buy && openedAt != null ? at - openedAt : undefined, estimatedImpactPct: model.impact*100, executionModel: model.source, quantity });
  book.trades = book.trades.slice(0, 200);
}

export function paperExecutionCost(book,order,tick,settings){
  const buy=order.side==="Osto";
  const notional=buy?order.usd:Math.min(order.sol,book.sol)*tick.price;
  const baseline=settings.slippageBps/10000;
  const fee=settings.feeBps/10000;
  if(!settings.trojanExit && settings.strategy !== 8)return {slip:baseline,fee,impact:0,source:"fixed"};
  // Indicative constant-product proxy, not a guaranteed executable quote.
  const reserve=Number(tick.liquidity)/2;
  const impact=Number.isFinite(reserve)&&reserve>0?notional/(reserve+notional):0.5;
  const route=buy&&Number.isFinite(tick.entryImpactPct)?Math.max(0,tick.entryImpactPct/100):0;
  let depth=0,source="liquidity_proxy";
  const pool=tick.sellPool;
  if(!buy&&pool?.status==="approve"&&pool.expires>=Date.now()&&pool.priceMode==="reserves"&&["Raydium CPMM","Raydium AMM v4","FluxBeam"].includes(pool.protocol)){
    const base=pool.baseMint===tick.token, valid=base||pool.quoteMint===tick.token;
    const reserveRaw=Number(base?pool.effectiveBaseRaw:pool.effectiveQuoteRaw), decimals=base?pool.base?.decimals:pool.quote?.decimals;
    const reserveTokens=reserveRaw/10**decimals, sold=Math.min(order.sol,book.sol);
    if(valid&&Number.isFinite(reserveTokens)&&reserveTokens>0&&Number.isFinite(pool.feeBps)){depth=sold/(reserveTokens+sold);source="verified_reserve_proxy";}
  }
  if(!buy&&pool?.status==="approve"&&pool.expires>=Date.now()&&["Raydium CLMM","Orca Whirlpool","Meteora DLMM"].includes(pool.protocol)){
    try{
      const x=pool.baseMint===tick.token;
      if(!x&&pool.quoteMint!==tick.token)throw new Error("Mint mismatch");
      const inputDecimals=x?pool.base.decimals:pool.quote.decimals,outputDecimals=x?pool.quote.decimals:pool.base.decimals;
      const quantity=Math.min(order.sol,book.sol),raw=Math.floor(quantity*10**inputDecimals);
      if(!Number.isSafeInteger(raw)||raw<=0)throw new Error("Invalid amount");
      const result=(pool.protocol==="Meteora DLMM"?estimateBinSwap:estimateTickSwap)(pool,BigInt(raw),x,pool.feeBps);
      const expected=quantity*(x?pool.spotRatio:1/pool.spotRatio),received=Number(result.outputRaw)/10**outputDecimals;
      if(result.complete&&expected>0&&Number.isFinite(received)&&received>0){depth=Math.max(0,1-received/expected);source="verified_array_proxy";}
    }catch{/* Missing or unsupported depth must not block risk exits. */}
  }
  const slip=Math.min(.99,Math.max(baseline,impact,route,depth));
  return {slip,fee:Math.max(fee,source==="verified_reserve_proxy"?pool.feeBps/10000:0),impact:Math.max(impact,depth),source};
}
