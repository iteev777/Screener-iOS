// SPDX-License-Identifier: BUSL-1.1
// Browser port of the risk thresholds in Trojan V2 rugcheck.py.
const numeric = value => (typeof value === "number" || (typeof value === "string" && value.trim())) &&
  Number.isFinite(Number(value)) ? Number(value) : null;
const percentage = value => numeric(value) !== null && numeric(value) >= 0 && numeric(value) <= 100
  ? numeric(value) : null;
const levels = {
  danger: "high", critical: "high", high: "high", warn: "medium", warning: "medium",
  medium: "medium", info: "low", low: "low"
};

export function fullRugCheck(data, { scoreLimit = 40, minHolders = 0, minLPProviders = 0,
  minPumpLock = 0, minRegularLock = 0, maxTopHolder = 50, maxTop10 = 80,
  maxTop3 = 85, maxCreator = 20, maxMedium = 3, maxInsiders = 10,
  maxInsiderPct = 100, maxGraphShare = 100, requireGraph = false } = {}) {
  const reasons = [];
  let high = 0;
  let medium = 0;
  let unknown = 0;
  function risk(level, reason) {
    if (level === "high") high++;
    if (level === "medium") medium++;
    if (level === "unknown") unknown++;
    if (level !== "low") reasons.push(reason);
  }
  const score = numeric(data?.score_normalised);
  if (score === null || score < 0 || score > 100) risk("unknown", "RugCheck-pisteet puuttuvat tai ovat virheelliset");
  else if (score >= 40 || score > scoreLimit) risk("high", "RugCheck-pisteraja");
  const risks = Array.isArray(data?.risks) ? data.risks : [];
  if (!Array.isArray(data?.risks)) risk("unknown", "Riskilista puuttuu");
  for (const item of risks) {
    const label = String(item?.level ?? "").trim().toLowerCase();
    const level = Object.hasOwn(levels, label) ? levels[label] : "unknown";
    risk(level, String(item?.name ?? "Tuntematon riski").slice(0, 100));
  }
  const mint = { ...data, ...data?.token };
  for (const name of ["mintAuthority", "freezeAuthority"]) {
    const authority = mint[name];
    if (authority === true || (typeof authority === "string" && authority)) risk("high", `${name} aktiivinen`);
    else if (!Object.hasOwn(mint, name) || ![null, false, ""].includes(authority)) risk("unknown", `${name} puuttuu`);
  }
  const update = data?.tokenUpdateAuthority ?? data?.updateAuthority ?? mint.updateAuthority ?? data?.tokenMeta?.updateAuthority;
  if (update) risk("medium", "Metadatan päivitysvaltuus");
  const holders = (Array.isArray(data?.topHolders) ? data.topHolders : [])
    .map(row => ({ row, pct: percentage(row?.pct) })).filter(item => item.pct !== null)
    .sort((a, b) => b.pct - a.pct);
  if (!holders.length) risk("unknown", "Omistajajakauma puuttuu");
  const sum = entries => entries.reduce((total, item) => total + item.pct, 0);
  const top10 = holders.slice(0, 10);
  const top = holders[0]?.pct;
  const top10Pct = Math.min(100, sum(top10));
  const top3 = sum(holders.slice(0, 3));
  if (top >= maxTopHolder) risk("high", "Suurimman omistajan osuus");
  else if (top >= 30) risk("medium", "Suurimman omistajan kohonnut osuus");
  if (top10Pct >= maxTop10) risk("high", "Kymmenen suurimman omistajan osuus");
  else if (top10Pct >= 60) risk("medium", "Kymmenen suurimman kohonnut osuus");
  if (top3 > maxTop3) risk("high", "Kolmen suurimman omistajan osuus");
  const insiderRows = top10.filter(({ row }) => row.insider === true);
  if (insiderRows.length > maxInsiders || sum(insiderRows) > maxInsiderPct) risk("high", "Sisäpiirilompakoiden keskittymä");
  const creator = holders.find(({ row }) => row.owner?.toLowerCase?.() === "creator" ||
    (typeof data?.creator === "string" && [row.owner, row.address].includes(data.creator)));
  const supply = numeric(data?.tokenSupply ?? mint.supply);
  const balance = numeric(data?.creatorBalance ?? mint.creatorBalance);
  const creatorPct = creator?.pct ?? (supply > 0 && balance !== null ? percentage(balance / supply * 100) : null);
  if (creatorPct >= maxCreator) risk("high", "Luojan omistusosuus");
  else if (creatorPct >= 10) risk("medium", "Luojan kohonnut omistusosuus");
  const count = numeric(data?.totalHolders);
  const lp = numeric(data?.totalLPProviders);
  const insiders = numeric(data?.graphInsidersDetected);
  if (minHolders > 0 && (!Number.isSafeInteger(count) || count <= 0)) risk("unknown", "Omistajamäärä puuttuu");
  else if (minHolders > 0 && count < minHolders) risk("high", "Liian vähän omistajia");
  if (minLPProviders > 0 && (!Number.isSafeInteger(lp) || lp < 0)) risk("unknown", "LP-tarjoajien määrä puuttuu");
  else if (minLPProviders > 0 && lp < minLPProviders) risk("high", "Liian vähän LP-tarjoajia");
  if (Number.isSafeInteger(lp) && lp >= 0 && lp <= 1) risk("medium", "Vähän LP-tarjoajia");
  if (insiders >= 3) risk("high", "Useita ketjussa linkitettyjä sisäpiiriläisiä");
  else if (insiders > 0) risk("medium", "Ketjussa linkitettyjä sisäpiiriläisiä");
  if (insiders !== null && count > 0 && insiders / count * 100 > maxGraphShare) risk("high", "Sisäpiirin osuus");
  if (requireGraph && (insiders === null || !(count > 0))) risk("unknown", "Sisäpiirigraafi puuttuu");
  let lock = percentage(data?.lpLockedPct);
  if (lock === null) {
    for (const item of risks) {
      if (!/lp.*lock|lock.*lp|liquidity.*lock/i.test(`${item?.name} ${item?.description}`)) continue;
      const info = [item?.value, item?.description, item?.name].join(" ");
      const match = info.match(/(\d+(?:\.\d+)?)\s*%/);
      lock = match ? percentage(match[1]) : /unlock|not locked/i.test(info) ? 0 : /locked/i.test(info) && !/partial/i.test(info) ? 100 : null;
      if (lock !== null) break;
    }
  }
  const minimumLock = /pump/i.test(String(data?.tokenType ?? mint.tokenType ?? "")) ? minPumpLock : minRegularLock;
  if (minimumLock > 0 && lock === null) risk("unknown", "LP-lukitustieto puuttuu");
  else if (minimumLock > 0 && lock < minimumLock) risk("high", "LP-lukitus alle rajan");
  const liquidity = numeric(data?.totalMarketLiquidity);
  if (liquidity !== null && liquidity <= 0) risk("high", "Markkinalikviditeetti puuttuu");
  if (data?.rugged === true) risk("high", "RugCheck merkitsee likviditeettihuijaukseksi");
  const rawFee = data?.transferFeePct ?? data?.transfer_fee_pct ?? data?.transferFee?.pct ?? data?.transferFee?.transferFeePct;
  const fee = numeric(rawFee);
  if (rawFee != null && fee === null) risk("unknown", "Virheellinen siirtomaksu");
  else if (fee < 0 || fee >= 10) risk("high", "Siirtomaksu ylittää rajan");
  else if (fee > 0) risk("medium", "Tokenilla on siirtomaksu");
  if (data?.transferFeeAuthority ?? data?.transferFee?.authority) risk("medium", "Siirtomaksuvaltuus aktiivinen");
  return { status: high || medium >= maxMedium ? "reject" : unknown ? "watch" : "approve",
    reasons, score, top, top10Pct, top3, creatorPct, lock, liquidity, high, medium, unknown };
}
