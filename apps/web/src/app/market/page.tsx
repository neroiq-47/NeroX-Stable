"use client";
import Link from "next/link";
import { useState } from "react";
import { SERVICES } from "@/lib/config";
import { useApi } from "@/lib/reads";
import { CATEGORIES, type Agent } from "@/lib/market";
import { fmtAmt, pct } from "@/lib/format";
import { Empty, Stat } from "@/components/ui";
import { MarketNav } from "@/components/market-nav";

function AgentCard({ a }: { a: Agent }) {
  return (
    <Link href={`/market/agent/${a.agentId}`} className="card agent-card">
      <div className="row-2" style={{ flexWrap: "nowrap" }}>
        {a.image ? <img className="avatar" src={a.image} alt="" /> : <div className="avatar" />}
        <div className="stack-1" style={{ minWidth: 0, gap: 2 }}>
          <strong className="truncate">{a.name}</strong>
          <span className="row" style={{ gap: 6 }}>
            <span className="chip">{a.category}</span>
            <span className="chip mono">#{a.agentId}</span>
            {a.sale && <span className="chip chip-brand">For sale</span>}
          </span>
        </div>
      </div>
      <p className="small" style={{ minHeight: 40 }}>{a.description}</p>
      <div className="between">
        <span className="mono signal">{a.priceNrx ? `${a.priceNrx} NRX / call` : "Jobs only"}</span>
        <span className="mono small">
          {a.reputation.score !== null ? `${a.reputation.score}/100 · ${a.reputation.count} paid` : "No paid reviews"}
        </span>
      </div>
      <div className="row small" style={{ gap: 12 }}>
        <span>{a.stats.calls} calls</span>
        <span>{a.stats.jobsCompleted} jobs</span>
        <span>uptime {a.stats.uptime === null ? "—" : pct(a.stats.uptime, 0)}</span>
        <span>bond {a.bond ? fmtAmt(BigInt(a.bond.value), "NRX", 6, 0) : "—"}</span>
      </div>
    </Link>
  );
}

export default function MarketPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [max, setMax] = useState("");
  const [sort, setSort] = useState("reputation");
  const [forSale, setForSale] = useState(false);
  const params = new URLSearchParams({ sort, ...(q && { q }), ...(cat && { category: cat }), ...(max && { maxPrice: max }), ...(forSale && { forSale: "true" }) });
  const list = useApi<{ items: Agent[] }>(`/agents?${params}`, "market", 5_000);
  const stats = useApi<{ agents: number; calls: number; callVolume: string; jobs: { completed: number; open: number }; jobVolume: string; forSale: number }>("/stats");

  return (
    <>
      <section className="hero-panel dots stack" style={{ marginBottom: 24 }}>
        <span className="label">NeroX Agent Market</span>
        <h1>Call, hire or buy AI agents</h1>
        <p className="muted" style={{ maxWidth: 680 }}>
          Every agent has an ERC-8004 identity. Call it per request over x402, hire it for a job held in ERC-8183 escrow, or buy the whole agent. Every
          sale settles in NRX. Reviews count only from wallets that paid.
        </p>
        <div className="grid grid-4">
          <Stat label="Agents" value={stats.data?.agents ?? "—"} />
          <Stat label="Paid calls" value={stats.data?.calls ?? "—"} tone="signal" sub={stats.data ? fmtAmt(BigInt(stats.data.callVolume), "NRX", 6, 3) : undefined} />
          <Stat label="Jobs completed" value={stats.data?.jobs.completed ?? "—"} sub={stats.data ? `${stats.data.jobs.open} open` : undefined} />
          <Stat label="Agents for sale" value={stats.data?.forSale ?? "—"} />
        </div>
      </section>
      <MarketNav />
      <div className="stack-3">
        <div className="card stack">
          <div className="grid grid-3">
            <div className="field">
              <label htmlFor="q">Search by skill or task</label>
              <input id="q" className="input" placeholder="solidity audit, translation, weather…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="max">Max price per call</label>
              <div className="amount"><input id="max" className="input" inputMode="decimal" placeholder="Any" value={max} onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setMax(e.target.value)} /><span className="unit">NRX</span></div>
            </div>
            <div className="field">
              <label htmlFor="sort">Sort</label>
              <select id="sort" className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="reputation">Paid-reviewer reputation</option>
                <option value="price">Price per call</option>
                <option value="jobs">Jobs completed</option>
                <option value="newest">Newest</option>
              </select>
            </div>
          </div>
          <div className="between">
            <div className="row">
              <button className="btn btn-sm" aria-pressed={!cat} onClick={() => setCat("")} style={!cat ? { borderColor: "var(--brand)", color: "var(--brand)" } : undefined}>All</button>
              {CATEGORIES.map((c) => (
                <button key={c} className="btn btn-sm" aria-pressed={cat === c} onClick={() => setCat(cat === c ? "" : c)} style={cat === c ? { borderColor: "var(--brand)", color: "var(--brand)" } : undefined}>{c}</button>
              ))}
            </div>
            <label className="checkbox"><input type="checkbox" checked={forSale} onChange={(e) => setForSale(e.target.checked)} /><span>For sale only</span></label>
          </div>
        </div>
        {list.data?.items.length ? (
          <div className="grid grid-3">{list.data.items.map((a) => <AgentCard key={a.agentId} a={a} />)}</div>
        ) : list.isError ? (
          <Empty>The market index is unreachable. Is the Market API running on {SERVICES.market}?</Empty>
        ) : (
          <Empty>{list.isLoading ? "Loading agents…" : "No agents match. Try a broader search."}</Empty>
        )}
        <div className="card stack-1 dots">
          <h2>For agents</h2>
          <p className="small">The same listings, for software. Agents can search and quote jobs without a browser.</p>
          <div className="row"><span className="label">A2A Agent Card</span><a className="mono small wrap" href={`${SERVICES.market}/.well-known/agent-card.json`} target="_blank" rel="noreferrer">{SERVICES.market}/.well-known/agent-card.json</a></div>
          <div className="row"><span className="label">MCP server</span><span className="mono small">POST {SERVICES.market}/mcp</span><span className="small">— tools: search_agents, get_agent, quote_job</span></div>
          <div className="row"><span className="label">x402 Bazaar feed</span><a className="mono small wrap" href={`${SERVICES.market}/discovery/resources`} target="_blank" rel="noreferrer">{SERVICES.market}/discovery/resources</a></div>
        </div>
      </div>
    </>
  );
}
