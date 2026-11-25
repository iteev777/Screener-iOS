#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="${1:?Anna staattisen paketin tuloshakemisto}"
mkdir -p "$output"
bash pwa/build-wasm.sh
cp pwa/{index.html,style.css,app.js,dashboard-nav.js,visual-rules.js,live-adapter.js,wallet-standard.js,network.js,policy.js,markets.js,market-panel.js,rules.js,copy.js,jupiter.js,scanner.js,market-tape.js,market-resolver.js,pool-stream.js,candidate-analyst.js,analyst-worker.js,momentum.js,momentum-learning.js,paper-signal-model.js,agent-dashboard.js,trojan-analysis.js,trojan-discovery.js,trojan-entry.js,trojan-pools.js,trojan-security.js,devnet.js,engine.wasm,sw.js,manifest.webmanifest,icon-192.png,icon-512.png,LICENSE} "$output/"
touch "$output/.nojekyll"
