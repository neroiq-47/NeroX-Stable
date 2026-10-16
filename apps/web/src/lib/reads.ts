"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { publicClients } from "./clients";
import { contract, has, marketParams, SERVICES, type ChainKey, type MarketKey } from "./config";
import { MockERC20Abi, MorphoBlueLiteAbi, MockOracleAbi, NeroPSMAbi, NeroTokenPoolAbi, NRXAbi, SNRXAbi, StablePoolLiteAbi, MorphoLenderStrategyAbi } from "./abis";

const REFRESH = 4_000;

export function useRead<T>(key: unknown[], fn: () => Promise<T>, opts: { enabled?: boolean; interval?: number } = {}) {
  return useQuery({ queryKey: key, queryFn: fn, enabled: opts.enabled ?? true, refetchInterval: opts.interval ?? REFRESH, staleTime: 2_000 });
}

export function useApi<T>(path: string | null, base: keyof typeof SERVICES = "market", interval = REFRESH) {
  return useQuery({
    queryKey: ["api", base, path],
    enabled: Boolean(path),
    refetchInterval: interval,
    queryFn: async () => {
      const r = await fetch(`${SERVICES[base]}${path}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as T;
    },
  });
}

const rc = (chain: ChainKey, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
  publicClients[chain].readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<never>;

// ------------------------------------------------------------------ protocol

export type Protocol = Awaited<ReturnType<typeof readProtocol>>;
export async function readProtocol(chain: ChainKey) {
  const nrx = contract(chain, "NRX");
  const psm = contract(chain, "NeroPSM");
  const snrx = contract(chain, "sNRX");
  const pool = contract(chain, "TokenPool");
  const [
    supply, supplyCap, nrxPaused, reserves, remMint, remRedeem, remGlobal, outstanding, dailyMintCap, dailyRedeemCap, globalMintCap,
    psmPaused, mintFee, redeemFee, totalAssets, sharePrice, sharesSupply, idle, liquid, queued, depositCap, vaultPaused, buffer, feeIncome, poolPaused, block,
  ] = await Promise.all([
    rc(chain, nrx, NRXAbi, "totalSupply"), rc(chain, nrx, NRXAbi, "supplyCap"), rc(chain, nrx, NRXAbi, "paused"),
    rc(chain, psm, NeroPSMAbi, "reserves"), rc(chain, psm, NeroPSMAbi, "remainingDailyMint"), rc(chain, psm, NeroPSMAbi, "remainingDailyRedeem"),
    rc(chain, psm, NeroPSMAbi, "remainingGlobalMint"), rc(chain, psm, NeroPSMAbi, "outstanding"), rc(chain, psm, NeroPSMAbi, "dailyMintCap"),
    rc(chain, psm, NeroPSMAbi, "dailyRedeemCap"), rc(chain, psm, NeroPSMAbi, "globalMintCap"), rc(chain, psm, NeroPSMAbi, "paused"),
    rc(chain, psm, NeroPSMAbi, "mintFeeBps"), rc(chain, psm, NeroPSMAbi, "redeemFeeBps"),
    rc(chain, snrx, SNRXAbi, "totalAssets"), rc(chain, snrx, SNRXAbi, "sharePrice"), rc(chain, snrx, SNRXAbi, "totalSupply"),
    rc(chain, snrx, SNRXAbi, "idle"), rc(chain, snrx, SNRXAbi, "availableLiquidity"), rc(chain, snrx, SNRXAbi, "queuedShares"),
    rc(chain, snrx, SNRXAbi, "depositCap"), rc(chain, snrx, SNRXAbi, "paused"), rc(chain, snrx, SNRXAbi, "bufferBps"), rc(chain, snrx, SNRXAbi, "totalFeeIncome"),
    rc(chain, pool, NeroTokenPoolAbi, "paused"), publicClients[chain].getBlock(),
  ]);
  return {
    supply: supply as bigint, supplyCap: supplyCap as bigint, nrxPaused: nrxPaused as boolean,
    reserves: reserves as bigint, remMint: remMint as bigint, remRedeem: remRedeem as bigint, remGlobal: remGlobal as bigint,
    outstanding: outstanding as bigint, dailyMintCap: dailyMintCap as bigint, dailyRedeemCap: dailyRedeemCap as bigint, globalMintCap: globalMintCap as bigint,
    psmPaused: psmPaused as boolean, mintFeeBps: mintFee as bigint, redeemFeeBps: redeemFee as bigint,
    vault: {
      totalAssets: totalAssets as bigint, sharePrice: sharePrice as bigint, totalShares: sharesSupply as bigint, idle: idle as bigint,
      liquid: liquid as bigint, queuedShares: queued as bigint, depositCap: depositCap as bigint, paused: vaultPaused as boolean,
      bufferBps: buffer as bigint, feeIncome: feeIncome as bigint,
    },
    poolPaused: poolPaused as boolean,
    chainTime: Number((block as { timestamp: bigint }).timestamp),
  };
}
export const useProtocol = (chain: ChainKey) => useRead(["protocol", chain], () => readProtocol(chain));

// ------------------------------------------------------------------ balances

export async function readBalances(chain: ChainKey, a: Address) {
  const snrx = contract(chain, "sNRX");
  const [nrx, usdc, shares, eth, allowanceSweeper] = await Promise.all([
    rc(chain, contract(chain, "NRX"), NRXAbi, "balanceOf", [a]),
    rc(chain, contract(chain, "USDC"), MockERC20Abi, "balanceOf", [a]),
    rc(chain, snrx, SNRXAbi, "balanceOf", [a]),
    publicClients[chain].getBalance({ address: a }),
    rc(chain, contract(chain, "NRX"), NRXAbi, "allowance", [a, contract(chain, "AutoSweeper")]),
  ]);
  const snrxValue = (await rc(chain, snrx, SNRXAbi, "convertToAssets", [shares])) as bigint;
  const maxWithdraw = (await rc(chain, snrx, SNRXAbi, "maxWithdraw", [a])) as bigint;
  let extra = { cbBTC: 0n, wstETH: 0n, lp: 0n };
  if (has(chain, "AerodromePool")) {
    const [c, w, lp] = await Promise.all([
      rc(chain, contract(chain, "cbBTC"), MockERC20Abi, "balanceOf", [a]),
      rc(chain, contract(chain, "wstETH"), MockERC20Abi, "balanceOf", [a]),
      rc(chain, contract(chain, "AerodromePool"), StablePoolLiteAbi, "balanceOf", [a]),
    ]);
    extra = { cbBTC: c as bigint, wstETH: w as bigint, lp: lp as bigint };
  }
  return { nrx: nrx as bigint, usdc: usdc as bigint, shares: shares as bigint, snrxValue, maxWithdraw, eth, sweeperAllowance: allowanceSweeper as bigint, ...extra };
}
export const useBalances = (chain: ChainKey, a?: Address) =>
  useRead(["balances", chain, a], () => readBalances(chain, a as Address), { enabled: Boolean(a) });

// ------------------------------------------------------------------ Morpho markets

const SECONDS_PER_YEAR = 365 * 86400;
const WAD = 10n ** 18n;

export async function readMarket(key: MarketKey, user?: Address) {
  const p = marketParams(key);
  const morpho = contract("base", "Morpho");
  const [m, rate, liquidity, price] = await Promise.all([
    rc("base", morpho, MorphoBlueLiteAbi, "expectedMarket", [p]),
    rc("base", morpho, MorphoBlueLiteAbi, "borrowRate", [p]),
    rc("base", morpho, MorphoBlueLiteAbi, "liquidity", [p]),
    rc("base", p.oracle, MockOracleAbi, "price"),
  ]);
  const mk = m as { totalSupplyAssets: bigint; totalBorrowAssets: bigint };
  const util = mk.totalSupplyAssets === 0n ? 0 : Number((mk.totalBorrowAssets * 10_000n) / mk.totalSupplyAssets) / 10_000;
  const borrowApr = (Number(rate as bigint) * SECONDS_PER_YEAR) / 1e18;
  let position = { collateral: 0n, debt: 0n, health: undefined as number | undefined };
  if (user) {
    const id = (await rc("base", morpho, MorphoBlueLiteAbi, "id", [p])) as `0x${string}`;
    const [pos, debt, hf] = await Promise.all([
      rc("base", morpho, MorphoBlueLiteAbi, "position", [id, user]),
      rc("base", morpho, MorphoBlueLiteAbi, "expectedBorrowAssets", [p, user]),
      rc("base", morpho, MorphoBlueLiteAbi, "healthFactor", [p, user]),
    ]);
    const posT = pos as readonly [bigint, bigint, bigint];
    const hfv = hf as bigint;
    position = { collateral: posT[2], debt: debt as bigint, health: hfv > 10n ** 30n ? undefined : Number((hfv * 10_000n) / WAD) / 10_000 };
  }
  return {
    key, params: p, totalSupply: mk.totalSupplyAssets, totalBorrow: mk.totalBorrowAssets, util, borrowApr,
    supplyApy: borrowApr * util, liquidity: liquidity as bigint, price: price as bigint, lltv: Number(p.lltv) / 1e18, position,
  };
}
export const useMarket = (key: MarketKey, user?: Address) => useRead(["market", key, user], () => readMarket(key, user));

/** Collateral value in NRX base units from a Morpho oracle price (1e36 scale). */
export const collateralValue = (amount: bigint, price: bigint) => (amount * price) / 10n ** 36n;

/** sNRX APY: borrower interest on the deployed share, weighted by the strategy's allocation. */
export async function readVaultApy(chain: ChainKey) {
  if (!has(chain, "MorphoLenderStrategy")) return { apy: 0, deployed: 0n, markets: [] as { key: MarketKey; supplied: bigint; apy: number }[] };
  const strategy = contract(chain, "MorphoLenderStrategy");
  const [total, vaultAssets] = await Promise.all([
    rc(chain, strategy, MorphoLenderStrategyAbi, "totalAssets"),
    rc(chain, contract(chain, "sNRX"), SNRXAbi, "totalAssets"),
  ]);
  const markets: { key: MarketKey; supplied: bigint; apy: number }[] = [];
  let weighted = 0;
  for (const key of ["cbBTC", "wstETH"] as MarketKey[]) {
    const m = await readMarket(key);
    const supplied = (await rc(chain, contract("base", "Morpho"), MorphoBlueLiteAbi, "expectedSupplyAssets", [m.params, strategy])) as bigint;
    markets.push({ key, supplied, apy: m.supplyApy });
    weighted += m.supplyApy * Number(supplied);
  }
  const va = Number(vaultAssets as bigint);
  return { apy: va ? weighted / va : 0, deployed: total as bigint, markets };
}
export const useVaultApy = (chain: ChainKey) => useRead(["vaultApy", chain], () => readVaultApy(chain), { interval: 8_000 });
