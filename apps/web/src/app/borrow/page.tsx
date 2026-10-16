"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { COLLATERAL_DECIMALS, contract, marketParams, type MarketKey } from "@/lib/config";
import { collateralValue, useBalances, useMarket } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { publicClients } from "@/lib/clients";
import { MockERC20Abi, MorphoBlueLiteAbi } from "@/lib/abis";
import { fmt, fmtAmt, fmtNum, parseAmount, pct } from "@/lib/format";
import { ActionButton, AmountInput, Bar, Kv, Notice, PageHead, Stat, Tabs, TxStatus } from "@/components/ui";

const GUARD = 0.8; // refuse loans above 80% of LLTV by default

export default function BorrowPage() {
  const { address } = useAccount();
  const [key, setKey] = useState<MarketKey>("cbBTC");
  const [mode, setMode] = useState<"borrow" | "repay" | "withdraw">("borrow");
  const [coll, setColl] = useState("");
  const [loan, setLoan] = useState("");
  const m = useMarket(key, address);
  const b = useBalances("base", address);
  const tx = useTx();
  const d = m.data;
  const dec = COLLATERAL_DECIMALS[key];
  const collAmt = parseAmount(coll, dec) ?? 0n;
  const loanAmt = parseAmount(loan) ?? 0n;
  const walletColl = key === "cbBTC" ? b.data?.cbBTC : b.data?.wstETH;
  const posColl = d?.position.collateral ?? 0n;
  const debt = d?.position.debt ?? 0n;
  const lltvWad = d ? d.params.lltv : 0n;

  const nextColl = mode === "withdraw" ? posColl - collAmt : posColl + (mode === "borrow" ? collAmt : 0n);
  const nextDebt = mode === "borrow" ? debt + loanAmt : mode === "repay" ? (loanAmt >= debt ? 0n : debt - loanAmt) : debt;
  const nextValue = d ? collateralValue(nextColl < 0n ? 0n : nextColl, d.price) : 0n;
  const nextMax = (nextValue * lltvWad) / 10n ** 18n;
  const nextHf = nextDebt > 0n && nextMax > 0n ? Number((nextMax * 10_000n) / nextDebt) / 10_000 : undefined;
  const guardMax = (nextMax * BigInt(Math.round(GUARD * 1000))) / 1000n;
  const safeBorrow = guardMax > debt ? guardMax - debt : 0n;
  const liqPrice = d && nextColl > 0n && nextDebt > 0n ? Number(nextDebt) / 1e6 / ((Number(nextColl) / 10 ** dec) * d.lltv) : undefined;
  const usdPrice = d ? Number((d.price * 10n ** BigInt(dec)) / 10n ** 36n) / 1e6 : 0;
  const refresh = () => { setColl(""); setLoan(""); m.refetch(); b.refetch(); };

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (mode === "borrow") {
    if (!collAmt && !loanAmt) reason = "Enter collateral, a loan amount, or both.";
    else if (walletColl !== undefined && collAmt > walletColl) reason = `Not enough ${key}.`;
    else if (loanAmt > 0n && nextDebt > guardMax) reason = `Above NeroX's safety limit (80% of LLTV). Borrow at most ${fmtAmt(safeBorrow, "NRX")} with this collateral.`;
    else if (d && loanAmt > d.liquidity) reason = "Not enough NRX liquidity in this market.";
  } else if (mode === "repay") {
    if (!loanAmt) reason = "Enter an amount.";
    else if (debt === 0n) reason = "No loan to repay.";
    else if (b.data && Math.min(Number(loanAmt), Number(debt)) > Number(b.data.nrx)) reason = "Not enough NRX.";
  } else {
    if (!collAmt) reason = "Enter an amount.";
    else if (collAmt > posColl) reason = "More than your posted collateral.";
    else if (nextDebt > 0n && nextDebt > guardMax) reason = "This would push the loan above the 80% safety limit. Repay first.";
  }

  const p = marketParams(key);
  const morpho = contract("base", "Morpho");
  const submit = () => {
    if (mode === "borrow")
      return tx.run({ title: `Borrow NRX against ${key}`, chain: "base", total: collAmt > 0n ? 2 : 1, onDone: refresh }, async (h) => {
        const calls = [];
        if (collAmt > 0n) calls.push({ params: { address: contract("base", key), abi: MockERC20Abi, functionName: "approve", args: [morpho, collAmt] }, label: `Approve exact ${key}` });
        // Collateral and borrow in one transaction (Bundler3-style).
        calls.push({ params: { address: morpho, abi: MorphoBlueLiteAbi, functionName: "supplyCollateralAndBorrow", args: [p, collAmt, loanAmt, address] }, label: loanAmt > 0n ? "Post collateral and borrow" : "Post collateral" });
        await h.writeAll(calls);
      });
    if (mode === "repay")
      return tx.run({ title: "Repay NRX", chain: "base", total: 2, onDone: refresh }, async (h) => {
        const full = loanAmt >= debt;
        let shares = 0n;
        if (full) {
          const id = await publicClients.base.readContract({ address: morpho, abi: MorphoBlueLiteAbi, functionName: "id", args: [p] });
          const pos = await publicClients.base.readContract({ address: morpho, abi: MorphoBlueLiteAbi, functionName: "position", args: [id, address!] });
          shares = (pos as readonly bigint[])[1];
        }
        const approveAmt = full ? debt + debt / 1000n + 1_000n : loanAmt; // small headroom for interest accrued while signing
        await h.writeAll([
          { params: { address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [morpho, approveAmt] }, label: "Approve exact NRX" },
          { params: { address: morpho, abi: MorphoBlueLiteAbi, functionName: "repay", args: full ? [p, 0n, shares, address] : [p, loanAmt, 0n, address] }, label: full ? "Repay in full" : "Repay" },
        ]);
      });
    return tx.run({ title: `Withdraw ${key}`, chain: "base", total: 1, onDone: refresh }, async (h) => {
      await h.write({ address: morpho, abi: MorphoBlueLiteAbi, functionName: "withdrawCollateral", args: [p, collAmt, address, address] }, "Withdraw collateral");
    });
  };

  const hf = d?.position.health;
  const low = hf !== undefined && hf < 1.2;
  const used = nextMax > 0n ? Number((nextDebt * 10_000n) / nextMax) / 10_000 : 0;

  return (
    <>
      <PageHead title="Borrow NRX" sub="Post cbBTC or wstETH and borrow NRX. Borrower interest funds the sNRX vault." chainNote={<>Acts on <strong>Base (local)</strong> — NeroX's Morpho markets. Morpho on Ethereum and Venus follow in the medium phase.</>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="seg" role="group" aria-label="Market">
          {(["cbBTC", "wstETH"] as MarketKey[]).map((k) => (
            <button key={k} aria-pressed={key === k} onClick={() => { setKey(k); tx.reset(); }}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card"><Stat label="LLTV" value={d ? pct(d.lltv, 1) : "—"} sub="Liquidation loan-to-value" /></div>
        <div className="card"><Stat label="Borrow APR" value={pct(d?.borrowApr)} sub={d ? `Utilisation ${pct(d.util, 1)}` : undefined} /></div>
        <div className="card"><Stat label={`${key} price`} value={d ? `${fmtNum(usdPrice)} USD` : "—"} sub="Oracle (Chainlink in production)" /></div>
        <div className="card"><Stat label="Liquidity" value={fmtAmt(d?.liquidity, "NRX", 6, 0)} /></div>
      </div>
      <div className="grid split">
        <div className="card-lg stack">
          <Tabs value={mode} onChange={(x) => { setMode(x); setColl(""); setLoan(""); tx.reset(); }} items={[{ id: "borrow", label: "Borrow" }, { id: "repay", label: "Repay" }, { id: "withdraw", label: "Withdraw collateral" }]} />
          {mode !== "repay" && (
            <AmountInput id="coll" label={mode === "borrow" ? `Add ${key} collateral` : `Withdraw ${key}`} unit={key} value={coll} onChange={setColl} max={mode === "borrow" ? walletColl : posColl} maxDecimals={dec} />
          )}
          {mode !== "withdraw" && (
            <AmountInput id="loan" label={mode === "borrow" ? "Borrow" : "Repay"} unit="NRX" value={loan} onChange={setLoan} max={mode === "borrow" ? safeBorrow : debt} />
          )}
          <div>
            <Kv k="Health factor after" v={nextHf === undefined ? "—" : `${nextHf < 1.2 ? "! " : ""}${fmtNum(nextHf)}`} tone={nextHf !== undefined && nextHf < 1.2 ? "danger" : ""} />
            <Kv k="Liquidation price" v={liqPrice ? `${fmtNum(liqPrice)} USD per ${key}` : "—"} />
            <Kv k="Max safe borrow (80% of LLTV)" v={fmtAmt(safeBorrow, "NRX")} />
          </div>
          <ActionButton onClick={submit} reason={tx.state.busy ? null : reason} busy={tx.state.busy}>
            {mode === "borrow" ? (loanAmt > 0n ? "Borrow NRX" : "Post collateral") : mode === "repay" ? "Repay NRX" : "Withdraw collateral"}
          </ActionButton>
          <TxStatus state={tx.state} />
        </div>
        <div className="stack-3">
          <div className="card stack">
            <h2>Your position</h2>
            <Kv k="Collateral" v={`${fmt(posColl, dec, 4)} ${key}`} />
            <Kv k="Debt" v={fmtAmt(debt, "NRX")} />
            <Kv k="Health factor" v={hf === undefined ? "—" : `${low ? "! " : ""}${fmtNum(hf)}`} tone={low ? "danger" : ""} />
            <div className="stack-1">
              <div className="between small"><span>Borrowing power used</span><span className="mono">{pct(used, 1)}</span></div>
              <Bar value={used} tone={used > GUARD ? "danger" : undefined} />
            </div>
          </div>
          {low && (
            <Notice tone="danger">
              <strong>Liquidation risk.</strong> Health factor <span className="mono">{fmtNum(hf)}</span>. Below 1.00 anyone can repay part of this loan and
              take collateral at a discount. Repay NRX or add collateral.
            </Notice>
          )}
          <Notice>
            Liquidation happens when the health factor falls below 1.00, i.e. debt exceeds collateral value × LLTV. NeroX blocks loans above 80% of LLTV by
            default. Every action is simulated before you sign.
          </Notice>
        </div>
      </div>
    </>
  );
}
