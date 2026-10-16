// NeroX x402 facilitator (/verify, /settle, /supported) plus the Seller Console API.
// Facilitator keys live only in this process — never on the frontend host.
import express from "express";
import cors from "cors";
import { randomUUID, randomBytes } from "node:crypto";
import { verifyMessage, getAddress, formatUnits } from "viem";
import { verifyExactPayment, settleExactPayment } from "@nerox/x402/verify";
import { wrapFetchWithPayment, NETWORKS, normaliseRequirement } from "@nerox/x402";
import { publicClients, wallet, keyByChainId, deployment, chainKeys, addr, account, serial, write, chainNow } from "./chain.js";
import { abi, FEES, URLS } from "./config.js";
import { jsonStore, json } from "./store.js";

const settlements = jsonStore("settlements", { items: [] });
const endpoints = jsonStore("endpoints", { items: [] });
const sessions = new Map(); // token -> { address, expires }
const challenges = new Map(); // address -> nonce
const listeners = new Set();

function emit(event) {
  for (const res of listeners) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function isSanctioned(chainKey, address) {
  return publicClients[chainKey].readContract({
    address: addr(chainKey, "SanctionsOracle"),
    abi: abi("MockSanctionsOracle"),
    functionName: "isSanctioned",
    args: [address],
  });
}

function chainForRequirement(r) {
  const chainId = normaliseRequirement(r).chainId;
  const key = keyByChainId(chainId);
  if (!key) throw Object.assign(new Error("invalid_network"), { status: 400 });
  return key;
}

// ------------------------------------------------------------------ keeper hooks

async function maybeSweep(chainKey, payTo) {
  try {
    const sweeper = addr(chainKey, "AutoSweeper");
    const amount = await publicClients[chainKey].readContract({ address: sweeper, abi: abi("AutoSweeper"), functionName: "sweepable", args: [payTo] });
    if (amount === 0n) return;
    const { hash } = await write(wallet("keeper", chainKey), chainKey, { address: sweeper, abi: abi("AutoSweeper"), functionName: "sweep", args: [payTo] });
    emit({ type: "sweep", chain: chainKey, payTo, amount: amount.toString(), tx: hash });
  } catch (e) {
    console.warn("[keeper] sweep failed", e.shortMessage ?? e.message);
  }
}

export function startFacilitator(port) {
  const app = express();
  app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    const out = {};
    for (const k of chainKeys) {
      const pc = publicClients[k];
      const [block, gas] = await Promise.all([pc.getBlockNumber(), pc.getBalance({ address: account("facilitator").address })]);
      out[k] = { chainId: deployment.chains[k].chainId, block: Number(block), gasWallet: account("facilitator").address, gasBalance: formatUnits(gas, 18) };
    }
    res.json({ status: "ok", chains: out, settlements: settlements.data.items.length });
  });

  app.get("/supported", (_req, res) => {
    const kinds = [];
    for (const k of chainKeys) {
      const id = deployment.chains[k].chainId;
      kinds.push({ x402Version: 1, scheme: "exact", network: NETWORKS[id].v1 });
      kinds.push({ x402Version: 2, scheme: "exact", network: NETWORKS[id].caip2 });
    }
    res.json({ kinds, extensions: ["bazaar"], signers: { "eip155:*": [account("facilitator").address] } });
  });

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body;
      const k = chainForRequirement(paymentRequirements);
      const r = await verifyExactPayment({ paymentPayload, paymentRequirements, publicClient: publicClients[k], isSanctioned: (a) => isSanctioned(k, a) });
      res.status(r.isValid ? 200 : 400).json(r);
    } catch (e) {
      res.status(400).json({ isValid: false, invalidReason: e.message });
    }
  });

  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements, meta } = req.body;
      const k = chainForRequirement(paymentRequirements);
      const gas = wallet("facilitator", k);
      const r = await serial(`${gas.account.address}:${k}`, () =>
        settleExactPayment({ paymentPayload, paymentRequirements, publicClient: publicClients[k], walletClient: gas, isSanctioned: (a) => isSanctioned(k, a) }),
      );
      if (r.success) {
        const n = normaliseRequirement(paymentRequirements);
        const market = Boolean(meta?.agentId);
        const item = {
          id: randomUUID(),
          time: Date.now(),
          chain: k,
          chainId: n.chainId,
          network: paymentRequirements.network,
          x402Version: paymentPayload.x402Version,
          payer: r.payer,
          payTo: getAddress(n.payTo),
          amount: n.amount.toString(),
          // Market calls carry a 1% NeroX fee, invoiced to the seller (see README).
          fee: market ? ((n.amount * BigInt(FEES.callBps)) / 10_000n).toString() : "0",
          asset: n.asset,
          tx: r.transaction,
          blockNumber: r.blockNumber,
          resource: meta?.resource ?? paymentRequirements.resource ?? "",
          meta: meta ?? {},
        };
        settlements.data.items.push(item);
        settlements.save();
        emit({ type: "settlement", ...item });
        maybeSweep(k, item.payTo);
      }
      res.status(r.success ? 200 : 400).json(r);
    } catch (e) {
      res.status(400).json({ success: false, errorReason: e.message, transaction: "", network: req.body?.paymentRequirements?.network ?? "" });
    }
  });

  app.get("/payments", (req, res) => {
    const { payTo, payer, chain, agentId, since } = req.query;
    let items = settlements.data.items;
    if (payTo) items = items.filter((i) => i.payTo.toLowerCase() === String(payTo).toLowerCase());
    if (payer) items = items.filter((i) => i.payer.toLowerCase() === String(payer).toLowerCase());
    if (chain) items = items.filter((i) => i.chain === chain);
    if (agentId) items = items.filter((i) => String(i.meta?.agentId) === String(agentId));
    if (since) items = items.filter((i) => i.time > Number(since));
    const limit = Math.min(Number(req.query.limit ?? 100), 5000);
    res.json({ items: items.slice(-limit).reverse(), total: items.length });
  });

  app.get("/stats", (req, res) => {
    const { payTo } = req.query;
    let items = settlements.data.items;
    if (payTo) items = items.filter((i) => i.payTo.toLowerCase() === String(payTo).toLowerCase());
    const dayAgo = Date.now() - 86_400_000;
    const sum = (xs) => xs.reduce((a, i) => a + BigInt(i.amount), 0n).toString();
    res.json({
      requests: items.length,
      revenue: sum(items),
      fees: items.reduce((a, i) => a + BigInt(i.fee), 0n).toString(),
      payers: new Set(items.map((i) => i.payer)).size,
      last24h: { requests: items.filter((i) => i.time > dayAgo).length, revenue: sum(items.filter((i) => i.time > dayAgo)) },
      byChain: Object.fromEntries(chainKeys.map((k) => [k, sum(items.filter((i) => i.chain === k))])),
    });
  });

  app.get("/events", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
    listeners.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      listeners.delete(res);
    });
  });

  // ---------------------------------------------------------------- seller console

  const auth = (req, res, next) => {
    const token = (req.get("authorization") ?? "").replace(/^Bearer /, "");
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) return res.status(401).json({ error: "Sign in with your payout wallet" });
    req.owner = s.address;
    next();
  };

  // Sign-in with Ethereum (EIP-4361 style message), one signature per session.
  app.get("/console/nonce", (req, res) => {
    const address = getAddress(String(req.query.address));
    const nonce = randomBytes(8).toString("hex");
    challenges.set(address, nonce);
    const message =
      `app.nerox wants you to sign in with your Ethereum account:\n${address}\n\n` +
      `Sign in to the NeroX Seller Console. This does not move funds.\n\n` +
      `URI: ${URLS.facilitator}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    res.json({ message });
  });

  app.post("/console/login", async (req, res) => {
    const { address, message, signature } = req.body;
    const a = getAddress(address);
    const nonce = challenges.get(a);
    if (!nonce || !message.includes(`Nonce: ${nonce}`)) return res.status(400).json({ error: "Unknown or reused nonce" });
    const ok = await verifyMessage({ address: a, message, signature }).catch(() => false);
    if (!ok) return res.status(401).json({ error: "Bad signature" });
    for (const k of chainKeys) if (await isSanctioned(k, a)) return res.status(403).json({ error: "This wallet failed sanctions screening" });
    challenges.delete(a);
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { address: a, expires: Date.now() + 12 * 3600_000 });
    res.json({ token, address: a });
  });

  app.get("/console/endpoints", auth, (req, res) => {
    res.json({ items: endpoints.data.items.filter((e) => e.owner === req.owner) });
  });

  app.post("/console/endpoints", auth, (req, res) => {
    const { name, urlPattern, price, chains: chainIds, description, framework } = req.body;
    if (!name || !urlPattern || !price) return res.status(400).json({ error: "Name, URL pattern and price are required" });
    const amount = BigInt(Math.round(Number(price) * 1e6));
    if (amount <= 0n || amount > 1_000_000_000n) return res.status(400).json({ error: "Price must be between 0.000001 and 1,000 NRX" });
    const ids = (chainIds?.length ? chainIds : [deployment.chains.base.chainId]).map(Number).filter((c) => keyByChainId(c));
    const item = {
      id: randomUUID().slice(0, 8),
      owner: req.owner,
      name: String(name).slice(0, 80),
      urlPattern: String(urlPattern).slice(0, 300),
      description: String(description ?? "").slice(0, 300),
      price: amount.toString(),
      chains: ids,
      framework: framework ?? "express",
      createdAt: Date.now(),
      sandboxUrl: "",
    };
    item.sandboxUrl = `${URLS.agents}/sandbox/${item.id}`;
    endpoints.data.items.push(item);
    endpoints.save();
    res.json(item);
  });

  app.delete("/console/endpoints/:id", auth, (req, res) => {
    endpoints.data.items = endpoints.data.items.filter((e) => !(e.id === req.params.id && e.owner === req.owner));
    endpoints.save();
    res.json({ ok: true });
  });

  // Public lookup used by the hosted sandbox endpoint.
  app.get("/console/endpoints/:id/public", (req, res) => {
    const e = endpoints.data.items.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "not found" });
    res.json(e);
  });

  app.get("/console/all-endpoints", (_req, res) => res.json({ items: endpoints.data.items }));

  // Built-in test buyer pays the endpoint once so the seller sees 402 → pay → 200.
  app.post("/console/endpoints/:id/test-pay", auth, async (req, res) => {
    const e = endpoints.data.items.find((x) => x.id === req.params.id && x.owner === req.owner);
    if (!e) return res.status(404).json({ error: "not found" });
    const steps = [];
    const buyer = account("carol");
    const chainId = Number(req.body?.chainId ?? e.chains[0]);
    const k = keyByChainId(chainId);
    const pay = wrapFetchWithPayment(fetch, buyer, {
      maxAmount: 1_000_000_000n,
      acceptAsset: (asset, cid) => cid === chainId && asset.toLowerCase() === addr(k, "NRX").toLowerCase(),
      preferVersion: req.body?.version === 1 ? 1 : 2,
      onStep: (s) => steps.push(json(s)),
      now: chainNow,
    });
    try {
      const r = await pay(`${e.sandboxUrl}?chainId=${chainId}`);
      const body = await r.json().catch(() => ({}));
      res.json({ ok: r.status === 200, status: r.status, body, steps, buyer: buyer.address });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message, steps });
    }
  });

  return app.listen(port, () => console.log(`[facilitator] listening on :${port}`));
}

export { settlements, endpoints, emit };
