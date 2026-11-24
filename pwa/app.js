import { devnetBalance, newDevnetWallet, reconcileDevnet, submitDevnetMemo } from "./devnet.js";
import { advancePortfolio, newPortfolio, runScanner, scanKey } from "./scanner.js";
import { createLiveAdapter } from "./live-adapter.js";

import { currentMarket, watchSlots } from "./network.js";
import { applyPaperFill, defaults, orderFor, reasons, validateSettings } from "./policy.js";

import { fetchCandles, poolPrice, solMarket, timeframes } from "./markets.js";
import { ruleSignal, validateRules } from "./rules.js";
import { formatAtomic, readQuote, simulateSwap } from "./jupiter.js";
import { copyGroup, recentSwaps } from "./copy.js";
import { address as solanaAddress } from "./markets.js";
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

function renderScan(portfolio, ticks = []) {
  const positions = Object.values(portfolio.positions);
  const equity = portfolio.cash + positions.reduce((sum, p) => sum + p.sol * p.mark, 0);
  byId("home-equity").textContent = usd.format(equity);
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
  rows("scan-positions", positions.map(p =>
    `${p.market.symbol} · ${amount.format(p.sol)} · viimeisin P/L ${usd.format(p.mark * p.sol - p.cost)}`));
  rows("scan-trades", portfolio.trades.slice(0, 20).map(t =>
    `${new Date(t.at).toLocaleTimeString("fi-FI")} · ${t.side} · ${t.symbol} · ${priceUsd.format(t.price)} · ${reasons[t.reason]}`));
}

function commitScan(ticks, decide, eligible, policy, signal) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("books", "readwrite");
    const books = transaction.objectStore("books");
    const locked = books.get("emergency-stop");
    const read = books.get(scanKey);
    let portfolio;
    read.onsuccess = () => {
      portfolio = read.result ?? newPortfolio();
      if (signal.aborted || document.visibilityState !== "visible") return;
      try {
        if (locked.result === true) throw new Error("Hätäpysäytys on lukittu.");
        advancePortfolio(portfolio, ticks, engine, policy, decide, eligible);
        books.put(portfolio, scanKey);
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(portfolio);
    transaction.onabort = () => reject(transaction.error ?? new Error("Skannaussalkun kirjoitus keskeytyi."));
  });
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
    const load = async () => await stored(scanKey) ?? newPortfolio();
    const samples = [];
    const rejectionReasons = new Map();
    const tokenResults = new Map();
    const filter = byId("token-status-filter"), query = byId("token-filter-query"), results = byId("token-filter-results");
    function renderTokens(){const q=query.value.trim();const rows=[...tokenResults.values()].reverse().filter(e=>(filter.value==="all"||e.status===filter.value)&&(!q||e.mint.includes(q))).slice(0,100);results.replaceChildren(...rows.map(e=>{const li=document.createElement("li");const label=document.createElement("p");label.textContent=`${e.mint} · ${e.status} · ${e.score??"—"}/100 · ${e.reason}`;const b=document.createElement("button");b.type="button";b.className="secondary";b.textContent="Tutki markkinaa";b.onclick=()=>{const form=byId("market-search");form.elements.query.value=e.mint;form.elements.liquidity.value="0";form.elements.volume.value="0";form.closest("details").open=true;const submit=form.querySelector("button");if(!submit.disabled)form.requestSubmit(submit);form.scrollIntoView({block:"start"});};li.append(label,b);return li;}));}
    filter.onchange=renderTokens;query.oninput=renderTokens;renderTokens();
    byId("filter-reasons").replaceChildren();
    await runScanner({ engine, policy, rules: policy.strategy === 3 ? rules : null, timeframe,
      copyWallets: policy.strategy === 4 ? copyWallets : null, birdeyeKey, jupiterKey, simulationWallet, signal: controller.signal, load,
      event(entry) {
        tokenResults.delete(entry.mint);tokenResults.set(entry.mint,entry);
        if(tokenResults.size>2000)tokenResults.delete(tokenResults.keys().next().value);
        renderTokens();
        const row = document.createElement("li");
        const label = { found: "Löytyi", approve: "Hyväksytty", watch: "Odottaa", reject: "Hylätty" }[entry.status];
        row.textContent = `${new Date(entry.at).toLocaleTimeString("fi-FI")} · ${label} · ${entry.mint}${entry.score == null ? "" : ` · strategia ${entry.score}/100`}${entry.quality == null ? "" : ` · laatu ${entry.quality}/100`} · ${entry.reason}`;
        if (entry.status === "reject") {
          rejectionReasons.set(entry.reason, (rejectionReasons.get(entry.reason) ?? 0) + 1);
          byId("filter-reasons").replaceChildren(...[...rejectionReasons].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([reason,count])=>{ const p=document.createElement("p"); p.textContent=`${count} · ${reason}`; return p; }));
        }
        const list = byId("scan-events");
        list.prepend(row);
        if (list.children.length > 60) list.lastElementChild.remove();
      },
      commit: (ticks, decide, eligible) => commitScan(ticks, decide, eligible, policy, controller.signal),
      telemetry(stats) {
      const total = stats.analyzed || 0;
      byId("filter-summary").textContent = `Analysoidut ${total} · Hyväksytyt ${stats.approved} · Hylätyt ${stats.rejected} · Odottavat ${stats.waiting}`;
      byId("monitor-summary").textContent = `PumpPortal ${stats.pump} · Työntekijät ${stats.activeWorkers ?? 0} · Keskimääräinen analyysierä ${stats.averageAnalysisMs ?? 0} ms`;
      byId("monitor-sources").replaceChildren(...(stats.sources ?? []).map(source => {
        const p = document.createElement("p");
        p.textContent = `${source.name}: ${source.error || (source.busy ? "Haetaan" : "Viimeisin haku: "+source.count)}`;
        return p;
      }));
        const now = Date.now();
        if (!samples.length || now - samples.at(-1).at >= 1000) samples.push({at:now,found:stats.found,analyzed:stats.analyzed});
        while (samples.length > 1 && samples[1].at <= now - 60000) samples.shift();
        const first = samples[0];
        const elapsed = (now - first.at) / 60000;
        const rate = key => elapsed >= 0.1 ? Math.round((stats[key] - first[key]) / elapsed) : "–";
        byId("scan-counts").textContent = `Löydetyt ${stats.found} · Analysoidut ${stats.analyzed} · Hylätyt ${stats.rejected} · Hyväksytyt ${stats.approved}`;
        byId("scan-queue").textContent = `Main ${stats.mainQueue ?? 0} · Sniper ${stats.sniperQueue ?? 0} · Löydöt/min ${rate("found")} · Analyysit/min ${rate("analyzed")} · Jono ${stats.queued} · Käsittelyssä ${stats.processing} · Uudelleenhaku ${stats.waiting} · Ohitetut ${stats.dropped} · PumpPortal ${stats.pump}${stats.sourceError ? ` · ${stats.sourceError}` : ""}`;
        let panel = byId("scan-source-stats");
        if (!panel) {
          panel = document.createElement("pre");
          panel.id = "scan-source-stats";
          panel.style.whiteSpace = "pre-wrap";
          byId("scan-queue").after(panel);
        }
        panel.textContent = (stats.sources ?? []).map(s => `${s.name}: ${s.count} · ${s.busy ? "Haetaan" : s.error ? "Virhe: " + s.error : "Valmis / odottaa"}`).join("\n");
      },
      report(message, portfolio, ticks) {
        if (controller.signal.aborted) return;
        byId("scan-status").textContent = message;
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
    await stored(settingsKey(), updated);
    settings = updated;
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
      const swaps = await stored(settlementKey(address)) ?? [];
      if (version !== viewVersion || wallet !== address || run) return;
      renderSettlements(swaps);
      byId("status").textContent = live.ready ? "Lompakko yhdistetty." :
        "Lompakko yhdistetty. Live Tradingin toteutusadapteri puuttuu.";
    }
  } catch (error) {
    if (version === viewVersion && !run) byId("status").textContent = error.message;
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
  mountMarkets({ selection: () => selection, select: async market => {
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
  renderScan(await stored(scanKey) ?? newPortfolio());
  navigator.serviceWorker?.register("./sw.js").catch(error => console.warn(error));
} catch (error) {
  byId("status").textContent = `Käynnistys epäonnistui. ${error.message}`;
}
