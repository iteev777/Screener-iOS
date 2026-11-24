// SPDX-License-Identifier: BUSL-1.1
import { discoverMarkets, fetchCandles, searchMarkets } from "./markets.js";

export function mountMarkets({ selection, select }) {
  const form = document.getElementById("market-search");
  const rows = document.getElementById("market-results");
  const status = document.getElementById("market-status");
  const candleStatus = document.getElementById("candle-status");
  let candlesRequest;
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
            candlesRequest?.abort();
          }
        }).catch(error => { status.textContent = error.message; });
        row.append(choose);
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
      const data = await fetchCandles(selection(), document.getElementById("timeframe").value, request.signal);
      if (request.signal.aborted) return;
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
