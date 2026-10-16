"use client";
import Link from "next/link";
import { useAccount } from "wagmi";
import { CHAINS, CHAIN_KEYS, personaOf, type ChainKey } from "@/lib/config";
import { useApi, useBalances, useMarket, useProtocol, useVaultApy } from "@/lib/reads";
import { ago, fmtAmt, fmtNum, pct, short } from "@/lib/format";
import { ArrowIcon, Empty, PageHead, Stat } from "@/components/ui";
import type { Address } from "viem";

type Activity = { chain: ChainKey; type: string; tx: string; time: number; amount?: string; agentId?: number; jobId?: number; market?: string; dest?: string };

const LABELS: Record<string, string> = {
  "psm.mint": "Minted NRX", "psm.redeem": "Redeemed NRX", "snrx.deposit": "Staked NRX into sNRX", "snrx.withdraw": "Unstaked sNRX",
  "snrx.queue": "Queued sNRX withdrawal", "ccip.send": "Bridged NRX out", "ccip.receive": "Received bridged NRX", "sweep": "Auto-swept revenue to sNRX",
  "morpho.borrow": "Borrowed NRX", "morpho.repay": "Repaid NRX", "morpho.collateral": "Posted collateral", "morpho.withdrawCollateral": "Withdrew collateral",
  "pool.add": "Added liquidity", "pool.remove": "Removed liquidity", "pool.swap": "Swapped", "x402.payment": "x402 payment settled",
  "job.JobCreated": "Job created", "job.JobFunded": "Job funded", "job.JobSubmitted": "Job delivered", "job.JobCompleted": "Job completed",
  "job.JobRejected": "Job rejected", "job.JobExpired": "Job refunded", "market.Sold": "Agent sold",
};

function ChainRow({ chain, address }: { chain: ChainKey; address: Address }) {
  const b = useBalances(chain, address);
  const d = b.data;
  return (
    <tr>
      <td>{CHAINS[chain].name}</td>
      <td className="num mono signal">{fmtAmt(d?.nrx, "NRX")}</td>
      <td className="num mono">{fmtAmt(d?.usdc, "USDC")}</td>
      <td className="num mono yield">{fmtAmt(d?.snrxValue, "NRX")}</td>
      <td className="num mono">{chain === "base" ? fmtAmt(d?.lp, "LP", 6, 4) : "—"}</td>
    </tr>
  );
}

function Loans({ address }: { address: Address }) {
  const c = useMarket("cbBTC", address);
  const w = useMarket("wstETH", address);
  const loans = [c.data, w.data].filter((m) => m && m.position.debt > 0n);
  if (!loans.length) return <p className="small">No open loans. <Link href="/borrow">Borrow NRX against cbBTC or wstETH</Link>.</p>;
  return (
    <div className="stack-1">
      {loans.map((m) => (
        <div key={m!.key} className="between">
          <span>{m!.key} market</span>
          <span className="mono">{fmtAmt(m!.position.debt, "NRX")}</span>
          <span className={`mono ${m!.position.health && m!.position.health < 1.2 ? "danger" : ""}`}>
            {m!.position.health && m!.position.health < 1.2 ? "! " : ""}health factor {fmtNum(m!.position.health)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Reserves() {
  const b = useProtocol("base");
  const e = useProtocol("ethereum");
  return (
    <div className="card stack-1">
      <h2>PSM reserves</h2>
      {[["base", b.data], ["ethereum", e.data]].map(([k, d]) => (
        <div key={k as string} className="kv">
          <span>{CHAINS[k as ChainKey].name}</span>
          <span className="mono">{fmtAmt((d as { reserves: bigint } | undefined)?.reserves, "USDC")}</span>
        </div>
      ))}
      <p className="small">
        USDC never leaves the PSM. <Link href="/transparency">See supply per chain</Link>.
      </p>
    </div>
  );
}

export default function Dashboard() {
  const { address } = useAccount();
  const persona = personaOf(address);
  const apy = useVaultApy("base");
  const act = useApi<{ items: Activity[] }>(address ? `/activity?address=${address}&limit=12` : null);
  const stats = useApi<{ agents: number; calls: number; jobs: { completed: number } }>("/stats");

  if (!address)
    return (
      <div className="stack-4">
        <section className="hero-panel stack-3">
          <h1 className="display">Stable money for the machine economy.</h1>
          <p className="muted" style={{ maxWidth: 640 }}>
            NRX is a 1:1 USD payment token, backed by USDC and built for x402 agent payments on Base and Ethereum. sNRX is a separate savings
            vault that earns from Morpho borrowers.
          </p>
          <div className="row-2">
            <Link className="btn btn-primary" href="/mint">Mint NRX</Link>
            <Link className="btn" href="/market">Browse the Agent Market</Link>
          </div>
        </section>
        <div className="grid grid-3">
          <div className="card"><Stat label="sNRX APY (Base)" value={pct(apy.data?.apy)} tone="yield" sub="From Morpho borrowers. Returns vary." /></div>
          <div className="card"><Stat label="Agents listed" value={stats.data?.agents ?? "—"} sub="ERC-8004 identities" /></div>
          <div className="card"><Stat label="Paid agent calls" value={stats.data?.calls ?? "—"} tone="signal" sub="Settled in NRX over x402" /></div>
        </div>
        <Reserves />
      </div>
    );

  return (
    <>
      <PageHead title="Dashboard" sub={<>Your NRX, sNRX, liquidity and loans across chains{persona ? ` — ${persona.label}` : ""}.</>} />
      <div className="stack-3">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Chain</th><th className="num">NRX</th><th className="num">USDC</th><th className="num">sNRX value</th><th className="num">Pool LP</th></tr>
            </thead>
            <tbody>
              {CHAIN_KEYS.map((k) => <ChainRow key={k} chain={k} address={address} />)}
            </tbody>
          </table>
        </div>
        <div className="grid grid-3">
          <div className="card stack-1">
            <h2>Loans</h2>
            <Loans address={address} />
          </div>
          <div className="card stack-1">
            <h2>Earn</h2>
            <Stat label="sNRX APY (Base)" value={pct(apy.data?.apy)} tone="yield" sub="Returns vary and are not guaranteed." />
            <Link href="/earn" className="row">Stake NRX <ArrowIcon /></Link>
          </div>
          <Reserves />
        </div>
        <div className="grid grid-4">
          {[["/mint", "Mint NRX", "USDC to NRX at 1:1"], ["/bridge", "Bridge", "Move NRX between chains"], ["/market", "Agent Market", "Call, hire or buy agents"], ["/seller", "Seller Console", "Get paid in NRX over x402"]].map(([h, t, s]) => (
            <Link key={h} href={h} className="card agent-card">
              <strong>{t}</strong>
              <span className="small">{s}</span>
            </Link>
          ))}
        </div>
        <section className="stack">
          <h2>Recent activity</h2>
          <div className="table-wrap">
            {act.data?.items.length ? (
              <table className="table">
                <thead><tr><th>When</th><th>What</th><th>Chain</th><th className="num">Amount</th><th>Tx</th></tr></thead>
                <tbody>
                  {act.data.items.map((a, i) => (
                    <tr key={`${a.tx}-${i}`}>
                      <td className="small">{ago(a.time)}</td>
                      <td>{LABELS[a.type] ?? a.type}{a.market ? ` · ${a.market}` : ""}{a.jobId !== undefined ? ` · #${a.jobId}` : ""}</td>
                      <td className="small">{CHAINS[a.chain]?.name}</td>
                      <td className="num mono">{a.amount ? fmtAmt(BigInt(a.amount), "NRX") : "—"}</td>
                      <td className="mono small">{short(a.tx, 6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No activity yet. Mint NRX to get started.</Empty>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
