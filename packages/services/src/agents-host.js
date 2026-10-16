// Hosts the 20 seeded demo agents: ERC-8004 registration files, A2A Agent Cards, x402-paid
// call endpoints, and workers that deliver ERC-8183 jobs and run the demo evaluators.
// Also hosts sandbox endpoints for sellers who register an endpoint in the Seller Console.
import express from "express";
import cors from "cors";
import { keccak256, toHex, getAddress } from "viem";
import { paymentMiddleware } from "@nerox/x402/server";
import { deployment, publicClients, addr, walletAt, write, account, keyByChainId } from "./chain.js";
import { abi, URLS } from "./config.js";
import { runAgent, deliverableFor } from "./brains.js";
import { jsonStore } from "./store.js";

const BASE = "base";
const base = deployment.chains[BASE];
const deliverables = jsonStore("deliverables", {});
const catalog = deployment.agents;
const bySlug = Object.fromEntries(catalog.map((a) => [a.slug, a]));
const ownerIndex = Object.fromEntries([0, 1, 2, 3].map((i) => [deployment.accounts[`owner${i}`].address.toLowerCase(), deployment.accounts[`owner${i}`].index]));

const u6 = (s) => BigInt(Math.round(Number(s) * 1e6));

// Agent wallets change on sale: read them from the Identity Registry, cached briefly.
const walletCache = new Map();
async function agentWallet(agentId) {
  const hit = walletCache.get(agentId);
  if (hit && hit.at > Date.now() - 5_000) return hit.wallet;
  const w = await publicClients[BASE].readContract({ address: addr(BASE, "IdentityRegistry"), abi: abi("IdentityRegistry"), functionName: "getAgentWallet", args: [BigInt(agentId)] });
  walletCache.set(agentId, { wallet: w, at: Date.now() });
  return w;
}

export function registrationFile(a, wallet) {
  const root = `${URLS.agents}/agents/${a.slug}`;
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: a.name,
    description: a.description,
    image: `${root}/avatar.svg`,
    endpoints: [
      { name: "A2A", endpoint: `${root}/.well-known/agent-card.json`, version: "1.0" },
      { name: "x402", endpoint: `${root}/call`, version: "2" },
      { name: "agentWallet", endpoint: `eip155:${base.chainId}:${wallet}` },
    ],
    registrations: [{ agentId: a.agentId, agentRegistry: `eip155:${base.chainId}:${addr(BASE, "IdentityRegistry")}` }],
    supportedTrust: ["reputation", "crypto-economic"],
    nerox: {
      category: a.category,
      skills: a.skills,
      input: a.input,
      x402: [{ resource: `${root}/call`, network: `eip155:${base.chainId}`, asset: addr(BASE, "NRX"), amount: u6(a.price).toString(), symbol: "NRX" }],
      jobs: a.jobs.map((j) => ({ ...j, budgetBaseUnits: u6(j.budget).toString() })),
    },
  };
}

function agentCard(a) {
  const root = `${URLS.agents}/agents/${a.slug}`;
  return {
    protocolVersion: "1.0",
    name: a.name,
    description: a.description,
    url: `${root}/a2a`,
    version: "1.0.0",
    provider: { organization: "NeroX demo agents", url: URLS.agents },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json"],
    securitySchemes: { x402: { type: "http", scheme: "x402", description: `Pay ${a.price} NRX per call over x402` } },
    skills: [{ id: a.slug, name: a.name, description: a.description, tags: a.skills, examples: [`${a.input}: …`] }],
    // A2A v1.0 supports JWS-signed cards; the market only trusts signed cards in production.
    signatures: [],
  };
}

function avatar(a) {
  const colors = { data: "#0E7C86", research: "#13235B", "code review": "#4A5568", content: "#0B1220" };
  const initials = a.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="16" fill="${colors[a.category] ?? "#13235B"}"/><text x="48" y="58" font-family="Space Grotesk, sans-serif" font-size="34" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
}

export function startAgentsHost(port) {
  const app = express();
  app.set("trust proxy", true);
  app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));
  app.use(express.json());

  app.get("/agents", (_req, res) => res.json({ items: catalog.map((a) => ({ slug: a.slug, agentId: a.agentId, name: a.name, price: a.price })) }));

  app.get("/agents/:slug/registration.json", async (req, res) => {
    const a = bySlug[req.params.slug];
    if (!a) return res.status(404).json({ error: "unknown agent" });
    res.json(registrationFile(a, await agentWallet(a.agentId)));
  });

  app.get("/agents/:slug/.well-known/agent-card.json", (req, res) => {
    const a = bySlug[req.params.slug];
    if (!a) return res.status(404).json({ error: "unknown agent" });
    res.json(agentCard(a));
  });

  app.get("/agents/:slug/avatar.svg", (req, res) => {
    const a = bySlug[req.params.slug];
    if (!a) return res.status(404).end();
    res.type("image/svg+xml").send(avatar(a));
  });

  app.get("/agents/:slug/health", (req, res) => res.json({ ok: Boolean(bySlug[req.params.slug]), at: Date.now() }));

  const agentPaywall = paymentMiddleware({
    facilitatorUrl: URLS.facilitator,
    price: async (req) => {
      const a = bySlug[req.params.slug];
      if (!a) return undefined;
      return [{ chainId: base.chainId, asset: addr(BASE, "NRX"), payTo: await agentWallet(a.agentId), amount: u6(a.price), description: `${a.name}: ${a.description}`, maxTimeoutSeconds: 120 }];
    },
    meta: (req) => ({ agentId: bySlug[req.params.slug]?.agentId, slug: req.params.slug, resource: `/agents/${req.params.slug}/call` }),
  });

  app.all("/agents/:slug/call", agentPaywall, (req, res) => {
    const a = bySlug[req.params.slug];
    if (!a) return res.status(404).json({ error: "unknown agent" });
    const input = String(req.query.q ?? req.body?.input ?? "");
    res.json({ agent: a.slug, input, output: runAgent(a.slug, input), paid: req.x402 && { tx: req.x402.transaction, payer: req.x402.payer, version: req.x402.version } });
  });

  // Hosted endpoint for agents registered through "Sell an agent".
  const hostedPaywall = paymentMiddleware({
    facilitatorUrl: URLS.facilitator,
    price: async (req) => {
      const reg = await fetch(`${URLS.market}/agents/${req.params.agentId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const price = reg?.price;
      if (!price) return undefined;
      return [{ chainId: base.chainId, asset: addr(BASE, "NRX"), payTo: await agentWallet(Number(req.params.agentId)), amount: BigInt(price), description: reg.name, maxTimeoutSeconds: 120 }];
    },
    meta: (req) => ({ agentId: Number(req.params.agentId), resource: `/hosted/${req.params.agentId}/call` }),
  });
  app.all("/hosted/:agentId/call", hostedPaywall, (req, res) => {
    const input = String(req.query.q ?? req.body?.input ?? "");
    res.json({ agentId: Number(req.params.agentId), input, output: { echo: input, note: "Hosted by NeroX demo host" }, paid: req.x402 && { tx: req.x402.transaction, payer: req.x402.payer } });
  });

  // Sandbox endpoint for Seller Console registrations: priced from the console's config.
  const sandboxPaywall = paymentMiddleware({
    facilitatorUrl: URLS.facilitator,
    price: async (req) => {
      const e = await fetch(`${URLS.facilitator}/console/endpoints/${req.params.id}/public`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!e) return undefined;
      req.endpoint = e;
      const only = req.query.chainId ? [Number(req.query.chainId)] : e.chains;
      return e.chains.filter((c) => only.includes(c)).map((chainId) => {
        const k = keyByChainId(chainId);
        return { chainId, asset: addr(k, "NRX"), payTo: e.owner, amount: BigInt(e.price), description: e.name, maxTimeoutSeconds: 120 };
      });
    },
    meta: (req) => ({ endpointId: req.params.id, resource: req.endpoint?.urlPattern }),
  });
  app.all("/sandbox/:id", sandboxPaywall, (req, res) => {
    if (!req.endpoint) return res.status(404).json({ error: "unknown endpoint" });
    res.json({ ok: true, endpoint: req.endpoint.name, pattern: req.endpoint.urlPattern, message: "Paid request served", paid: { tx: req.x402.transaction, payer: req.x402.payer, version: req.x402.version } });
  });

  app.get("/deliverables/:jobId", (req, res) => {
    const d = deliverables.data[req.params.jobId];
    if (!d) return res.status(404).json({ error: "not found" });
    res.json(d.content);
  });

  startJobWorkers();
  return app.listen(port, () => console.log(`[agents] hosting ${catalog.length} agents on :${port}`));
}

// ------------------------------------------------------------------ job workers

const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const scheduled = new Set();

function startJobWorkers() {
  const jobsAddr = addr(BASE, "NeroJobs");
  const jobsAbi = abi("NeroJobs");
  const pc = publicClients[BASE];
  const contractEval = account("contractEvaluator").address.toLowerCase();
  const poolBots = new Map([
    [deployment.accounts.eval2.address.toLowerCase(), deployment.accounts.eval2.index],
    [deployment.accounts.eval3.address.toLowerCase(), deployment.accounts.eval3.index],
  ]);
  const agentById = Object.fromEntries(catalog.map((a) => [a.agentId, a]));
  let from = 0;

  const later = (key, ms, fn) => {
    if (scheduled.has(key)) return;
    scheduled.add(key);
    setTimeout(() => fn().catch((e) => {
      console.warn(`[agents] ${key} failed:`, e.shortMessage ?? e.message);
      scheduled.delete(key);
    }), ms);
  };

  const tick = async () => {
    const count = Number(await pc.readContract({ address: jobsAddr, abi: jobsAbi, functionName: "jobCount" }));
    let lowestOpen = count;
    for (let id = from; id < count; id++) {
      const j = await pc.readContract({ address: jobsAddr, abi: jobsAbi, functionName: "getJob", args: [BigInt(id)] });
      const status = STATUS[j.status];
      if (["Open", "Funded", "Submitted"].includes(status)) lowestOpen = Math.min(lowestOpen, id);
      const agent = agentById[Number(j.agentId)];
      const providerIdx = ownerIndex[j.provider.toLowerCase()];

      // Seeded agents deliver funded jobs on their own.
      if (status === "Funded" && agent && providerIdx !== undefined) {
        later(`submit:${id}`, 6_000, async () => {
          const content = deliverableFor(agent.slug, j.description, id);
          const hash = keccak256(toHex(JSON.stringify(content)));
          deliverables.data[id] = { hash, content };
          deliverables.save();
          await write(walletAt(providerIdx, BASE), BASE, { address: jobsAddr, abi: jobsAbi, functionName: "submit", args: [BigInt(id), hash] });
          console.log(`[agents] ${agent.slug} delivered job #${id}`);
        });
      }
      // Contract evaluator: deterministic check that the delivered hash matches the file.
      if (status === "Submitted" && j.evaluator.toLowerCase() === contractEval) {
        later(`eval:${id}`, 4_000, async () => {
          const d = deliverables.data[id];
          const pass = d ? d.hash === j.deliverable : j.deliverable !== "0x" + "0".repeat(64);
          const reason = toHex(pass ? "hash verified" : "hash mismatch", { size: 32 });
          await write(walletAt(deployment.accounts.contractEvaluator.index, BASE), BASE, {
            address: jobsAddr, abi: jobsAbi, functionName: pass ? "complete" : "reject", args: [BigInt(id), reason],
          });
          console.log(`[agents] contract evaluator ${pass ? "completed" : "rejected"} job #${id}`);
        });
      }
      // Two of the three pool evaluators are bots; the third is the "Evaluator" demo persona.
      if (status === "Submitted" && poolBots.has(j.evaluator.toLowerCase())) {
        later(`pool:${id}`, 10_000, async () => {
          await write(walletAt(poolBots.get(j.evaluator.toLowerCase()), BASE), BASE, {
            address: jobsAddr, abi: jobsAbi, functionName: "complete", args: [BigInt(id), toHex("meets brief", { size: 32 })],
          });
          console.log(`[agents] pool evaluator completed job #${id}`);
        });
      }
    }
    from = lowestOpen;
  };

  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      console.warn("[agents] job worker:", e.shortMessage ?? e.message);
    }
    setTimeout(loop, 2_000);
  };
  loop();
}

export { getAddress };
