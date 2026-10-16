"use client";
import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useApp } from "@/lib/app-state";
import { CHAINS, CHAIN_KEYS, SERVICES, chainKeyOf, contract, type ChainKey } from "@/lib/config";
import { useApi, useBalances, useRead } from "@/lib/reads";
import { publicClients } from "@/lib/clients";
import { useTx } from "@/lib/tx";
import { AutoSweeperAbi, MockERC20Abi } from "@/lib/abis";
import { ago, fmt, fmtAmt, parseAmount, short } from "@/lib/format";
import { ActionButton, CheckIcon, CopyIcon, Empty, Kv, Notice, PageHead, Stat, Tabs, TxStatus } from "@/components/ui";
import type { Address } from "viem";

type Endpoint = { id: string; name: string; urlPattern: string; price: string; chains: number[]; framework: string; sandboxUrl: string; description: string; createdAt: number };
type Payment = { id: string; time: number; chain: ChainKey; payer: string; payTo: string; amount: string; tx: string; x402Version: number; resource: string; meta: { endpointId?: string; agentId?: number } };
type Step = { kind: string; status?: number; v1?: unknown; v2?: unknown; version?: number; authorization?: Record<string, string>; settlement?: { transaction: string; success: boolean } };

function useSession(address?: string) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return setToken(null);
    try {
      setToken(sessionStorage.getItem(`nerox.console.${address}`));
    } catch {}
  }, [address]);
  const save = (t: string | null) => {
    setToken(t);
    try {
      if (t) sessionStorage.setItem(`nerox.console.${address}`, t);
      else sessionStorage.removeItem(`nerox.console.${address}`);
    } catch {}
  };
  return [token, save] as const;
}

const FRAMEWORKS = [
  { id: "express", label: "Express" },
  { id: "next", label: "Next.js" },
  { id: "hono", label: "Hono" },
] as const;

function snippet(fw: string, e: Endpoint, payTo: string) {
  const net = e.chains.map((c) => `"eip155:${c}"`).join(", ");
  const route = e.urlPattern.replace(/^https?:\/\/[^/]+/, "") || "/api/paid";
  const nrx = e.chains.map((c) => `    // ${CHAINS[chainKeyOf(c)!].name}: ${contract(chainKeyOf(c)!, "NRX")}`).join("\n");
  const cfg = `{
  "GET ${route}": {
    price: { amount: "${e.price}", asset: NRX }, // ${fmt(BigInt(e.price), 6, 6)} NRX
    network: [${net}],
    description: ${JSON.stringify(e.name)},
  },
}`;
  const common = `// NRX (6 decimals, EIP-3009). Addresses per chain:
${nrx}
const NRX = { symbol: "NRX", decimals: 6, eip712: { name: "NeroX USD", version: "1" } };
const facilitator = { url: "${SERVICES.facilitator}" }; // NeroX facilitator`;
  if (fw === "next")
    return `// middleware.ts
import { paymentMiddleware } from "@x402/next";
${common}

export const middleware = paymentMiddleware("${payTo}", ${cfg}, facilitator);
export const config = { matcher: ["${route}"] };`;
  if (fw === "hono")
    return `import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
${common}

const app = new Hono();
app.use(paymentMiddleware("${payTo}", ${cfg}, facilitator));
app.get("${route}", (c) => c.json({ ok: true }));
export default app;`;
  return `import express from "express";
import { paymentMiddleware } from "@x402/express";
${common}

const app = express();
app.use(paymentMiddleware("${payTo}", ${cfg}, facilitator));
app.get("${route}", (req, res) => res.json({ ok: true }));
app.listen(3000);

// Challenges are served in x402 v1 (JSON body) and v2 (PAYMENT-REQUIRED header),
// so agents on x402-fetch v1 and @x402/fetch v2 can both pay.`;
}

function SignIn({ onToken }: { onToken: (t: string) => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const { message } = await fetch(`${SERVICES.facilitator}/console/nonce?address=${address}`).then((r) => r.json());
      const signature = await signMessageAsync({ message });
      const r = await fetch(`${SERVICES.facilitator}/console/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, message, signature }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onToken(j.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-lg stack" style={{ maxWidth: 560 }}>
      <h2>Sign in with your payout wallet</h2>
      <p className="muted">Payments for your endpoints go straight to this wallet. Signing in is a message signature — it does not move funds.</p>
      <ActionButton onClick={go} busy={busy} reason={!address ? "Connect a wallet to continue." : null}>Sign in with Ethereum</ActionButton>
      {err && <Notice tone="danger">{err}</Notice>}
    </div>
  );
}

function AddEndpoint({ token, onAdded }: { token: string; onAdded: () => void }) {
  const [name, setName] = useState("Forecast API");
  const [url, setUrl] = useState("https://api.example.com/v1/forecast");
  const [price, setPrice] = useState("0.01");
  const [chains, setChains] = useState<number[]>([CHAINS.base.id]);
  const [fw, setFw] = useState("express");
  const [err, setErr] = useState("");
  const add = async () => {
    setErr("");
    const r = await fetch(`${SERVICES.facilitator}/console/endpoints`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, urlPattern: url, price, chains, framework: fw }),
    });
    const j = await r.json();
    if (!r.ok) return setErr(j.error);
    onAdded();
  };
  const priceOk = parseAmount(price) !== undefined && Number(price) > 0;
  return (
    <div className="card stack">
      <h2>Add an endpoint</h2>
      <div className="grid grid-2">
        <div className="field"><label htmlFor="ep-name">Name</label><input id="ep-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="ep-price">Price per request</label>
          <div className="amount"><input id="ep-price" className="input" inputMode="decimal" value={price} onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setPrice(e.target.value)} /><span className="unit">NRX</span></div>
        </div>
      </div>
      <div className="field"><label htmlFor="ep-url">URL pattern</label><input id="ep-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
      <div className="row-2">
        <fieldset className="row" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>Chains</legend>
          {CHAIN_KEYS.map((k) => (
            <label key={k} className="checkbox" style={{ marginRight: 16 }}>
              <input type="checkbox" checked={chains.includes(CHAINS[k].id)} onChange={(e) => setChains(e.target.checked ? [...chains, CHAINS[k].id] : chains.filter((c) => c !== CHAINS[k].id))} />
              <span>{CHAINS[k].name}</span>
            </label>
          ))}
        </fieldset>
        <div className="field"><label htmlFor="ep-fw">Framework</label>
          <select id="ep-fw" className="input" value={fw} onChange={(e) => setFw(e.target.value)} style={{ width: "auto" }}>
            {FRAMEWORKS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
      </div>
      <button className="btn btn-primary" onClick={add} disabled={!name || !url || !priceOk || !chains.length}>Add endpoint</button>
      {err && <Notice tone="danger">{err}</Notice>}
    </div>
  );
}

function EndpointCard({ e, token, payTo, onDelete }: { e: Endpoint; token: string; payTo: string; onDelete: () => void }) {
  const [fw, setFw] = useState(e.framework || "express");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState<1 | 2>(2);
  const code = snippet(fw, e, payTo);
  const test = async () => {
    setBusy(true);
    setSteps(null);
    const r = await fetch(`${SERVICES.facilitator}/console/endpoints/${e.id}/test-pay`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ version }) });
    const j = await r.json();
    setSteps(j.steps ?? []);
    setBusy(false);
  };
  return (
    <div className="card stack">
      <div className="between">
        <div className="stack-1">
          <h3>{e.name}</h3>
          <span className="mono small wrap">{e.urlPattern}</span>
        </div>
        <div className="row">
          <span className="chip chip-signal mono">{fmt(BigInt(e.price), 6, 6)} NRX</span>
          {e.chains.map((c) => <span key={c} className="chip">{CHAINS[chainKeyOf(c)!]?.name}</span>)}
        </div>
      </div>
      <Tabs value={fw} onChange={setFw} items={FRAMEWORKS.map((f) => ({ id: f.id, label: f.label }))} />
      <div style={{ position: "relative" }}>
        <pre className="code">{code}</pre>
        <button className="btn btn-sm" style={{ position: "absolute", top: 8, right: 8 }} onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="row-2">
        <div className="seg" role="group" aria-label="x402 version">
          <button aria-pressed={version === 2} onClick={() => setVersion(2)}>v2 client</button>
          <button aria-pressed={version === 1} onClick={() => setVersion(1)}>v1 client</button>
        </div>
        <button className="btn" onClick={test} disabled={busy}>{busy && <span className="dot live" />} Test pay once</button>
        <button className="btn btn-ghost btn-danger" onClick={onDelete}>Remove</button>
      </div>
      <p className="small">Test pay calls a hosted sandbox copy of this endpoint (<span className="mono">{short(e.sandboxUrl, 12)}</span>) with a built-in buyer, so you see a real 402 → pay → 200 cycle.</p>
      {steps && (
        <div className="steps" aria-live="polite">
          {steps.map((s, i) => (
            <div className="step" key={i}>
              <span className="n">{i + 1}</span>
              <span>
                {s.kind === "request" && "GET the endpoint without payment"}
                {s.kind === "challenge" && <>Server answers <span className="mono">402</span> with a v1 body and a v2 <span className="mono">PAYMENT-REQUIRED</span> header</>}
                {s.kind === "signed" && <>Buyer signs an EIP-3009 authorization (x402 v{s.version}) for <span className="mono">{fmt(BigInt(s.authorization!.value), 6, 6)} NRX</span> to <span className="mono">{short(s.authorization!.to)}</span></>}
                {s.kind === "result" && (s.status === 200 ? <>Facilitator settles on-chain; server answers <span className="mono">200</span> · tx <span className="mono">{short(s.settlement?.transaction, 6)}</span></> : <span className="danger">! Server answered {s.status}</span>)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutoSweep({ chain, address }: { chain: ChainKey; address: Address }) {
  const tx = useTx();
  const b = useBalances(chain, address);
  const rule = useRead(["rule", chain, address], async () => {
    const r = (await publicClients[chain].readContract({ address: contract(chain, "AutoSweeper"), abi: AutoSweeperAbi, functionName: "rules", args: [address] })) as readonly [boolean, bigint, bigint];
    return { enabled: r[0], threshold: r[1], keep: r[2] };
  });
  const [threshold, setThreshold] = useState("100");
  const [keep, setKeep] = useState("20");
  const [budget, setBudget] = useState("1000");
  const t = parseAmount(threshold), k = parseAmount(keep), bud = parseAmount(budget);
  const on = rule.data?.enabled;
  const sweeper = contract(chain, "AutoSweeper");
  const enable = () =>
    tx.run({ title: "Turn on auto-sweep", chain, total: 2, onDone: () => { rule.refetch(); b.refetch(); } }, async (h) => {
      await h.write({ address: sweeper, abi: AutoSweeperAbi, functionName: "setRule", args: [true, t, k] }, "Save rule");
      // Capped sweep budget — never an unlimited approval.
      await h.write({ address: contract(chain, "NRX"), abi: MockERC20Abi, functionName: "approve", args: [sweeper, bud] }, "Approve sweep budget");
    });
  const disable = () =>
    tx.run({ title: "Turn off auto-sweep", chain, total: 2, onDone: () => { rule.refetch(); b.refetch(); } }, async (h) => {
      await h.write({ address: sweeper, abi: AutoSweeperAbi, functionName: "setRule", args: [false, 0n, 0n] }, "Turn off rule");
      await h.write({ address: contract(chain, "NRX"), abi: MockERC20Abi, functionName: "approve", args: [sweeper, 0n] }, "Revoke sweep budget");
    });
  return (
    <div className="card stack">
      <div className="between">
        <h2>Auto-sweep revenue to sNRX</h2>
        <span className={`chip ${on ? "chip-yield" : ""}`}>{on ? "On" : "Off"}</span>
      </div>
      <p className="small">When your NRX payout balance passes the threshold, NeroX deposits the excess into sNRX for you. Off by default. Acts on {CHAINS[chain].name}.</p>
      {on ? (
        <>
          <Kv k="Threshold" v={fmtAmt(rule.data?.threshold, "NRX")} />
          <Kv k="Keep in wallet" v={fmtAmt(rule.data?.keep, "NRX")} />
          <Kv k="Sweep budget left" v={fmtAmt(b.data?.sweeperAllowance, "NRX")} />
          <Kv k="Your sNRX" v={fmtAmt(b.data?.snrxValue, "NRX")} tone="yield" />
          <button className="btn" onClick={disable} disabled={tx.state.busy}>Turn off</button>
        </>
      ) : (
        <>
          <div className="grid grid-3">
            <div className="field"><label htmlFor="sw-t">Threshold (NRX)</label><input id="sw-t" className="input mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
            <div className="field"><label htmlFor="sw-k">Keep (NRX)</label><input id="sw-k" className="input mono" value={keep} onChange={(e) => setKeep(e.target.value)} /></div>
            <div className="field"><label htmlFor="sw-b">Budget (NRX)</label><input id="sw-b" className="input mono" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
          </div>
          <ActionButton onClick={enable} busy={tx.state.busy} reason={!t || k === undefined || !bud ? "Enter a threshold, an amount to keep and a budget." : k! > t! ? "Keep must not exceed the threshold." : null}>
            Turn on auto-sweep
          </ActionButton>
        </>
      )}
      <TxStatus state={tx.state} />
      <p className="small">sNRX returns come from Morpho borrowers. They vary and are not guaranteed.</p>
    </div>
  );
}

export default function SellerConsole() {
  const { address } = useAccount();
  const { chain } = useApp();
  const [token, setToken] = useSession(address);
  const eps = useQuery_endpoints(token);
  const pays = useApi<{ items: Payment[]; total: number }>(address ? `/payments?payTo=${address}&limit=50` : null, "facilitator", 2_000);
  const stats = useApi<{ requests: number; revenue: string; payers: number; last24h: { requests: number; revenue: string } }>(address ? `/stats?payTo=${address}` : null, "facilitator", 2_000);
  const health = useApi<{ status: string; chains: Record<string, { block: number; gasBalance: string }> }>("/health", "facilitator", 5_000);
  const supported = useApi<{ kinds: { x402Version: number; network: string }[] }>("/supported", "facilitator", 60_000);

  // Console sessions live in the facilitator; a restart signs you out.
  useEffect(() => {
    if (eps.isError) setToken(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eps.isError]);

  const del = async (id: string) => {
    await fetch(`${SERVICES.facilitator}/console/endpoints/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    eps.refetch();
  };

  return (
    <>
      <section className="hero-panel dots stack" style={{ marginBottom: 24 }}>
        <span className="label">x402 Seller Console</span>
        <h1>Get paid in NRX for every request</h1>
        <p className="muted" style={{ maxWidth: 640 }}>
          Price an API or agent endpoint in NRX, paste the middleware, and agents pay per call — no accounts, no API keys. Settled by the NeroX facilitator
          on Base and Ethereum.
        </p>
        <div className="row">
          <span className="chip chip-signal"><span className={`dot ${health.data?.status === "ok" ? "live" : "danger"}`} /> Facilitator {health.data?.status === "ok" ? "online" : "unreachable"}</span>
          {supported.data && <span className="chip mono" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{supported.data.kinds.map((k) => `v${k.x402Version}:${k.network}`).join(" · ")}</span>}
        </div>
      </section>

      {!address || !token ? (
        <SignIn onToken={(t) => { setToken(t); }} />
      ) : (
        <div className="stack-3">
          <div className="grid grid-4">
            <div className="card"><Stat label="Requests paid" value={stats.data?.requests ?? "—"} tone="signal" /></div>
            <div className="card"><Stat label="Revenue" value={stats.data ? fmtAmt(BigInt(stats.data.revenue), "NRX", 6, 4) : "—"} tone="signal" /></div>
            <div className="card"><Stat label="Unique payers" value={stats.data?.payers ?? "—"} /></div>
            <div className="card"><Stat label="Last 24 h" value={stats.data ? fmtAmt(BigInt(stats.data.last24h.revenue), "NRX", 6, 4) : "—"} sub={stats.data ? `${stats.data.last24h.requests} requests` : undefined} /></div>
          </div>
          <div className="grid split">
            <div className="stack-3">
              {eps.data?.items.map((e) => <EndpointCard key={e.id} e={e} token={token} payTo={address} onDelete={() => del(e.id)} />)}
              <AddEndpoint token={token} onAdded={() => eps.refetch()} />
            </div>
            <div className="stack-3">
              <AutoSweep chain={chain} address={address} />
              <div className="card stack-1">
                <h2>Payout wallet</h2>
                <span className="mono small wrap">{address}</span>
                <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setToken(null)}>Sign out</button>
              </div>
            </div>
          </div>
          <section className="stack">
            <div className="between">
              <h2>Payments</h2>
              <span className="row small"><span className="dot live" /> Live from the facilitator's settle log</span>
            </div>
            <div className="table-wrap">
              {pays.data?.items.length ? (
                <table className="table">
                  <thead><tr><th>Time</th><th>Payer</th><th className="num">Amount</th><th>Chain</th><th className="hide-sm">Resource</th><th>Tx</th></tr></thead>
                  <tbody>
                    {pays.data.items.map((p) => (
                      <tr key={p.id}>
                        <td className="small">{ago(p.time)}</td>
                        <td className="mono small">{short(p.payer)}</td>
                        <td className="num mono signal">{fmt(BigInt(p.amount), 6, 4)} NRX</td>
                        <td className="small">{CHAINS[p.chain]?.name} · v{p.x402Version}</td>
                        <td className="small hide-sm truncate" style={{ maxWidth: 220 }}>{p.resource}</td>
                        <td className="mono small">{short(p.tx, 6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No payments yet. Add an endpoint and press “Test pay once”.</Empty>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function useQuery_endpoints(token: string | null) {
  return useRead(["endpoints", token], async () => {
    const r = await fetch(`${SERVICES.facilitator}/console/endpoints`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("auth");
    return (await r.json()) as { items: Endpoint[] };
  }, { enabled: Boolean(token), interval: 10_000 });
}
