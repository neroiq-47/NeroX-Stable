"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { contract } from "@/lib/config";
import { publicClients } from "@/lib/clients";
import { useBalances, useProtocol, useRead } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { SNRXAbi, SellerBondAbi } from "@/lib/abis";
import { fmtAmt, parseAmount } from "@/lib/format";
import { AmountInput, Kv, TxStatus } from "./ui";

export function useBond(a?: Address) {
  return useRead(["bond", a], async () => {
    const c = { address: contract("base", "SellerBond"), abi: SellerBondAbi } as const;
    const pc = publicClients.base;
    const [value, free, locked, pending] = await Promise.all([
      pc.readContract({ ...c, functionName: "bondValue", args: [a!] }),
      pc.readContract({ ...c, functionName: "freeValue", args: [a!] }),
      pc.readContract({ ...c, functionName: "lockedAssets", args: [a!] }),
      pc.readContract({ ...c, functionName: "pending", args: [a!] }),
    ]);
    const p = pending as readonly [bigint, bigint];
    return { value: value as bigint, free: free as bigint, locked: locked as bigint, pendingShares: p[0], unlockAt: Number(p[1]) };
  }, { enabled: Boolean(a) });
}

/** Seller and evaluator bonds are posted in sNRX, so they keep earning while posted. */
export function BondPanel() {
  const { address } = useAccount();
  const bond = useBond(address);
  const b = useBalances("base", address);
  const p = useProtocol("base");
  const tx = useTx();
  const [amt, setAmt] = useState("");
  const amount = parseAmount(amt);
  const price = p.data?.vault.sharePrice ?? 0n;
  const shares = amount && price ? (amount * 10n ** 12n) / price : 0n;
  const chainTime = p.data?.chainTime ?? 0;
  const bondAddr = contract("base", "SellerBond");
  const refresh = () => { setAmt(""); bond.refetch(); b.refetch(); };
  const deposit = () => tx.run({ title: "Post bond", chain: "base", total: 2, onDone: refresh }, async (h) => {
    const s = b.data && amount! >= b.data.snrxValue ? b.data.shares : shares;
    await h.writeAll([
      { params: { address: contract("base", "sNRX"), abi: SNRXAbi, functionName: "approve", args: [bondAddr, s] }, label: "Approve exact sNRX" },
      { params: { address: bondAddr, abi: SellerBondAbi, functionName: "deposit", args: [s] }, label: "Post bond" },
    ]);
  });
  const request = () => tx.run({ title: "Request bond withdrawal", chain: "base", total: 1, onDone: refresh }, async (h) => {
    await h.write({ address: bondAddr, abi: SellerBondAbi, functionName: "requestWithdraw", args: [shares] }, "Start 7-day timelock");
  });
  const withdraw = () => tx.run({ title: "Withdraw bond", chain: "base", total: 1, onDone: refresh }, async (h) => {
    await h.write({ address: bondAddr, abi: SellerBondAbi, functionName: "withdraw", args: [] }, "Withdraw");
  });
  const d = bond.data;
  return (
    <div className="card stack">
      <h2>Your sNRX bond</h2>
      <Kv k="Bond value" v={fmtAmt(d?.value, "NRX")} tone="yield" />
      <Kv k="Committed to open jobs" v={fmtAmt(d?.locked, "NRX")} />
      <Kv k="Free" v={fmtAmt(d?.free, "NRX")} />
      {d && d.pendingShares > 0n && <Kv k="Withdrawal" v={chainTime >= d.unlockAt ? "Ready" : `unlocks in ${Math.ceil((d.unlockAt - chainTime) / 86400)} d`} />}
      <AmountInput id="bond-amt" label="Amount (NRX value)" unit="NRX" value={amt} onChange={setAmt} max={b.data?.snrxValue} />
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={deposit} disabled={!amount || tx.state.busy || (b.data ? amount > b.data.snrxValue : true)}>Post from my sNRX</button>
        <button className="btn btn-sm" onClick={request} disabled={!amount || tx.state.busy}>Request withdrawal</button>
        {d && d.pendingShares > 0n && <button className="btn btn-sm" onClick={withdraw} disabled={tx.state.busy || chainTime < d.unlockAt}>Withdraw</button>}
      </div>
      <TxStatus state={tx.state} />
      <p className="small">Stake NRX on the Earn screen to get sNRX. Sellers need free bond of 10% of each funded job. Bonds are slashed only on a NeroJobs ruling.</p>
    </div>
  );
}
