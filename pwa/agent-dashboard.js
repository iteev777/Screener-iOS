// SPDX-License-Identifier: BUSL-1.1
const element = id => document.getElementById(id);
const money = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "USD" });
const time = at => new Date(at).toLocaleTimeString("fi-FI");

export function equityDashboard(portfolio, equity) {
  const positions = Object.values(portfolio.positions);
  const invested = positions.reduce((sum, item) => sum + item.cost, 0);
  const unrealized = equity - portfolio.cash - invested;
  const change = portfolio.realized + unrealized;
  const sales = portfolio.trades.filter(trade => trade.side === "Myynti" && Number.isFinite(trade.realizedPnl));
  const base = portfolio.initialCash ?? 1000;
  const value = element("home-equity");
  if (value.textContent !== money.format(equity)) {
    value.textContent = money.format(equity);
    value.animate?.([{ opacity: .65 }, { opacity: 1 }], matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250);
  }
  for (const [id, label, delta] of [
    ["home-return", `${money.format(change)} · ${(100 * change / base).toFixed(2)} %`, change],
    ["home-invested", money.format(invested), 0], ["home-unrealized", money.format(unrealized), unrealized],
    ["home-win-rate", sales.length ? `${(100 * sales.filter(item => item.realizedPnl > 0).length / sales.length).toFixed(1)} %` : "—", 0]
  ]) {
    element(id).textContent = label;
    element(id).classList.toggle("positive", delta > 0);
    element(id).classList.toggle("negative", delta < 0);
  }
  const canvas = element("equity-chart");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const points = portfolio.history ?? [];
  const key = points.at(-1)?.at ?? "empty";
  if (canvas.dataset.asOf === String(key)) return;
  canvas.dataset.asOf = key;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return;
  const low = Math.min(...points.map(row => row.equity));
  const high = Math.max(...points.map(row => row.equity));
  const from = points[0].at;
  const span = Math.max(1, points.at(-1).at - from);
  ctx.strokeStyle = change < 0 ? "#fb7185" : "#63e6ae";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [i, row] of points.entries()) {
    const x = 8 + (row.at - from) / span * (canvas.width - 16);
    const y = (high === low ? .5 : (high - row.equity) / (high - low)) * (canvas.height - 20) + 10;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    if (points.length === 1) ctx.lineTo(canvas.width - 8, y);
  }
  ctx.stroke();
}

function decisionLabel(row) {
  return ({ found: "Löydetty", approve: "Ostosignaali", watch: "WATCH", reject: "REJECT" })[row.status] ?? row.status;
}

export function tokenBadge(symbol, mint) {
  const badge = document.createElement("span");
  badge.className = "token-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = (symbol || mint).slice(0, 2).toUpperCase();
  return badge;
}

export function eventRows(rows) {
  return rows.map(row => {
    const item = document.createElement("li");
    const title = document.createElement("b");
    const market = row.market;
    const label = [market?.name, market?.symbol].filter(Boolean).join(" · ") || row.mint;
    title.textContent = `${decisionLabel(row)} · ${label}`;
    const detail = document.createElement("p");
    detail.textContent = `${time(row.at)} · ${market?.price ? money.format(market.price) : "—"}${row.score == null ? "" : ` · ${row.score}/100`} · ${row.reason}`;
    item.append(tokenBadge(market?.symbol, row.mint), title, detail);
    return item;
  });
}

export function showAgents(stats, activity) {
  const data = [
    ["SCANNER", `${stats.pump} · ${stats.foundPerMinute} löydettyä/min`, stats.found, "Etsii ja yhdistää tokeneita", activity.get("found")],
    ["ANALYST", `${stats.activeWorkers}/${stats.adaptiveLimit} aktiivista · ${stats.averageAnalysisMs} ms/token`, stats.analysisTotal, "Pisteyttää ja priorisoi", activity.get("analysis")],
    ["BRAIN", `${stats.signalsPerMinute} ostosignaalia/min`, stats.approved, "Päättää ostoista ja poistumisista", activity.get("brain")],
    ["EXECUTOR", stats.lastFill || "Odottaa toimeksiantoa", stats.tradeCount, "Kirjaa toteutuneet paperikaupat", activity.get("fill")],
    ["RISK", `${stats.rejected} hylättyä · ${stats.waiting} odottaa`, stats.rejected, "Valvoo tuoreutta, altistusta ja turvallisuutta", activity.get("risk")]
  ];
  const target = element("agent-cards");
  if (!target.children.length) {
    for (const [name] of data) {
      const card = document.createElement("article");
      const heading = document.createElement("h3");
      heading.textContent = name;
      card.append(heading, ...Array.from({ length: 4 }, () => document.createElement("p")));
      target.append(card);
    }
  }
  data.forEach(([name, state, count, task, last], index) => {
    const card = target.children[index];
    const details = [state, `${task} · ${count}`, last ? `${time(last.at)} · ${last.reason}` : "Ei tapahtumia",
      name === "SCANNER" || name === "ANALYST" ? stats.sourceError || "" :
        name === "EXECUTOR" || name === "RISK" ? activity.get("executionError")?.reason || "" : ""];
    details.forEach((text, i) => {
      const row = card.children[i + 1];
      if (row.textContent !== text) row.textContent = text;
    });
    card.classList.toggle("agent-active", Boolean(last && Date.now() - last.at < 4500));
  });
}

export function renderFeed(rows) {
  element("agent-feed").replaceChildren(...eventRows(rows.slice(0, 45)));
}
