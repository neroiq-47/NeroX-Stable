"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useApp } from "@/lib/app-state";
import { CHAINS, CHAIN_KEYS, DEMO, PERSONAS, SERVICES, personaAddress, personaOf, type ChainKey } from "@/lib/config";
import { setPersona, currentPersona } from "@/lib/demo-connector";
import { useProtocol } from "@/lib/reads";
import { fmt, short } from "@/lib/format";
import { CloseIcon, MenuIcon, Modal, Notice, SunIcon } from "./ui";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/mint", label: "Mint" },
  { href: "/earn", label: "Earn" },
  { href: "/pools", label: "Pools" },
  { href: "/borrow", label: "Borrow" },
  { href: "/bridge", label: "Bridge" },
  { href: "/market", label: "Market" },
  { href: "/seller", label: "Seller Console" },
  { href: "/transparency", label: "Transparency" },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function BetaBanner() {
  const b = useProtocol("base");
  const e = useProtocol("ethereum");
  const cap = (b.data?.supplyCap ?? 0n) + (e.data?.supplyCap ?? 0n);
  const supply = (b.data?.supply ?? 0n) + (e.data?.supply ?? 0n);
  return (
    <div className="beta" role="region" aria-label="Beta notice">
      <div className="container">
        <span>
          <strong>Capped beta.</strong> NeroX is live with hard supply caps while it is audited and tested in public.
        </span>
        <span className="mono">
          NRX {fmt(supply, 6, 0)} / {fmt(cap, 6, 0)} cap
        </span>
      </div>
    </div>
  );
}

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const { chain, setChain } = useApp();
  const { address, isConnected } = useAccount();
  const persona = personaOf(address);

  useEffect(() => setOpen(false), [path]);

  return (
    <header className="header">
      <div className="container">
        <Link href="/" className="wordmark" aria-label="NeroX home">
          NeroX
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <label className="hide-sm" htmlFor="chain-switch" style={{ position: "absolute", left: -9999 }}>
            Chain
          </label>
          <select id="chain-switch" className="input chain-select" value={chain} onChange={(e) => setChain(e.target.value as ChainKey)} aria-label="Chain">
            {CHAIN_KEYS.map((k) => (
              <option key={k} value={k}>
                {CHAINS[k].name}
              </option>
            ))}
            <option disabled>BNB Chain — medium phase</option>
          </select>
          <button className={isConnected ? "btn btn-sm" : "btn btn-primary btn-sm"} onClick={() => setConnectOpen(true)}>
            {isConnected ? (
              <>
                <span className="dot" aria-hidden />
                <span className="mono">{persona ? persona.label : short(address)}</span>
              </>
            ) : (
              "Connect"
            )}
          </button>
          <ThemeToggle />
          <button className="btn btn-ghost btn-sm menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>
      {open && (
        <div className="container">
          <nav className="mobile-nav" aria-label="Main mobile">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={isActive(path, n.href) ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
      <ConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} />
    </header>
  );
}

function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("nerox.theme", root.dataset.theme);
    } catch {}
  };
  return (
    <button className="btn btn-ghost btn-sm hide-sm" aria-label="Toggle theme" onClick={toggle}>
      <SunIcon />
    </button>
  );
}

function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { address, isConnected, connector } = useAccount();
  const { chain } = useApp();
  const [role, setRole] = useState("alice");
  useEffect(() => setRole(currentPersona()), [open]);
  const demo = connectors.find((c) => c.id === "nerox-demo");
  const injected = connectors.find((c) => c.id === "injected" || c.type === "injected");

  const usePersona = async (r: string) => {
    setPersona(r);
    setRole(r);
    if (!isConnected && demo) await connectAsync({ connector: demo, chainId: CHAINS[chain].id });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={isConnected ? "Wallet" : "Connect a wallet"}>
      {isConnected && (
        <div className="stack-1">
          <span className="label">Connected</span>
          <span className="mono wrap">{address}</span>
          <span className="small">via {connector?.name}</span>
        </div>
      )}
      {DEMO && demo && (
        <div className="stack-1">
          <span className="label">Demo personas (local chains)</span>
          <p className="small">Each persona is a funded dev account on the local Base and Ethereum chains.</p>
          <div className="stack-1">
            {PERSONAS.map((p) => (
              <button key={p.role} className="btn" style={{ justifyContent: "space-between" }} aria-pressed={isConnected && connector?.id === "nerox-demo" && role === p.role} onClick={() => usePersona(p.role)}>
                <span>
                  <strong>{p.label}</strong> <span className="small">— {p.blurb}</span>
                </span>
                <span className="mono small">{short(personaAddress(p.role))}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {injected && (
        <button
          className="btn"
          onClick={async () => {
            await connectAsync({ connector: injected, chainId: CHAINS[chain].id }).catch(() => {});
            onClose();
          }}
        >
          Browser wallet ({injected.name})
        </button>
      )}
      <p className="small">
        Connecting screens your address against sanctions lists. NeroX never asks for unlimited approvals.
      </p>
      {isConnected && (
        <button className="btn btn-ghost" onClick={() => { disconnect(); onClose(); }}>
          Disconnect
        </button>
      )}
    </Modal>
  );
}

/** Terms on first connect, sanctions screening before any write. */
export function ComplianceGate() {
  const { screening, termsAccepted, acceptTerms } = useApp();
  const { isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [checked, setChecked] = useState(false);
  if (screening.status === "sanctioned")
    return (
      <Modal open onClose={() => {}} title="This wallet can't use NeroX" dismissable={false}>
        <Notice tone="danger">
          <strong>Sanctions screening failed.</strong> <span className="mono wrap">{screening.address}</span> appears on a sanctions list. NeroX
          cannot provide services to this address. All write actions are disabled.
        </Notice>
        <button className="btn btn-primary" onClick={() => disconnect()}>
          Disconnect
        </button>
      </Modal>
    );
  if (isConnected && !termsAccepted)
    return (
      <Modal open onClose={() => {}} title="Before you start" dismissable={false}>
        <div className="stack small" style={{ color: "var(--ink)" }}>
          <p>NeroX is in a capped beta. By continuing you confirm that:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>NRX is a 1:1 USD payment token, backed by USDC and redeemable. It is for paying and settling only.</li>
            <li>sNRX is a separate savings product. Its returns come from Morpho borrowers, vary, and are not guaranteed.</li>
            <li>You are not in a restricted jurisdiction and are not a sanctioned person.</li>
            <li>Smart contracts carry risk, including loss of funds.</li>
          </ul>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I have read and accept the NeroX beta terms.</span>
        </label>
        <button className="btn btn-primary" disabled={!checked} onClick={acceptTerms}>
          Continue
        </button>
      </Modal>
    );
  return null;
}

export function TxTray() {
  const { txs, clearTxs } = useApp();
  const [hidden, setHidden] = useState(false);
  const recent = txs.filter((t) => t.status === "pending" || Date.now() - t.time < 20_000);
  if (hidden || !recent.length) return null;
  return (
    <div className="drawer" aria-live="polite">
      {recent.slice(0, 3).map((t) => (
        <div key={t.hash} className="tray stack-1">
          <div className="between">
            <span className="row">
              <span className={`dot ${t.status === "pending" ? "live" : t.status === "reverted" ? "danger" : ""}`} aria-hidden />
              <strong>{t.status === "pending" ? "Pending" : t.status === "success" ? "Confirmed" : "Reverted"}</strong>
            </span>
            <span className="small">{CHAINS[t.chain].name}</span>
          </div>
          <span className="small">{t.label}</span>
          <span className="mono small truncate">{t.hash}</span>
        </div>
      ))}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
        <button className="btn btn-sm" onClick={() => { setHidden(true); clearTxs(); }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container between">
        <span>
          NeroX — stable money for the machine economy. NRX is redeemable 1:1 for USDC. sNRX returns vary and are not guaranteed.
        </span>
        <span className="row">
          <Link href="/transparency">Contracts and reserves</Link>
          {DEMO && <DemoControls />}
        </span>
      </div>
    </footer>
  );
}

function DemoControls() {
  const [open, setOpen] = useState(false);
  const { address } = useAccount();
  const [msg, setMsg] = useState("");
  const [traffic, setTraffic] = useState<boolean | null>(null);
  useEffect(() => {
    if (open) fetch(`${SERVICES.market}/demo/traffic`).then((r) => r.json()).then((j) => setTraffic(j.enabled)).catch(() => {});
  }, [open]);
  const post = async (path: string, body: object, done: string) => {
    setMsg("Working…");
    const r = await fetch(`${SERVICES.market}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? done : `Failed: ${j.error ?? r.status}`);
    return j;
  };
  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        Demo controls
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Demo controls">
        <p className="small">These act on the local demo chains only.</p>
        <button className="btn" disabled={!address} onClick={() => post("/demo/faucet", { address }, "Sent 5,000 USDC per chain, 0.1 cbBTC, 1 wstETH and gas.")}>
          Faucet to my wallet
        </button>
        <div className="row">
          <button className="btn" onClick={() => post("/demo/time-warp", { days: 30 }, "Moved both chains forward 30 days. Borrower interest has accrued.")}>
            Fast-forward 30 days
          </button>
          <button className="btn" onClick={() => post("/demo/time-warp", { days: 1 }, "Moved forward 1 day. Daily caps reset.")}>
            +1 day
          </button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => post("/demo/price", { asset: "cbBTC", usd: 48000 }, "cbBTC oracle set to $48,000.")}>
            cbBTC to $48,000
          </button>
          <button className="btn" onClick={() => post("/demo/price", { asset: "cbBTC", usd: 65000 }, "cbBTC oracle reset to $65,000.")}>
            Reset cbBTC
          </button>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={Boolean(traffic)} onChange={async (e) => { const j = await post("/demo/traffic", { enabled: e.target.checked }, e.target.checked ? "Agent traffic on." : "Agent traffic off."); setTraffic(j.enabled); }} />
          <span>Background agent traffic (a buyer agent paying seeded agents over x402)</span>
        </label>
        {msg && <p className="small" aria-live="polite">{msg}</p>}
      </Modal>
    </>
  );
}
