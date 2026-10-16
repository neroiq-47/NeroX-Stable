"use client";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import { parseEventLogs } from "viem";
import { SERVICES, contract } from "@/lib/config";
import { publicClients } from "@/lib/clients";
import { useApi } from "@/lib/reads";
import { useTx } from "@/lib/tx";
import { AgentSaleAbi, IdentityRegistryAbi } from "@/lib/abis";
import { CATEGORIES, type Agent, type AgentDetail } from "@/lib/market";
import { fmt, fmtAmt, parseAmount, short } from "@/lib/format";
import { ActionButton, Empty, Kv, Notice, PageHead, TxStatus } from "@/components/ui";
import { MarketNav } from "@/components/market-nav";
import { BondPanel } from "@/components/bond-panel";

function Register({ onDone }: { onDone: () => void }) {
  const { address } = useAccount();
  const tx = useTx();
  const [f, setF] = useState({ name: "", description: "", category: "data", skills: "", price: "0.01", a2aUrl: "", mcpUrl: "", jobTitle: "", jobBudget: "", jobHours: "24" });
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<number | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setErr("");
    const body = {
      name: f.name, description: f.description, category: f.category, price: f.price,
      skills: f.skills.split(",").map((s) => s.trim()).filter(Boolean),
      a2aUrl: f.a2aUrl || undefined, mcpUrl: f.mcpUrl || undefined,
      jobs: f.jobTitle && f.jobBudget ? [{ title: f.jobTitle, budget: f.jobBudget, hours: Number(f.jobHours) }] : [],
    };
    const r = await fetch(`${SERVICES.market}/registrations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) return setErr(j.error);
    await tx.run({ title: "Register agent", chain: "base", total: 1, onDone }, async (h) => {
      const hash = await h.write({ address: contract("base", "IdentityRegistry"), abi: IdentityRegistryAbi, functionName: "register", args: [j.uri] }, "Mint ERC-8004 identity");
      const rc = await publicClients.base.getTransactionReceipt({ hash });
      const [ev] = parseEventLogs({ abi: IdentityRegistryAbi, logs: rc.logs, eventName: "Registered" });
      setCreated(Number((ev.args as { agentId: bigint }).agentId));
    });
  };
  const ok = f.name && f.description && parseAmount(f.price) !== undefined;
  return (
    <div className="card-lg stack">
      <h2>List a new agent</h2>
      <p className="small">NeroX writes an ERC-8004 registration file for you; you mint the identity token, so you own the listing. The agent wallet starts as your address.</p>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="n">Name</label><input id="n" className="input" value={f.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="c">Category</label>
          <select id="c" className="input" value={f.category} onChange={set("category")}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
      </div>
      <div className="field"><label htmlFor="d">Description</label><textarea id="d" className="input" value={f.description} onChange={set("description")} /></div>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="s">Skills (comma separated)</label><input id="s" className="input" value={f.skills} onChange={set("skills")} /></div>
        <div className="field"><label htmlFor="p">Price per call</label><div className="amount"><input id="p" className="input" value={f.price} onChange={set("price")} /><span className="unit">NRX</span></div></div>
      </div>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="a2a">A2A Agent Card URL (optional)</label><input id="a2a" className="input mono" value={f.a2aUrl} onChange={set("a2aUrl")} placeholder="https://…/.well-known/agent-card.json" /></div>
        <div className="field"><label htmlFor="mcp">MCP server URL (optional)</label><input id="mcp" className="input mono" value={f.mcpUrl} onChange={set("mcpUrl")} /></div>
      </div>
      <div className="grid grid-3">
        <div className="field"><label htmlFor="jt">Fixed-price job (optional)</label><input id="jt" className="input" value={f.jobTitle} onChange={set("jobTitle")} placeholder="Audit this contract" /></div>
        <div className="field"><label htmlFor="jb">Job budget (NRX)</label><input id="jb" className="input mono" value={f.jobBudget} onChange={set("jobBudget")} /></div>
        <div className="field"><label htmlFor="jh">Delivery (hours)</label><input id="jh" className="input mono" value={f.jobHours} onChange={set("jobHours")} /></div>
      </div>
      <Notice>Excluded at launch: financial advice, trading signals, medical, and anything on the prohibited-use list. Agent Cards are treated as data; the market never executes instructions from them.</Notice>
      <ActionButton onClick={submit} busy={tx.state.busy} reason={!address ? "Connect a wallet to continue." : !ok ? "Add a name, description and price." : null}>Register agent</ActionButton>
      <TxStatus state={tx.state} />
      {err && <Notice tone="danger">{err}</Notice>}
      {created !== null && <Notice>Agent <span className="mono">#{created}</span> is registered. The market indexes it within seconds: <Link href={`/market/agent/${created}`}>view listing</Link>.</Notice>}
    </div>
  );
}

function OwnedAgent({ a, onChange }: { a: Agent; onChange: () => void }) {
  const tx = useTx();
  const [price, setPrice] = useState(a.sale ? fmt(BigInt(a.sale.price), 6, 0).replace(/,/g, "") : "");
  const d = useApi<AgentDetail>(`/agents/${a.agentId}`, "market", 8_000);
  const sale = contract("base", "AgentSale");
  const amt = parseAmount(price);
  const list = () => tx.run({ title: "List agent for sale", chain: "base", total: 2, onDone: onChange }, async (h) => {
    await h.write({ address: contract("base", "IdentityRegistry"), abi: IdentityRegistryAbi, functionName: "approve", args: [sale, BigInt(a.agentId)] }, "Approve this agent token");
    await h.write({ address: sale, abi: AgentSaleAbi, functionName: "list", args: [BigInt(a.agentId), amt] }, "List");
  });
  const unlist = () => tx.run({ title: "Unlist agent", chain: "base", total: 1, onDone: onChange }, async (h) => {
    await h.write({ address: sale, abi: AgentSaleAbi, functionName: "unlist", args: [BigInt(a.agentId)] }, "Unlist");
  });
  const accept = (offerId: number) => tx.run({ title: "Accept offer", chain: "base", total: 2, onDone: onChange }, async (h) => {
    await h.write({ address: contract("base", "IdentityRegistry"), abi: IdentityRegistryAbi, functionName: "approve", args: [sale, BigInt(a.agentId)] }, "Approve this agent token");
    await h.write({ address: sale, abi: AgentSaleAbi, functionName: "acceptOffer", args: [BigInt(a.agentId), BigInt(offerId)] }, "Accept offer");
  });
  const offers = (d.data?.offers ?? []).filter((o) => o.active && o.expiresAt > Date.now());
  return (
    <div className="card stack">
      <div className="between">
        <Link href={`/market/agent/${a.agentId}`}><strong>{a.name}</strong></Link>
        <span className="chip mono">#{a.agentId}</span>
      </div>
      <Kv k="Revenue" v={fmtAmt(BigInt(a.stats.revenue), "NRX")} />
      <Kv k="Open jobs" v={a.stats.jobsOpen} />
      {a.sale ? (
        <div className="between"><span className="small">Listed at <span className="mono">{fmtAmt(BigInt(a.sale.price), "NRX", 6, 0)}</span></span><button className="btn btn-sm" onClick={unlist} disabled={tx.state.busy}>Unlist</button></div>
      ) : (
        <div className="row"><div className="amount" style={{ flex: 1 }}><input className="input" aria-label="Asking price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Asking price" /><span className="unit">NRX</span></div><button className="btn btn-sm" onClick={list} disabled={!amt || tx.state.busy}>List for sale</button></div>
      )}
      {offers.map((o) => (
        <div key={o.offerId} className="between small"><span>Offer from <span className="mono">{short(o.buyer)}</span>: <span className="mono">{fmtAmt(BigInt(o.amount), "NRX")}</span></span><button className="btn btn-sm" onClick={() => accept(o.offerId)} disabled={tx.state.busy || a.stats.jobsOpen > 0}>Accept</button></div>
      ))}
      <TxStatus state={tx.state} />
    </div>
  );
}

export default function SellPage() {
  const { address } = useAccount();
  const all = useApi<{ items: Agent[] }>("/agents?limit=500&sort=newest", "market", 4_000);
  const mine = (all.data?.items ?? []).filter((a) => a.owner.toLowerCase() === address?.toLowerCase());
  return (
    <>
      <PageHead title="Sell an agent" sub="List an agent, post a bond for hired work, and sell the whole agent if you want to." />
      <MarketNav />
      <div className="grid split">
        <div className="stack-3">
          <Register onDone={() => all.refetch()} />
          <h2>Your agents</h2>
          {!address ? <Empty>Connect a wallet.</Empty> : mine.length ? <div className="grid grid-2">{mine.map((a) => <OwnedAgent key={a.agentId} a={a} onChange={() => all.refetch()} />)}</div> : <Empty>You don&apos;t own any agents yet.</Empty>}
        </div>
        <div className="stack-3">
          <BondPanel />
          <Notice>Fees in the beta: 1% on x402 calls, 3% on completed jobs, 2.5% on agent sales. The first 100 verified sellers trade fee-free for 90 days.</Notice>
        </div>
      </div>
    </>
  );
}
