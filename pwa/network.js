export const mint = "So11111111111111111111111111111111111111112";
export const market = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
export const rpc = "https://api.mainnet-beta.solana.com";
const alternateRpc = "https://solana-rpc.publicnode.com";
let preferAlternateUntil = 0;
const retryableReads = new Set(["getMultipleAccounts", "getBalance", "getTokenSupply",
  "getSignaturesForAddress", "getTransaction", "simulateTransaction"]);

export async function fetchJson(url, options = {}, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 10000);
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(url, { ...options, cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function currentMarket(signal) {
  const pairs = await fetchJson(market, {}, signal);
  if (!Array.isArray(pairs)) throw new Error("Hintavastauksen muoto muuttui.");
  const best = pairs.filter(pair => pair.chainId === "solana" && pair.baseToken?.address === mint &&
      Number.isFinite(Number(pair.priceUsd)) && Number(pair.priceUsd) >= 0.01 &&
      Number(pair.priceUsd) <= 1000000 && Number.isFinite(pair.liquidity?.usd) &&
      pair.liquidity.usd > 0)
    .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
  if (!best) throw new Error("Kelvollista SOL-markkinaa ei löytynyt.");
  return { price: Number(best.priceUsd), liquidity: best.liquidity.usd, at: Date.now(),
    pool: best.pairAddress, volume: best.volume?.h24, change: best.priceChange?.h24,
    transactions: best.txns, created: best.pairCreatedAt };
}

export async function rpcCall(method, params, signal, endpoint = rpc) {
  const options = { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) };
  const fallback = endpoint === rpc && retryableReads.has(method);
  const first = fallback && Date.now() < preferAlternateUntil ? alternateRpc : endpoint;
  let data;
  try {
    data = await fetchJson(first, options, signal);
  } catch (error) {
    if (signal?.aborted || !fallback ||
        (error.status && ![403, 429, 500, 502, 503, 504].includes(error.status))) throw error;
    data = await fetchJson(first === rpc ? alternateRpc : rpc, options, signal);
    preferAlternateUntil = first === rpc ? Date.now() + 60000 : 0;
  }
  if (data?.id !== 1 || data.error || !Object.hasOwn(data, "result")) {
    throw new Error(`Solana RPC: ${data?.error?.message ?? "virheellinen vastaus"}`);
  }
  return data.result;
}

export function watchSlots(signal, report) {
  if (signal.aborted) return;
  let socket;
  let retry;
  let liveness;
  let attempts = 0;
  let alternate = false;
  let lastReported = -Infinity;
  function start() {
    socket = new WebSocket(alternate ? "wss://solana-rpc.publicnode.com/" :
      "wss://api.mainnet-beta.solana.com/");
    function heartbeat() {
      clearTimeout(liveness);
      liveness = setTimeout(() => socket.close(), 20000);
    }
    heartbeat();
    socket.onopen = () => socket.send(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "slotSubscribe"
    }));
    socket.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data?.id === 1 && data.error) socket.close();
      const slot = data?.params?.result?.slot;
      if (data?.method === "slotNotification" && Number.isSafeInteger(slot) && slot >= 0) {
        attempts = 0;
        heartbeat();
        const now = performance.now();
        if (now - lastReported >= 5000) {
          lastReported = now;
          report(slot);
        }
      }
    };
    socket.onclose = () => {
      clearTimeout(liveness);
      if (signal.aborted) return;
      lastReported = -Infinity;
      alternate = !alternate;
      report(null);
      retry = setTimeout(start, 2000 * 2 ** Math.min(attempts++, 4));
    };
  }
  signal.addEventListener("abort", () => {
    clearTimeout(retry);
    clearTimeout(liveness);
    socket?.close();
  }, { once: true });
  start();
}
