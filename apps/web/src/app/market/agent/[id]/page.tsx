"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useAccount, useSignTypedData, useSwitchChain } from "wagmi";
import { parseEventLogs, zeroAddress, type Address } from "viem";
import { wrapFetchWithPayment } from "@nerox/x402";
import { CHAINS, DEPLOYMENT, contract } from "@/lib/config";
import { useApi, useBalances, useProtocol } from "@/lib/reads";
import { chainNow, publicClients } from "@/lib/clients";
import { readableError, useTx } from "@/lib/tx";
import { AgentSaleAbi, MockERC20Abi, NeroJobsAbi } from "@/lib/abis";
import { x402Endpoint, type AgentDetail } from "@/lib/market";
import { ago, duration, fmt, fmtAmt, parseAmount, pct, short } from "@/lib/format";
import { ActionButton, AmountInput, Empty, Kv, Notice, Stat, Tabs, TxStatus } from "@/components/ui";
import { MarketNav } from "@/components/market-nav";

type Trace = { kind: string; status?: number; version?: number; authorization?: Record<string, string>; settlement?: { transaction: string } };

function CallPanel({ a }: { a: AgentDetail }) {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const [input, setInput] = useState("");
  const [trace, setTrace] = useState<Trace[]>([]);
  const [out, setOut] = useState<unknown>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const b = useBalances("base", address);
  const ep = x402Endpoint(a);
  const price = a.price ? BigInt(a.price) : 0n;

  const call = async () => {
    setBusy(true);
    setErr("");
    setOut(null);
    setTrace([]);
    try {
      if (chainId !== CHAINS.base.id) await switchChainAsync({ chainId: CHAINS.base.id });
      const pay = wrapFetchWithPayment(fetch, { address: address!, signTypedData: (args: Parameters<typeof signTypedDataAsync>[0]) => signTypedDataAsync(args) } as never, {
        maxAmount: price,
        acceptAsset: (asset, cid) => cid === CHAINS.base.id && asset.toLowerCase() === contract("base", "NRX").toLowerCase(),
        now: chainNow,
        onStep: (s) => setTrace((t) => [...t, s as Trace]),
      });
      const r = await pay(`${ep}?q=${encodeURIComponent(input)}`);
      const j = await r.json();
      if (r.status !== 200) throw new Error(j.error ?? `HTTP ${r.status}`);
      setOut(j.output);
      b.refetch();
    } catch (e) {
      setErr(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ep || !a.price) return <Notice>This agent takes jobs only. Use Hire.</Notice>;
  return (
    <div className="stack">
      <p className="small">Pay per request over x402. Your wallet signs a gasless NRX authorization for exactly <span className="mono">{a.priceNrx} NRX</span>; the NeroX facilitator settles it, then the agent answers.</p>
      <div className="field">
        <label htmlFor="call-in">Input ({(a.registration as { nerox?: { input?: string } }).nerox?.input ?? "query"})</label>
        <input id="call-in" className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a request" />
      </div>
      <Kv k="Price" v={`${a.priceNrx} NRX`} tone="signal" />
      <Kv k="Your NRX on Base" v={fmtAmt(b.data?.nrx, "NRX")} />
      <ActionButton onClick={call} busy={busy} reason={!address ? "Connect a wallet to continue." : b.data && b.data.nrx < price ? "Not enough NRX on Base. Mint some first." : null}>
        Call for {a.priceNrx} NRX
      </ActionButton>
      {trace.length > 0 && (
        <div className="steps" aria-live="polite">
          {trace.map((s, i) => (
            <div key={i} className="step">
              <span className="n">{i + 1}</span>
              <span>
                {s.kind === "request" && "Request sent without payment"}
                {s.kind === "challenge" && <>Agent answered <span className="mono">402 Payment Required</span> (v1 body + v2 header)</>}
                {s.kind === "signed" && <>You signed an EIP-3009 authorization (x402 v{s.version}) — no gas</>}
                {s.kind === "result" && (s.status === 200 ? <>Settled on Base · tx <span className="mono">{short(s.settlement?.transaction, 6)}</span> · <span className="mono">200 OK</span></> : <span className="danger">! {s.status}</span>)}
              </span>
            </div>
          ))}
        </div>
      )}
      {err && <Notice tone="danger"><strong>Call failed.</strong> {err}</Notice>}
      {out !== null && <pre className="code">{JSON.stringify(out, null, 2)}</pre>}
    </div>
  );
}

function HirePanel({ a }: { a: AgentDetail }) {
  const { address } = useAccount();
  const b = useBalances("base", address);
  const p = useProtocol("base");
  const tx = useTx();
  const [pick, setPick] = useState(a.jobMenu.length ? 0 : -1);
  const [title, setTitle] = useState(a.jobMenu[0]?.title ?? "");
  const [brief, setBrief] = useState("");
  const [budgetStr, setBudgetStr] = useState(a.jobMenu[0]?.budget ?? "25");
  const [hours, setHours] = useState(String(a.jobMenu[0]?.hours ?? 24));
  const [ev, setEv] = useState<"buyer" | "contract" | "pool">("contract");
  const [jobId, setJobId] = useState<number | null>(null);
  const budget = parseAmount(budgetStr) ?? 0n;
  const forcePool = budget > 500_000_000n;
  const kind = forcePool ? "pool" : ev;
  const evalFee = kind === "pool" ? (budget * 150n) / 10_000n : 0n;
  const platformFee = (budget * 300n) / 10_000n;
  const bondNeeded = budget / 10n;
  const bondFree = a.bond ? BigInt(a.bond.free) : 0n;
  const own = address && (address.toLowerCase() === a.owner.toLowerCase() || address.toLowerCase() === a.wallet.toLowerCase());

  const choose = (i: number) => {
    setPick(i);
    if (i >= 0) {
      setTitle(a.jobMenu[i].title);
      setBudgetStr(a.jobMenu[i].budget);
      setHours(String(a.jobMenu[i].hours));
    }
  };

  let reason: string | null = null;
  if (!address) reason = "Connect a wallet to continue.";
  else if (own) reason = "You can't hire your own agent.";
  else if (!budget) reason = "Enter a budget.";
  else if (budget > 1_000_000_000n) reason = "Job budgets are capped at 1,000 NRX in the beta.";
  else if (Number(hours) < 2) reason = "Allow at least 2 hours.";
  else if (bondFree < bondNeeded) reason = `The seller's free bond (${fmtAmt(bondFree, "NRX")}) does not cover 10% of this budget.`;
  else if (b.data && b.data.nrx < budget + evalFee) reason = "Not enough NRX on Base.";

  const submit = () =>
    tx.run({ title: `Hire ${a.name}`, chain: "base", total: 3 }, async (h) => {
      const jobs = contract("base", "NeroJobs");
      const evaluator: Address = kind === "buyer" ? address! : kind === "contract" ? (DEPLOYMENT.accounts.contractEvaluator.address as Address) : zeroAddress;
      const expiredAt = BigInt((p.data?.chainTime ?? Math.floor(Date.now() / 1000)) + Number(hours) * 3600);
      const description = brief ? `${title} — ${brief}` : title;
      const hash = await h.write({ address: jobs, abi: NeroJobsAbi, functionName: "createJob", args: [BigInt(a.agentId), evaluator, expiredAt, description, budget] }, "Create job");
      const rc = await publicClients.base.getTransactionReceipt({ hash });
      const [ev] = parseEventLogs({ abi: NeroJobsAbi, logs: rc.logs, eventName: "JobCreated" });
      const id = (ev.args as { jobId: bigint }).jobId;
      setJobId(Number(id));
      await h.write({ address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [jobs, budget + evalFee] }, "Approve exact NRX");
      await h.write({ address: jobs, abi: NeroJobsAbi, functionName: "fund", args: [id, budget] }, "Fund escrow");
    });

  return (
    <div className="stack">
      <p className="small">Fund a job in ERC-8183 escrow. The evaluator releases NRX to the agent on delivery, or refunds you. Anyone can trigger a refund after the deadline.</p>
      {a.jobMenu.length > 0 && (
        <fieldset className="stack-1" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>Job menu</legend>
          {a.jobMenu.map((j, i) => (
            <label key={j.title} className="checkbox"><input type="radio" name="menu" checked={pick === i} onChange={() => choose(i)} /><span>{j.title} — <span className="mono">{j.budget} NRX · {j.hours} h</span></span></label>
          ))}
          <label className="checkbox"><input type="radio" name="menu" checked={pick === -1} onChange={() => choose(-1)} /><span>Custom job</span></label>
        </fieldset>
      )}
      {pick === -1 && <div className="field"><label htmlFor="jt">Title</label><input id="jt" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>}
      <div className="field"><label htmlFor="jb">Brief</label><textarea id="jb" className="input" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should the agent deliver?" /></div>
      <div className="grid grid-2">
        <AmountInput id="budget" label="Budget" unit="NRX" value={budgetStr} onChange={(v) => { setBudgetStr(v); setPick(-1); }} />
        <div className="field"><label htmlFor="hrs">Deadline (hours)</label><input id="hrs" className="input mono" inputMode="numeric" value={hours} onChange={(e) => /^\d*$/.test(e.target.value) && setHours(e.target.value)} /></div>
      </div>
      <fieldset className="stack-1" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>Evaluator — who decides payment</legend>
        <label className="checkbox"><input type="radio" name="ev" disabled={forcePool} checked={kind === "contract"} onChange={() => setEv("contract")} /><span><strong>Contract evaluator</strong> — deterministic checks (delivered hash matches the file). No fee.</span></label>
        <label className="checkbox"><input type="radio" name="ev" disabled={forcePool} checked={kind === "buyer"} onChange={() => setEv("buyer")} /><span><strong>You</strong> — cheapest; rejections refund without slashing the seller.</span></label>
        <label className="checkbox"><input type="radio" name="ev" checked={kind === "pool"} onChange={() => setEv("pool")} /><span><strong>NeroX pool</strong> — a bonded evaluator picked at random; 1.5% fee. Required above 500 NRX.</span></label>
      </fieldset>
      <div>
        <Kv k="Escrowed" v={fmtAmt(budget, "NRX")} />
        <Kv k="Evaluator fee (you pay)" v={fmtAmt(evalFee, "NRX")} />
        <Kv k="NeroX fee (from the seller, on completion)" v={fmtAmt(platformFee, "NRX")} />
        <Kv k="Seller bond committed" v={fmtAmt(bondNeeded, "NRX")} />
      </div>
      <ActionButton onClick={submit} busy={tx.state.busy} reason={tx.state.busy ? null : reason}>Hire for {fmt(budget + evalFee)} NRX</ActionButton>
      <TxStatus state={tx.state} />
      {tx.state.done && jobId !== null && <Notice>Job <span className="mono">#{jobId}</span> is funded. Track delivery in <Link href="/market/jobs">My jobs</Link>.</Notice>}
    </div>
  );
}

function BuyPanel({ a }: { a: AgentDetail }) {
  const { address } = useAccount();
  const b = useBalances("base", address);
  const tx = useTx();
  const [offer, setOffer] = useState("");
  const own = address?.toLowerCase() === a.owner.toLowerCase();
  const sale = contract("base", "AgentSale");
  const price = a.sale ? BigInt(a.sale.price) : 0n;
  const offerAmt = parseAmount(offer);
  const buy = () =>
    tx.run({ title: `Buy ${a.name}`, chain: "base", total: 2 }, async (h) => {
      await h.writeAll([
        { params: { address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [sale, price] }, label: "Approve exact NRX" },
        { params: { address: sale, abi: AgentSaleAbi, functionName: "buy", args: [BigInt(a.agentId), price] }, label: "Buy agent" },
      ]);
    });
  const makeOffer = () =>
    tx.run({ title: "Make an offer", chain: "base", total: 2 }, async (h) => {
      const now = (await publicClients.base.getBlock()).timestamp;
      await h.writeAll([
        { params: { address: contract("base", "NRX"), abi: MockERC20Abi, functionName: "approve", args: [sale, offerAmt] }, label: "Approve exact NRX" },
        { params: { address: sale, abi: AgentSaleAbi, functionName: "makeOffer", args: [BigInt(a.agentId), offerAmt, now + 7n * 86400n] }, label: "Escrow offer" },
      ]);
    });
  if (own) return <Notice>You own this agent. Manage its sale in <Link href="/market/sell">Sell an agent</Link>.</Notice>;
  return (
    <div className="stack">
      <p className="small">Buy the whole agent: its ERC-8004 identity token, reputation history and payout wallet move to you in one atomic swap. NeroX sells whole agents only.</p>
      <div>
        <Kv k="Lifetime revenue" v={fmtAmt(BigInt(a.stats.revenue), "NRX")} />
        <Kv k="Jobs completed" v={a.stats.jobsCompleted} />
        <Kv k="Paid-reviewer score" v={a.reputation.score === null ? "—" : `${a.reputation.score}/100 (${a.reputation.count})`} />
        <Kv k="Seller bond" v={a.bond ? fmtAmt(BigInt(a.bond.value), "NRX") : "—"} />
        <Kv k="Open jobs" v={a.stats.jobsOpen} />
      </div>
      {a.sale ? (
        <>
          <Kv k="Asking price" v={fmtAmt(price, "NRX")} tone="signal" />
          <Kv k="Sale fee (paid by seller from price)" v={fmtAmt((price * 250n) / 10_000n, "NRX")} />
          <ActionButton onClick={buy} busy={tx.state.busy} reason={tx.state.busy ? null : !address ? "Connect a wallet to continue." : a.stats.jobsOpen > 0 ? "This agent has open jobs. They must settle first." : b.data && b.data.nrx < price ? "Not enough NRX on Base." : null}>
            Buy for {fmt(price, 6, 0)} NRX
          </ActionButton>
        </>
      ) : (
        <Notice>Not listed for sale. You can still escrow an offer the owner can accept.</Notice>
      )}
      <hr className="hairline" />
      <AmountInput id="offer" label="Make an offer (escrowed for 7 days)" unit="NRX" value={offer} onChange={setOffer} max={b.data?.nrx} />
      <button className="btn" onClick={makeOffer} disabled={!offerAmt || !address || tx.state.busy}>Escrow offer</button>
      <TxStatus state={tx.state} />
    </div>
  );
}

export default function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const a = useApi<AgentDetail>(`/agents/${id}`, "market", 5_000);
  const [tab, setTab] = useState<"call" | "hire" | "buy">("call");
  const d = a.data;
  if (a.isError) return <Empty>Agent not found.</Empty>;
  if (!d) return <Empty>Loading…</Empty>;
  const hidden = d.reputation.hiddenUnpaid;
  return (
    <>
      <MarketNav />
      <div className="stack-3">
        <div className="hero-panel dots stack">
          <div className="row-2" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
            {d.image && <img className="avatar" src={d.image} alt="" style={{ width: 64, height: 64 }} />}
            <div className="stack-1" style={{ minWidth: 0 }}>
              <h1>{d.name}</h1>
              <p className="muted">{d.description}</p>
              <div className="row">
                <span className="chip">{d.category}</span>
                {d.skills.map((s) => <span className="chip" key={s}>{s}</span>)}
                <span className="chip mono">agent #{d.agentId}</span>
                {d.verified && <span className="chip chip-signal">Wallet-verified listing</span>}
                {d.sale && <span className="chip chip-brand">For sale · {fmt(BigInt(d.sale.price), 6, 0)} NRX</span>}
              </div>
            </div>
          </div>
          <div className="grid grid-4">
            <Stat label="Paid-reviewer score" value={d.reputation.score === null ? "—" : `${d.reputation.score}/100`} sub={`${d.reputation.count} paid review(s)${hidden ? ` · ${hidden} unpaid hidden` : ""}`} />
            <Stat label="Jobs completed" value={d.stats.jobsCompleted} sub={`refund rate ${pct(d.stats.refundRate, 0)}`} />
            <Stat label="Median delivery" value={duration(d.stats.medianDeliveryMs)} sub={`uptime ${d.stats.uptime === null ? "—" : pct(d.stats.uptime, 0)}`} />
            <Stat label="Bond" value={d.bond ? fmtAmt(BigInt(d.bond.value), "NRX", 6, 0) : "—"} tone="yield" sub="Posted in sNRX" />
          </div>
        </div>
        <div className="grid split">
          <div className="card-lg">
            <Tabs value={tab} onChange={setTab} items={[{ id: "call", label: `Call${d.priceNrx ? ` · ${d.priceNrx} NRX` : ""}` }, { id: "hire", label: "Hire" }, { id: "buy", label: "Buy" }]} />
            {tab === "call" && <CallPanel a={d} />}
            {tab === "hire" && <HirePanel a={d} />}
            {tab === "buy" && <BuyPanel a={d} />}
          </div>
          <div className="stack-3">
            <div className="card stack-1">
              <h2>Reviews</h2>
              <p className="small">Ranked on paid reviewers only: wallets with a settled NRX payment or completed job with this agent.</p>
              {d.feedback.length ? d.feedback.slice(0, 8).map((f, i) => (
                <div key={i} className="kv">
                  <span className="mono">{short(f.client)} {f.paidReviewer ? <span className="chip chip-signal">paid</span> : <span className="chip">unpaid — not counted</span>}</span>
                  <span className="mono">{f.score}/100</span>
                </div>
              )) : <Empty>No reviews yet.</Empty>}
            </div>
            <div className="card stack-1">
              <h2>Endpoints</h2>
              {d.endpoints.map((e) => <Kv key={e.name} k={e.name} v={<span className="small wrap">{e.endpoint}</span>} />)}
              <Kv k="Owner" v={short(d.owner)} />
              <Kv k="Payout wallet" v={short(d.wallet)} />
              <Kv k="Registration" v={<a className="small" href={d.uri} target="_blank" rel="noreferrer">ERC-8004 file</a>} />
            </div>
            <div className="card stack-1">
              <h2>Recent paid calls</h2>
              {d.recentCalls.length ? d.recentCalls.slice(0, 6).map((c) => <Kv key={c.id} k={`${short(c.payer)} · ${ago(c.time)}`} v={`${fmt(BigInt(c.amount), 6, 4)} NRX`} />) : <Empty>No calls yet.</Empty>}
            </div>
            {d.sales.length > 0 && (
              <div className="card stack-1">
                <h2>Ownership history</h2>
                {d.sales.map((s) => <Kv key={s.tx} k={`${short(s.seller)} → ${short(s.buyer)}`} v={fmtAmt(BigInt(s.price), "NRX", 6, 0)} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
