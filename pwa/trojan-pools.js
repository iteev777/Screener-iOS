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
    if (decoded.protocol === "Pump.fun") return {status:"approve",protocol:decoded.protocol,reason:"PDA tarkistetaan syväanalyysissä"};
    if (decoded.protocol === "Moonit" || decoded.protocol === "Meteora DBC") {
      return { status: decoded.base && equal(decoded.base,base) ? "approve" : "reject", protocol:decoded.protocol, reason:"Mintin alustava tarkistus; konfiguraatio tarkistetaan seuraavaksi" };
    }
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
  if (decoded.status === "decoded" && decoded.protocol === "Pump.fun") return verifyPumpCurve(market,account,signal);
  if (decoded.status === "decoded" && ["Moonit","Meteora DBC"].includes(decoded.protocol)) return verifySpecialPool(market, account, decoded, signal);
  if (decoded.status !== "decoded" || !decoded.baseVault || !decoded.quoteVault || !decoded.base || !decoded.quote) return { status:"watch", reason:"Reservirakenne ei ole tuettu" };
  const keys = [decoded.baseVault, decoded.quoteVault, decoded.base, decoded.quote].map(encodeKey);
  const feeKeys = decoded.protocol === "PumpSwap" ? ["ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw","5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx"] : decoded.protocol === "Raydium CPMM" ? [encodeKey(accountBytes(account).slice(8,40))] : decoded.protocol === "Raydium CLMM" ? [encodeKey(accountBytes(account).slice(9,41))] : [];
  const range = concentratedRange(decoded.protocol,accountBytes(account));
  const arrayKeys = range ? await rangeAddresses(decoded.protocol,market.pool,account.owner,range) : [];
  const snapshot = await rpcCall("getMultipleAccounts", [[market.pool, ...keys, ...feeKeys, ...arrayKeys], options], signal);
  const [p, v1, v2, m1, m2, globalConfig, feeConfig] = snapshot?.value ?? [];
  if (p?.owner !== account.owner) throw new Error("Poolin omistaja vaihtui");
  const fresh = decodePool(p.owner, accountBytes(p));
  if (fresh.status !== "decoded" || !["baseVault","quoteVault","base","quote"].every(k => fresh[k] && equal(fresh[k], decoded[k]))) throw new Error("Poolin rakenne vaihtui");
  const base = decodeReserve(v1,m1,fresh.base), quote = decodeReserve(v2,m2,fresh.quote);
  if (!Number.isSafeInteger(snapshot.context?.slot) || snapshot.context.slot <= 0) throw new Error("RPC-slot puuttuu");
  const requested = publicKeyBytes(market.token), other = publicKeyBytes(market.quoteToken);
  if (!((equal(fresh.base,requested) && equal(fresh.quote,other)) || (equal(fresh.quote,requested) && equal(fresh.base,other)))) throw new Error("Poolin markkinapari vaihtui");
  const pricing = poolPricing(fresh.protocol, accountBytes(p), base, quote);
  if (fresh.protocol === "Orca Whirlpool") {
    const raw=accountBytes(p);
    pricing.feeBps=decodeConcentratedFee(fresh.protocol,raw);
  }
  if (fresh.protocol === "Raydium CLMM") {
    if(globalConfig?.owner!==p.owner||!equal(accountBytes(p).slice(9,41),accountBytes(account).slice(9,41)))throw new Error("CLMM config changed");
    const cfg=accountBytes(globalConfig);
    const disc=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("account:AmmConfig"))).slice(0,8);
    if(!equal(cfg.subarray(0,8),disc))throw new Error("CLMM config discriminator invalid");
    pricing.feeBps=decodeConcentratedFee(fresh.protocol,cfg);
  }
  if (fresh.protocol === "Raydium CPMM") {
    if (globalConfig?.owner !== p.owner || !equal(accountBytes(p).slice(8,40),accountBytes(account).slice(8,40))) throw new Error("CPMM konfiguraatio vaihtui");
    pricing.feeBps = await decodeCpmmFees(accountBytes(globalConfig));
  }
  if (fresh.protocol === "PumpSwap") {
    if (globalConfig?.owner !== p.owner || feeConfig?.owner !== "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ") throw new Error("PumpSwap palkkiotilien omistaja ei täsmää");
    const global = accountBytes(globalConfig);
    if (global.length < 321 || !equal(global.subarray(0,8),[149,8,156,202,160,252,176,217])) throw new Error("PumpSwap global config virheellinen");
    pricing.feeBps = decodePumpFees(accountBytes(feeConfig));
  }
  const currentRange=concentratedRange(fresh.protocol,accountBytes(p));
  const arrays=range ? await inspectArrays(fresh.protocol,market.pool,p.owner,currentRange,range,snapshot.value.slice(5+feeKeys.length),arrayKeys) : null;
  return { status:"approve", protocol:fresh.protocol, slot:snapshot.context.slot, base, quote, ...pricing, range:currentRange, arrays };
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

export async function decodeCpmmFees(raw) {
  const discriminator = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("account:AmmConfig"))).slice(0,8);
  if(raw.length<116 || !equal(raw.subarray(0,8),discriminator)) throw new Error("CPMM AmmConfig virheellinen");
  const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  const [trade,protocol,fund,creator]=[12,20,28,108].map(o=>v.getBigUint64(o,true));
  if(trade+creator>=1000000n || protocol+fund>1000000n) throw new Error("CPMM palkkiot virheelliset");
  return Number(trade+creator)/100;
}

export function curvePricing(protocol, bytes, decimals) {
  if (!Number.isInteger(decimals) || decimals<0 || decimals>255) throw new Error("Mintin desimaalit virheelliset");
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u=o=>v.getBigUint64(o,true);
  let priceSol, liquiditySol;
  if(protocol==="Pump.fun"){
    if(bytes.length<125 || bytes[48] || bytes[81] || bytes[82] || bytes[124]) throw new Error("Pump.fun käyrä ei ole tuettu");
    const virtualTokens=Number(u(8))/10**decimals, virtualQuote=Number(u(16))/1e9;
    if(virtualTokens<=0 || virtualQuote<=0) throw new Error("Tyhjä virtuaalinen reservi");
    priceSol=virtualQuote/virtualTokens;
    liquiditySol=Number(u(32))/1e9+Number(u(24))/10**decimals*priceSol;
  } else if(protocol==="Moonit"){
    if(bytes.length<82 || bytes[56]!==decimals || bytes[57]!==0 || bytes[58]!==1) throw new Error("Moonit käyrä ei ole tuettu");
    const total=u(8), remaining=u(16), initial=1073000000000000000n, sol=30000000000n;
    const virtual=initial-(total-remaining);
    if(remaining<=0n || total<=remaining || virtual<=0n) throw new Error("Moonit reservi virheellinen");
    const virtualSol=initial*sol/virtual;
    priceSol=(Number(virtualSol)/1e9)/(Number(virtual)/10**decimals);
    liquiditySol=Math.max(0,Number(virtualSol-sol))/1e9+Number(remaining)/10**decimals*priceSol;
  } else throw new Error("Tuntematon bonding curve");
  if(!Number.isFinite(priceSol)||priceSol<=0||!Number.isFinite(liquiditySol)||liquiditySol<=0) throw new Error("Käyrän hinta tai likviditeetti virheellinen");
  return {priceSol,liquiditySol,priceMode:"bonding_curve"};
}

async function verifySpecialPool(market, account, decoded, signal) {
  const options={commitment:"confirmed",encoding:"base64"};
  const token=publicKeyBytes(market.token);
  if(!equal(decoded.base,token)) throw new Error("Käyrän mintti ei täsmää");
  const isDbc=decoded.protocol==="Meteora DBC";
  const configKey=isDbc?encodeKey(accountBytes(account).slice(72,104)):null;
  const keys=isDbc?[market.pool,market.token,configKey,market.quoteToken]:[market.pool,market.token];
  const result=await rpcCall("getMultipleAccounts",[keys,options],signal);
  const [p,m,config,q]=result?.value??[];
  if(!Number.isSafeInteger(result?.context?.slot)||result.context.slot<=0||p?.owner!==account.owner||!tokenPrograms.has(m?.owner)) throw new Error("Käyrän RPC-tilannekuva virheellinen");
  const bytes=accountBytes(p), mint=accountBytes(m), fresh=decodePool(p.owner,bytes);
  if(fresh.status!=="decoded"||!equal(fresh.base,token)||mint.length<82||mint[45]!==1) throw new Error("Käyrän tila muuttui");
  if(!isDbc){
    if(market.quoteToken!=="So11111111111111111111111111111111111111112") throw new Error("Moonit vastavaluutta virheellinen");
    return {status:"approve",protocol:fresh.protocol,slot:result.context.slot,...curvePricing(fresh.protocol,bytes,mint[44])};
  }
  const cfg=accountBytes(config), qm=accountBytes(q);
  if(config.owner!==p.owner||!equal(bytes.slice(72,104),publicKeyBytes(configKey))||cfg.length<40||!equal(cfg.subarray(0,8),[26,108,14,123,116,230,129,43])||!equal(cfg.slice(8,40),publicKeyBytes(market.quoteToken))||!tokenPrograms.has(q.owner)||qm.length<82||qm[45]!==1) throw new Error("DBC konfiguraatio virheellinen");
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const sqrt=v.getBigUint64(280,true)+(v.getBigUint64(288,true)<<64n);
  const spotRatio=(Number(sqrt)/2**64)**2*10**(mint[44]-qm[44]);
  const baseAmount=Number(v.getBigUint64(232,true))/10**mint[44],quoteAmount=Number(v.getBigUint64(240,true))/10**qm[44];
  if(!Number.isFinite(spotRatio)||spotRatio<=0||baseAmount<=0||quoteAmount<=0) throw new Error("DBC reservit virheelliset");
  return {status:"approve",protocol:fresh.protocol,slot:result.context.slot,priceMode:"dbc_curve",spotRatio,baseAmount,quoteAmount};
}

const fieldP=(1n<<255n)-19n;
const mod=x=>((x%fieldP)+fieldP)%fieldP;
function powMod(x,n){let r=1n;for(x=mod(x);n;n>>=1n,x=mod(x*x))if(n&1n)r=mod(r*x);return r;}
function onCurve(bytes){
  let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)+BigInt(i===31?bytes[i]&127:bytes[i]);
  if(y>=fieldP)return false;
  const yy=mod(y*y),d=mod(-121665n*powMod(121666n,fieldP-2n)),den=mod(d*yy+1n);
  if(!den)return false;
  const x2=mod((yy-1n)*powMod(den,fieldP-2n));
  return x2===0n ? !(bytes[31]&128) : powMod(x2,(fieldP-1n)/2n)===1n;
}
export async function pumpCurveAddress(mint,program){
  const seed=new TextEncoder().encode("bonding-curve"),suffix=new TextEncoder().encode("ProgramDerivedAddress");
  const data=new Uint8Array(seed.length+32+1+32+suffix.length);
  data.set(seed);data.set(publicKeyBytes(mint),seed.length);data.set(publicKeyBytes(program),seed.length+33);data.set(suffix,seed.length+65);
  for(let bump=255;bump>=0;bump--){data[seed.length+32]=bump;const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",data));if(!onCurve(hash))return encodeKey(hash);}
  throw new Error("Pump.fun PDA puuttuu");
}
async function verifyPumpCurve(market,account,signal){
  const sol="So11111111111111111111111111111111111111112";
  if(market.quoteToken!==sol||await pumpCurveAddress(market.token,account.owner)!==market.pool)throw new Error("Pump.fun PDA tai vastavaluutta ei täsmää");
  const result=await rpcCall("getMultipleAccounts",[[market.pool,market.token],{commitment:"confirmed",encoding:"base64"}],signal);
  const [p,m]=result?.value??[];
  if(p?.owner!==account.owner||!tokenPrograms.has(m?.owner)||!Number.isSafeInteger(result?.context?.slot)||result.context.slot<=0)throw new Error("Pump.fun snapshot virheellinen");
  const bytes=accountBytes(p),mint=accountBytes(m),fresh=decodePool(p.owner,bytes);
  if(fresh.status!=="decoded"||mint.length<82||mint[45]!==1||!equal(fresh.quote,publicKeyBytes(sol)))throw new Error("Pump.fun käyrä tai mintti virheellinen");
  return {status:"approve",protocol:fresh.protocol,slot:result.context.slot,...curvePricing(fresh.protocol,bytes,mint[44])};
}

/* Active price range metadata; not a multi-tick executable quote. */
export function concentratedRange(protocol, bytes) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(protocol==="Meteora DLMM"){
    if(bytes.length<216)throw new Error("DLMM layout truncated");
    const active=v.getInt32(76,true),step=v.getUint16(80,true);
    if(!step)throw new Error("Invalid bin step");
    const arrayIndex=Math.floor(active/70);
    return {activeBin:active,binStep:step,arrayIndex,firstBin:arrayIndex*70,lastBin:arrayIndex*70+69};
  }
  if(protocol==="Orca Whirlpool"){
    if(bytes.length<245)throw new Error("Whirlpool layout truncated");
    const spacing=v.getUint16(41,true),tick=v.getInt32(81,true);
    if(!spacing)throw new Error("Invalid tick spacing");
    const width=88*spacing,start=Math.floor(tick/width)*width;
    return {activeTick:tick,tickSpacing:spacing,arrayStart:start,arrayEnd:start+87*spacing,liquidityRaw:readU128(v,49).toString(),sqrtPriceX64:readU128(v,65).toString()};
  }
  if(protocol==="Raydium CLMM"){
    if(bytes.length<273)throw new Error("CLMM layout truncated");
    const spacing=v.getUint16(235,true),tick=v.getInt32(269,true);
    if(!spacing)throw new Error("Invalid tick spacing");
    const width=60*spacing,start=Math.floor(tick/width)*width;
    return {activeTick:tick,tickSpacing:spacing,arrayStart:start,arrayEnd:start+59*spacing,liquidityRaw:readU128(v,237).toString(),sqrtPriceX64:readU128(v,253).toString()};
  }
  return null;
}

async function deriveAddress(seeds,program){
  const suffix=new TextEncoder().encode("ProgramDerivedAddress");
  const size=seeds.reduce((n,s)=>n+s.length,0);
  const data=new Uint8Array(size+1+32+suffix.length);
  let at=0;for(const seed of seeds){data.set(seed,at);at+=seed.length;}
  data.set(publicKeyBytes(program),size+1);data.set(suffix,size+33);
  for(let bump=255;bump>=0;bump--){data[size]=bump;const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",data));if(!onCurve(hash))return encodeKey(hash);}
  throw new Error("Array PDA puuttuu");
}
async function rangeAddresses(protocol,pool,program,range){
  const encoder=new TextEncoder(),key=publicKeyBytes(pool);
  const indices=protocol==="Meteora DLMM"?[-1,0,1].map(n=>range.arrayIndex+n):[-1,0,1].map(n=>range.arrayStart+n*(protocol==="Orca Whirlpool"?88:60)*range.tickSpacing);
  return Promise.all(indices.map(i=>{
    let index;
    if(protocol==="Orca Whirlpool")index=encoder.encode(String(i));
    else if(protocol==="Meteora DLMM"){index=new Uint8Array(8);new DataView(index.buffer).setBigInt64(0,BigInt(i),true);}
    else {index=new Uint8Array(4);new DataView(index.buffer).setInt32(0,i,false);}
    return deriveAddress([encoder.encode(protocol==="Meteora DLMM"?"bin_array":"tick_array"),key,index],program);
  }));
}
async function inspectArrays(protocol,pool,program,current,previous,accounts,addresses){
  if(current.arrayStart!==previous.arrayStart||current.arrayIndex!==previous.arrayIndex)throw new Error("Aktiivinen array vaihtui");
  const name=protocol==="Meteora DLMM"?"BinArray":protocol==="Orca Whirlpool"?"TickArray":"TickArrayState";
  const discriminator=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("account:"+name))).slice(0,8);
  const key=publicKeyBytes(pool);
  return accounts.map((a,i)=>{
    if(!a)return {address:addresses[i],status:"missing"};
    if(a.owner!==program)throw new Error("Array omistaja virheellinen");
    const b=accountBytes(a);
    if(!equal(b.subarray(0,8),discriminator))return {address:addresses[i],status:"unsupported_layout"};
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    const expected=protocol==="Meteora DLMM"?current.arrayIndex+i-1:current.arrayStart+(i-1)*(protocol==="Orca Whirlpool"?88:60)*current.tickSpacing;
    const poolOffset=protocol==="Meteora DLMM"?24:protocol==="Orca Whirlpool"?9956:8;
    const index=protocol==="Meteora DLMM"?Number(v.getBigInt64(8,true)):v.getInt32(protocol==="Orca Whirlpool"?8:40,true);
    if(index!==expected||!equal(b.slice(poolOffset,poolOffset+32),key))throw new Error("Array pooli tai indeksi virheellinen");
    return {address:addresses[i],status:"verified",index,byteLength:b.length,levels:decodeArrayLevels(protocol,b,index,current.tickSpacing)};
  });
}

export function decodeArrayLevels(protocol,b,index,spacing){
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const u128=o=>v.getBigUint64(o,true)+(v.getBigUint64(o+8,true)<<64n);
  const i128=o=>BigInt.asIntN(128,u128(o));
  const levels=[];
  if(protocol==="Orca Whirlpool"){
    if(b.length!==9988)throw new Error("Whirlpool fixed array layout unsupported");
    for(let i=0;i<88;i++){
      const o=12+i*113;
      if(b[o]>1)throw new Error("Invalid initialized flag");
      if(b[o])levels.push({tick:index+i*spacing,liquidityNet:i128(o+1).toString(),liquidityGross:u128(o+17).toString()});
    }
  }else if(protocol==="Raydium CLMM"){
    if(b.length!==10240)throw new Error("CLMM array layout unsupported");
    for(let i=0;i<60;i++){
      const o=44+i*168,gross=u128(o+20);
      if(gross){
        const tick=v.getInt32(o,true);
        if(tick!==index+i*spacing)throw new Error("Tick index mismatch");
        levels.push({tick,liquidityNet:i128(o+4).toString(),liquidityGross:gross.toString()});
      }
    }
  }else if(protocol==="Meteora DLMM"){
    if(b.length!==10136)throw new Error("DLMM array layout unsupported");
    for(let i=0;i<70;i++){
      const o=56+i*144,x=v.getBigUint64(o,true),y=v.getBigUint64(o+8,true);
      if(x||y)levels.push({bin:index*70+i,amountX:x.toString(),amountY:y.toString(),priceX64:u128(o+16).toString()});
    }
  }
  return levels;
}

/* Indicative exact-input bin traversal. Caller supplies a verified fee bound.
   Never use an incomplete traversal as an executable quote. */
export function estimateBinSwap(snapshot,inputRaw,swapXForY,feeBps){
  if(snapshot.protocol!=="Meteora DLMM"||!snapshot.range||!Array.isArray(snapshot.arrays))throw new Error("DLMM snapshot required");
  if(!Number.isInteger(feeBps)||feeBps<0||feeBps>=10000)throw new Error("Verified fee bound required");
  const Q=1n<<64n,den=10000n,rate=den-BigInt(feeBps),ceil=(a,b)=>(a+b-1n)/b;
  const input=BigInt(inputRaw);
  if(input<=0n)throw new Error("Positive input required");
  let remaining=input,out=0n,fees=0n,bins=0;
  const active=snapshot.range.activeBin,idx=snapshot.range.arrayIndex;
  const arrays=new Map(snapshot.arrays.filter(a=>a.status==="verified").map(a=>[a.index,a]));
  for(let j=0;j<3&&remaining>0n;j++){
    const array=arrays.get(idx+(swapXForY?-j:j));
    if(!array)break;
    const levels=array.levels.filter(l=>swapXForY?l.bin<=active:l.bin>=active).sort((a,b)=>swapXForY?b.bin-a.bin:a.bin-b.bin);
    for(const l of levels){
      const p=BigInt(l.priceX64),capacity=BigInt(swapXForY?l.amountY:l.amountX);
      if(p<=0n||capacity<=0n)continue;
      const netCapacity=swapXForY?ceil(capacity*Q,p):ceil(capacity*p,Q);
      const grossCapacity=ceil(netCapacity*den,rate);
      const gross=remaining<grossCapacity?remaining:grossCapacity;
      const net=gross*rate/den;
      const calculated=swapXForY?net*p/Q:net*Q/p;
      const received=calculated<capacity?calculated:capacity;
      if(received<=0n)continue;
      out+=received;remaining-=gross;fees+=gross-net;bins++;
      if(!remaining)break;
    }
  }
  const spent=input-remaining;
  return {complete:remaining===0n&&out>0n,inputRaw:input.toString(),spentRaw:spent.toString(),outputRaw:out.toString(),unfilledRaw:remaining.toString(),feeRaw:fees.toString(),binsCrossed:bins,indicative:true};
}

function readU128(v,o){return v.getBigUint64(o,true)+(v.getBigUint64(o+8,true)<<64n);}
export function estimateTickSwap(snapshot,inputRaw,swapXForY,feeBps){
  if(!["Raydium CLMM","Orca Whirlpool"].includes(snapshot.protocol)||!snapshot.range||!Array.isArray(snapshot.arrays))throw new Error("CLMM snapshot required");
  if(!Number.isInteger(feeBps)||feeBps<0||feeBps>=10000)throw new Error("Verified fee bound required");
  const Q=1n<<64n,den=10000n,rate=den-BigInt(feeBps),ceil=(a,b)=>(a+b-1n)/b;
  const input=BigInt(inputRaw),r=snapshot.range;
  let remaining=input,out=0n,fees=0n,L=BigInt(r.liquidityRaw),s=BigInt(r.sqrtPriceX64),crossed=0;
  if(input<=0n||L<=0n||s<=0n)throw new Error("Invalid swap state");
  const width=(snapshot.protocol==="Orca Whirlpool"?88:60)*r.tickSpacing;
  const arrays=new Map(snapshot.arrays.filter(a=>a.status==="verified").map(a=>[a.index,a]));
  const levels=[];
  let boundary=r.arrayStart;
  for(let j=0;j<3;j++){
    const start=r.arrayStart+(swapXForY?-j:j)*width,a=arrays.get(start);
    if(!a)break;
    levels.push(...a.levels.filter(l=>swapXForY?l.tick<=r.activeTick:l.tick>r.activeTick));
    boundary=swapXForY?start:start+width;
  }
  if(!arrays.has(r.arrayStart))return {complete:false,outputRaw:"0",unfilledRaw:input.toString(),indicative:true};
  levels.sort((a,b)=>swapXForY?b.tick-a.tick:a.tick-b.tick);
  levels.push({tick:boundary,liquidityNet:"0"});
  for(const level of levels){
    if(!remaining||L<=0n)break;
    if(Math.abs(level.tick)>443636)break;
    const t=BigInt(Math.floor(Math.pow(1.0001,level.tick/2)*Number(Q)));
    if(t<=0n||(swapXForY?t>s:t<s))continue;
    const delta=swapXForY?s-t:t-s;
    const need=swapXForY?ceil(L*Q*delta,s*t):ceil(L*delta,Q);
    const grossNeed=ceil(need*den,rate);
    const gross=remaining<grossNeed?remaining:grossNeed,net=gross*rate/den;
    const reached=gross>=grossNeed;
    const next=reached?t:swapXForY?ceil(L*Q*s,L*Q+net*s):s+net*Q/L;
    const received=swapXForY?L*(s-next)/Q:L*Q*(next-s)/(next*s);
    out+=received;remaining-=gross;fees+=gross-net;s=next;
    if(!reached)break;
    L+=BigInt(level.liquidityNet)*(swapXForY?-1n:1n);crossed++;
  }
  return {complete:remaining===0n&&out>0n,inputRaw:input.toString(),outputRaw:out.toString(),unfilledRaw:remaining.toString(),feeRaw:fees.toString(),ticksCrossed:crossed,indicative:true};
}

export function decodeConcentratedFee(protocol,raw){
  const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
  let rate;
  if(protocol==="Orca Whirlpool"){
    if(raw.length<245)throw new Error("Whirlpool fee layout truncated");
    rate=v.getUint16(45,true);
  }else if(protocol==="Raydium CLMM"){
    if(raw.length<47)throw new Error("CLMM fee layout truncated");
    rate=v.getUint32(43,true);
  }else throw new Error("Unsupported fee layout");
  if(rate>=1000000)throw new Error("Invalid trade fee");
  return Math.ceil(rate/100);
}
