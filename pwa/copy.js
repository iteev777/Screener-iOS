// SPDX-License-Identifier: BUSL-1.1
import { rpcCall } from "./network.js";

export const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const jupiter = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const options = { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 };

function tokenDelta(meta, owner, mint) {
  let delta = 0n;
  let decimals;
  const sides = [[meta.preTokenBalances, -1n], [meta.postTokenBalances, 1n]];
  if (sides.some(([balances]) => !Array.isArray(balances))) return;
  for (const [balances, side] of sides) {
    for (const balance of balances) {
      if (balance.owner !== owner || balance.mint !== mint) continue;
      const amount = balance.uiTokenAmount;
      if (!/^\d{1,20}$/.test(amount?.amount ?? "") || !Number.isInteger(amount.decimals) ||
          amount.decimals < 0 || amount.decimals > 18 ||
          (decimals !== undefined && decimals !== amount.decimals)) return;
      decimals = amount.decimals;
      delta += side * BigInt(amount.amount);
    }
  }
  if (decimals !== undefined) return { delta, decimals };
}

export function classifySwap(tx, owner, token) {
  if (!tx?.meta || tx.meta.err !== null || token === usdc ||
      !Number.isSafeInteger(tx.blockTime) || tx.blockTime <= 0) return;
  const message = tx.transaction?.message;
  if (!message?.accountKeys?.some(key => key.pubkey === owner && key.signer === true) ||
      !message.instructions?.some(instruction => instruction.programId === jupiter)) return;
  const coin = tokenDelta(tx.meta, owner, token);
  const cash = tokenDelta(tx.meta, owner, usdc);
  if (!coin || !cash || cash.decimals !== 6 || coin.delta === 0n || cash.delta === 0n ||
      (coin.delta > 0n) === (cash.delta > 0n)) return;
  return { direction: coin.delta > 0n ? 1 : -1,
    quantity: Math.abs(Number(coin.delta)) / 10 ** coin.decimals,
    usd: Math.abs(Number(cash.delta)) / 1e6, at: tx.blockTime * 1000 };
}

export async function accountSignatures(owner, limit, signal, until) {
  const result = await rpcCall("getSignaturesForAddress", [owner, {
    commitment: "confirmed", limit, ...(until ? { until } : {})
  }], signal);
  if (!Array.isArray(result) || result.some(item => typeof item?.signature !== "string")) {
    throw new Error("Virheellinen Solana-tapahtumalista.");
  }
  return result;
}

async function readSwap(signature, owner, token, signal) {
  const transaction = await rpcCall("getTransaction", [signature, options], signal);
  if (transaction?.transaction?.signatures?.[0] !== signature) {
    throw new Error("Vahvistettua Solana-tapahtumaa ei voitu täsmäyttää.");
  }
  const swap = classifySwap(transaction, owner, token);
  if (swap) return { ...swap, signature };
}

export async function recentSwaps(owner, token, signal) {
  const signatures = await accountSignatures(owner, 8, signal);
  const swaps = [];
  for (const item of signatures) {
    if (item.err) continue;
    const swap = await readSwap(item.signature, owner, token, signal);
    if (swap) swaps.push(swap);
  }
  return swaps;
}

export async function copySignal(owner, token, cursor, now, signal) {
  const signatures = await accountSignatures(owner, 21, signal);
  if (cursor === undefined) return { cursor: signatures[0]?.signature ?? null, signal: 0 };
  const previous = cursor === null ? signatures.length : signatures.findIndex(item => item.signature === cursor);
  if (previous < 0 || previous >= 21) throw new Error("Copy Trading keskeytyi: lompakon tapahtumaväli kasvoi liian suureksi.");
  for (const item of signatures.slice(0, previous)) {
    if (item.err || !Number.isSafeInteger(item.blockTime) ||
        item.blockTime * 1000 < now - 120000) continue;
    const swap = await readSwap(item.signature, owner, token, signal);
    if (swap && swap.at <= now && now - swap.at <= 120000) {
      return { cursor: signatures[0].signature, signal: swap.direction };
    }
  }
  return { cursor: signatures[0]?.signature ?? cursor, signal: 0 };
}

export async function copyBatch(owner, tokens, cursor, now, signal) {
  const signatures = await accountSignatures(owner, 21, signal);
  const latest = signatures[0]?.signature ?? cursor ?? null;
  const directions = new Map();
  if (cursor === undefined) return { cursor: latest, directions };
  const preceding = cursor === null ? signatures.length : signatures.findIndex(row => row.signature === cursor);
  if (preceding < 0 || preceding >= 21) throw new Error("Copy Trading: tapahtumaväli kasvoi liian suureksi.");
  for (const item of signatures.slice(0, preceding)) {
    const age = now - item.blockTime * 1000;
    if (item.err || !Number.isSafeInteger(item.blockTime) || age < 0 || age > 120000) continue;
    const tx = await rpcCall("getTransaction", [item.signature, options], signal);
    if (tx?.transaction?.signatures?.[0] !== item.signature) {
      throw new Error("Copy-tapahtumaa ei voitu täsmäyttää.");
    }
    for (const token of tokens) {
      if (directions.has(token)) continue;
      const swap = classifySwap(tx, owner, token);
      if (swap && swap.at <= now && now - swap.at <= 120000) directions.set(token, swap.direction);
    }
    if (directions.size === tokens.size) break;
  }
  return { cursor: latest, directions };
}

export async function copyGroup(wallets, tokens, cursors, now, signal) {
  const next = new Map(cursors);
  const votes = new Map();
  const failures = [];
  // Two wallets at a time. Each wallet reads its own transactions sequentially.
  for (let offset = 0; offset < wallets.length; offset += 2) {
    const cohort = wallets.slice(offset, offset + 2);
    const results = await Promise.allSettled(cohort.map(wallet =>
      copyBatch(wallet, tokens, cursors.get(wallet), now, signal)));
    if (signal?.aborted) return { cursors, directions: new Map(), failures };
    for (const [i, result] of results.entries()) {
      const wallet = cohort[i];
      if (result.status === "rejected") {
        failures.push(result.reason);
        continue;
      }
      next.set(wallet, result.value.cursor);
      for (const [token, direction] of result.value.directions) {
        const previous = votes.get(token);
        votes.set(token, previous === undefined || previous === direction ? direction : 0);
      }
    }
  }
  return { cursors: next, directions: failures.length ? new Map() : votes, failures };
}
