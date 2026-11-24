import { rpcCall } from "./network.js";
import { discoverWallets, publicKeyBytes, signDevnetProbe } from "./wallet-standard.js";

export function createLiveAdapter(execution) {
  const provider = globalThis.phantom?.solana;
  const wallets = discoverWallets();
  let standard;
  let walletChange;
  let unsubscribe;
  const signingWallets = () => wallets().filter(wallet =>
    wallet.features["standard:connect"] && wallet.features["solana:signTransaction"]
  );
  return {
    ready: typeof execution?.execute === "function" &&
      typeof execution?.readBook === "function",
    execute: execution?.execute,
    async connect() {
      unsubscribe?.();
      unsubscribe = undefined;
      standard = undefined;
      const candidates = signingWallets();
      if (candidates.length === 1) {
        const selected = candidates[0];
        const { accounts } = await selected.features["standard:connect"].connect();
        const address = accounts.find(account => account.chains.includes("solana:mainnet"))?.address;
        publicKeyBytes(address);
        standard = selected;
        unsubscribe = selected.features["standard:events"]?.on("change", event => {
          if (event.accounts) walletChange?.();
        });
        return address;
      }
      if (candidates.length > 1 && !provider?.isPhantom) {
        throw new Error("Käytä selaimessa yhtä Solana-lompakkoa kerrallaan.");
      }
      if (!provider?.isPhantom) {
        throw new Error("Phantom-lompakkoa ei löytynyt tästä selaimesta.");
      }
      const result = await provider.connect();
      const address = result.publicKey.toString();
      publicKeyBytes(address);
      return address;
    },
    onWalletChange(callback) {
      walletChange = callback;
      provider?.on("accountChanged", callback);
      provider?.on("disconnect", callback);
    },
    canSign() { return Boolean(standard); },
    signProbe(address, signal) { return signDevnetProbe(standard, address, signal); },
    async snapshot(address, signal) {
      const result = await rpcCall("getBalance", [address, { commitment: "confirmed" }], signal);
      if (!Number.isSafeInteger(result?.value) || result.value < 0) {
        throw new Error("Lompakon saldon haku epäonnistui.");
      }
      const book = execution ? await execution.readBook(address, signal) : {};
      return { ...book, walletSol: result.value / 1e9 };
    }
  };
}
