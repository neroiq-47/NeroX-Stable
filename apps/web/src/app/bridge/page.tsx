"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useApp } from "@/lib/app-state";
import { CHAINS, CHAIN_KEYS, DEPLOYMENT, SERVICES, contract, type ChainKey } from "@/lib/config";
import { useApi, useBalances, useProtocol, useRead } from "@/lib/reads";
import { publicClients } from "@/lib/clients";
import { useTx } from "@/lib/tx";
import { MockERC20Abi, NeroTokenPoolAbi } from "@/lib/abis";
import { ago, fmtAmt, parseAmount, short } from "@/lib/format";
import { ActionButton, AmountInput, ArrowIcon, Empty, Kv, Notice, PageHead, PausedNotice, TxStatus } from "@/components/ui";
import { formatEther } from "viem";

type Msg = { messageId: string; sourceChain: ChainKey; destChain: ChainKey; amount: string; status: string; sentAt: number; executedAt?: number; sourceTx: string; destTx?: string; attestations?: string[]; receiver: string };
const STEPS = ["SENT", "FINALIZED", "COMMITTED", "EXECUTED"];
const STEP_LABEL: Record<string, string> = { SENT: "Burned on source", FINALIZED: "Source finalised", COMMITTED: "Committee attested (2 of 3)", EXECUTED: "Minted on destination" };

function useLane(from: ChainKey, to: ChainKey) {
  return useRead(["lane", from, to], async () => {
    const sel = (k: ChainKey) => BigInt(DEPLOYMENT.chains[k].ccipSelector);
    const [fee, out, inn] = await Promise.all([
      publicClients[from].readContract({ address: contract(from, "TokenPool"), abi: NeroTokenPoolAbi, functionName: "getFee", args: [sel(to)] }),
      publicClients[from].readContract({ address: contract(from, "TokenPool"), abi: NeroTokenPoolAbi, functionName: "outboundHeadroom", args: [sel(to)] }),
      publicClients[to].readContract({ address: contract(to, "TokenPool"), abi: NeroTokenPoolAbi, functionName: "inboundHeadroom", args: [sel(from)] }),
    ]);
    return { fee: fee as bigint, outbound: out as bigint, inbound: inn as bigint, headroom: (out as bigint) < (inn as bigint) ? (out as bigint) : (inn as bigint) };
  });
}

export default function BridgePage() {
  const { chain, setChain } = useApp();
  const { address } = useAccount();
  const from = chain;
  const to: ChainKey = CHAIN_KEYS.find((k) => k !== from)!;
  const [value, setValue] = useState("");
  const [receiver, setReceiver] = useState("");
  const b = useBalances(from, address);
  const p = useProtocol(from);
  const lane = useLane(from, to);
  const msgs = useApi<{ items: Msg[] }>(address ? `/messages?address=${address}` : null, "relayer", 2_000);
  const tx = useTx();
  const amount = parseAmount(value);
  const dest = (receiver || address) as `0x${string}` | undefined;
  const validReceiver = !receiver || /^0x[0-9a-fA-F]{40}$/.test(receiver);

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (!amount) reason = "Enter an amount.";
  else if (p.data?.poolPaused || p.data?.nrxPaused) reason = "Contract paused.";
  else if (!validReceiver) reason = "Receiver must be a 0x address.";
  else if (b.data && amount > b.data.nrx) reason = "Not enough NRX.";
  else if (lane.data && amount > lane.data.headroom) reason = `This lane can carry ${fmtAmt(lane.data.headroom, "NRX")} right now (rate limit). Send less or wait for it to refill.`;
  else if (b.data && lane.data && b.data.eth < lane.data.fee) reason = "Not enough ETH for the bridge fee.";

  const submit = () =>
    tx.run({ title: `Bridge NRX to ${CHAINS[to].name}`, chain: from, total: 2, onDone: () => { setValue(""); b.refetch(); lane.refetch(); msgs.refetch(); } }, async (h) => {
      const pool = contract(from, "TokenPool");
      await h.writeAll([
        { params: { address: contract(from, "NRX"), abi: MockERC20Abi, functionName: "approve", args: [pool, amount] }, label: "Approve exact NRX" },
        { params: { address: pool, abi: NeroTokenPoolAbi, functionName: "ccipSend", args: [BigInt(DEPLOYMENT.chains[to].ccipSelector), dest, amount], value: lane.data!.fee }, label: "Burn and send" },
      ]);
    });

  return (
    <>
      <PageHead title="Bridge NRX" sub="Move NRX between chains. One supply: NRX is burned here and minted there over a CCIP lane." chainNote={<>From <strong>{CHAINS[from].name}</strong> to <strong>{CHAINS[to].name}</strong>. BNB Chain joins in the medium phase.</>} />
      <div className="grid split">
        <div className="card-lg stack">
          <div className="row-2">
            <div className="stack-1" style={{ flex: 1 }}>
              <span className="label">From</span>
              <span>{CHAINS[from].name}</span>
            </div>
            <button className="btn btn-sm" onClick={() => setChain(to)} aria-label="Swap direction">
              <ArrowIcon /> Swap
            </button>
            <div className="stack-1" style={{ flex: 1, textAlign: "right" }}>
              <span className="label">To</span>
              <span>{CHAINS[to].name}</span>
            </div>
          </div>
          {(p.data?.poolPaused || p.data?.nrxPaused) && <PausedNotice what="The bridge lane" />}
          <AmountInput id="bridge-amt" label="Amount" unit="NRX" value={value} onChange={setValue} max={b.data?.nrx} />
          <div className="field">
            <label htmlFor="recv">Receiver on {CHAINS[to].name}</label>
            <input id="recv" className="input mono" placeholder={address ?? "0x…"} value={receiver} onChange={(e) => setReceiver(e.target.value.trim())} />
            <span className="small">Leave empty to send to your own address.</span>
          </div>
          <div>
            <Kv k="CCIP fee" v={lane.data ? `${formatEther(lane.data.fee)} ETH` : "—"} />
            <Kv k="Lane headroom (rate limit)" v={fmtAmt(lane.data?.headroom, "NRX")} />
            <Kv k="Estimated time" v="~10 s local · ~20 min on mainnet" />
          </div>
          <ActionButton onClick={submit} reason={tx.state.busy ? null : reason} busy={tx.state.busy}>
            Bridge NRX
          </ActionButton>
          <TxStatus state={tx.state} />
        </div>
        <div className="stack-3">
          <div className="card stack">
            <h2>Your transfers</h2>
            {msgs.data?.items.length ? (
              msgs.data.items.slice(0, 6).map((m) => {
                const idx = STEPS.indexOf(m.status);
                return (
                  <div key={m.messageId} className="stack-1" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 12 }}>
                    <div className="between">
                      <span className="mono">{fmtAmt(BigInt(m.amount), "NRX")}</span>
                      <span className="small">{CHAINS[m.sourceChain]?.name} → {CHAINS[m.destChain]?.name} · {ago(m.sentAt)}</span>
                    </div>
                    <div className="steps">
                      {STEPS.map((s, i) => (
                        <div className="step" key={s}>
                          <span className={`dot ${i < idx || m.status === "EXECUTED" ? "" : i === idx + 1 ? "live" : "muted"}`} style={{ marginTop: 8 }} aria-hidden />
                          <span className={i <= idx ? "" : "muted"}>{STEP_LABEL[s]}</span>
                        </div>
                      ))}
                    </div>
                    <span className="small mono">Message {short(m.messageId, 6)}</span>
                    {m.status === "FAILED" && <span className="small danger">! Failed — the relayer will not retry. Contact support with the message ID.</span>}
                  </div>
                );
              })
            ) : (
              <Empty>No transfers yet.</Empty>
            )}
            <a className="small" href={`${SERVICES.relayer}/messages?address=${address ?? ""}`} target="_blank" rel="noreferrer">Raw message status (CCIP Explorer stand-in)</a>
          </div>
          <Notice>
            Bridging uses burn/mint with per-lane rate limits, and minting needs 2 of 3 independent attestations. A single forged message cannot mint
            NRX — the failure behind the April 2026 bridge drain.
          </Notice>
        </div>
      </div>
    </>
  );
}
