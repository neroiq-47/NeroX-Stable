// Keeper: processes the sNRX withdrawal queue when Morpho liquidity returns.
// (Auto-sweeps run from the facilitator right after each settlement.)
import { publicClients, chainKeys, addr, wallet, write } from "./chain.js";
import { abi } from "./config.js";

export function startKeeper() {
  const loop = async () => {
    for (const k of chainKeys) {
      try {
        const c = { address: addr(k, "sNRX"), abi: abi("SNRX") };
        const queued = await publicClients[k].readContract({ ...c, functionName: "queuedShares" });
        if (queued === 0n) continue;
        await write(wallet("keeper", k), k, { ...c, functionName: "processQueue", args: [10n] });
      } catch (e) {
        console.warn(`[keeper] ${k}:`, e.shortMessage ?? e.message);
      }
    }
    setTimeout(loop, 10_000);
  };
  loop();
  console.log("[keeper] watching sNRX withdrawal queues");
}
