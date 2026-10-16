"use client";
// Transaction engine: verified addresses only, simulate before sign, one confirmation per
// action where the wallet supports EIP-5792 batching, a clear step counter where it does not,
// and pending transactions that persist across reloads.
import { useCallback, useState } from "react";
import { useAccount, useConfig, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { getCapabilities, sendCalls, waitForCallsStatus } from "wagmi/actions";
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, hexToSignature, type Abi, type Address } from "viem";
import { CHAINS, isVerified, type ChainKey } from "./config";
import { publicClients } from "./clients";
import { useApp } from "./app-state";

export type WriteParams = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

const ERRORS: Record<string, string> = {
  DailyMintCapExceeded: "Today's mint cap is used up. Try a smaller amount or come back tomorrow.",
  DailyRedeemCapExceeded: "Today's redeem cap is used up. Try a smaller amount.",
  GlobalMintCapExceeded: "The beta supply cap is reached.",
  InsufficientReserves: "This chain's PSM does not hold enough USDC. Bridge to another chain to redeem.",
  SupplyCapExceeded: "The NRX supply cap on this chain is reached.",
  EnforcedPause: "Contract paused.",
  AccountBlocklisted: "This address is blocked.",
  InsufficientCollateral: "Not enough collateral for this loan.",
  InsufficientLiquidity: "Not enough liquidity right now.",
  RateLimitExceeded: "This bridge lane's rate limit would be exceeded.",
  InsufficientFee: "The bridge fee is too low.",
  ERC4626ExceededMaxWithdraw: "More than can be withdrawn right now — use the withdrawal queue.",
  ERC4626ExceededMaxRedeem: "More than can be withdrawn right now — use the withdrawal queue.",
  ERC4626ExceededMaxDeposit: "The vault deposit cap is reached.",
  DepositCapExceeded: "The vault deposit cap is reached.",
  ERC20InsufficientBalance: "Insufficient balance.",
  ERC20InsufficientAllowance: "Approval missing for this amount.",
  BondTooLow: "The seller's bond does not cover this job. The seller must add to their sNRX bond.",
  SharedOwner: "The provider and evaluator cannot share an owner.",
  PoolEvaluatorRequired: "Jobs above 500 NRX need a random pool evaluator.",
  BudgetAboveCap: "Job budgets are capped at 1,000 NRX in the beta.",
  BudgetMismatch: "The budget changed. Review the new quote.",
  NotPoolEvaluator: "Join the pool with at least 500 NRX of sNRX bonded.",
  OpenJobs: "This agent has open jobs. They must settle before a sale.",
  PriceChanged: "The asking price changed.",
  NotExpired: "This job has not reached its deadline.",
  InvalidStatus: "This action is not available in the job's current state.",
  NotAuthorized: "Only the right party can do this.",
  HealthyPosition: "This position is healthy.",
  StillLocked: "Bond withdrawal is still timelocked.",
};

export function readableError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? "";
      if (ERRORS[name]) return ERRORS[name];
      if (revert.reason) return revert.reason;
      if (name) return name.replace(/([a-z])([A-Z])/g, "$1 $2");
    }
    if (/User (rejected|denied)/i.test(e.message)) return "You rejected the request in your wallet.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export type TxState = { busy: boolean; step: number; total: number; label: string; error?: string; done?: string; hash?: string };

type Helpers = {
  write: (p: WriteParams, label: string) => Promise<`0x${string}`>;
  /** Approve-and-act pairs in one prompt via EIP-5792 when supported; sequential otherwise. */
  writeAll: (calls: { params: WriteParams; label: string }[]) => Promise<void>;
  permit: (token: Address, spender: Address, value: bigint, label: string) => Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; deadline: bigint }>;
  sign: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  simulate: (p: WriteParams) => Promise<unknown>;
};

export function useTx() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { addTx, updateTx, screening } = useApp();
  const [state, setState] = useState<TxState>({ busy: false, step: 0, total: 0, label: "" });

  const run = useCallback(
    async (opts: { title: string; chain: ChainKey; total: number; onDone?: () => void }, plan: (h: Helpers) => Promise<void>) => {
      if (!address) return setState({ busy: false, step: 0, total: 0, label: "", error: "Connect a wallet first." });
      if (screening.status === "sanctioned") return setState({ busy: false, step: 0, total: 0, label: "", error: "This wallet failed sanctions screening." });
      const target = CHAINS[opts.chain].id;
      const pc = publicClients[opts.chain];
      let step = 0;
      const next = (label: string) => {
        step += 1;
        setState({ busy: true, step, total: opts.total, label });
      };
      const ensureChain = async () => {
        if (chainId !== target) await switchChainAsync({ chainId: target });
      };
      const simulate = async (p: WriteParams) => {
        if (!isVerified(target, p.address)) throw new Error("Refusing to call an address outside the verified address book.");
        const { request, result } = await pc.simulateContract({ ...(p as object), account: address } as never);
        return { request, result };
      };
      const h: Helpers = {
        simulate: async (p) => (await simulate(p)).result,
        async write(p, label) {
          next(label);
          await ensureChain();
          await simulate(p); // blocks on revert, before the wallet opens
          const hash = await writeContractAsync({ ...(p as object), chainId: target } as never);
          addTx({ hash, chain: opts.chain, label: `${opts.title} — ${label}`, status: "pending", time: Date.now() });
          setState((s) => ({ ...s, hash }));
          const r = await pc.waitForTransactionReceipt({ hash });
          updateTx(hash, { status: r.status === "success" ? "success" : "reverted" });
          if (r.status !== "success") throw new Error("Transaction reverted.");
          return hash;
        },
        async writeAll(calls) {
          await ensureChain();
          let atomic = false;
          try {
            const caps = await getCapabilities(config, { account: address, chainId: target });
            const c = (caps as Record<string, { atomic?: { status?: string } }>)[target] ?? caps;
            atomic = ["supported", "ready"].includes((c as { atomic?: { status?: string } }).atomic?.status ?? "");
          } catch {
            atomic = false;
          }
          if (!atomic) {
            for (const c of calls) await h.write(c.params, c.label);
            return;
          }
          next(calls.map((c) => c.label).join(" + "));
          for (const c of calls) if (!isVerified(target, c.params.address)) throw new Error("Unverified address");
          const { id } = await sendCalls(config, {
            chainId: target,
            calls: calls.map((c) => ({ to: c.params.address, data: encodeFunctionData({ abi: c.params.abi as Abi, functionName: c.params.functionName, args: c.params.args as unknown[] }), value: c.params.value })),
          });
          const res = await waitForCallsStatus(config, { id });
          const hash = res.receipts?.[res.receipts.length - 1]?.transactionHash;
          if (hash) addTx({ hash, chain: opts.chain, label: opts.title, status: res.status === "success" ? "success" : "reverted", time: Date.now() });
          step += calls.length - 1;
        },
        async permit(token, spender, value, label) {
          next(label);
          await ensureChain();
          const [name, nonce, block] = await Promise.all([
            pc.readContract({ address: token, abi: PERMIT_ABI, functionName: "name" }),
            pc.readContract({ address: token, abi: PERMIT_ABI, functionName: "nonces", args: [address] }),
            pc.getBlock(),
          ]);
          const deadline = block.timestamp + 1200n;
          const sig = await signTypedDataAsync({
            domain: { name, version: "1", chainId: target, verifyingContract: token },
            types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
            primaryType: "Permit",
            message: { owner: address, spender, value, nonce, deadline },
          });
          const { v, r, s } = hexToSignature(sig);
          return { v: Number(v), r, s, deadline };
        },
        async sign(label, fn) {
          next(label);
          await ensureChain();
          return fn();
        },
      };
      try {
        setState({ busy: true, step: 0, total: opts.total, label: "Preparing" });
        await plan(h);
        setState({ busy: false, step: opts.total, total: opts.total, label: "", done: `${opts.title}: done` });
        opts.onDone?.();
      } catch (e) {
        setState({ busy: false, step: 0, total: opts.total, label: "", error: readableError(e) });
      }
    },
    [address, chainId, config, writeContractAsync, signTypedDataAsync, switchChainAsync, addTx, updateTx, screening.status],
  );

  const reset = useCallback(() => setState({ busy: false, step: 0, total: 0, label: "" }), []);
  return { state, run, reset };
}

const PERMIT_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
