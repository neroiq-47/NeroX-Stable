"use client";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { keccak256, stringToHex, toHex } from "viem";
import { SERVICES, contract } from "@/lib/config";
import { useTx } from "@/lib/tx";
import { MockERC20Abi, NeroJobsAbi, ReputationRegistryAbi } from "@/lib/abis";
import { statusTone, type Job } from "@/lib/market";
import { ago, fmtAmt, short } from "@/lib/format";
import { Kv, TxStatus } from "./ui";

const reason32 = (s: string) => toHex(s.slice(0, 31), { size: 32 });

export function JobCard({ j, reviewed, onChange }: { j: Job; reviewed?: boolean; onChange?: () => void }) {
  const { address } = useAccount();
  const tx = useTx();
  const [text, setText] = useState("");
  const [score, setScore] = useState(90);
  const me = address?.toLowerCase();
  const isClient = me === j.client.toLowerCase();
  const isProvider = me === j.provider.toLowerCase();
  const isEvaluator = me === j.evaluator.toLowerCase();
  const expired = j.expiredAt > 0 && Date.now() > j.expiredAt;
  const jobs = contract("base", "NeroJobs");
  const id = BigInt(j.jobId);
  const done = () => onChange?.();

  const act = (title: string, total: number, fn: Parameters<typeof tx.run>[1]) => tx.run({ title, chain: "base", total, onDone: done }, fn);
  const fund = () => act("Fund job", 2, async (h) => {
    const fee = j.kind === "Pool" ? (BigInt(j.budget) * 150n) / 10_000n : 0n;
    await h.write({ address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [jobs, BigInt(j.budget) + fee] }, "Approve exact NRX");
    await h.write({ address: jobs, abi: NeroJobsAbi, functionName: "fund", args: [id, BigInt(j.budget)] }, "Fund escrow");
  });
  const call = (title: string, functionName: string, args: unknown[]) => act(title, 1, async (h) => { await h.write({ address: jobs, abi: NeroJobsAbi, functionName, args }, title); });
  const review = () => act("Leave a review", 1, async (h) => {
    await h.write({ address: contract("base", "ReputationRegistry"), abi: ReputationRegistryAbi, functionName: "giveFeedback", args: [BigInt(j.agentId), score, reason32("job"), reason32(""), "", keccak256(stringToHex(text || "review"))] }, "Write review");
  });

  return (
    <div className="card stack">
      <div className="between">
        <div className="stack-1" style={{ gap: 2 }}>
          <strong>Job #{j.jobId} · <Link href={`/market/agent/${j.agentId}`}>{j.agentName ?? `Agent #${j.agentId}`}</Link></strong>
          <span className="small">{j.description}</span>
        </div>
        <span className={`chip ${statusTone(j.status)}`}>{j.status}</span>
      </div>
      <div className="grid grid-2" style={{ gap: 0, columnGap: 24 }}>
        <Kv k="Budget" v={fmtAmt(BigInt(j.budget), "NRX")} />
        <Kv k="Evaluator" v={`${j.kind} · ${short(j.evaluator)}`} />
        <Kv k="Client" v={isClient ? "You" : short(j.client)} />
        <Kv k="Deadline" v={j.expiredAt ? (expired ? "passed" : `in ${Math.round((j.expiredAt - Date.now()) / 3600_000)} h`) : "—"} />
      </div>
      {j.events.length > 0 && (
        <div className="row small" style={{ gap: 12 }}>
          {j.events.map((e, i) => <span key={i}>{e.type}{e.reason ? ` (“${e.reason}”)` : ""}{e.slashed && e.slashed !== "0" ? ` · bond slashed ${fmtAmt(BigInt(e.slashed), "NRX")}` : ""} · {ago(e.time)}</span>)}
        </div>
      )}
      {["Submitted", "Completed", "Rejected"].includes(j.status) && j.deliverable !== `0x${"0".repeat(64)}` && (
        <span className="small">Deliverable hash <span className="mono">{short(j.deliverable, 8)}</span> · <a href={`${SERVICES.agents}/deliverables/${j.jobId}`} target="_blank" rel="noreferrer">open file</a></span>
      )}
      <div className="row">
        {isClient && j.status === "Open" && <><button className="btn btn-primary btn-sm" onClick={fund} disabled={tx.state.busy}>Fund escrow</button><button className="btn btn-sm" onClick={() => call("Cancel job", "reject", [id, reason32("cancelled")])} disabled={tx.state.busy}>Cancel</button></>}
        {(j.status === "Funded" || j.status === "Submitted") && expired && <button className="btn btn-sm" onClick={() => call("Claim refund", "claimRefund", [id])} disabled={tx.state.busy}>Claim refund</button>}
        {isEvaluator && j.status === "Submitted" && <button className="btn btn-primary btn-sm" onClick={() => call("Complete job", "complete", [id, reason32(text || "meets brief")])} disabled={tx.state.busy}>Complete and release NRX</button>}
        {isEvaluator && (j.status === "Submitted" || j.status === "Funded") && <button className="btn btn-danger btn-sm" onClick={() => call("Reject job", "reject", [id, reason32(text || "does not meet brief")])} disabled={tx.state.busy}>Reject and refund</button>}
        {isProvider && j.status === "Funded" && <button className="btn btn-primary btn-sm" onClick={() => call("Submit deliverable", "submit", [id, keccak256(stringToHex(text || `delivery for job ${j.jobId}`))])} disabled={tx.state.busy}>Submit deliverable</button>}
      </div>
      {(isEvaluator && ["Submitted", "Funded"].includes(j.status)) || (isProvider && j.status === "Funded") ? (
        <input className="input" placeholder={isProvider ? "Deliverable (hashed on-chain)" : "Reason (optional, 31 chars)"} value={text} onChange={(e) => setText(e.target.value)} />
      ) : null}
      {isClient && j.status === "Completed" && !reviewed && (
        <div className="row-2">
          <label className="small" htmlFor={`score-${j.jobId}`}>Your review</label>
          <input id={`score-${j.jobId}`} type="range" min={0} max={100} value={score} onChange={(e) => setScore(Number(e.target.value))} style={{ accentColor: "var(--brand)" }} />
          <span className="mono">{score}/100</span>
          <button className="btn btn-sm" onClick={review} disabled={tx.state.busy}>Post to ERC-8004</button>
        </div>
      )}
      {isClient && j.status === "Completed" && reviewed && <span className="small signal">Reviewed — counts as a paid review.</span>}
      <TxStatus state={tx.state} />
    </div>
  );
}
