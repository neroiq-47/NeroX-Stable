"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { contract } from "@/lib/config";
import { useBalances, useRead } from "@/lib/reads";
import { publicClients } from "@/lib/clients";
import { useTx } from "@/lib/tx";
import { MockERC20Abi, StablePoolLiteAbi } from "@/lib/abis";
import { fmt, fmtAmt, parseAmount, pct } from "@/lib/format";
import { ActionButton, AmountInput, ExternalIcon, Kv, Notice, PageHead, Stat, Tabs, TxStatus } from "@/components/ui";
import type { Address } from "viem";

const POOL = () => contract("base", "AerodromePool");

function usePool() {
  return useRead(["pool"], async () => {
    const pc = publicClients.base;
    const a = POOL();
    const r = (n: string, args: unknown[] = []) => pc.readContract({ address: a, abi: StablePoolLiteAbi, functionName: n as never, args: args as never }) as Promise<never>;
    const [t0, r0, r1, supply, spot, fees0, fees1, created, block] = await Promise.all([
      r("token0"), r("reserve0"), r("reserve1"), r("totalSupply"), r("spotPrice0"), r("cumulativeFees0"), r("cumulativeFees1"), r("createdAt"), pc.getBlock(),
    ]);
    const nrxIs0 = (t0 as Address).toLowerCase() === contract("base", "NRX").toLowerCase();
    const reserveNrx = nrxIs0 ? (r0 as bigint) : (r1 as bigint);
    const reserveUsdc = nrxIs0 ? (r1 as bigint) : (r0 as bigint);
    const spot0 = Number(spot as bigint) / 1e18;
    const peg = nrxIs0 ? spot0 : spot0 ? 1 / spot0 : 0; // USDC per NRX
    const tvl = reserveNrx + reserveUsdc;
    const age = Math.max(3600, Number(block.timestamp) - Number(created as bigint));
    const fees = (fees0 as bigint) + (fees1 as bigint);
    const feeApr = tvl > 0n ? (Number(fees) / Number(tvl)) * (365 * 86400) / age : 0;
    return { reserveNrx, reserveUsdc, supply: supply as bigint, peg, tvl, feeApr, nrxIs0 };
  });
}

export default function PoolsPage() {
  const { address } = useAccount();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [nrxIn, setNrxIn] = useState("");
  const [lpIn, setLpIn] = useState("");
  const pool = usePool();
  const b = useBalances("base", address);
  const tx = useTx();
  const d = pool.data;
  const nrxAmt = parseAmount(nrxIn);
  // Balanced deposit at the current reserve ratio.
  const usdcAmt = nrxAmt && d && d.reserveNrx > 0n ? (nrxAmt * d.reserveUsdc) / d.reserveNrx + 1n : undefined;
  const lpAmt = parseAmount(lpIn);
  const outN = lpAmt && d ? (lpAmt * d.reserveNrx) / d.supply : undefined;
  const outU = lpAmt && d ? (lpAmt * d.reserveUsdc) / d.supply : undefined;
  const refresh = () => { setNrxIn(""); setLpIn(""); b.refetch(); pool.refetch(); };

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (mode === "add" && !nrxAmt) reason = "Enter an amount.";
  else if (mode === "add" && b.data && nrxAmt! > b.data.nrx) reason = "Not enough NRX.";
  else if (mode === "add" && b.data && usdcAmt! > b.data.usdc) reason = "Not enough USDC for a balanced deposit.";
  else if (mode === "remove" && !lpAmt) reason = "Enter an amount.";
  else if (mode === "remove" && b.data && lpAmt! > b.data.lp) reason = "Not enough LP tokens.";

  const submit = () => {
    const a = POOL();
    if (mode === "add")
      return tx.run({ title: "Add liquidity", chain: "base", total: 3, onDone: refresh }, async (h) => {
        const [a0, a1] = d!.nrxIs0 ? [nrxAmt!, usdcAmt!] : [usdcAmt!, nrxAmt!];
        // Exact approvals, batched with the deposit into one prompt where the wallet supports it.
        await h.writeAll([
          { params: { address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [a, nrxAmt] }, label: "Approve exact NRX" },
          { params: { address: contract("base", "USDC"), abi: MockERC20Abi, functionName: "approve", args: [a, usdcAmt] }, label: "Approve exact USDC" },
          { params: { address: a, abi: StablePoolLiteAbi, functionName: "addLiquidity", args: [a0, a1, 0n, address] }, label: "Add liquidity" },
        ]);
      });
    return tx.run({ title: "Remove liquidity", chain: "base", total: 1, onDone: refresh }, async (h) => {
      const [m0, m1] = d!.nrxIs0 ? [(outN! * 995n) / 1000n, (outU! * 995n) / 1000n] : [(outU! * 995n) / 1000n, (outN! * 995n) / 1000n];
      await h.write({ address: a, abi: StablePoolLiteAbi, functionName: "removeLiquidity", args: [lpAmt, m0, m1, address] }, "Remove liquidity");
    });
  };

  const share = d && b.data && d.supply > 0n ? Number((b.data.lp * 1_000_000n) / d.supply) / 1_000_000 : 0;
  const deviation = d ? Math.abs(d.peg - 1) : 0;

  return (
    <>
      <PageHead title="Pools" sub="Provide NRX/USDC liquidity on the stable curve that keeps NRX on peg and routes swaps." chainNote={<>Acts on <strong>Base (local)</strong> — the Aerodrome sAMM NRX/USDC pool. Curve and PancakeSwap pools follow in the medium phase.</>} />
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card"><Stat label="Peg price" value={d ? `${d.peg.toFixed(4)} USDC` : "—"} tone={deviation > 0.003 ? "danger" : "signal"} sub={deviation > 0.003 ? "! Outside ±0.3% band" : "Within ±0.3% band"} /></div>
        <div className="card"><Stat label="Pool depth" value={fmtAmt(d?.tvl, "USD", 6, 0)} sub={d ? `${fmt(d.reserveNrx, 6, 0)} NRX · ${fmt(d.reserveUsdc, 6, 0)} USDC` : undefined} /></div>
        <div className="card"><Stat label="Fee APR" value={pct(d?.feeApr)} sub="0.05% swap fee to LPs" /></div>
        <div className="card"><Stat label="Your share" value={pct(share, 4)} sub={b.data ? `${fmt(b.data.lp, 6, 4)} LP` : undefined} /></div>
      </div>
      <div className="grid split">
        <div className="card-lg stack">
          <Tabs value={mode} onChange={(m) => { setMode(m); tx.reset(); }} items={[{ id: "add", label: "Add liquidity" }, { id: "remove", label: "Remove" }]} />
          {mode === "add" ? (
            <>
              <AmountInput id="pool-nrx" label="NRX" unit="NRX" value={nrxIn} onChange={setNrxIn} max={b.data?.nrx} />
              <Kv k="USDC (balanced at pool ratio)" v={fmtAmt(usdcAmt, "USDC")} />
              <Kv k="Your USDC" v={fmtAmt(b.data?.usdc, "USDC")} />
            </>
          ) : (
            <>
              <AmountInput id="pool-lp" label="LP tokens" unit="LP" value={lpIn} onChange={setLpIn} max={b.data?.lp} />
              <Kv k="You receive" v={outN !== undefined ? `${fmt(outN)} NRX + ${fmt(outU)} USDC` : "—"} />
              <Kv k="Slippage guard" v="0.5%" />
            </>
          )}
          <ActionButton onClick={submit} reason={tx.state.busy ? null : reason} busy={tx.state.busy}>
            {mode === "add" ? "Add liquidity" : "Remove liquidity"}
          </ActionButton>
          <TxStatus state={tx.state} />
        </div>
        <div className="stack-3">
          <div className="card stack-1">
            <h2>Prefer the venue directly?</h2>
            <p className="small">On mainnet this pool lives on Aerodrome. You can manage the position there instead.</p>
            <a className="btn" href="https://aerodrome.finance/liquidity" target="_blank" rel="noreferrer">
              Open Aerodrome <ExternalIcon />
            </a>
          </div>
          <Notice>
            The pool uses a stable curve (x³y + xy³), so swaps near 1:1 stay cheap. The PSM gives a hard 1:1 redemption floor; protocol-owned
            liquidity seeds the pool. LP positions can lose value if either asset depegs.
          </Notice>
        </div>
      </div>
    </>
  );
}
