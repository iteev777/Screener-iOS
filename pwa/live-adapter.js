import { rpcCall } from "./network.js";
import { discoverWallets, publicKeyBytes, signDevnetProbe } from "./wallet-standard.js";

export function createLiveAdapter(execution) {
  const getProvider = () => globalThis.phantom?.solana;
  const wallets = discoverWallets();
  let standard;
  let walletChange;
  let unsubscribe;
  let connectedAddress;
  let generation=0;
  let boundProvider;
  const invalidate=()=>{generation++;connectedAddress=undefined;walletChange?.();};
  function bindProvider(provider){if(!provider||boundProvider===provider)return;boundProvider?.removeListener?.("accountChanged",invalidate);boundProvider?.removeListener?.("disconnect",invalidate);boundProvider=provider;provider.on?.("accountChanged",invalidate);provider.on?.("disconnect",invalidate);}
  const signingWallets = () => wallets().filter(wallet =>
    wallet.features["standard:connect"] && wallet.features["solana:signTransaction"]
  );
  return {
    ready: typeof execution?.execute === "function" &&
      typeof execution?.readBook === "function",
    execute: execution?.execute,
    async connect() {
      const attempt=++generation;
      connectedAddress=undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      standard = undefined;
      const provider=getProvider();
      const candidates = signingWallets();
      if (candidates.length === 1) {
        const selected = candidates[0];
        const { accounts } = await selected.features["standard:connect"].connect();
        const address = accounts.find(account => account.chains.includes("solana:mainnet"))?.address;
        publicKeyBytes(address);
        standard = selected;
        unsubscribe = selected.features["standard:events"]?.on("change", event => {
          if (event.accounts) invalidate();
        });
        if(attempt!==generation)throw new Error("Lompakkoyhteys muuttui");
        connectedAddress=address;
        return address;
      }
      if (candidates.length > 1 && !provider?.isPhantom) {
        throw new Error("Käytä selaimessa yhtä Solana-lompakkoa kerrallaan.");
      }
      if (!provider?.isPhantom) {
        throw new Error("Phantom-lompakkoa ei löytynyt. Avaa sovellus Phantom-lompakon omassa selaimessa.");
      }
      bindProvider(provider);
      const result = await provider.connect();
      const address = result.publicKey.toString();
      publicKeyBytes(address);
      if(attempt!==generation)throw new Error("Lompakkoyhteys muuttui");
      connectedAddress=address;
      return address;
    },
    onWalletChange(callback) {
      walletChange = callback;
      bindProvider(getProvider());
    },
    canSign() { return Boolean(standard && connectedAddress); },
    assertConnected(address){if(!connectedAddress||address!==connectedAddress)throw new Error("Lompakkoyhteys ei ole enää voimassa");return generation;},
    phantomLink(url=globalThis.location?.href) {
      const target=new URL(url);if(target.protocol!=="https:")throw new Error("HTTPS required");
      return "https://phantom.app/ul/browse/"+encodeURIComponent(target.href)+"?ref="+encodeURIComponent(target.origin);
    },
    async signProbe(address, signal) {
      if(!standard||address!==connectedAddress)throw new Error("Lompakkoyhteys ei ole voimassa");
      const before=generation;
      await signDevnetProbe(standard,address,signal);
      if(before!==generation||address!==connectedAddress)throw new Error("Lompakko vaihtui allekirjoituksen aikana");
    },
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

/* Read-only reconciliation: an unknown signature is not a failed trade. */
export async function reconcileLiveSignature(signature,signal){
  if(typeof signature!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))throw new Error("Virheellinen transaktiotunniste");
  const result=await rpcCall("getSignatureStatuses",[[signature],{searchTransactionHistory:true}],signal);
  if(!Array.isArray(result?.value)||result.value.length!==1)throw new Error("Virheellinen vahvistusvastaus");
  const status=result.value[0];
  if(!status)return {signature,state:"unknown"};
  if(status.err!=null)return {signature,state:"failed",error:status.err};
  if(["confirmed","finalized"].includes(status.confirmationStatus))return {signature,state:"confirmed",slot:status.slot};
  return {signature,state:"pending",slot:status.slot};
}
