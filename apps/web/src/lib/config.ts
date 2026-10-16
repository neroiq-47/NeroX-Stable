import deployment from "@nerox/contracts/deployments/local.json";
import { defineChain, getAddress, type Address } from "viem";

export type ChainKey = "base" | "ethereum";
export const CHAIN_KEYS: ChainKey[] = ["base", "ethereum"];

type Deployed = (typeof deployment)["chains"]["base"];
export const DEPLOYMENT = deployment;

export const SERVICES = {
  facilitator: process.env.NEXT_PUBLIC_FACILITATOR_URL || "http://localhost:4020",
  agents: process.env.NEXT_PUBLIC_AGENTS_URL || "http://localhost:4021",
  market: process.env.NEXT_PUBLIC_MARKET_URL || "http://localhost:4022",
  relayer: process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:4023",
};

const rpcOverride: Record<ChainKey, string | undefined> = {
  base: process.env.NEXT_PUBLIC_BASE_RPC,
  ethereum: process.env.NEXT_PUBLIC_ETH_RPC,
};

export const CHAINS = Object.fromEntries(
  CHAIN_KEYS.map((k) => {
    const c = deployment.chains[k] as Deployed;
    return [
      k,
      defineChain({
        id: c.chainId,
        name: c.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcOverride[k] || c.rpc] } },
        testnet: true,
      }),
    ];
  }),
) as Record<ChainKey, ReturnType<typeof defineChain>>;

export function chainKeyOf(chainId?: number): ChainKey | undefined {
  return CHAIN_KEYS.find((k) => CHAINS[k].id === chainId);
}

export type ContractName =
  | "USDC" | "SanctionsOracle" | "Timelock" | "NRX" | "NeroPSM" | "sNRX" | "TokenPool" | "AutoSweeper"
  | "cbBTC" | "wstETH" | "Morpho" | "Irm" | "OracleCbBTC" | "OracleWstETH" | "MorphoLenderStrategy"
  | "AerodromePool" | "IdentityRegistry" | "ReputationRegistry" | "SellerBond" | "NeroJobs" | "AgentSale";

/** Verified address book, shipped in the build. The app refuses to call anything else. */
export function contract(chain: ChainKey, name: ContractName): Address {
  const a = (deployment.chains[chain].contracts as Record<string, string>)[name];
  if (!a) throw new Error(`${name} is not deployed on ${chain}`);
  return getAddress(a);
}
export function has(chain: ChainKey, name: ContractName) {
  return Boolean((deployment.chains[chain].contracts as Record<string, string>)[name]);
}

const allowed = new Set(
  CHAIN_KEYS.flatMap((k) => Object.values(deployment.chains[k].contracts as Record<string, string>).map((a) => `${CHAINS[k].id}:${a.toLowerCase()}`)),
);
export function isVerified(chainId: number, address: string) {
  return allowed.has(`${chainId}:${address.toLowerCase()}`);
}

export const MARKETS = (deployment.chains.base as Deployed & { markets: Record<string, { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: string; id: string }> }).markets;
export type MarketKey = "cbBTC" | "wstETH";
export function marketParams(key: MarketKey) {
  const m = MARKETS[key];
  return {
    loanToken: getAddress(m.loanToken),
    collateralToken: getAddress(m.collateralToken),
    oracle: getAddress(m.oracle),
    irm: getAddress(m.irm),
    lltv: BigInt(m.lltv),
  } as const;
}
export const COLLATERAL_DECIMALS: Record<MarketKey, number> = { cbBTC: 8, wstETH: 18 };

export const PERSONAS = [
  { role: "alice", label: "Alice", blurb: "Holder — mints, earns, borrows, bridges" },
  { role: "bob", label: "Bob", blurb: "x402 seller — Seller Console" },
  { role: "carol", label: "Carol", blurb: "Agent buyer — calls and hires agents" },
  { role: "owner2", label: "Dev Studio", blurb: "Agent owner — 5 listed agents" },
  { role: "eval1", label: "Erin", blurb: "Pool evaluator — rules on jobs" },
  { role: "mallory", label: "Mallory", blurb: "Sanctioned — fails screening" },
] as const;

export function personaAddress(role: string): Address {
  return getAddress((deployment.accounts as Record<string, { address: string }>)[role].address);
}
export function personaOf(address?: string) {
  if (!address) return undefined;
  return PERSONAS.find((p) => personaAddress(p.role).toLowerCase() === address.toLowerCase());
}

export const DEMO = process.env.NEXT_PUBLIC_DEMO !== "0";
