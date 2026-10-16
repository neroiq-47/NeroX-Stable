import { createPublicClient, http, type PublicClient } from "viem";
import { CHAINS, CHAIN_KEYS, type ChainKey } from "./config";

export const publicClients = Object.fromEntries(
  CHAIN_KEYS.map((k) => [k, createPublicClient({ chain: CHAINS[k], transport: http(CHAINS[k].rpcUrls.default.http[0], { batch: true }) })]),
) as Record<ChainKey, PublicClient>;

/** Chain clock (the demo can fast-forward time), used to sign x402 validity windows. */
export async function chainNow(chainId: number) {
  const k = CHAIN_KEYS.find((c) => CHAINS[c].id === chainId) ?? "base";
  const b = await publicClients[k].getBlock();
  return Number(b.timestamp);
}
