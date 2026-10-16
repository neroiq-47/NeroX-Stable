"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useApp } from "@/lib/app-state";
import { CHAINS, contract, type ChainKey } from "@/lib/config";
import { useBalances, useProtocol, useRead, useVaultApy } from "@/lib/reads";
import { publicClients } from "@/lib/clients";
import { useTx } from "@/lib/tx";
import { SNRXAbi } from "@/lib/abis";
import { fmt, fmtAmt, parseAmount, pct } from "@/lib/format";
import { ActionButton, AmountInput, Bar, Kv, Notice, PageHead, PausedNotice, Stat, Tabs, TxStatus } from "@/components/ui";
import type { Address } from "viem";

type Req = { id: number; shares: bigint; requestedAt: number; done: boolean };

function useMyRequests(chain: ChainKey, a?: Address) {
  return useRead(["requests", chain, a], async () => {
    const pc = publicClients[chain];
    const v = contract(chain, "sNRX");
    const n = Number(await pc.readContract({ address: v, abi: SNRXAbi, functionName: "requestCount" }));
    const out: Req[] = [];
    for (let i = Math.max(0, n - 50); i < n; i++) {
      const r = (await pc.readContract({ address: v, abi: SNRXAbi, functionName: "requests", args: [BigInt(i)] })) as readonly [Address, Address, bigint, bigint, boolean];
      if (r[0].toLowerCase() === a!.toLowerCase()) out.push({ id: i, shares: r[2], requestedAt: Number(r[3]), done: r[4] });
    }
    return out.reverse();
  }, { enabled: Boolean(a) });
}

export default function EarnPage() {
  const { chain } = useApp();
  const { address } = useAccount();
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [value, setValue] = useState("");
  const p = useProtocol(chain);
  const b = useBalances(chain, address);
  const apy = useVaultApy(chain);
  const reqs = useMyRequests(chain, address);
  const tx = useTx();
  const v = p.data?.vault;
  const amount = parseAmount(value);
  const sharesFor = (assets: bigint) => (v && v.sharePrice > 0n ? (assets * 10n ** 12n) / v.sharePrice : 0n);
  const refresh = () => { setValue(""); b.refetch(); p.refetch(); reqs.refetch(); };

  const instant = b.data?.maxWithdraw ?? 0n;
  const needsQueue = mode === "unstake" && amount !== undefined && amount > instant;

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (!amount) reason = "Enter an amount.";
  else if (v?.paused) reason = "Contract paused.";
  else if (mode === "stake" && b.data && amount > b.data.nrx) reason = "Not enough NRX.";
  else if (mode === "stake" && v && amount > v.depositCap - v.totalAssets) reason = "Above the vault's beta deposit cap.";
  else if (mode === "unstake" && b.data && amount > b.data.snrxValue) reason = "More than your sNRX is worth.";

  const submit = () => {
    const vault = contract(chain, "sNRX");
    if (mode === "stake")
      return tx.run({ title: "Stake NRX", chain, total: 2, onDone: refresh }, async (h) => {
        const sig = await h.permit(contract(chain, "NRX"), vault, amount!, "Sign NRX permit (no gas)");
        await h.write({ address: vault, abi: SNRXAbi, functionName: "depositWithPermit", args: [amount, address, sig.deadline, sig.v, sig.r, sig.s] }, "Confirm stake");
      });
    if (!needsQueue)
      return tx.run({ title: "Unstake sNRX", chain, total: 1, onDone: refresh }, async (h) => {
        const all = b.data && amount! >= b.data.snrxValue;
        await h.write(
          all ? { address: vault, abi: SNRXAbi, functionName: "redeem", args: [b.data!.shares, address, address] } : { address: vault, abi: SNRXAbi, functionName: "withdraw", args: [amount, address, address] },
          "Confirm unstake",
        );
      });
    return tx.run({ title: "Queue withdrawal", chain, total: 1, onDone: refresh }, async (h) => {
      const shares = b.data && amount! >= b.data.snrxValue ? b.data.shares : sharesFor(amount!);
      await h.write({ address: vault, abi: SNRXAbi, functionName: "requestRedeem", args: [shares, address] }, "Confirm queued withdrawal");
    });
  };

  const util = v && v.totalAssets > 0n ? Number(((v.totalAssets - v.liquid) * 10_000n) / v.totalAssets) / 10_000 : 0;
  const queuedValue = v ? (v.queuedShares * v.sharePrice) / 10n ** 12n : 0n;

  return (
    <>
      <PageHead
        title="Earn with sNRX"
        sub="Stake NRX to earn from Morpho borrowers. Returns vary and are not guaranteed."
        chainNote={<>Acts on <strong>{CHAINS[chain].name}</strong>.</>}
      />
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card"><Stat label="Current APY" value={pct(apy.data?.apy)} tone="yield" sub={chain === "base" ? "Borrower interest, after the idle buffer" : "Fee share only on this chain"} /></div>
        <div className="card"><Stat label="sNRX share price" value={v ? `${fmt(v.sharePrice, 6, 6)} NRX` : "—"} tone="yield" /></div>
        <div className="card"><Stat label="Vault TVL" value={fmtAmt(v?.totalAssets, "NRX", 6, 0)} /></div>
        <div className="card"><Stat label="Withdrawal queue" value={fmtAmt(queuedValue, "NRX")} sub={queuedValue > 0n ? "Clears as borrowers repay" : "No wait right now"} /></div>
      </div>
      <div className="grid split">
        <div className="card-lg stack">
          <Tabs value={mode} onChange={(m) => { setMode(m); setValue(""); tx.reset(); }} items={[{ id: "stake", label: "Stake" }, { id: "unstake", label: "Unstake" }]} />
          {v?.paused && <PausedNotice what="The sNRX vault" />}
          <AmountInput id="earn-amt" label={mode === "stake" ? "Stake" : "Unstake (NRX value)"} unit="NRX" value={value} onChange={setValue} max={mode === "stake" ? b.data?.nrx : b.data?.snrxValue} />
          <div>
            {mode === "stake" ? (
              <Kv k="You receive" v={amount ? `${fmt(sharesFor(amount), 12, 4)} sNRX` : "—"} tone="yield" />
            ) : (
              <Kv k="You receive" v={fmtAmt(amount, "NRX")} />
            )}
            <Kv k="Available instantly" v={fmtAmt(instant, "NRX")} />
            <Kv k="Your sNRX" v={b.data ? `${fmt(b.data.shares, 12, 4)} sNRX · ${fmtAmt(b.data.snrxValue, "NRX")}` : "—"} />
          </div>
          {needsQueue && (
            <Notice>
              Morpho liquidity is thin right now, so <span className="mono">{fmtAmt(amount! - instant, "NRX")}</span> of this can't leave instantly. NeroX
              will queue it: your sNRX keeps earning until the keeper processes the queue as borrowers repay.
            </Notice>
          )}
          <ActionButton onClick={submit} reason={tx.state.busy ? null : reason} busy={tx.state.busy}>
            {mode === "stake" ? "Stake NRX" : needsQueue ? "Queue withdrawal" : "Unstake"}
          </ActionButton>
          <TxStatus state={tx.state} />
          {reqs.data && reqs.data.length > 0 && (
            <div className="stack-1">
              <span className="label">Your queued withdrawals</span>
              {reqs.data.map((r) => (
                <div key={r.id} className="kv">
                  <span>Request #{r.id}</span>
                  <span className="mono">{fmt(r.shares, 12, 4)} sNRX · {r.done ? "paid" : "waiting"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="stack-3">
          <div className="card stack">
            <h2>Where the vault's NRX is</h2>
            <div className="stack-1">
              <div className="between small"><span>Lent to Morpho borrowers</span><span className="mono">{pct(util, 1)}</span></div>
              <Bar value={util} tone="yield" />
            </div>
            <Kv k="Idle buffer (instant exits)" v={fmtAmt(v?.idle, "NRX")} />
            <Kv k="Deployed to Morpho" v={fmtAmt(apy.data?.deployed, "NRX")} />
            {apy.data?.markets.map((m) => (
              <Kv key={m.key} k={`NRX/${m.key} market supply APY`} v={pct(m.apy)} tone="yield" />
            ))}
            <Kv k="x402 fee share received" v={fmtAmt(v?.feeIncome, "NRX")} />
          </div>
          <Notice tone="yield">
            <strong>Where sNRX income comes from.</strong> The vault lends NRX to borrowers in NeroX's Morpho markets, who post cbBTC or wstETH as
            collateral. Their interest is the return, topped up by a share of x402 facilitator fees. The USDC reserves behind NRX are never used. Risks:
            borrower bad debt, Morpho contract risk and withdrawal delays when markets are fully lent.
          </Notice>
        </div>
      </div>
    </>
  );
}
