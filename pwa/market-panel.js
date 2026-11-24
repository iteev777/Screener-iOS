// SPDX-License-Identifier: BUSL-1.1
import { discoverMarkets, fetchCandles, searchMarkets } from "./markets.js";

export function mountMarkets({ selection, select }) {
  const form = document.getElementById("market-search");
  const rows = document.getElementById("market-results");
  const status = document.getElementById("market-status");
  const candleStatus = document.getElementById("candle-status");
  let candlesRequest;
  let inspected;
  const canvas = document.getElementById("token-chart");
  function draw(data) {
    const ctx=canvas.getContext("2d"); if(!ctx)return;
    const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);
    if(!data.length)return;
    const low=Math.min(...data.map(c=>c.low)), high=Math.max(...data.map(c=>c.high));
    const y=v=>12+(high-v)/(high-low||high||1)*(h-40), step=(w-24)/data.length;
    data.forEach((c,i)=>{const x=12+(i+.5)*step;ctx.strokeStyle=ctx.fillStyle=c.close>=c.open?"#89e8c1":"#ff8585";ctx.beginPath();ctx.moveTo(x,y(c.high));ctx.lineTo(x,y(c.low));ctx.stroke();ctx.fillRect(x-step*.3,Math.min(y(c.open),y(c.close)),step*.6,Math.max(1,Math.abs(y(c.open)-y(c.close))));});
    document.getElementById("chart-range").textContent=`${low.toPrecision(5)} – ${high.toPrecision(5)} · ${data.length} kynttilää`;
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const values = new FormData(form);
    const submitters = [...form.querySelectorAll("button")];
    for (const button of submitters) button.disabled = true;
    rows.replaceChildren();
    status.textContent = "Haetaan markkinoita…";
    try {
      const bounds = { liquidity: Number(values.get("liquidity")), volume: Number(values.get("volume")) };
      const feed = event.submitter?.value;
      const markets = feed === "new_pools" || feed === "trending_pools"
        ? await discoverMarkets(feed, bounds)
        : await searchMarkets(values.get("query"), bounds);
      for (const market of markets) {
        const row = document.createElement("li");
        const choose = document.createElement("button");
        choose.type = "button";
        choose.textContent = `${market.symbol || market.token} · $${market.price} · likviditeetti $${market.liquidity.toLocaleString("fi-FI")}`;
        choose.title = `${market.token} / ${market.pool}`;
        choose.onclick = () => select(market).then(changed => {
          if (changed) {
            status.textContent = `Valittu ${market.symbol || market.token}.`;
            candleStatus.textContent = "";
            document.getElementById("candles").replaceChildren();
            inspected = market;
            draw([]);
            candlesRequest?.abort();
          }
        }).catch(error => { status.textContent = error.message; });
        const inspect=document.createElement("button"); inspect.type="button"; inspect.className="secondary"; inspect.textContent="Tiedot";
        inspect.onclick=()=>{ inspected=market; candlesRequest?.abort(); draw([]); document.getElementById("chart-range").textContent=""; document.getElementById("token-detail-title").textContent=market.symbol||market.token; document.getElementById("token-detail-data").textContent=`Mint ${market.token} · Pool ${market.pool} · Hinta ${market.price} · Likviditeetti ${market.liquidity} · Volyymi 24h ${market.volume??"—"} · Muutos 24h ${market.change??"—"} %`; document.getElementById("load-candles").click(); };
        row.append(choose,inspect);
        rows.append(row);
      }
      status.textContent = `${markets.length} tulosta.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      for (const button of submitters) button.disabled = false;
    }
  };
  document.getElementById("load-candles").onclick = async () => {
    candlesRequest?.abort();
    const request = new AbortController();
    candlesRequest = request;
    try {
      const data = await fetchCandles(inspected ?? selection(), document.getElementById("chart-timeframe").value, request.signal);
      if (request.signal.aborted) return;
      draw(data);
      const lines = data.slice(-12).reverse().map(candle => {
        const item = document.createElement("li");
        item.textContent = `${new Date(candle.time * 1000).toLocaleString("fi-FI")}: O ${candle.open} · H ${candle.high} · L ${candle.low} · C ${candle.close} · V ${candle.volume}`;
        return item;
      });
      document.getElementById("candles").replaceChildren(...lines);
      candleStatus.textContent = `${data.length} kynttilää.`;
    } catch (error) {
      if (!request.signal.aborted) candleStatus.textContent = error.message;
    }
  };
}
