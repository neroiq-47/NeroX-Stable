"use client";
import { createConfig, http } from "wagmi";
import { injected } from "@wagmi/core";
import { CHAINS } from "./config";
import { demoWallet } from "./demo-connector";

// Wallet UI: a NeroX-styled connect sheet over wagmi connectors. Production adds
// RainbowKit/WalletConnect for mobile wallets; the connector list is the only change.
export const wagmiConfig = createConfig({
  chains: [CHAINS.base, CHAINS.ethereum],
  connectors: [demoWallet(), injected({ shimDisconnect: true })],
  transports: {
    [CHAINS.base.id]: http(CHAINS.base.rpcUrls.default.http[0]),
    [CHAINS.ethereum.id]: http(CHAINS.ethereum.rpcUrls.default.http[0]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
