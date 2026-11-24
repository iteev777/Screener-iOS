// SPDX-License-Identifier: BUSL-1.1
// Account owners, layout guards and offsets from Trojan V2 solana_onchain.py.
import { rpcCall } from "./network.js";
import { publicKeyBytes } from "./wallet-standard.js";
const pool = [241, 154, 109, 4, 17, 177, 109, 188];
const state = [247, 237, 227, 245, 215, 195, 222, 70];
const layouts = new Map([
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", ["PumpSwap", 271, pool, [43, 75, 139, 171]]],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", ["Raydium CPMM", 413, state, [168, 200, 72, 104]]],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", ["Raydium CLMM", 269, state, [73, 105, 137, 169]]],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", ["Raydium AMM v4", 464, null, [400, 432, 336, 368]]],
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", ["Orca Whirlpool", 245, [63, 149, 209, 12, 225, 128, 99, 9], [101, 181, 133, 213]]],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", ["Meteora DLMM", 216, [33, 11, 49, 98, 181, 101, 177, 13], [88, 120, 152, 184]]],
  ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", ["Meteora DAMM v2", 488, pool, [168, 200, 232, 264]]],
  ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", ["Meteora DBC", 306, [213, 224, 5, 209, 98, 69, 119, 92], [136, null, 168, 200]]],
  ["FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X", ["FluxBeam", 324, null, [131, 163, 35, 67]]],
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", ["Pump.fun", 125, [23, 183, 248, 55, 96, 216, 172, 96], [null, 83]]],
  ["MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG", ["Moonit", 82, [8, 91, 83, 28, 132, 216, 248, 22], [24]]]
]);
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

export function decodePool(owner, bytes) {
  const layout = layouts.get(owner);
  if (!layout) return { status: "unsupported", reason: "Poolin ohjelma ei kuulu tuettuihin" };
  const [protocol, length, discriminator, offsets] = layout;
  const fail = () => ({ status: "reject", protocol, reason: `${protocol}: poolin rakenne tai tila ei kelpaa` });
  if (bytes.length < length || (discriminator && !equal(bytes.subarray(0, 8), discriminator))) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = offset => view.getBigUint64(offset, true);
  const nonzero128 = offset => bytes.subarray(offset, offset + 16).some(Boolean);
  const fee = (num, den) => u64(den) > 0n && u64(num) < u64(den);
  switch (protocol) {
    case "PumpSwap": if (bytes[243] || bytes[244] || bytes[270]) return fail(); break;
    case "Raydium CPMM": if (bytes[329] & 4) return fail(); break;
    case "Raydium AMM v4": if (![1n, 6n, 7n].includes(u64(0)) || !fee(176, 184)) return fail(); break;
    case "Raydium CLMM": if (!nonzero128(253)) return fail(); break;
    case "Orca Whirlpool": if (!nonzero128(65)) return fail(); break;
    case "Meteora DLMM": if (bytes[82] || !view.getUint16(80, true)) return fail(); break;
    case "Meteora DAMM v2": if (bytes[481] || !nonzero128(456)) return fail(); break;
    case "Meteora DBC": if (bytes[305]) return fail(); break;
    case "FluxBeam": if (bytes.length !== 324 || bytes[1] !== 1 || !fee(227, 235) || !fee(243, 251)) return fail(); break;
    case "Pump.fun": if (bytes[48]) return fail(); break;
  }
  const key = offset => offset == null ? null : bytes.slice(offset, offset + 32);
  const [base, quote, baseVault, quoteVault] = offsets.map(key);
  return { status: "decoded", protocol, base, quote, baseVault, quoteVault };
}

export async function verifyPools(rows, signal) {
  if (!rows.length) return [];
  const result = await rpcCall("getMultipleAccounts", [rows.map(row => row.pool), {
    commitment: "confirmed", encoding: "base64"
  }], signal);
  if (!Array.isArray(result?.value) || result.value.length !== rows.length) throw new Error("Poolitilit puuttuvat");
  return result.value.map((account, i) => {
    if (!account || account.executable !== false || account.data?.[1] !== "base64" ||
        typeof account.data[0] !== "string" || account.data[0].length > 32768) {
      return { status: "watch", reason: "Poolitili puuttuu tai on virheellinen" };
    }
    const decoded = decodePool(account.owner, Uint8Array.from(atob(account.data[0]), ch => ch.charCodeAt(0)));
    if (decoded.status !== "decoded") return decoded;
    const market = rows[i];
    const base = publicKeyBytes(market.token);
    const quote = typeof market.quoteToken === "string" ? publicKeyBytes(market.quoteToken) : null;
    if (!decoded.base || !decoded.quote || !quote) {
      return { status: "unsupported", protocol: decoded.protocol, reason: "Poolin tokenparia ei voida varmistaa tilistä" };
    }
    const matches = (equal(decoded.base, base) && equal(decoded.quote, quote)) ||
      (equal(decoded.base, quote) && equal(decoded.quote, base));
    return { status: matches ? "approve" : "reject", protocol: decoded.protocol,
      reason: matches ? `${decoded.protocol}: poolitili ja mintit varmennettu` : "Poolitilin mintit eivät vastaa markkinaparia" };
  });
}

const tokenPrograms = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
function accountBytes(account) {
  if (!account || account.executable !== false || account.data?.[1] !== "base64") throw new Error("Virheellinen reservitili");
  return Uint8Array.from(atob(account.data[0]), ch => ch.charCodeAt(0));
}
function encodeKey(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n, out = "", zeros = 0;
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}
export function decodeReserve(vault, mint, expected) {
  if (!tokenPrograms.has(vault?.owner) || vault.owner !== mint?.owner) throw new Error("Reservin tokenohjelma ei täsmää");
  const v = accountBytes(vault), m = accountBytes(mint);
  if (v.length < 165 || m.length < 82 || !equal(v.subarray(0,32), expected) || v[108] !== 1 || m[45] !== 1) throw new Error("Reservin mintti tai tila ei kelpaa");
  const raw = new DataView(v.buffer, v.byteOffset, v.byteLength).getBigUint64(64,true);
  if (!raw) throw new Error("Tyhjä reservi");
  return { raw: raw.toString(), decimals: m[44], amount: Number(raw) / 10 ** m[44] };
}
export async function verifyPoolReserves(market, signal) {
  const options = { commitment:"confirmed", encoding:"base64" };
  const first = await rpcCall("getMultipleAccounts", [[market.pool], options], signal);
  const account = first?.value?.[0];
  const decoded = decodePool(account?.owner, accountBytes(account));
  if (decoded.status !== "decoded" || !decoded.baseVault || !decoded.quoteVault || !decoded.base || !decoded.quote) return { status:"watch", reason:"Reservirakenne ei ole tuettu" };
  const keys = [decoded.baseVault, decoded.quoteVault, decoded.base, decoded.quote].map(encodeKey);
  const feeKeys = decoded.protocol === "PumpSwap" ? ["ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw","5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx"] : [];
  const snapshot = await rpcCall("getMultipleAccounts", [[market.pool, ...keys, ...feeKeys], options], signal);
  const [p, v1, v2, m1, m2, globalConfig, feeConfig] = snapshot?.value ?? [];
  if (p?.owner !== account.owner) throw new Error("Poolin omistaja vaihtui");
  const fresh = decodePool(p.owner, accountBytes(p));
  if (fresh.status !== "decoded" || !["baseVault","quoteVault","base","quote"].every(k => fresh[k] && equal(fresh[k], decoded[k]))) throw new Error("Poolin rakenne vaihtui");
  const base = decodeReserve(v1,m1,fresh.base), quote = decodeReserve(v2,m2,fresh.quote);
  if (!Number.isSafeInteger(snapshot.context?.slot) || snapshot.context.slot <= 0) throw new Error("RPC-slot puuttuu");
  const requested = publicKeyBytes(market.token), other = publicKeyBytes(market.quoteToken);
  if (!((equal(fresh.base,requested) && equal(fresh.quote,other)) || (equal(fresh.quote,requested) && equal(fresh.base,other)))) throw new Error("Poolin markkinapari vaihtui");
  const pricing = poolPricing(fresh.protocol, accountBytes(p), base, quote);
  if (fresh.protocol === "PumpSwap") {
    if (globalConfig?.owner !== p.owner || feeConfig?.owner !== "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ") throw new Error("PumpSwap palkkiotilien omistaja ei täsmää");
    const global = accountBytes(globalConfig);
    if (global.length < 321 || !equal(global.subarray(0,8),[149,8,156,202,160,252,176,217])) throw new Error("PumpSwap global config virheellinen");
    pricing.feeBps = decodePumpFees(accountBytes(feeConfig));
  }
  return { status:"approve", protocol:fresh.protocol, slot:snapshot.context.slot, base, quote, ...pricing };
}

export function poolPricing(protocol, bytes, base, quote) {
  const v = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u64 = o => v.getBigUint64(o,true);
  const u128 = o => u64(o) + (u64(o+8)<<64n);
  const scale = 10 ** (base.decimals-quote.decimals);
  let a = BigInt(base.raw), b = BigInt(quote.raw), feeBps = null, ratio, mode = "reserves";
  if (protocol === "Raydium CPMM") {
    a -= u64(341)+u64(357)+u64(397); b -= u64(349)+u64(365)+u64(405);
  } else if (protocol === "Raydium AMM v4") {
    a -= u64(192); b -= u64(200); feeBps = Number(u64(176))*10000/Number(u64(184));
  } else if (protocol === "FluxBeam") {
    feeBps = 10000*(Number(u64(227))/Number(u64(235))+Number(u64(243))/Number(u64(251)));
  }
  if (a<=0n || b<=0n) throw new Error("Käytettävät reservit tyhjät");
  const sqrtOffset = {"Raydium CLMM":253,"Orca Whirlpool":65,"Meteora DAMM v2":456}[protocol];
  if (sqrtOffset !== undefined) { mode="sqrt_price"; ratio=(Number(u128(sqrtOffset))/2**64)**2*scale; }
  else if (protocol === "Meteora DLMM") { mode="active_bin"; ratio=(1+v.getUint16(80,true)/10000)**v.getInt32(76,true)*scale; }
  else { ratio=Number(b)/Number(a)*scale; }
  if (!Number.isFinite(ratio)||ratio<=0 || (feeBps!==null && (!Number.isFinite(feeBps)||feeBps<0||feeBps>=10000))) throw new Error("Virheellinen poolihinta tai palkkio");
  return { priceMode:mode, spotRatio:ratio, feeBps, effectiveBaseRaw:a.toString(), effectiveQuoteRaw:b.toString() };
}

export function decodePumpFees(raw) {
  if (raw.length < 69 || !equal(raw.subarray(0,8),[143,52,146,187,219,123,76,155])) throw new Error("PumpSwap fee config virheellinen");
  const view = new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const fees = offset => {
    if (offset+24>raw.length) throw new Error("Palkkiotaulukko katkennut");
    const rates=[0,8,16].map(i=>Number(view.getBigUint64(offset+i,true)));
    if (rates.some(n=>n>10000)) throw new Error("Palkkio virheellinen");
    return rates.reduce((a,b)=>a+b,0);
  };
  let cursor=65, max=fees(41);
  for(let group=0;group<2;group++){
    if(cursor+4>raw.length) throw new Error("Palkkiotasot puuttuvat");
    const count=view.getUint32(cursor,true);cursor+=4;
    if(count>128) throw new Error("Liikaa palkkiotasoja");
    for(let i=0;i<count;i++){max=Math.max(max,fees(cursor+16));cursor+=40;}
  }
  max=Math.max(max,fees(cursor));
  if(max>=10000) throw new Error("Palkkio kuluttaa koko kaupan");
  return max;
}
