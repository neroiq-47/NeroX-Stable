"use client";
import { useAccount } from "wagmi";
import { contract } from "@/lib/config";
import { useApi, useBalances } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { NeroJobsAbi } from "@/lib/abis";
import type { Job } from "@/lib/market";
import { fmtAmt, short } from "@/lib/format";
import { ActionButton, Empty, Kv, Notice, PageHead, Stat, TxStatus } from "@/components/ui";
import { JobCard } from "@/components/job-card";
import { MarketNav } from "@/components/market-nav";
import { BondPanel } from "@/components/bond-panel";

type Ev = { address: string; bond: { value: string; free: string }; judged: number; completed: number; rejected: number; pending: number };

export default function EvaluatorPage() {
  const { address } = useAccount();
  const pool = useApi<{ items: Ev[]; contractEvaluators: string[] }>("/evaluators", "market", 5_000);
  const jobs = useApi<{ items: Job[] }>(address ? `/jobs?address=${address}` : null, "market", 3_000);
  const b = useBalances("base", address);
  const tx = useTx();
  const me = pool.data?.items.find((e) => e.address.toLowerCase() === address?.toLowerCase());
  const mine = (jobs.data?.items ?? []).filter((j) => j.evaluator.toLowerCase() === address?.toLowerCase());
  const pending = mine.filter((j) => j.status === "Submitted" || j.status === "Funded");
  const join = () => tx.run({ title: "Join evaluator pool", chain: "base", total: 1, onDone: () => pool.refetch() }, async (h) => {
    await h.write({ address: contract("base", "NeroJobs"), abi: NeroJobsAbi, functionName: "joinEvaluatorPool", args: [] }, "Join pool");
  });
  return (
    <>
      <PageHead title="Evaluator dashboard" sub="Pool evaluators are bonded in sNRX and picked at random for jobs. They are slashed for provably wrong rulings." />
      <MarketNav />
      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <div className="card"><Stat label="Pool size" value={pool.data?.items.length ?? "—"} /></div>
        <div className="card"><Stat label="Your status" value={me ? "In pool" : "Not in pool"} tone={me ? "signal" : undefined} /></div>
        <div className="card"><Stat label="Waiting on you" value={pending.length} tone={pending.length ? "brand" : undefined} /></div>
        <div className="card"><Stat label="Your sNRX (wallet)" value={fmtAmt(b.data?.snrxValue, "NRX")} tone="yield" /></div>
      </div>
      <div className="grid split">
        <div className="stack-3">
          <h2>Jobs assigned to you</h2>
          {!address ? <Empty>Connect a wallet.</Empty> : mine.length ? mine.map((j) => <JobCard key={j.jobId} j={j} onChange={() => jobs.refetch()} />) : <Empty>No jobs assigned yet. Pool evaluators are picked at random when a buyer chooses the pool.</Empty>}
        </div>
        <div className="stack-3">
          {!me && (
            <div className="card stack">
              <h2>Join the pool</h2>
              <p className="small">Requires at least 500 NRX of free sNRX bond. You earn 1.5% of each job's budget you rule on.</p>
              <ActionButton onClick={join} busy={tx.state.busy} reason={!address ? "Connect a wallet to continue." : null}>Join evaluator pool</ActionButton>
              <TxStatus state={tx.state} />
            </div>
          )}
          <BondPanel />
          <div className="card stack-1">
            <h2>Pool members</h2>
            {pool.data?.items.map((e) => <Kv key={e.address} k={short(e.address)} v={`${fmtAmt(BigInt(e.bond.value), "NRX", 6, 0)} · ${e.completed}✓ ${e.rejected}✗`} />)}
            <p className="small">Contract evaluator: <span className="mono">{short(pool.data?.contractEvaluators[0])}</span></p>
          </div>
          <Notice>The market blocks any job where the evaluator is the provider or the agent's owner.</Notice>
        </div>
      </div>
    </>
  );
}
