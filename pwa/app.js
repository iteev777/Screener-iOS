import { devnetBalance, newDevnetWallet, reconcileDevnet, submitDevnetMemo } from "./devnet.js";
import { advancePortfolio, newPortfolio, runScanner, scanKey } from "./scanner.js";
import { reconcileLiveSignature, createLiveAdapter } from "./live-adapter.js";

import { currentMarket, watchSlots } from "./network.js";
import { applyPaperFill, defaults, orderFor, reasons, validateSettings } from "./policy.js";

import { fetchCandles, poolPrice, solMarket, timeframes } from "./markets.js";
import { ruleSignal, validateRules } from "./rules.js";
import { formatAtomic, readQuote, simulateSwap } from "./jupiter.js";
import { copyGroup, recentSwaps } from "./copy.js";
import { address as solanaAddress } from "./markets.js";
import { equityDashboard, renderFeed, showAgents, tokenBadge } from "./agent-dashboard.js";
import { momentumTrailingDistance } from "./momentum.js";
import { mountMarkets } from "./market-panel.js";

const byId = id => document.getElementById(id);
const usd = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "USD" });
const amount = new Intl.NumberFormat("fi-FI", { maximumFractionDigits: 5 });
const demoPrices = [151, 148, 145, 142, 144, 149, 153];
const emptyBook = () => ({ cash: 1000, sol: 0, trades: [] });
let database;
let engine;
let run;
let emergency = false;
let changingInterlock = false;
let wallet;
let signing;
let quoting = false;
let devWallet;
let devAction;
let devRecord;
let viewVersion = 0;
const live = createLiveAdapter();
const mode = () => byId("mode").value;
let settings = defaults;
const settingsKey = () => mode() === 'live' ? 'settings:live' : 'settings:paper';
async function loadModeSettings() {
  settings = validateSettings(await stored(settingsKey()) ?? (mode() === 'live' ? {} : await stored('settings') ?? {}));
  for (const [name,value] of Object.entries(settings)) {
    const field = byId('settings').elements.namedItem(name);
    if (field) field.value = String(value);
  }
}
let selection = solMarket;
let rules;
let timeframe = "5m";
let events = [];
let scanEvents = [];
let scanPortfolio;
const agentActivity = new Map();
let lastStats;
let lastFeedAt = 0;
let pendingScanEvents = [];
let renderingFeed = false;
let closingPosition = false;

function refreshFeed() {
  if (renderingFeed) return;
  renderingFeed = true;
  requestAnimationFrame(() => {
    renderingFeed = false;
    const fills = (scanPortfolio?.trades ?? []).slice(0, 45).map(trade => ({
      at: trade.at, mint: trade.token, status: `Toteutunut ${trade.side.toLowerCase()}`, score: trade.score,
      market: { ...trade.market, price: trade.price, symbol: trade.symbol },
      reason: [Number.isFinite(trade.notional) ? usd.format(trade.notional) : "",
        Number.isFinite(trade.feeUsd) ? `kulut ${usd.format(trade.feeUsd)}` : "",
        Number.isFinite(trade.realizedPnl) ? `P/L ${usd.format(trade.realizedPnl)}` : ""].filter(Boolean).join(" · ")
    }));
    renderFeed([...scanEvents, ...(scanPortfolio?.decisions ?? []), ...fills].sort((a, b) => b.at - a.at));
  });
}

async function persistScanEvents() {
  const rows = pendingScanEvents;
  if (!rows.length) return;
  pendingScanEvents = [];
  lastFeedAt = Date.now();
  const transaction = database.transaction("books", "readwrite");
  const books = transaction.objectStore("books");
  const read = books.get("scan-events");
  read.onsuccess = () => {
    const combined = new Map([...rows, ...(read.result ?? [])].map(row =>
      [JSON.stringify([row.at, row.mint, row.status, row.reason]), row]));
    books.put([...combined.values()].sort((a, b) => b.at - a.at).slice(0, 240), "scan-events");
  };
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  }).catch(error => {
    pendingScanEvents = [...pendingScanEvents, ...rows].slice(0, 240);
    logEvent(`Analyysilokia ei tallennettu: ${error?.message ?? "paikallinen tallennusvirhe"}`);
  });
}

let copyWallets = [];
const settlementKey = account => `settlements:${account}:${selection.token}`;

function renderSettlements(swaps) {
  byId("settlements").replaceChildren(...swaps.map(swap => {
    const row = document.createElement("li");
    row.textContent = `${new Date(swap.at).toLocaleString("fi-FI")} · ${swap.direction > 0 ? "Osto" : "Myynti"} · ${amount.format(swap.quantity)} ${selection.symbol} · ${usd.format(swap.usd)} · ${swap.signature}`;
    return row;
  }));
}
const paperKey = () => selection.pool ? `paper:${selection.pool}:${selection.token}` : "paper";
const priceUsd = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "USD",
  maximumSignificantDigits: 7 });

function logEvent(message) {
  const at = Date.now();
  events = [{ at, message }, ...events].slice(0, 40);
  renderLog();
  if (database) stored("activity", events).catch(() => {});
}

function renderLog() {
  byId("activity").replaceChildren(...events.map(({ at, message }) => {
    const row = document.createElement("li");
    row.textContent = `${new Date(at).toLocaleTimeString("fi-FI")} · ${message}`;
    return row;
  }));
}

function stored(key, value) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("books", value === undefined ? "readonly" : "readwrite");
    const books = transaction.objectStore("books");
    const request = value === undefined ? books.get(key) : books.put(value, key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

// Persistent wallet-scoped journal. Reserve before submission, reconcile before retry.
async function liveJournal(account, record) {
  if(!solanaAddress.test(account))throw new Error("Virheellinen lompakko");
  const key="live-journal:"+account;
  return new Promise((resolve,reject)=>{
    const tx=database.transaction("books","readwrite"), store=tx.objectStore("books"), req=store.get(key);
    let rows;
    req.onsuccess=()=>{
      rows=req.result??[];
      if(!record)return;
      const previous=rows.find(x=>x.id===record.id);
      if(record.state==="reserved"){
        if(previous||rows.some(x=>["reserved","pending","unknown"].includes(x.state))){tx.abort();return;}
      }else if(!previous||!["reserved","pending","unknown"].includes(previous.state)){tx.abort();return;}
      rows=[{...previous,...record,updatedAt:Date.now()},...rows.filter(x=>x.id!==record.id)].slice(0,200);
      store.put(rows,key);
    };
    tx.oncomplete=()=>resolve(rows);
    tx.onabort=()=>reject(tx.error??new Error("Live-tapahtuma on lukittu tai odottaa vahvistusta"));
  });
}
async function reconcileLiveJournal(account,signal){
  const rows=await liveJournal(account);
  for(const row of rows){
    if(signal.aborted)break;
    if(!row.signature||!["pending","unknown"].includes(row.state))continue;
    const status=await reconcileLiveSignature(row.signature,signal);
    await liveJournal(account,{id:row.id,...status});
  }
  return liveJournal(account);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("screener-paper", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("books");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function bookUpdate(mode, tick, signal, policy, candles, abortSignal) {
  if (!tick) return stored(mode).then(book => book ?? emptyBook());
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("books", "readwrite");
    const books = transaction.objectStore("books");
    const locked = books.get("emergency-stop");
    const read = books.get(mode);
    let book;
    read.onsuccess = () => {
      book = read.result ?? emptyBook();
      if (abortSignal?.aborted || document.visibilityState !== "visible") return;
      if (locked.result === true) {
        reject(new Error("Hätäpysäytys on lukittu."));
        transaction.abort();
        return;
      }
      if (tick.at <= (book.lastTickAt ?? 0)) return;
      if (book.sol > 0) book.openedAt ??= tick.at;
      const resolved = candles ? ruleSignal(rules, { engine, tick, book, candles, orderUsd: policy.orderUsd }) : signal;
      const order = orderFor(engine, resolved, book, tick, policy);
      if (order) applyPaperFill(book, order, tick, policy);
      else if (book.sol > 0) book.peak = Math.max(book.peak ?? tick.price, tick.price);
      book.lastTickAt = tick.at;
      book.mark = tick.price;
      book.symbol = mode === "demo" ? "SOL" : selection.symbol;
      books.put(book, mode);
    };
    transaction.oncomplete = () => resolve(book);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function renderOpenPositions() {
  const open = await new Promise((resolve, reject) => {
    const transaction = database.transaction("books", "readonly");
    const cursor = transaction.objectStore("books").openCursor();
    const result = [];
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      if ((item.key === "paper" || String(item.key).startsWith("paper:")) && item.value.sol > 0) {
        result.push({ ...item.value, key: item.key });
      }
      item.continue();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
  });
  if (mode() !== "paper") return;
  byId("open-positions").replaceChildren(...open.map(book => {
    const row = document.createElement("li");
    row.textContent = `${book.symbol || "SOL"} · ${amount.format(book.sol)} · ${usd.format(book.cost)} sijoitettu${book.mark ? ` · viimeisin P/L ${usd.format(book.mark * book.sol - book.cost)}` : ""}${book.key === paperKey() ? " · valittu" : ""}`;
    return row;
  }));
  byId("no-open-positions").hidden = open.length > 0;
}

function renderBook(book, price, symbol = selection.symbol || selection.token) {
  byId("equity").textContent = price ? usd.format(book.cash + book.sol * price) : "—";
  byId("balance").textContent = `${usd.format(book.cash)} · ${amount.format(book.sol)} ${symbol}`;
  const unrealized = price && book.sol > 0 ? book.sol * price - book.cost : null;
  byId("position").textContent = book.sol > 0
    ? `Avoin positio: ${amount.format(book.sol)} ${symbol} · hankintameno ${usd.format(book.cost)}${unrealized === null ? "" : ` · avoin P/L ${usd.format(unrealized)}`}`
    : "Ei avointa positiota.";
  byId("stats").textContent = `${book.count ?? 0} kauppaa · toteutunut P/L ${usd.format(book.realized ?? 0)}`;
  byId("empty").hidden = book.trades.length > 0;
  byId("trades").replaceChildren(...book.trades.map(trade => {
    const item = document.createElement("li");
    item.textContent = `${trade.side} · ${priceUsd.format(trade.price)} / ${symbol}${trade.reason ? ` · ${reasons[trade.reason]}` : ""}`;
    return item;
  }));
}

function setButtons() {
  const isLive = mode() === "live";
  const busy = !engine || !database || Boolean(run);
  const blocked = emergency || changingInterlock;
  byId("emergency").disabled = !database || changingInterlock;
  byId("emergency").textContent = emergency ? "Vapauta hätäpysäytys" : "Hätäpysäytys";
  byId("emergency").setAttribute("aria-pressed", String(emergency));
  byId("devnet-copy").disabled = !devWallet;
  byId("run-state").textContent = changingInterlock ? "Tallennetaan…" :
    emergency ? "Lukittu" : run ? "Käynnissä" : "Pysäytetty";
  byId("mode").disabled = busy || Boolean(signing) || Boolean(devAction);
  byId("settings-fields").disabled = busy;
  byId("rule-fields").disabled = busy;
  byId("copy-fields").disabled = busy;
  byId("sync-swaps").hidden = !isLive || !wallet;
  byId("simulate-swap").disabled = busy || !wallet || quoting;
  byId("timeframe").disabled = busy;
  byId("devnet-panel").hidden = !isLive;
  byId("devnet-create").disabled = busy || Boolean(devAction);
  byId("devnet-faucet").hidden = !devWallet;
  byId("devnet-send").disabled = blocked || busy || Boolean(devAction) || !devWallet || devRecord?.state === "pending";
  byId("devnet-sync").disabled = busy || Boolean(devAction) || devRecord?.state !== "pending";
  byId("scan").hidden = isLive;
  byId("scan").disabled = blocked || busy || Boolean(signing);
  byId("scan-panel").hidden = isLive;
  byId("demo").hidden = isLive;
  byId("demo").disabled = blocked || busy;
  byId("connect").hidden = !isLive;
  byId("connect").disabled = busy || Boolean(signing);
  byId("sign-probe").hidden = !isLive || !wallet || !live.canSign?.();
  byId("sign-probe").disabled = busy || Boolean(signing);
  byId("live").hidden = !isLive && settings.strategy >= 5;
  byId("live").textContent = isLive ? "Käynnistä Live" : "Käynnistä valitulla poolilla";
  byId("live").disabled = blocked || busy || (isLive && (!wallet || !live.ready));
  byId("stop").disabled = !run;
}

function stop(message) {
  if (database) void persistScanEvents();
  if (lastStats) {
    lastStats = { ...lastStats, activeWorkers: 0, adaptiveLimit: 0, pump: "Pysäytetty",
      foundPerMinute: 0, signalsPerMinute: 0 };
    showAgents(lastStats, agentActivity);
  }
  run?.abort();
  run = undefined;
  byId("slot").textContent = "—";
  byId("status").textContent = message;
  logEvent(message);
  setButtons();
}

byId("emergency").onclick = async () => {
  if (!database || changingInterlock) return;
  const lock = !emergency;
  changingInterlock = true;
  if (lock) {
    emergency = true;
    signing?.abort();
    devAction?.abort();
    stop("Hätäpysäytys lukittu.");
  }
  setButtons();
  try {
    await stored("emergency-stop", lock);
    emergency = lock;
    if (!lock) byId("status").textContent = "Lukitus vapautettu. Voit käynnistää ajon.";
  } catch (error) {
    byId("status").textContent = `Lukituksen tallennus epäonnistui: ${error.message}`;
  } finally {
    changingInterlock = false;
    setButtons();
  }
};

function renderPerformance(trades) {
  const target=byId("trade-performance");
  const sales=trades.filter(t=>t.side==="Myynti"&&Number.isFinite(t.realizedPnl));
  target.replaceChildren(...[["Kaikki",sales],["Main",sales.filter(t=>t.strategy===5)],["Sniper",sales.filter(t=>t.strategy===6)],["Momentum",sales.filter(t=>t.strategy===8)]].map(([name,items])=>{
    const wins=items.filter(t=>t.realizedPnl>0), gross=wins.reduce((s,t)=>s+t.realizedPnl,0), loss=-items.filter(t=>t.realizedPnl<0).reduce((s,t)=>s+t.realizedPnl,0);
    const p=document.createElement("p");p.textContent=`${name} · Myynnit ${items.length} · Win rate ${items.length?(100*wins.length/items.length).toFixed(1)+" %":"—"} · Profit factor ${loss?(gross/loss).toFixed(2):gross?"∞":"—"} · P/L ${items.length?usd.format(gross-loss):"—"}`;return p;
  }));
  const note=document.createElement("p");note.textContent="Tilastot koskevat tallennettuja myyntitapahtumia, myös osamyyntejä. Vanhat myynnit ilman P/L-tietoa eivät sisälly.";target.append(note);
  const canvas=byId("pnl-chart"),ctx=canvas.getContext("2d");if(!ctx)return;ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!sales.length)return;let total=0;const points=[0,...sales.slice().reverse().map(t=>total+=t.realizedPnl)];const lo=Math.min(...points),hi=Math.max(...points);ctx.strokeStyle="#89e8c1";ctx.lineWidth=2;ctx.beginPath();points.forEach((v,i)=>{const x=10+i*(canvas.width-20)/(points.length-1),y=10+(hi-v)/(hi-lo||1)*(canvas.height-20);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
}
function renderScan(portfolio, ticks = []) {
  const previous = scanPortfolio;
  scanPortfolio = portfolio;
  const positions = Object.values(portfolio.positions);
  const equity = portfolio.cash + positions.reduce((sum, p) => sum + p.sol * p.mark, 0);
  if (mode() === "paper") equityDashboard(portfolio, equity);
  const decision = portfolio.decisions?.[0];
  if (previous?.decisions?.[0]?.at !== decision?.at) {
    refreshFeed();
    if (decision) {
      agentActivity.set("brain", { ...decision, reason: `${decision.state} · ${decision.reason}` });
      if (decision.state === "REJECT") agentActivity.set("risk", decision);
    }
  }
  if (portfolio.trades[0]?.at !== previous?.trades[0]?.at) {
    const trade = portfolio.trades[0];
    if (trade) agentActivity.set("fill", { at: trade.at, reason: `${trade.side} · ${trade.symbol} · ${usd.format(trade.notional ?? trade.price)}` });
    renderPerformance(portfolio.trades);
  } else if (!previous) renderPerformance(portfolio.trades);
  byId("home-cash").textContent = usd.format(portfolio.cash);
  byId("home-pnl").textContent = usd.format(portfolio.realized);
  byId("home-count").textContent = String(positions.length);
  byId("scan-balance").textContent = `${usd.format(portfolio.cash)} käteistä · salkku ${usd.format(equity)} · toteutunut P/L ${usd.format(portfolio.realized)}`;
  const rows = (id, values) => byId(id).replaceChildren(...values.map(value => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
  if (ticks.length) rows("scan-markets", ticks.map(t => `${t.symbol || t.token} · ${priceUsd.format(t.price)}`));
  byId("scan-positions").replaceChildren(...positions.map(position => {
    const item = document.createElement("li");
    const title = document.createElement("b");
    const entry = position.cost / position.sol;
    const value = position.mark * position.sol;
    const pnl = value - position.cost;
    title.textContent = [position.name, position.market.symbol].filter(Boolean).join(" · ") || position.market.token;
    const change = document.createElement("p");
    change.textContent = `${usd.format(value)} · ${usd.format(pnl)} (${(100 * pnl / position.cost).toFixed(2)} %)`;
    change.className = pnl >= 0 ? "positive" : "negative";
    const mark = document.createElement("p");
    const distance = position.strategy === 8 ? momentumTrailingDistance(position.change5, settings) : settings.trailing;
    mark.textContent = `Osto ${priceUsd.format(entry)} · Nyt ${priceUsd.format(position.mark)} · Huippu ${priceUsd.format(position.peak)} · ${amount.format(position.sol)} kpl · ${Math.floor((Date.now() - position.openedAt) / 60000)} min`;
    const risk = document.createElement("p");
    risk.textContent = `HOLD${distance ? ` · Trailing-viite ${priceUsd.format(position.peak * (1 - distance / 100))}` : ""} · Hinta ${new Date(position.lastTickAt).toLocaleTimeString("fi-FI")}`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "Sulje paperipositio";
    close.onclick = () => closePaperPosition(position.market);
    item.append(tokenBadge(position.market.symbol, position.market.token), title, change, mark, risk, close);
    return item;
  }));
  if (portfolio.trades[0]?.at !== previous?.trades[0]?.at || !previous) rows("scan-trades", portfolio.trades.slice(0, 20).map(t =>
    `${new Date(t.at).toLocaleTimeString("fi-FI")} · ${t.side} · ${t.symbol} · ${priceUsd.format(t.price)} · ${t.detail || reasons[t.reason]}${Number.isFinite(t.realizedPnl) ? ` · P/L ${usd.format(t.realizedPnl)}` : ""}`));
}

function commitScan(ticks, decide, eligible, policy, signal) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("books", "readwrite");
    const books = transaction.objectStore("books");
    const locked = books.get("emergency-stop");
    const read = books.get(scanKey);
    let portfolio;
    read.onsuccess = () => {
      portfolio = read.result ?? newPortfolio(policy.paperCapital);
      if (signal.aborted || document.visibilityState !== "visible") return;
      try {
        if (locked.result === true) throw new Error("Hätäpysäytys on lukittu.");
        const lastScanAt = portfolio.lastScanAt;
        advancePortfolio(portfolio, ticks, engine, policy, decide, eligible);
        if (portfolio.lastScanAt !== lastScanAt) books.put(portfolio, scanKey);
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(portfolio);
    transaction.onabort = () => reject(transaction.error ?? new Error("Skannaussalkun kirjoitus keskeytyi."));
  });
}

async function closePaperPosition(market) {
  if (mode() !== "paper" || emergency || changingInterlock || closingPosition || !confirm(`Suljetaanko simuloitu positio ${market.symbol || market.token}?`)) return;
  closingPosition = true;
  const request = new AbortController();
  try {
    const tick = await poolPrice(market, request.signal);
    if (mode() !== "paper" || emergency || changingInterlock || document.visibilityState !== "visible") return;
    const previous = await stored(scanKey);
    const updated = await commitScan([{ ...tick, at: Math.max(Date.now(), (previous?.lastScanAt ?? 0) + 1),
      observedAt: tick.at, manual: true, exitsOnly: true }], () => 0, () => false, settings, request.signal);
    renderScan(updated, [tick]);
    if (Object.values(updated.positions).some(item => item.market.pool === market.pool && item.market.token === market.token)) {
      throw new Error("Positio jäi avoimeksi. Hinta vaihtui samaan aikaan, joten voit yrittää uudelleen.");
    }
    logEvent(`Paper-position ${market.symbol || market.token} manuaalinen sulkeminen käsitelty.`);
  } catch (error) {
    byId("status").textContent = error.message;
  } finally { closingPosition = false; }
}

async function startScan() {
  if (emergency || changingInterlock || run || signing || mode() !== "paper" || document.visibilityState !== "visible") return;
  const policy = settings;
  const birdeyeKey = byId("birdeye-key").value.trim();
  byId("birdeye-key").value = "";
  const jupiterKey = byId("trojan-jupiter-key").value.trim();
  byId("trojan-jupiter-key").value = "";
  const simulationWallet = byId("trojan-taker").value.trim();
  if (simulationWallet && !solanaAddress.test(simulationWallet)) {
    byId("scan-status").textContent = "Anna kelvollinen julkinen Solana-osoite.";
    return;
  }
  agentActivity.clear();
  byId("scan-events").replaceChildren();
  if ((policy.strategy === 4 && !copyWallets.length) || (policy.strategy === 3 && !rules)) {
    byId("scan-status").textContent = "Tallenna ehtopuu tai Copy Trading -lompakko valitulle strategialle.";
    return;
  }
  const controller = new AbortController();
  run = controller;
  setButtons();
  logEvent("Automaattinen Paper-skannaus käynnistyi.");
  byId("scan-panel").open = true;
  byId("scan-status").textContent = "Haetaan pooleja…";
  byId("status").textContent = "Automaattinen Paper-skannaus käynnissä.";
  try {
    const load = async () => await stored(scanKey) ?? newPortfolio(policy.paperCapital);
    const tokenResults = new Map();
    const filter = byId("token-status-filter"), query = byId("token-filter-query"), results = byId("token-filter-results");
    function renderTokens(){const q=query.value.trim();const rows=[...tokenResults.values()].reverse().filter(e=>(filter.value==="all"||e.status===filter.value)&&(!q||e.mint.includes(q))).slice(0,100);results.replaceChildren(...rows.map(e=>{const li=document.createElement("li");const label=document.createElement("p");label.textContent=`${e.mint} · ${e.status} · ${e.score??"—"}/100 · ${e.reason}`;const b=document.createElement("button");b.type="button";b.className="secondary";b.textContent="Tutki markkinaa";b.onclick=()=>{const form=byId("market-search");form.elements.query.value=e.mint;form.elements.liquidity.value="0";form.elements.volume.value="0";form.closest("details").open=true;const submit=form.querySelector("button");if(!submit.disabled)form.requestSubmit(submit);form.scrollIntoView({block:"start"});};li.append(tokenBadge(e.market?.symbol,e.mint),label,b);return li;}));}
    let scheduleTokens = false;
    const updateTokens = () => {
      if (scheduleTokens || byId("scan-panel").classList.contains("inactive-page")) return;
      scheduleTokens = true;
      setTimeout(() => { scheduleTokens = false; renderTokens(); }, 450);
    };
    byId("dashboard-nav").addEventListener("click", updateTokens, { signal: controller.signal });
    filter.onchange=renderTokens;query.oninput=renderTokens;renderTokens();
    byId("filter-reasons").replaceChildren();
    await runScanner({ engine, policy, rules: policy.strategy === 3 ? rules : null, timeframe,
      copyWallets: policy.strategy === 4 ? copyWallets : null, birdeyeKey, jupiterKey, simulationWallet, signal: controller.signal, load,
      event(entry) {
        tokenResults.delete(entry.mint);tokenResults.set(entry.mint,entry);
        if(tokenResults.size>2000)tokenResults.delete(tokenResults.keys().next().value);
        updateTokens();
        pendingScanEvents.unshift(entry);
        pendingScanEvents.length = Math.min(pendingScanEvents.length, 240);
        scanEvents.unshift(entry);
        scanEvents.length = Math.min(scanEvents.length, 240);
        agentActivity.set(entry.status === "found" ? "found" : "analysis", entry);
        if (entry.status === "approve" || entry.status === "watch") agentActivity.set("brain", entry);
        if (entry.status === "reject") agentActivity.set("risk", entry);
        refreshFeed();
        const row = document.createElement("li");
        const label = { found: "Löytyi", approve: "Hyväksytty", watch: "Odottaa", reject: "Hylätty" }[entry.status];
        row.textContent = `${new Date(entry.at).toLocaleTimeString("fi-FI")} · ${label} · ${entry.mint}${entry.score == null ? "" : ` · strategia ${entry.score}/100`}${entry.quality == null ? "" : ` · laatu ${entry.quality}/100`} · ${entry.reason}`;
        const list = byId("scan-events");
        list.prepend(row);
        if (list.children.length > 60) list.lastElementChild.remove();
      },
      commit: (ticks, decide, eligible) => commitScan(ticks, decide, eligible, policy, controller.signal),
      telemetry(stats) {
        lastStats = stats;
        showAgents(stats, agentActivity);
        if (Date.now() - lastFeedAt > 10000) void persistScanEvents();
        byId("filter-summary").textContent = `Analysoidut ${stats.analyzed} · Hyväksytyt ${stats.approved} · Hylätyt ${stats.rejected} · Odottavat ${stats.waiting}`;
        byId("filter-reasons").replaceChildren(...stats.reasons.map(([reason, count]) => {
          const p = document.createElement("p");
          p.textContent = `${count} · ${reason}`;
          return p;
        }));
        byId("monitor-summary").textContent = `PumpPortal ${stats.pump} · Työntekijät ${stats.activeWorkers}/${stats.adaptiveLimit} (max ${stats.workerLimit}) · Analyysi ${stats.averageAnalysisMs} ms/token · Löydöstä analyysiin ${stats.averageDiscoveryMs} ms`;
        const sources = [...stats.sources.map(source => [source.name, source.error || (source.busy ? "Haetaan" :
          source.count == null ? "Odottaa" : `Viime haussa ${source.count}`)]), ...Object.entries(stats.apis)];
        byId("monitor-sources").replaceChildren(...sources.map(([name, state]) => {
          const p = document.createElement("p");
          p.textContent = `${name} · ${state}`;
          return p;
        }));
        byId("scan-counts").textContent = `Löydetyt ${stats.found} · Analysoidut ${stats.analyzed} · Hylätyt ${stats.rejected} · Hyväksytyt ${stats.approved}`;
        byId("scan-queue").textContent = `Löydöt/min ${stats.foundPerMinute} · Analyysit/min ${stats.analyzedPerMinute} (ml. uusinnat) · Ostosignaalit/min ${stats.signalsPerMinute} · Kaupat ${stats.tradeCount} · Jono ${stats.queued} · Käsittelyssä ${stats.processing} · Uudelleenhaku ${stats.waiting} · Ohitetut ${stats.dropped}`;
      },
      report(message, portfolio, ticks) {
        if (controller.signal.aborted) return;
        byId("scan-status").textContent = message;
        if (message.startsWith("Skannaus yrittää uudelleen")) {
          agentActivity.set("executionError", { at: Date.now(), reason: message });
        }
        if (portfolio) renderScan(portfolio, ticks);
        else logEvent(message);
      }
    });
  } catch (error) {
    if (!controller.signal.aborted) stop(error.message);
  }
}

async function trade(mode) {
  if (emergency || changingInterlock || run || signing || document.visibilityState !== "visible") return;
  if (mode === "paper" && settings.strategy >= 5) {
    await startScan();
    return;
  }
  const real = mode === "real";
  if (real && (!wallet || !live.ready ||
      !confirm("Käynnistetäänkö Live Trading yhdistetyllä Solana-lompakolla?"))) return;
  const address = wallet;
  const key = mode === "paper" ? paperKey() : mode;
  if (mode !== "demo" && settings.strategy === 3 && (!rules || (rules.candles && !selection.pool))) {
    stop("Tallenna ehtopuu ja valitse tarvittaessa pooli.");
    return;
  }
  if (mode !== "demo" && settings.strategy === 4 && (real || !copyWallets.length || !selection.pool)) {
    stop("Copy Trading vaatii seurattavan lompakon ja poolin Paper-tilassa.");
    return;
  }
  const controller = new AbortController();
  run = controller;
  logEvent(mode === "demo" ? "Testisarja käynnistyi." : `Ajo käynnistyi: ${selection.symbol}.`);
  setButtons();
  byId("source").textContent = mode === "demo" ? "Kiinteä testisarja" : `DEX Screener · ${selection.symbol || selection.token}`;
  byId("price").textContent = "—";
  byId("status").textContent = mode === "demo" ? "Ajetaan testisarjaa…" : "Haetaan hintaa…";
  const policy = mode === "demo"
    ? { ...defaults, strategy: 0, minLiquidity: 0, cooldownSeconds: 0, feeBps: 0, slippageBps: 0 }
    : settings;
  const historyKey = real ? `history:live:${address}` : `history:${key}`;
  const history = [];
  let lastCandleFetch = 0;
  let candles = [];
  let copyCursors = new Map();
  const needsCandles = policy.strategy === 3 && rules?.candles;
  const candleKey = `candles:${selection.pool}:${selection.token}:${timeframe}`;
  if (mode !== "demo") watchSlots(controller.signal, slot => {
    byId("slot").textContent = slot === null ? "Yhdistetään uudelleen…" : String(slot);
  });
  try {
    if(real){
      const journal=await reconcileLiveJournal(address,controller.signal);
      if(journal.some(row=>["reserved","pending","unknown"].includes(row.state)))throw new Error("Live Trading estetty: keskeneräinen transaktio on täsmäytettävä.");
      if(controller.signal.aborted||wallet!==address||emergency)return;
    }
    const initial = real ? await live.snapshot(address, controller.signal) :
      await bookUpdate(key);
    if (controller.signal.aborted) return;
    if (mode !== "demo") {
      const saved = await stored(historyKey);
      const age = Date.now() - (saved?.at ?? 0);
      if (controller.signal.aborted) return;
      if (saved?.interval === policy.interval && age >= 0 && age < policy.interval * 2000 &&
          Array.isArray(saved.prices)) history.push(...saved.prices.slice(-64));
    }
    if (needsCandles) {
      const saved = await stored(candleKey);
      if (controller.signal.aborted) return;
      if (saved?.at <= Date.now() && Date.now() - saved.at < 60000) {
        candles = saved.candles;
        lastCandleFetch = saved.at;
      }
    }
    let count = initial.count ?? 0;
    if (real) renderLive(initial);
    else renderBook(initial, 0, mode === "demo" ? "SOL" : undefined);
    for (let i = 0; mode !== "demo" || i < demoPrices.length; i++) {
      const tick = mode === "demo"
        ? { price: demoPrices[i], at: Math.max(Date.now(), (initial.lastTickAt ?? 0) + 1) + i, liquidity: 0 }
        : selection.pool ? await poolPrice(selection, controller.signal) : await currentMarket(controller.signal);
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      const { price } = tick;
      if (needsCandles && tick.at - lastCandleFetch >= 60000) {
        lastCandleFetch = tick.at;
        try {
          candles = await fetchCandles(selection, timeframe, controller.signal);
          if (controller.signal.aborted) return;
          await stored(candleKey, { at: tick.at, candles });
        } catch (error) {
          if (controller.signal.aborted) return;
          candles = [];
          logEvent(`OHLCV: ${error.message}`);
        }
      }
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      const seconds = timeframes[timeframe][2];
      const completed = needsCandles ? candles.filter(candle =>
        candle.time + seconds <= tick.at / 1000
      ) : [];
      const latest = completed.at(-1);
      const usable = latest && tick.at / 1000 - latest.time <= seconds * 3 ? completed : [];
      history.push(price);
      if (history.length > 64) history.shift();
      if (mode !== "demo") {
        await stored(historyKey, { interval: policy.interval, at: tick.at, prices: history });
        if (controller.signal.aborted || document.visibilityState !== "visible") return;
      }
      let signal = 0;
      if (history.length >= 4) {
        new Float64Array(engine.memory.buffer, engine.sample_buffer(), history.length).set(history);
        signal = engine.entry(history.length, policy.strategy);
      }
      if (policy.strategy === 4) {
        // Baseline is taken at the start of each run. No historical swaps become orders.
        const update = await copyGroup(copyWallets, new Set([selection.token]), copyCursors,
          Date.now(), controller.signal);
        copyCursors = update.cursors;
        signal = update.directions.get(selection.token) ?? 0;
        for (const error of update.failures) logEvent(`Copy Trading: ${error.message}`);
      }
      if (controller.signal.aborted || document.visibilityState !== "visible") return;
      if (mode !== "demo" && (Date.now() < tick.at || Date.now() - tick.at > 20000)) {
        stop("Hinta vanheni ennen toimeksiantoa. Käynnistä ajo uudelleen.");
        return;
      }
      const book = real
        ? await liveTick(address, tick, signal, policy, controller.signal, policy.strategy === 3 ? usable : null)
        : await bookUpdate(key, tick, signal, policy, policy.strategy === 3 ? usable : null, controller.signal);
      if (controller.signal.aborted) return;
      byId("price").textContent = priceUsd.format(price);
      if ((book.count ?? 0) > count && book.trades[0]) {
        const { side, reason } = book.trades[0];
        logEvent(`${side} · ${reason ? reasons[reason] : selection.symbol}`);
        count = book.count;
      }
      if (real) renderLive(book);
      else renderBook(book, price, mode === "demo" ? "SOL" : undefined);
      if (mode === "paper") await renderOpenPositions();
      if (controller.signal.aborted) return;
      if (mode !== "demo") {
        byId("status").textContent = `Viimeisin haku ${new Date().toLocaleTimeString("fi-FI")} · ${policy.interval} s välein`;
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", cancel);
            resolve();
          }, policy.interval * 1000);
          function cancel() {
            clearTimeout(timer);
            resolve();
          }
          controller.signal.addEventListener("abort", cancel, { once: true });
        });
        if (controller.signal.aborted) return;
      }
    }
    stop("Testisarja valmis.");
  } catch (error) {
    if (!controller.signal.aborted) stop(`Ajo keskeytyi. ${error.message}`);
  }
}

async function liveTick(address, tick, signal, policy, abortSignal, candles) {
  const snapshot = await live.snapshot(address, abortSignal);
  const resolved = candles ? ruleSignal(rules, { engine, tick, book: snapshot, candles, orderUsd: policy.orderUsd }) : signal;
  const order = orderFor(engine, resolved, snapshot, tick, policy);
  if (!order || abortSignal.aborted || address !== wallet ||
      document.visibilityState !== "visible") return snapshot;
  const journal=await reconcileLiveJournal(address,abortSignal);
  if(journal.some(row=>["reserved","pending","unknown"].includes(row.state)))throw new Error("Keskeneräinen Live-tapahtuma estää uuden kaupan.");
  if(abortSignal.aborted||address!==wallet||emergency||document.visibilityState!=="visible")return snapshot;
  // Execution must provide a durable submission lifecycle before it can be enabled.
  if(!live.journalAware)throw new Error("Live-toteutusadapterin tapahtumakirjanpito puuttuu.");
  return live.execute({ address, order, price: tick.price, signal: abortSignal });
}

function renderLive(book = {}) {
  renderBook({ cash: 0, sol: 0, trades: [], ...book }, 0);
  byId("balance").textContent = Number.isFinite(book.walletSol)
    ? `${amount.format(book.walletSol)} SOL lompakossa` : "Lompakon saldo —";
}

async function renderMode() {
  const version = ++viewVersion;
  const isLive = mode() === "live";
  setButtons();
  byId("book-title").textContent = isLive ? "Live-salkku" : "Paperisalkku";
  byId("trades-title").textContent = isLive ? "Live-kaupat" : "Simuloidut kaupat";
  byId("price").textContent = "—";
  byId("market-title").textContent = `${selection.symbol || selection.token} / USD`;
  byId("source").textContent = selection.pool ?? "Likvidein SOL-pari";
  byId("settlement-panel").hidden = !isLive;
  byId("open-panel").hidden = isLive;
  renderSettlements([]);
  byId("quote-result").textContent = "";
  byId("home-equity").closest("section").hidden = isLive;
  byId("home-metrics").hidden = isLive;
  byId("home-activity").hidden = isLive;
  byId("scan-positions").closest("section").hidden = isLive;
  if (isLive) {
    renderLive();
    byId("status").textContent = live.ready
      ? "Yhdistä lompakko ja vahvista Live Tradingin käynnistys."
      : "Live Tradingin toteutusadapteri puuttuu. Voit tarkistaa lompakkoyhteyden.";
    if (wallet) {
      const address = wallet;
      try {
        const snapshot = await live.snapshot(address, new AbortController().signal);
        if (version === viewVersion && wallet === address && !run) renderLive(snapshot);
      } catch (error) {
        if (version === viewVersion && wallet === address && !run) {
          byId("status").textContent = error.message;
        }
      }
    }
  } else {
    byId("status").textContent = "WebAssembly valmis. Valitse testisarja tai markkinaseuranta.";
    const book = await bookUpdate(paperKey());
    if (version === viewVersion && !run) {
      renderBook(book, 0);
      await renderOpenPositions();
    }
  }
}

byId("settings").onsubmit = async event => {
  event.preventDefault();
  if (run) return;
  try {
    const updated = validateSettings(Object.fromEntries(
      Array.from(new FormData(event.target), ([name, value]) => [name, value === "" ? NaN : Number(value)])
    ));
    if (mode() === "live" && updated.strategy === 8) throw new Error("Aggressive Momentum on käytössä Paper Trading -tilassa.");
    await stored(settingsKey(), updated);
    settings = updated;
    if (mode() === "paper") renderScan(await stored(scanKey) ?? newPortfolio(settings.paperCapital));
    setButtons();
    byId("status").textContent = "Asetukset tallennettu.";
  } catch (error) {
    byId("status").textContent = error.message;
  }
};

byId("mode").onchange = async () => {
  if (run || signing) return;
  try { await loadModeSettings(); await renderMode(); } catch (error) { stop(error.message); }
};
byId("connect").onclick = async () => {
  const version = viewVersion;
  byId("connect").disabled = true;
  try {
    wallet = await live.connect();
    const address = wallet;
    const snapshot = await live.snapshot(address, new AbortController().signal);
    if (version === viewVersion && wallet === address && !run) {
      renderLive(snapshot);
      const journal=await reconcileLiveJournal(address,new AbortController().signal);
      if(journal.some(row=>["reserved","pending","unknown"].includes(row.state)))logEvent("Live: keskeneräinen tapahtuma vaatii selvityksen.");
      const swaps = await stored(settlementKey(address)) ?? [];
      if (version !== viewVersion || wallet !== address || run) return;
      renderSettlements(swaps);
      byId("status").textContent = live.ready ? "Lompakko yhdistetty." :
        "Lompakko yhdistetty. Live Tradingin toteutusadapteri puuttuu.";
    }
  } catch (error) {
    if (version === viewVersion && !run) {
      byId("status").textContent = error.message;
      if (/Phantom-lompakkoa ei löytynyt/.test(error.message)) {
        const link=document.createElement("a");
        link.href=live.phantomLink();link.textContent="Avaa Phantom-selaimessa";
        link.rel="noopener noreferrer";byId("status").append(" ",link);
      }
    }
  } finally {
    setButtons();
  }
};
byId("sign-probe").onclick = async () => {
  if (run || signing || !wallet || !live.canSign?.()) return;
  const address = wallet;
  const controller = new AbortController();
  signing = controller;
  setButtons();
  try {
    await live.signProbe(address, controller.signal);
    if (mode() === "live" && wallet === address) {
      byId("status").textContent = "Devnet-allekirjoitus varmennettu. Transaktiota ei lähetetty.";
    }
  } catch (error) {
    if (!controller.signal.aborted && mode() === "live") byId("status").textContent = error.message;
  } finally {
    signing = undefined;
    setButtons();
  }
};
live.onWalletChange(() => {
  signing?.abort();
  wallet = undefined;
  if (mode() === "live") {
    stop("Lompakko vaihtui tai yhteys katkesi.");
    renderLive();
  }
});

byId("scan").onclick = startScan;
byId("demo").onclick = () => trade("demo");
byId("live").onclick = () => trade(mode() === "live" ? "real" : "paper");
byId("stop").onclick = () => stop("Pysäytetty.");
async function devnetAction(action) {
  if (mode() !== "live" || devAction || run || document.visibilityState !== "visible") return;
  const controller = new AbortController();
  devAction = controller;
  setButtons();
  try {
    await action(controller.signal);
  } catch (error) {
    byId("devnet-status").textContent = controller.signal.aborted
      ? "Keskeytetty. Mahdollinen odottava tapahtuma voidaan täsmäyttää."
      : error.message;
  } finally {
    devAction = undefined;
    setButtons();
  }
}

async function saveDevnet(record) {
  await new Promise((resolve, reject) => {
    const tx = database.transaction("books", "readwrite");
    const books = tx.objectStore("books");
    const lock = books.get("emergency-stop");
    const read = books.get("devnet-last");
    read.onsuccess = () => {
      if (record.state === "pending" && lock.result === true) {
        reject(new Error("Hätäpysäytys on lukittu."));
        tx.abort();
        return;
      }
      const previous = read.result;
      if (previous?.signature !== record.signature &&
          (previous?.state === "pending" || record.state !== "pending")) {
        reject(new Error("Toinen Devnet-tapahtuma on odottamassa tai näkymä on vanhentunut."));
        tx.abort();
        return;
      }
      if (previous?.signature === record.signature && previous.state !== "pending") {
        reject(new Error("Devnet-tapahtuma on jo täsmäytetty."));
        tx.abort();
        return;
      }
      books.put(record, "devnet-last");
    };
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error("Devnet-kirjaus keskeytyi."));
  });
  devRecord = record;
  byId("devnet-history").textContent = `${record.state} · ${record.signature}`;
}

byId("devnet-create").onclick = () => devnetAction(async () => {
  devWallet = await newDevnetWallet();
  byId("devnet-wallet").textContent = devWallet.address;
  byId("devnet-status").textContent = "Devnet-testilompakko luotu. Avain poistuu sivun sulkeutuessa.";
});
byId("devnet-copy").onclick = async () => {
  if (!devWallet) return;
  try {
    await navigator.clipboard.writeText(devWallet.address);
    byId("devnet-status").textContent = "Julkinen Devnet-osoite kopioitu.";
  } catch {
    byId("devnet-status").textContent = "Kopioi näytetty julkinen osoite käsin.";
  }
};
byId("devnet-send").onclick = () => devnetAction(async signal => {
  if (emergency || changingInterlock || !devWallet || devRecord?.state === "pending") return;
  if ((await devnetBalance(devWallet.address, signal) ?? 0) < 10000) {
    throw new Error("Testilompakolla ei ole vielä riittävästi Devnet-lamporteja.");
  }
  await submitDevnetMemo(devWallet, saveDevnet, signal);
  byId("devnet-status").textContent = "Devnet-testimerkintä lähetetty. Tarkista vahvistus.";
});
byId("devnet-sync").onclick = () => devnetAction(async signal => {
  if (devRecord?.state !== "pending") return;
  await saveDevnet(await reconcileDevnet(devRecord, signal));
  byId("devnet-status").textContent = `Devnet-tila: ${devRecord.state}.`;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    signing?.abort();
    devAction?.abort();
    if (run) stop("Pysäytetty, koska sovellus siirtyi taustalle.");
  }
});
window.addEventListener("offline", () => {
  signing?.abort();
  devAction?.abort();
  if (run) stop("Verkkoyhteys katkesi. Käynnistä ajo uudelleen yhteyden palattua.");
});

window.addEventListener("pagehide", () => {
  signing?.abort();
  devAction?.abort();
  if (run) stop("Pysäytetty sivulta poistuttaessa.");
});

byId("copy-settings").onsubmit = async event => {
  event.preventDefault();
  if (run) return;
  const next = [...new Set(byId("copy-wallet").value.trim().split(/[\s,]+/))];
  if (next.length > 4 || next.some(wallet => !solanaAddress.test(wallet))) {
    byId("status").textContent = "Anna 1–4 Solana-lompakon osoitetta.";
    return;
  }
  try {
    await stored("copy-wallets", next);
    copyWallets = next;
    byId("status").textContent = "Copy Trading -lompakko tallennettu.";
  } catch (error) { byId("status").textContent = error.message; }
};

byId("sync-swaps").onclick = async () => {
  if (!wallet || run || mode() !== "live") return;
  const account = wallet;
  const key = settlementKey(account);
  const version = viewVersion;
  const button = byId("sync-swaps");
  button.disabled = true;
  try {
    const swaps = await recentSwaps(account, selection.token);
    const existing = await stored(key) ?? [];
    const merged = [...new Map([...existing, ...swaps].map(item => [item.signature, item])).values()]
      .sort((a, b) => b.at - a.at).slice(0, 100);
    await stored(key, merged);
    if (viewVersion === version && wallet === account && mode() === "live") {
      renderSettlements(merged);
      byId("status").textContent = `Vahvistettuja Jupiter/USDC-kauppoja: ${merged.length}.`;
    }
  } catch (error) {
    if (viewVersion === version && wallet === account && mode() === "live") byId("status").textContent = error.message;
  } finally { button.disabled = false; }
};

byId("quote-form").onsubmit = async event => {
  event.preventDefault();
  if (mode() !== "live" || run || quoting) return;
  const form = event.target;
  const values = new FormData(form);
  form.elements.namedItem("apiKey").value = "";
  const result = byId("quote-result");
  const version = viewVersion;
  const button = event.submitter ?? form.querySelector("button");
  const simulate = button.value === "simulate";
  const payer = wallet;
  if (simulate && !payer) return;
  quoting = true;
  for (const control of form.querySelectorAll("button")) control.disabled = true;
  result.textContent = "Haetaan Jupiter-tarjousta…";
  try {
    const input = { token: selection.token, side: values.get("side"),
      value: values.get("value"), apiKey: values.get("apiKey"), payer };
    const quote = await (simulate ? simulateSwap(input) : readQuote(input));
    if (version !== viewVersion || (simulate && wallet !== payer)) return;
    const symbol = values.get("side") === "buy" ? selection.symbol : "USDC";
    result.textContent = `Arvio ${formatAtomic(quote.out, quote.decimals)} ${symbol} · vähintään ${formatAtomic(quote.minimum, quote.decimals)} ${symbol}${simulate ? (quote.error ? ` · Simulaatio hylättiin: ${JSON.stringify(quote.error)}` : ` · Simulaatio onnistui, ${quote.units ?? "—"} laskentayksikköä`) : ""}`;
  } catch (error) {
    if (version === viewVersion) result.textContent = error.message;
  } finally {
    quoting = false;
    for (const control of form.querySelectorAll("button")) control.disabled = false;
    setButtons();
  }
};

byId("rules").onsubmit = async event => {
  event.preventDefault();
  if (run) return;
  try {
    const next = validateRules(JSON.parse(byId("rule-json").value));
    const interval = byId("timeframe").value;
    if (!Object.hasOwn(timeframes, interval)) throw new Error("Virheellinen aikaväli.");
    await stored("rule-settings", { rules: next, timeframe: interval });
    rules = next;
    timeframe = interval;
    byId("status").textContent = "Ehtopuut tallennettu.";
  } catch (error) {
    byId("status").textContent = error.message;
  }
};

try {
  const response = await fetch("./engine.wasm");
  if (!response.ok) throw new Error(`WebAssembly HTTP ${response.status}`);
  const compiled = await WebAssembly.instantiate(await response.arrayBuffer());
  engine = compiled.instance.exports;
  database = await openDatabase();
  emergency = await stored("emergency-stop") === true;
  devRecord = await stored("devnet-last");
  if (devRecord) byId("devnet-history").textContent = `${devRecord.state} · ${devRecord.signature}`;
  byId("mode").value = "paper";
  await loadModeSettings();
  selection = await stored("market") ?? solMarket;
  events = await stored("activity") ?? [];
  const legacyCopyWallet = await stored("copy-wallet");
  copyWallets = await stored("copy-wallets") ?? (legacyCopyWallet ? [legacyCopyWallet] : []);
  byId("copy-wallet").value = copyWallets.join("\n");
  renderLog();
  const ruleSettings = await stored("rule-settings");
  if (ruleSettings) {
    rules = validateRules(ruleSettings.rules);
    timeframe = ruleSettings.timeframe;
    byId("rule-json").value = JSON.stringify({ entry: rules.entry, exit: rules.exit }, null, 2);
  }
  byId("timeframe").value = timeframe;
  mountMarkets({
    history: mint => ({
      fills: (scanPortfolio?.trades ?? []).filter(trade => trade.token === mint),
      decisions: [...scanEvents, ...(scanPortfolio?.decisions ?? [])].filter(row => row.mint === mint).sort((a, b) => b.at - a.at)
    }),
    selection: () => selection, select: async market => {
    if (run || signing || mode() === "live") throw new Error("Valitse markkina pysäytetyssä Paper-tilassa.");
    await stored("market", market);
    selection = market;
    logEvent(`Markkina valittu: ${market.symbol}.`);
    await renderMode();
    return true;
  } });
  for (const [name, value] of Object.entries(settings)) {
    byId("settings").elements.namedItem(name).value = String(value);
  }
  byId("mode").value = "paper";
  await renderMode();
  scanEvents = await stored("scan-events") ?? [];
  refreshFeed();
  renderScan(await stored(scanKey) ?? newPortfolio(settings.paperCapital));
  navigator.serviceWorker?.register("./sw.js").catch(error => console.warn(error));
} catch (error) {
  byId("status").textContent = `Käynnistys epäonnistui. ${error.message}`;
}
