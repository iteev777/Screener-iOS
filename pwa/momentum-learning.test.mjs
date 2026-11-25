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
  for (let i=0; i<18; i++) {
    const candidate={...market,pool:`p${i}`};
    model.proveRoute(candidate,{inLamports:"100000000",tokenRaw:"1000000",quoteUsd:100,entrySlip:.01},now+1000);
    assert.equal(model.mark({...candidate,price:1.08},now+120000),true);
  }
  assert.equal(model.calibration(80,now+120000).tracks.early.threshold,80);
  assert.equal(model.virtualDue(now+120000).length,0);
  model = paperLearning(model.snapshot(), defaults);
  assert.equal(model.virtualDue(now+121000).length,18);
  for (const candidate of model.virtualDue(now+121000)) {
    assert.equal(model.finishVirtual(candidate,{allowed:true,lamports:"110000000"},now+121000,100),true);
  }
  assert.deepEqual(model.calibration(80,now + 121000).tracks.early,{threshold:80,shadow:18,paper:0});
  assert.equal(model.calibration(80,now + 120000).tracks.rolling.threshold,80);
});

test("records each closed net Paper position once including its partial sales", () => {
  const trades = [];
  for (let i=0; i<24; i++) {
    const at=now+i*10000;
    trades.unshift(
      {strategy:8,side:"Myynti",token:"T",pool:`p${i}`,at:at+3,closed:true,realizedPnl:-.8},
      {strategy:8,side:"Myynti",token:"T",pool:`p${i}`,at:at+2,realizedPnl:.2},
      {strategy:8,side:"Osto",token:"T",pool:`p${i}`,at,track:"short",score:87,notional:10});
  }
  let model = paperLearning(undefined,defaults);
  model.recordTrades(trades);
  model = paperLearning(model.snapshot(),defaults);
  model.recordTrades(trades);
  assert.deepEqual(model.calibration(80,now+240000).tracks.short,{threshold:86,shadow:0,paper:24});
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
  assert.deepEqual(merged.pending[0].remaining,[180,300,900,3600]);
});

test("time-bounded observation records actual checkpoints without imputing skipped prices", () => {
  const model = paperLearning(undefined,defaults);
  model.observe(market,now,"early",78,true,true,{missed:true});
  for (const seconds of [15,30,60,120,180,300,900,3600]) {
    assert.equal(model.mark({...market,price:1.04},now+seconds*1000),true);
  }
  assert.deepEqual(model.snapshot().samples.map(row=>row.horizon),[15,30,60,120,180,300,900,3600]);
  assert.equal(model.calibration(80,now+3600000).missed,0);
  assert.equal(model.snapshot().pending.length,0);
});

test("virtual observation resumes exact quote horizons after persistence",()=>{
  const proof={inLamports:"100000000",tokenRaw:"1000000",quoteUsd:100,entrySlip:.004};
  let book=paperLearning(undefined,defaults);
  book.observe(market,now,"early",77,true,true,{missed:true});
  book.proveRoute(market,proof,now+1000);
  for (const seconds of [15,30,60,180,300,900]) {
    const at=now+1000+seconds*1000;
    const [due]=book.virtualDue(at);
    assert.equal(due.next,seconds);
    assert.ok(book.finishVirtual(due,{allowed:true,lamports:"110000000"},at,100));
    assert.equal(book.finishVirtual(due,{allowed:true,lamports:"110000000"},at,100),false);
    book=paperLearning(book.snapshot(),defaults);
  }
  assert.deepEqual(book.snapshot().samples.map(s=>s.horizon),[15,30,60,180,300,900]);
  assert.equal(book.calibration(80,now+902000).missed,1);
});

test("position and exit model requires aligned chronological results from distinct pools",async ()=>{
  const {fitExecutionRegimes}=await import("./paper-signal-model.js");
  const rows=Array.from({length:36},(_,i)=>({key:String(i),track:"early",segment:"young/rising",
    type:"shadow",observedAt:now+i*400000,at:now+200000+i*400000,horizon:180,verified:true,executable:true,net:.04}));
  for (const row of [...rows]) rows.push({...row,horizon:60,at:row.at-120000,net:.065});
  const learned=fitExecutionRegimes(rows,now+14500000)["early/young/rising"];
  assert.equal(learned.holdSeconds,60);
  assert.equal(learned.scale,1);
  assert.deepEqual(fitExecutionRegimes(rows,now+100000),{});
  const inverted=rows.map(row=>Number(row.key)>=24?{...row,net:-row.net}:row);
  assert.deepEqual(fitExecutionRegimes(inverted,now+14500000),{});
});

test("feature weights are learned only with chronological holdout confirmation", async () => {
  const { fitSignalWeights, learnedScore } = await import("./paper-signal-model.js");
  const samples = Array.from({length:36},(_,i) => ({
    key:String(i), type:"shadow",track:"early",segment:"new/quiet", at:now+i, horizon:120, verified:true,
    executable:true, calibratable:true, features:{buying:i%2 ? .9 : .1}, net:(i%2 ? .05:-.04)
  }));
  const fitted = fitSignalWeights(samples,now+40);
  assert.equal(fitted["shadow/early/new/quiet"].weights.buying,2);
  assert.ok(learnedScore(fitted,"early","new/quiet",{buying:.95},80)>80);
  assert.equal(learnedScore(fitted,"early","listed/quiet",{buying:.95},80),80);
  const reversed = samples.map((row,i)=>i<24?row:{...row,net:-row.net});
  assert.deepEqual(fitSignalWeights(reversed,now+40),{});
  assert.deepEqual(fitSignalWeights(samples,now+15),{});
});

test("rollback restores the previous model and disables promotion during evaluation", () => {
  const weights = {"shadow/early/new/quiet":{weights:{buying:2}}};
  const model = paperLearning({version:3,samples:[],pending:[],paperKeys:[],models:[
    {id:10,at:now-20000,settings:{early:-4},weights},
    {id:11,at:now-10000,settings:{early:6},weights:{}}
  ]},{...defaults,momentumRollback:1});
  const result = model.calibration(80,now);
  assert.equal(result.modelRevision,10);
  assert.equal(result.tracks.early.threshold,76);
  assert.equal(model.snapshot().models.length,2);
});
