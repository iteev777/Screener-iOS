import assert from "node:assert/strict";
import test from "node:test";
import { defaults } from "./policy.js";
import { earlyMomentum, shortMomentum } from "./momentum.js";
import { paperLearning } from "./momentum-learning.js";

const now = 1700000000000;
const market = {pool:"P", token:"T", liquidity:10000, price:1};

test("learns from cost-adjusted future quotes and restores feedback across a restart", () => {
  let model = paperLearning(undefined, defaults);
  for (let i=0; i<18; i++) model.observe({...market,pool:`p${i}`}, now, "early", 78, true, true);
  model = paperLearning(JSON.parse(JSON.stringify(model.snapshot())), defaults);
  assert.equal(model.mark({...market,pool:"p0", price:1.15}, now + 119000), false);
  assert.equal(model.due(now + 120000).length,15);
  for (let i=0; i<18; i++) assert.equal(model.mark({...market,pool:`p${i}`, price:1.08}, now + 120000),true);
  model = paperLearning(model.snapshot(), defaults);
  assert.deepEqual(model.calibration(80,now + 120000).tracks.early,{threshold:76,shadow:18,paper:0});
  assert.equal(model.calibration(80,now + 120000).tracks.rolling.threshold,80);
});

test("records each closed net Paper position once including its partial sales", () => {
  const trades = [];
  for (let i=0; i<12; i++) trades.unshift(
    {strategy:8,side:"Myynti",token:"T",pool:`p${i}`,at:now+3,closed:true,realizedPnl:-.8},
    {strategy:8,side:"Myynti",token:"T",pool:`p${i}`,at:now+2,realizedPnl:.2},
    {strategy:8,side:"Osto",token:"T",pool:`p${i}`,at:now,track:"short",score:87,notional:10});
  let model = paperLearning(undefined,defaults);
  model.recordTrades(trades);
  model = paperLearning(model.snapshot(),defaults);
  model.recordTrades(trades);
  assert.deepEqual(model.calibration(80,now+3).tracks.short,{threshold:86,shadow:0,paper:12});
});

test("young-pool signal needs only timestamped short-window tape and rejects falling depth", () => {
  const rows = [18,13,9,5,1].map((seconds,index) =>
    ({at:now-seconds*1000,price:1+index*.014,usd:45,side:"buy"}));
  const tape = shortMomentum(rows,now);
  assert.equal(tape[60].count,5);
  assert.equal(earlyMomentum(tape,market,75,80,defaults,10000).decision,"approve");
  assert.equal(earlyMomentum(tape,{...market,changeHour:-26},75,80,defaults,10000).code,"extended");
  assert.equal(earlyMomentum(tape,market,75,80,defaults,15000).code,"short-depth-drop");
  assert.equal(earlyMomentum(shortMomentum(rows.slice(-2),now),market,90,80,defaults).decision,"watch");
});

test("fresh alternative pool price starts trade collection before five-minute bars exist", async () => {
  const { preferMarket } = await import("./market-tape.js");
  const early = { market, observedAt:now, raw:{ priceUsd:"1" } };
  assert.equal(preferMarket(undefined,early,now+5000),early);
  assert.equal(preferMarket(undefined,early,now+16000),undefined);
  assert.equal(preferMarket(undefined,early,now-1),undefined);
});

test("successfully measured rejections outside the score gate cannot lower thresholds", () => {
  const model = paperLearning(undefined, defaults);
  for (let i=0; i<18; i++) {
    const pool = `non-executable-${i}`;
    model.observe({...market,pool},now,"rolling",78,false);
    model.mark({...market,pool,price:1.4},now+120000);
  }
  assert.equal(model.calibration(80,now+120000).shadow,18);
  assert.equal(model.calibration(80,now+120000).tracks.rolling.threshold,80);
});

test("a completed observation is not resurrected by another tab's older save", async () => {
  const { mergeLearning } = await import("./momentum-learning.js");
  const open = paperLearning(undefined, defaults);
  open.observe(market,now,"rolling",79,true);
  const old = open.snapshot();
  assert.ok(open.mark({...market,price:1.04},now+120000));
  const latest = open.snapshot();
  const merged = mergeLearning(latest,old,now+120000);
  assert.equal(merged.samples.length,1);
  assert.equal(merged.pending.length,0);
});
