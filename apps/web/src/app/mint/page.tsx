"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useApp } from "@/lib/app-state";
import { CHAINS, contract } from "@/lib/config";
import { useBalances, useProtocol } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { NeroPSMAbi } from "@/lib/abis";
import { fmtAmt, parseAmount } from "@/lib/format";
import { ActionButton, AmountInput, Kv, Notice, PageHead, PausedNotice, Tabs, TxStatus } from "@/components/ui";

export default function MintPage() {
  const { chain } = useApp();
  const { address } = useAccount();
  const [mode, setMode] = useState<"mint" | "redeem">("mint");
  const [value, setValue] = useState("");
  const p = useProtocol(chain);
  const b = useBalances(chain, address);
  const tx = useTx();
  const amount = parseAmount(value);
  const d = p.data;

  const fee = amount && d ? (amount * (mode === "mint" ? d.mintFeeBps : d.redeemFeeBps)) / 10_000n : 0n;
  const out = amount ? amount - fee : undefined;
  const balance = mode === "mint" ? b.data?.usdc : b.data?.nrx;

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (!amount) reason = "Enter an amount.";
  else if (d && (d.psmPaused || d.nrxPaused)) reason = "Contract paused.";
  else if (balance !== undefined && amount > balance) reason = `Not enough ${mode === "mint" ? "USDC" : "NRX"}.`;
  else if (d && mode === "mint" && amount > d.remMint) reason = `Above today's remaining mint cap of ${fmtAmt(d.remMint, "NRX")}.`;
  else if (d && mode === "mint" && out! > d.remGlobal) reason = `Above the beta supply cap. ${fmtAmt(d.remGlobal, "NRX")} left.`;
  else if (d && mode === "redeem" && amount > d.remRedeem) reason = `Above today's remaining redeem cap of ${fmtAmt(d.remRedeem, "NRX")}.`;
  else if (d && mode === "redeem" && amount > d.reserves) reason = `This chain's PSM holds ${fmtAmt(d.reserves, "USDC")}. Bridge NRX to redeem the rest elsewhere.`;

  const submit = () =>
    tx.run({ title: mode === "mint" ? "Mint NRX" : "Redeem NRX", chain, total: 2, onDone: () => { setValue(""); b.refetch(); p.refetch(); } }, async (h) => {
      const psm = contract(chain, "NeroPSM");
      const token = contract(chain, mode === "mint" ? "USDC" : "NRX");
      // Exact permit for this amount — never an unlimited approval.
      const sig = await h.permit(token, psm, amount!, `Sign ${mode === "mint" ? "USDC" : "NRX"} permit (no gas)`);
      await h.write(
        { address: psm, abi: NeroPSMAbi, functionName: mode === "mint" ? "mintWithPermit" : "redeemWithPermit", args: [amount, address, sig.deadline, sig.v, sig.r, sig.s] },
        mode === "mint" ? "Confirm mint" : "Confirm redeem",
      );
    });

  return (
    <>
      <PageHead
        title={mode === "mint" ? "Mint NRX" : "Redeem NRX"}
        sub={mode === "mint" ? "Swap USDC for NRX at 1:1. Redeem at any time." : "Swap NRX back to USDC at 1:1."}
        chainNote={<>Acts on <strong>{CHAINS[chain].name}</strong>. Change chain in the header.</>}
      />
      <div className="grid split">
        <div className="card-lg stack">
          <Tabs value={mode} onChange={(m) => { setMode(m); setValue(""); tx.reset(); }} items={[{ id: "mint", label: "Mint" }, { id: "redeem", label: "Redeem" }]} />
          {d && (d.psmPaused || d.nrxPaused) && <PausedNotice what="The PSM" />}
          <AmountInput id="amt" label={mode === "mint" ? "You pay" : "You redeem"} unit={mode === "mint" ? "USDC" : "NRX"} value={value} onChange={setValue} max={balance} />
          <div>
            <Kv k="You receive" v={fmtAmt(out, mode === "mint" ? "NRX" : "USDC")} tone="signal" />
            <Kv k="Rate" v={mode === "mint" ? "1 USDC = 1 NRX" : "1 NRX = 1 USDC"} />
            <Kv k="Fee" v={fmtAmt(fee, mode === "mint" ? "USDC" : "NRX")} />
            <Kv k={mode === "mint" ? "Daily mint cap remaining" : "Daily redeem cap remaining"} v={fmtAmt(mode === "mint" ? d?.remMint : d?.remRedeem, "NRX")} />
          </div>
          <ActionButton onClick={submit} reason={tx.state.busy ? null : reason} busy={tx.state.busy}>
            {mode === "mint" ? "Mint NRX" : "Redeem NRX"}
          </ActionButton>
          <TxStatus state={tx.state} />
          <p className="small">Two steps: a gasless permit signature for the exact amount, then one transaction.</p>
        </div>
        <div className="stack-3">
          <div className="card stack-1">
            <h2>Peg Stability Module</h2>
            <Kv k="USDC held on this chain" v={fmtAmt(d?.reserves, "USDC")} />
            <Kv k="NRX supply on this chain" v={fmtAmt(d?.supply, "NRX")} />
            <Kv k="Beta supply cap remaining" v={fmtAmt(d?.remGlobal, "NRX")} />
            <Kv k="Daily mint cap" v={fmtAmt(d?.dailyMintCap, "NRX")} />
          </div>
          <div className="card stack-1">
            <h2>Your balances</h2>
            <Kv k="USDC" v={fmtAmt(b.data?.usdc, "USDC")} />
            <Kv k="NRX" v={fmtAmt(b.data?.nrx, "NRX")} tone="signal" />
          </div>
          <Notice>
            NRX is backed 1:1 by USDC held in the PSM contract on each chain, and can be redeemed at any time. USDC
            issuer risk passes through to NRX.
          </Notice>
        </div>
      </div>
    </>
  );
}
