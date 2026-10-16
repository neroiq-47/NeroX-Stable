"use client";
import { CHAINS, CHAIN_KEYS, DEPLOYMENT, type ChainKey } from "@/lib/config";
import { useProtocol, useRead } from "@/lib/reads";
import { publicClients } from "@/lib/clients";
import { NeroTimelockAbi } from "@/lib/abis";
import { fmtAmt, pct } from "@/lib/format";
import { Kv, Notice, PageHead, Stat } from "@/components/ui";

const DESCRIPTIONS: Record<string, string> = {
  NRX: "NeroX USD — ERC-20 + EIP-2612 + EIP-3009, burn/mint",
  NeroPSM: "Peg Stability Module — USDC ⇄ NRX 1:1, daily and global caps",
  sNRX: "Savings vault — ERC-4626, virtual shares, withdrawal queue",
  TokenPool: "CCIP-style burn/mint pool — per-lane rate limits, 2-of-3 attestation",
  Timelock: "48h timelock in front of admin changes",
  AutoSweeper: "Opt-in seller revenue sweep into sNRX",
  USDC: "USDC (demo token on local chains)",
  SanctionsOracle: "Chainalysis-compatible sanctions oracle",
  Morpho: "Morpho Blue stand-in (local)",
  MorphoLenderStrategy: "Supplies sNRX NRX to NeroX Morpho markets",
  AerodromePool: "NRX/USDC stable pool (Aerodrome sAMM stand-in)",
  IdentityRegistry: "ERC-8004 identity registry",
  ReputationRegistry: "ERC-8004 reputation registry",
  NeroJobs: "ERC-8183 job escrow",
  SellerBond: "sNRX seller and evaluator bonds",
  AgentSale: "Whole-agent sales (NRX ⇄ ERC-8004 token)",
  cbBTC: "Collateral (demo token)", wstETH: "Collateral (demo token)", Irm: "Rate model", OracleCbBTC: "cbBTC price feed (demo)", OracleWstETH: "wstETH price feed (demo)",
};

function ChainPanel({ chain }: { chain: ChainKey }) {
  const p = useProtocol(chain);
  const d = p.data;
  const delay = useRead(["delay", chain], async () => (await publicClients[chain].readContract({ address: DEPLOYMENT.chains[chain].contracts.Timelock as `0x${string}`, abi: NeroTimelockAbi, functionName: "getMinDelay" })) as bigint, { interval: 60_000 });
  const status = (paused?: boolean) => (paused === undefined ? "—" : paused ? "! Paused" : "Live");
  return (
    <div className="card stack-1">
      <h2>{CHAINS[chain].name}</h2>
      <Kv k="NRX supply" v={fmtAmt(d?.supply, "NRX")} />
      <Kv k="PSM USDC reserves" v={fmtAmt(d?.reserves, "USDC")} />
      <Kv k="NRX supply cap" v={fmtAmt(d?.supplyCap, "NRX", 6, 0)} />
      <Kv k="PSM global cap remaining" v={fmtAmt(d?.remGlobal, "NRX", 6, 0)} />
      <Kv k="Daily mint / redeem cap" v={d ? `${fmtAmt(d.dailyMintCap, "NRX", 6, 0)} / ${fmtAmt(d.dailyRedeemCap, "NRX", 6, 0)}` : "—"} />
      <Kv k="sNRX vault assets" v={fmtAmt(d?.vault.totalAssets, "NRX")} />
      <Kv k="NRX / PSM / sNRX / bridge" v={d ? [d.nrxPaused, d.psmPaused, d.vault.paused, d.poolPaused].map(status).join(" · ") : "—"} />
      <Kv k="Timelock delay" v={delay.data !== undefined ? `${Number(delay.data) / 3600} h` : "—"} />
    </div>
  );
}

export default function TransparencyPage() {
  const b = useProtocol("base");
  const e = useProtocol("ethereum");
  const supply = (b.data?.supply ?? 0n) + (e.data?.supply ?? 0n);
  const reserves = (b.data?.reserves ?? 0n) + (e.data?.reserves ?? 0n);
  const ratio = supply > 0n ? Number((reserves * 10_000n) / supply) / 10_000 : undefined;

  return (
    <>
      <PageHead title="Transparency" sub="Live on-chain reads: NRX supply per chain, PSM reserves, caps, pause states and the verified contract address book." />
      <div className="grid grid-3" style={{ marginBottom: 24 }}>
        <div className="card"><Stat label="Total NRX supply" value={fmtAmt(supply, "NRX")} /></div>
        <div className="card"><Stat label="Total USDC reserves" value={fmtAmt(reserves, "USDC")} /></div>
        <div className="card"><Stat label="Reserve ratio" value={ratio === undefined ? "—" : pct(ratio)} tone={ratio !== undefined && ratio < 1 ? "danger" : "signal"} sub="Reserves ÷ supply, all chains" /></div>
      </div>
      <div className="grid grid-2">
        {CHAIN_KEYS.map((k) => <ChainPanel key={k} chain={k} />)}
      </div>
      <div className="section stack">
        <h2>Proof of reserve and audits</h2>
        <div className="grid grid-2">
          <Notice>
            <strong>Reserves are on-chain.</strong> Every NRX is minted by a PSM against USDC that stays in that PSM, or by a CCIP lane after an equal burn on
            another chain. A Chainlink Proof of Reserve feed and Secure Mint guard arrive in the medium phase.
          </Notice>
          <Notice tone="brand">
            <strong>Audits.</strong> External audit of NRX, NeroPSM, sNRX and the token pool is scheduled for weeks 6–9, plus a public contest. NeroJobs and
            SellerBond are audited before the Market beta. Reports will be linked here.
          </Notice>
        </div>
      </div>
      <div className="section stack">
        <h2>Verified address book</h2>
        <p className="small">Shipped in the app build. The app refuses to send transactions to any address not on this list.</p>
        {CHAIN_KEYS.map((k) => (
          <div key={k} className="stack-1">
            <span className="label">{CHAINS[k].name} · chain ID {CHAINS[k].id} · CCIP selector <span className="mono">{DEPLOYMENT.chains[k].ccipSelector}</span></span>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Contract</th><th>Address</th><th className="hide-sm">Purpose</th></tr></thead>
                <tbody>
                  {Object.entries(DEPLOYMENT.chains[k].contracts).map(([name, a]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="mono small wrap">{a as string}</td>
                      <td className="small hide-sm">{DESCRIPTIONS[name] ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
