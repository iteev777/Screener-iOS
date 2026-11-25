import assert from "node:assert/strict";
import test from "node:test";
import { marketNumber, normalizePair, orientPair, pairState } from "./markets.js";
import { curveMarket, pumpProgram, pumpTrades, tokenProgram2022 } from "./market-resolver.js";
import { mintEligible } from "./scanner.js";
import { mint as wsol } from "./network.js";
import { publicKeyBytes } from "./wallet-standard.js";

const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const token = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const pool = "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";
const now = 1800000000000;
const asAccount = (owner,data) => ({owner,executable:false,data:[data.toString("base64"),"base64"]});

test("classifies missing, zero and empty-liquidity observations separately",()=>{
  const pair={chainId:"solana",baseToken:{address:token},quoteToken:{address:wsol},pairAddress:pool};
  assert.equal(pairState({...pair,priceUsd:"0",liquidity:{usd:100}}),"zero-price");
  assert.equal(pairState({...pair,priceUsd:"4",liquidity:{usd:"0"}}),"empty-liquidity");
  assert.equal(pairState({...pair,priceUsd:"4"}),"missing-liquidity");
  assert.equal(pairState({...pair,liquidity:{usd:"10000"}}),"missing-price");
  assert.equal(pairState({...pair,priceUsd:"4",liquidity:{usd:"10000"}}),"priced");
  assert.equal(marketNumber(null),undefined);
});

test("quote-oriented pools use native units and market activity cannot impersonate USD price bars",()=>{
  const raw={chainId:"solana",baseToken:{address:wsol},quoteToken:{address:token},pairAddress:pool,
    priceUsd:"50",priceNative:"250",liquidity:{usd:20000},priceChange:{m5:4},txns:{m5:{buys:1,sells:9}}};
  const reversed=normalizePair(orientPair(raw,token));
  assert.equal(reversed.price,.2);
  assert.equal(reversed.quoteToken,wsol);
  assert.deepEqual(reversed.transactions.m5,{buys:9,sells:1});
  assert.equal(reversed.change5,undefined);
  assert.equal(normalizePair(orientPair({...raw,priceNative:undefined},token)),undefined);
});

test("bonding curve uses both on-chain mint decimals and real quote liquidity",()=>{
  const curve=Buffer.alloc(166);
  curve.set([23,183,248,55,96,216,172,96]);
  curve.writeBigUInt64LE(1_000_000n,8);
  curve.writeBigUInt64LE(500_000_000n,16);
  curve.writeBigUInt64LE(40_000_000n,24);
  curve.writeBigUInt64LE(100_000_000n,32);
  const mint=Buffer.alloc(82); mint[44]=6; mint[45]=1;
  const oracle=new Map([[wsol,{price:70,at:now}],[usdc,{price:.999,at:now}]]);
  const account=asAccount(tokenProgram2022,mint);
  const read=()=>curveMarket(asAccount(pumpProgram,curve),account,oracle);
  assert.equal(read().price,35);
  assert.equal(read().liquidity,14);
  assert.equal(read().quoteToken,wsol);
  curve.set(publicKeyBytes(usdc),83);
  assert.equal(read().price,500*.999);
  assert.equal(read().quoteToken,usdc);
  curve.writeBigUInt64LE(0n,32);
  assert.equal(read().state,"empty-liquidity");
  curve[48]=1;
  assert.equal(read().state,"curve-complete");
  assert.equal(curveMarket(asAccount(tokenProgram2022,curve),account,oracle).state,"invalid-pair");
});

test("confirmed Pump tape requires the correct program invocation, mint and event timestamp",()=>{
  const raw=Buffer.alloc(97);
  raw.set([189,219,127,211,78,230,97,238]);
  raw.set(publicKeyBytes(token),8);
  raw.writeBigUInt64LE(1_000_000_000n,40);
  raw.writeBigUInt64LE(2_000_000n,48);
  raw[56]=1;
  raw.writeBigInt64LE(BigInt(now/1000-1),89);
  const payload=`Program data: ${raw.toString("base64")}`;
  const notification={value:{err:null,signature:"sig",logs:[payload,`Program ${pumpProgram} invoke [1]`,
    payload,`Program ${pumpProgram} success`,payload]}};
  const market={token,decimals:6,quoteToken:wsol,quoteDecimals:9,quoteAt:now,quoteUsd:70};
  const rows=pumpTrades(notification,market,now);
  assert.equal(rows.length,1);
  assert.equal(rows[0].price,35);
  assert.equal(rows[0].usd,70);
  assert.equal(rows[0].side,"buy");
  assert.deepEqual(pumpTrades(notification,{...market,token:usdc},now),[]);
});

test("Token-2022 mint checks admit metadata extensions and reject transfer or freezing controls",()=>{
  const account=(extensions,mintAuthority=null)=>({owner:tokenProgram2022,data:{parsed:{type:"mint",
    info:{extensions:extensions.map(extension=>({extension})),mintAuthority,freezeAuthority:null,isInitialized:true}}}});
  assert.ok(mintEligible(account(["metadataPointer","tokenMetadata"])));
  assert.equal(mintEligible(account(["metadataPointer","transferFeeConfig"])),false);
  assert.equal(mintEligible(account(["permanentDelegate"])),false);
  assert.equal(mintEligible(account(["metadataPointer"],"admin")),false);
});
