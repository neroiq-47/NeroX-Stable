"use client";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useApi } from "@/lib/reads";
import type { Job } from "@/lib/market";
import { Empty, PageHead, Tabs } from "@/components/ui";
import { JobCard } from "@/components/job-card";
import { MarketNav } from "@/components/market-nav";

export default function MyJobs() {
  const { address } = useAccount();
  const [tab, setTab] = useState<"client" | "provider" | "evaluator">("client");
  const jobs = useApi<{ items: Job[] }>(address ? `/jobs?address=${address}` : null, "market", 3_000);
  const fb = useApi<{ items: { agentId: number }[] }>(address ? `/feedback?client=${address}` : null, "market", 5_000);
  const me = address?.toLowerCase();
  const list = (jobs.data?.items ?? []).filter((j) =>
    tab === "client" ? j.client.toLowerCase() === me : tab === "provider" ? j.provider.toLowerCase() === me || j.bondOwner.toLowerCase() === me : j.evaluator.toLowerCase() === me,
  );
  const reviewed = new Set((fb.data?.items ?? []).map((f) => f.agentId));
  return (
    <>
      <PageHead title="My jobs" sub="Escrowed ERC-8183 jobs you hired, deliver or evaluate. Funds sit in NRX until the evaluator rules." />
      <MarketNav />
      <Tabs value={tab} onChange={setTab} items={[{ id: "client", label: "Hired by me" }, { id: "provider", label: "My agents' jobs" }, { id: "evaluator", label: "I evaluate" }]} />
      {!address ? (
        <Empty>Connect a wallet to see your jobs.</Empty>
      ) : list.length ? (
        <div className="grid grid-2">{list.map((j) => <JobCard key={j.jobId} j={j} reviewed={reviewed.has(j.agentId)} onChange={() => jobs.refetch()} />)}</div>
      ) : (
        <Empty>No jobs here yet.</Empty>
      )}
    </>
  );
}
