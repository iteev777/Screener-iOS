// SPDX-License-Identifier: BUSL-1.1
// Notifications trigger quote refreshes. Account data itself is never a USD quote.
export function poolStream(signal, changed, status) {
  let socket;
  let retry;
  let connectTimeout;
  let ackTimeout;
  let serial = 0;
  let failures = 0;
  let desired = new Set();
  const requests = new Map();
  const subscriptions = new Map();
  const blocked = new Set();

  function send(method, params) {
    const id = ++serial;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }
  function sync() {
    if (socket?.readyState !== 1) return;
    for (const [id, pool] of subscriptions) {
      if (desired.has(pool)) continue;
      send("logsUnsubscribe", [id]);
      subscriptions.delete(id);
    }
    const subscribed = new Set([...subscriptions.values(), ...requests.values()]);
    for (const pool of desired) {
      if (subscribed.has(pool) || blocked.has(pool) || requests.size >= 8) continue;
      requests.set(send("logsSubscribe", [{ mentions: [pool] }, { commitment: "confirmed" }]), pool);
    }
    if (requests.size && ackTimeout === undefined) {
      ackTimeout = setTimeout(() => { ackTimeout = undefined; if (requests.size) socket?.close(); }, 10000);
    }
  }
  function connect() {
    if (signal.aborted || !desired.size) return;
    let peer;
    try { peer = new WebSocket(failures % 2 ? "wss://solana-rpc.publicnode.com" : "wss://api.mainnet-beta.solana.com"); }
    catch { status("WebSocket ei käytettävissä"); return; }
    socket = peer;
    connectTimeout = setTimeout(() => peer.close(), 10000);
    peer.onopen = () => { clearTimeout(connectTimeout); status("yhdistetty"); sync(); };
    peer.onmessage = ({ data }) => {
      if (signal.aborted || socket !== peer || typeof data !== "string" || data.length > 65536) return;
      try {
        const message = JSON.parse(data);
        if (requests.has(message.id)) {
          const pool = requests.get(message.id);
          requests.delete(message.id);
          if (!requests.size) { clearTimeout(ackTimeout); ackTimeout = undefined; }
          if (Number.isSafeInteger(message.result)) { subscriptions.set(message.result, pool); failures = 0; }
          else { blocked.add(pool); status("Osa tilauksista hylättiin"); }
          sync();
        }
        const pool = message.method === "logsNotification" && subscriptions.get(message.params?.subscription);
        const notification = message.params?.result;
        if (pool && desired.has(pool) && Number.isSafeInteger(notification?.context?.slot) &&
            notification?.value?.err === null) changed(pool);
      } catch { /* Ignore malformed provider frames. */ }
    };
    peer.onclose = () => {
      clearTimeout(connectTimeout);
      clearTimeout(ackTimeout);
      ackTimeout = undefined;
      socket = undefined;
      requests.clear();
      subscriptions.clear();
      blocked.clear();
      if (signal.aborted) return;
      status("yhdistetään uudelleen");
      retry = setTimeout(() => { retry = undefined; connect(); }, Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)));
    };
  }
  signal.addEventListener("abort", () => { clearTimeout(retry); clearTimeout(connectTimeout); clearTimeout(ackTimeout); socket?.close(); }, { once: true });
  return pools => {
    desired = new Set([...pools].slice(0, 8));
    for (const pool of blocked) if (!desired.has(pool)) blocked.delete(pool);
    if (!socket && retry === undefined) connect();
    else sync();
  };
}
