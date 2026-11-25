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
  const match = pair.txns?.m5;
  const count = Number.isSafeInteger(match?.buys) && Number.isSafeInteger(match?.sells) && match.buys >= 0 && match.sells >= 0
    ? match.buys + match.sells : null;
  const age = (now - pair.pairCreatedAt) / 60000;
  const young = Number.isFinite(age) && age >= 5 && age < 60;
  const depth = Number(pair.liquidity?.usd);
  const prior = finite(volumeHour) && volumeHour >= volume5 ? volumeHour - volume5 : null;
  const oldMinutes = young ? age - 5 : 55;
  const acceleration = prior > 0 && oldMinutes >= 1 ? volume5 / 5 / (prior / oldMinutes) : null;
  const strongYoungTape = young && volume5 >= Math.max(100,depth * .012) && count >= 8 && metrics.buying >= .62;
  const requiredTrades = depth >= 50000 && metrics.buying >= .64 ? 4 : 5;
  const requiredPressure = metrics.hour > 5 && acceleration >= 1.4 ? .55 : young ? .60 : .58;
  const sustained = metrics.hour >= 0 && metrics.buying >= .64 && metrics.move >= 1 && volume5 >= depth*.01;
  const gates = {
    "missing-tape": ![metrics.move,volume5].every(finite),
    "missing-flow": count === null,
    "thin-flow": count !== null && count < requiredTrades,
    "extended-5m": metrics.move > 20,
    "hour-drop": metrics.hour < -25,
    "hour-extension": metrics.hour > 75,
    "missing-baseline": (!finite(metrics.hour) || !finite(acceleration)) && !strongYoungTape,
    "no-rebound": finite(metrics.move) && metrics.move <= 0,
    "buy-pressure": finite(metrics.buying) && metrics.buying < requiredPressure,
    "low-acceleration": finite(acceleration) && acceleration < 1.2 && !sustained,
    "weak-hour": metrics.hour < -3
  };
  const result = (decision, code, reason, score = 0) => ({ decision, code, reason, score, gates });
  if (quality.tier === "reject" || [volume5, volumeHour].some(v => finite(v) && v < 0) ||
      [metrics.move, metrics.hour].some(v => finite(v) && v < -100))
    return result("reject", "invalid", "Virheellinen markkinadata");
  if (gates["missing-tape"])
    return result("watch", "missing-tape", "5 min hinta tai volyymi puuttuu");
  if (gates["missing-flow"])
    return result("watch", "missing-flow", "5 min kauppamäärät puuttuvat");
  if (gates["thin-flow"])
    return result("watch", "thin-flow", "Viiden minuutin toteumamäärä alle poolin vaatimuksen");
  if (gates["extended-5m"] || gates["hour-drop"] || gates["hour-extension"])
    return result("reject", "extended", "Liian voimakas hintaliike tai laskeva tuntitrendi");
  if (gates["missing-baseline"])
    return result("watch", "missing-baseline", "Volyymin vertailujakso tai tuntitrendi puuttuu");
  const score = Math.round(clamp(quality.score * .45 + metrics.buying * 25 +
    (finite(acceleration) ? Math.min(acceleration, 3) * 5 : 8) +
    (metrics.move > 0 ? 10 : 0) + (metrics.hour > 0 ? 5 : 0), 0, 100));
  gates.score = score < threshold;
  if (gates["no-rebound"]) return result("watch", "no-rebound", "5 min hintasuunta ei ole positiivinen", score);
  if (gates["buy-pressure"]) return result("watch", "buy-pressure", "Heikko 5 min ostopaine", score);
  if (gates["low-acceleration"] || gates["weak-hour"])
    return result("watch", "weak-momentum", "Volyymin kiihtyminen tai tuntitrendi on heikko", score);
  if (score < threshold) return result("watch", "score", "Momentumin pisteraja ei täyty", score);
  return result("approve", "signal",
    `Markkinalaatu ${quality.score}/100 · ostopaine ${Math.round(metrics.buying * 100)} % · 5 min ${metrics.move.toFixed(1)} %`, score);
}

// Pool snapshots support a price trajectory. The provider's rolling trades
// and volume remain window aggregates and are never treated as new fills.
export function snapshotMomentum(history, market, quality, threshold, policy) {
  const result=(decision,code,reason,score=0,extra={})=>({decision,code,reason,score,...extra});
  const last=history.at(-1);
  const first=history.find(row=>last.at-row.at<=60000 && row.at<last.at && row.provider===last.provider);
  if (!first || last.at-first.at<8000 || history.filter(row=>row.at>=first.at && row.provider===last.provider).length<3)
    return result("watch","quote-span","Tuoreita poolin hintahavaintoja tarvitaan lisää");
  const flow=market.transactions?.m5, pressure=share(flow?.buys,flow?.sells);
  const count=(flow?.buys??0)+(flow?.sells??0);
  const depth=market.liquidity, volume=market.volume5;
  const young=finite(market.created) && last.at-market.created<600000;
  if (!(pressure >= (young?.62:.57) && count >= (young?5:8) &&
        finite(volume) && volume >= Math.max(150,depth*(young?.008:.004))))
    return result("watch","quote-flow","Poolihintojen tueksi ei ole riittävästi toteumia tai ostopainetta");
  const move=(last.price/first.price-1)*100;
  const middle=history.findLast(row=>row.at<last.at && row.at>first.at && row.provider===last.provider);
  if (!(move>.35 && move<=10 && last.price>=middle?.price && depth>=first.liquidity*.9))
    return result("watch","quote-motion","Poolihintojen liike tai likviditeetti ei vahvista signaalia");
  if (market.change5>20 || market.changeHour< -25 || market.changeHour>75 || market.change5< -8)
    return result("watch","quote-adverse","Pidemmän markkinaliikkeen riskiraja");
  const score=Math.round(clamp(quality*.29+pressure*33+Math.min(move,4)*6+
    Math.min(volume/depth*100,6)*2+(market.changeHour>=0?5:0)+6,0,100));
  return result(score>=threshold?"approve":"watch",score>=threshold?"quote-signal":"score",
    score>=threshold?"Poolihintojen nousu ja toteutunut ostovirta vahvistivat momentumin":"Poolisignaalin pisteraja ei täyty",
    score,{observedMove:move,structural:true,window:{move,pressure},shortVolume:volume});
}

export function momentumBudget(cash, score, liquidity, scoreFloor, policy, scale = 1) {
  const result=momentumSize(cash,score,liquidity,{...policy,momentumScore:scoreFloor,
    orderUsd:Math.min(policy.orderUsd,cash*(policy.balanceFraction??10)/100)});
  const size=Math.floor(result*Math.max(.55,Math.min(1,scale))*100)/100;
  return size>=policy.momentumMinUsd?size:0;
}

export function momentumPayoff(market, observedMove, window, policy, learned) {
  const move=finite(observedMove)?observedMove:window?.move??market.change5;
  const strength=window?.pressure??share(market.transactions?.m5?.buys,market.transactions?.m5?.sells);
  if (!(move>0) || !(strength>.5)) return 0;
  // Haircut observed movement instead of projecting it linearly. Risk and
  // cash controls remain outside this scenario estimate.
  const estimate=clamp(move*(.48+.25*(strength-.5)),0,Math.min(6,policy.profit??8));
  return learned ? Math.min(estimate,Math.max(0,learned.payoffPct)) : estimate;
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
  const distance = momentumTrailingDistance(short, { ...policy, momentumTrailing: Math.min(policy.momentumTrailing, 4) });
  const exit = (reason, detail, fraction = 1) => ({ side: "Myynti", sol: book.sol * fraction, reason, detail });
  if (finite(tick.liquidity) && finite(book.entryLiquidity) && book.entryLiquidity > 0 &&
      tick.liquidity <= book.entryLiquidity * (1 - policy.momentumLiquidityDrop / 100))
    return exit(8, "Likviditeetti romahti suhteessa ostoon");
  if (move <= -(policy.momentumStop ?? 5)) return exit(1, "Kiinteä tappioraja");
  if (policy.breakEven > 0 && peakMove >= policy.breakEven && move <= 0)
    return exit(2, "Break-even-suoja");
  if ((1 - tick.price / peak) * 100 >= distance) return exit(3, "Volatiliteettiin mukautettu trailing stop");
  const maxHold=(policy.momentumHoldMinutes??5)*60000;
  const planned=book.exitPlan;
  if (at >= Math.min(maxHold,(planned?.holdSeconds??Infinity)*1000)) return exit(4,"Enimmäispitoaika");
  const partial = policy.momentumProfitShare ?? 50;
  const costFloor = (policy.feeBps + policy.slippageBps) / 100;
  const target=planned ? Math.max(costFloor+.8,planned.costPct+.45,
    Math.min(policy.momentumProfit??8,planned.payoffPct*1.45)*(planned.profitScale??1)) : (policy.momentumProfit??8);
  if (move >= Math.max(target,costFloor+1) && !book.profitTaken)
    return exit(5, "Ensimmäinen Momentum-voittotavoite", partial / 100);
  if (book.profitTaken && move >= (planned?Math.min(policy.momentumFinalProfit??15,target*1.65):policy.momentumFinalProfit??15))
    return exit(5, "Jäljellä olevan osuuden voitto kotiutettu");
  const liveFlow = tick.shortWindow;
  if (["early", "short"].includes(book.track) && at >= 45000 && liveFlow?.spanMs >= 3000 &&
      liveFlow.pressure < .42 && liveFlow.move < -.8 && move < costFloor)
    return exit(9, "Tuore myyntivirta purki nopean Momentum-signaalin");
  if (weak && finite(short) && short < 0 && finite(buying) && buying < .45 && !confirmed)
    return exit(9, "Negatiivinen momentum ja kasvava myyntipaine");
}

// Short-window observations must be actual timestamped trades, not inferred from rolling 5m totals.
export function shortMomentum(trades, now) {
  const rows = trades.filter(t => finite(t.at) && t.at <= now && t.at >= now - 300000 &&
    finite(t.price) && t.price > 0 && finite(t.usd) && t.usd > 0 && ["buy","sell"].includes(t.side))
    .sort((a,b) => a.at-b.at);
  const windows = {};
  for (const seconds of [5,15,30,60,300]) {
    const w = rows.filter(t => t.at > now-seconds*1000);
    const volume = w.reduce((n,t)=>n+t.usd,0);
    const buyers = w.filter(trade => trade.side === "buy");
    const identified = buyers.filter(trade => trade.trader);
    const distinctBuyers = identified.length === buyers.length ? new Set(identified.map(trade => trade.trader)).size : null;
    windows[seconds] = w.length >= 3 ? { count:w.length, buys:buyers.length, sells:w.length-buyers.length,
      volume, spanMs:w.at(-1).at-w[0].at, distinctBuyers,
      pressure:w.filter(t=>t.side==="buy").reduce((n,t)=>n+t.usd,0)/volume,
      move:(w.at(-1).price/w[0].price-1)*100, high:Math.max(...w.map(t=>t.price)),
      low:Math.min(...w.map(t=>t.price)) } : null;
  }
  return windows;
}

export function momentumSignal(w, quality, threshold=80) {
  const a=w[5], b=w[15], c=w[30], d=w[60];
  if (!a || !b || !c || !d || !finite(quality)) return {decision:"watch",code:"short-data"};
  const acceleration = d.volume > b.volume ? (b.volume/15)/((d.volume-b.volume)/45) : 0;
  const score=Math.round(clamp(b.pressure*25+clamp(acceleration/3,0,1)*25+
    clamp(b.move/3,0,1)*20+clamp(quality/100,0,1)*15+
    (d.move>0?10:0)+5,0,100));
  const early=a.move>0 && b.move>0 && b.pressure>=.65 && acceleration>=1.5;
  const pullback=d.move>0 && c.move<0 && a.move>0 && a.pressure>=.65;
  const breakout=d.move>0 && b.move>0 && a.move>0 && a.high>=d.high && acceleration>=1.5;
  const signal=breakout?"breakout":pullback?"pullback":early?"early":null;
  return {decision:signal && score>=threshold?"approve":"watch",code:signal??"weak-momentum",structural:Boolean(signal),score};
}

// The early path uses only real trades and a priced pool. It can use a shorter
// observation period when the first trade is too young for a complete longer window.
export function earlyMomentum(windows, market, quality, threshold, policy, previousLiquidity) {
  const recent = windows[15];
  const context = windows[30];
  const watch = (code, reason, score) => ({decision:"watch", code, reason, score, track:"early"});
  if (!recent || !context || recent.spanMs < 3000 || context.spanMs < 5000)
    return watch("short-data", "Lyhyen aikavälin todennettu kauppavirta puuttuu");
  if (market.change5 > 20 || market.changeHour < -25 || market.changeHour > 75)
    return watch("extended", "Pidemmän ikkunan hintaliike ylittää riskirajan");
  if (!(market.liquidity >= policy.minLiquidity) || !Number.isFinite(quality))
    return watch("short-liquidity", "Poolin likviditeettitieto tai strategian laatu puuttuu");
  if (Number.isFinite(previousLiquidity) && market.liquidity < previousLiquidity * .9)
    return watch("short-depth-drop", "Poolin likviditeetti heikkeni tuoreiden havaintojen välillä");
  const ticket = Math.min(policy.orderUsd, policy.momentumMaxUsd);
  const impact = ticket / (market.liquidity / 2 + ticket);
  const estimatedCostPct = (2 * (policy.feeBps / 10000 + Math.max(policy.slippageBps / 10000, impact))) * 100;
  const activity = recent.volume / Math.max(ticket, market.liquidity * .004);
  if (recent.distinctBuyers === 1 && recent.count >= 5)
    return watch("short-concentration", "Lyhyen ikkunan ostoista vastaa yksi tunnistettu lompakko");
  if (!(recent.move > estimatedCostPct) || recent.move > 12) return watch("short-move","Lyhyt hintaliike ei kata arvioituja kuluja tai ylittää 12 %");
  if (context.move < -.5) return watch("short-context","Lyhyen hintaliikkeen vertailuikkuna laskee");
  if (recent.pressure < .60 || context.pressure < .54) return watch("short-pressure","Lyhyen ikkunan ostovirta jää alle vaatimuksen");
  if (activity < 1) return watch("short-volume","Lyhyen ikkunan volyymi jää alle poolin vaatimuksen");
  const older = Math.max(0, context.volume - recent.volume);
  const pace = older > 0 ? recent.volume / older : null;
  // Evidence in young markets is measured in fills and present liquidity.
  // A mature-market quality score includes 5m/1h/6h fields that do not exist yet.
  const depth = clamp(Math.log2(market.liquidity / Math.max(1,policy.minLiquidity)),0,3);
  const coverage = Math.min(100, quality * .45 + 29 + depth * 9 +
    Math.min(4,recent.distinctBuyers ?? 0)*3);
  const score = Math.round(clamp(coverage * .23 + recent.pressure * 30 + Math.min(activity, 3) * 7 +
    Math.min(recent.move / Math.max(1, estimatedCostPct), 4) * 5 + (pace > 1 ? 6 : 0), 0, 100));
  if (windows[5]?.move < -estimatedCostPct && windows[5].pressure < .45)
    return watch("short-reversal", "Viimeisten 5 sekunnin toteumat osoittavat myyntikäänteen", score);
  if (score < threshold) return watch("score", "Lyhyen ikkunan pisteraja ei täyty", score);
  return { decision:"approve", code:"early-flow", reason:`15 s ostovirta ${Math.round(recent.pressure*100)} % ja liike ${recent.move.toFixed(2)} %`, score, track:"early" };
}

// Conservative calibration from completed paper positions, never from open marks.
export function momentumCalibration(trades, baseline=80) {
  const groups=new Map(), completed=[];
  for(const t of [...trades].reverse()){
    if(t.strategy!==8 || !t.token || !t.pool) continue;
    const key=t.token+":"+t.pool;
    if(t.side==="Osto") groups.set(key,{pnl:0,cost:t.notional,score:t.score});
    else if(t.side==="Myynti" && groups.has(key)){
      const g=groups.get(key);
      if(!finite(t.realizedPnl)){groups.delete(key);continue;}
      g.pnl+=t.realizedPnl;
      if(t.closed){if(g.cost>0 && finite(g.score)) completed.push(g);groups.delete(key);}
    }
  }
  const sample=completed.slice(-60);
  if(sample.length<30) return {threshold:baseline,samples:sample.length};
  const mean=sample.reduce((n,t)=>n+t.pnl/t.cost,0)/sample.length;
  // Only tighten automatically; lowering requires independent validation.
  return {threshold:clamp(baseline+(mean<0?4:0),baseline,100),samples:sample.length,mean};
}
