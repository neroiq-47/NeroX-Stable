// Market indexer + search API. Indexes ERC-8004, NeroJobs, AgentSale and facilitator
// settlements; ranks by paid-reviewer-only reputation; exposes the market itself to other
// agents as an A2A agent and an MCP server, and lists paid endpoints in Bazaar format.
// Also indexes protocol activity (PSM, sNRX, CCIP, Morpho, pool) for the dashboard.
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { parseEventLogs, formatUnits, parseUnits, getAddress } from "viem";
import { buildRequirements } from "@nerox/x402";
import { deployment, publicClients, chainKeys, addr, wallet, write } from "./chain.js";
import { abi, URLS, DEMO } from "./config.js";
import { jsonStore, json } from "./store.js";
import { setTraffic, trafficEnabled } from "./traffic.js";

const BASE = "base";
const registrations = jsonStore("registrations", {});
const state = {
  agents: {},
  jobs: {},
  feedback: [],
  payments: [],
  activity: [],
  uptime: {},
  cursors: {},
  lastPayment: 0,
  blockTimes: {},
  // Chain clock minus wall clock (ms). The demo can fast-forward chain time, so chain
  // timestamps are converted to wall-clock equivalents before they reach the UI.
  offset: {},
};
const wallTime = (chain, secs) => (secs ? Number(secs) * 1000 - (state.offset[chain] ?? 0) : 0);
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const KIND = ["Buyer", "Contract", "Pool"];
const fmt = (v) => formatUnits(BigInt(v), 6);

// ------------------------------------------------------------------ indexing

const sources = () => {
  const out = [];
  for (const k of chainKeys) {
    const c = deployment.chains[k].contracts;
    const add = (name, abiName) => c[name] && out.push({ chain: k, name, address: c[name], abi: abi(abiName) });
    add("NeroPSM", "NeroPSM");
    add("sNRX", "SNRX");
    add("TokenPool", "NeroTokenPool");
    add("AutoSweeper", "AutoSweeper");
    if (k === BASE) {
      add("Morpho", "MorphoBlueLite");
      add("AerodromePool", "StablePoolLite");
      add("IdentityRegistry", "IdentityRegistry");
      add("ReputationRegistry", "ReputationRegistry");
      add("NeroJobs", "NeroJobs");
      add("AgentSale", "AgentSale");
    }
  }
  return out;
};

async function blockTime(chain, bn) {
  const key = `${chain}:${bn}`;
  if (!state.blockTimes[key]) {
    const b = await publicClients[chain].getBlock({ blockNumber: bn });
    state.blockTimes[key] = wallTime(chain, b.timestamp);
  }
  return state.blockTimes[key];
}

function agent(id) {
  id = Number(id);
  if (!state.agents[id]) state.agents[id] = { agentId: id, transfers: [], sale: null, offers: [], sales: [] };
  return state.agents[id];
}

const marketNames = Object.fromEntries(
  Object.entries(deployment.chains.base.markets ?? {}).map(([sym, m]) => [m.id, sym]),
);

async function refreshJob(id) {
  const j = await publicClients[BASE].readContract({ address: addr(BASE, "NeroJobs"), abi: abi("NeroJobs"), functionName: "getJob", args: [BigInt(id)] });
  const prev = state.jobs[id] ?? { events: [] };
  state.jobs[id] = {
    ...prev,
    jobId: Number(id),
    client: j.client,
    provider: j.provider,
    evaluator: j.evaluator,
    agentId: Number(j.agentId),
    budget: j.budget.toString(),
    evaluatorFee: j.evaluatorFee.toString(),
    bondLocked: j.bondLocked.toString(),
    bondOwner: j.bondOwner,
    createdAt: wallTime(BASE, j.createdAt),
    fundedAt: wallTime(BASE, j.fundedAt),
    submittedAt: wallTime(BASE, j.submittedAt),
    expiredAt: wallTime(BASE, j.expiredAt),
    status: STATUS[j.status],
    kind: KIND[j.kind],
    deliverable: j.deliverable,
    description: j.description,
  };
}

async function handle(src, ev) {
  const time = await blockTime(src.chain, ev.blockNumber);
  const a = ev.args;
  const tx = ev.transactionHash;
  const act = (type, accounts, extra) => state.activity.push({ chain: src.chain, type, accounts: accounts.filter(Boolean).map((x) => x.toLowerCase()), tx, time, ...json(extra) });

  switch (`${src.name}.${ev.eventName}`) {
    case "IdentityRegistry.Registered": {
      const ag = agent(a.agentId);
      Object.assign(ag, { owner: a.owner, uri: a.tokenURI, registeredAt: time, wallet: ag.wallet ?? a.owner });
      ag.registration = undefined;
      break;
    }
    case "IdentityRegistry.UriUpdated":
      Object.assign(agent(a.agentId), { uri: a.newUri, registration: undefined });
      break;
    case "IdentityRegistry.AgentWalletSet":
      agent(a.agentId).wallet = a.wallet;
      break;
    case "IdentityRegistry.Transfer":
      if (a.from !== "0x0000000000000000000000000000000000000000") {
        const ag = agent(a.tokenId);
        ag.owner = a.to;
        ag.transfers.push({ from: a.from, to: a.to, tx, time });
      }
      break;
    case "ReputationRegistry.NewFeedback":
      state.feedback.push({ agentId: Number(a.agentId), client: a.clientAddress, score: Number(a.score), tag: hexToTag(a.tag1), tx, time });
      break;
    case "NeroJobs.JobCreated":
    case "NeroJobs.BudgetSet":
    case "NeroJobs.JobFunded":
    case "NeroJobs.JobSubmitted":
    case "NeroJobs.JobCompleted":
    case "NeroJobs.JobRejected":
    case "NeroJobs.JobExpired": {
      await refreshJob(a.jobId);
      const j = state.jobs[Number(a.jobId)];
      j.events.push({ type: ev.eventName.replace("Job", ""), tx, time, ...(a.reason ? { reason: hexToTag(a.reason) } : {}), ...(a.slashed !== undefined ? { slashed: a.slashed.toString() } : {}) });
      act(`job.${ev.eventName}`, [j.client, j.provider, j.evaluator], { jobId: j.jobId, agentId: j.agentId, amount: j.budget });
      break;
    }
    case "AgentSale.Listed":
      agent(a.agentId).sale = { seller: a.seller, price: a.price.toString(), listedAt: time };
      break;
    case "AgentSale.Unlisted":
      agent(a.agentId).sale = null;
      break;
    case "AgentSale.Sold": {
      const ag = agent(a.agentId);
      ag.sale = null;
      ag.sales.push({ seller: a.seller, buyer: a.buyer, price: a.price.toString(), fee: a.fee.toString(), tx, time });
      act("market.Sold", [a.seller, a.buyer], { agentId: Number(a.agentId), amount: a.price });
      break;
    }
    case "AgentSale.OfferMade":
      agent(a.agentId).offers.push({ offerId: Number(a.offerId), buyer: a.buyer, amount: a.amount.toString(), expiresAt: wallTime(BASE, a.expiresAt), active: true, time });
      break;
    case "AgentSale.OfferWithdrawn": {
      const o = agent(a.agentId).offers.find((x) => x.offerId === Number(a.offerId));
      if (o) o.active = false;
      break;
    }
    case "NeroPSM.Minted":
      act("psm.mint", [a.account, a.to], { amount: a.nrxOut, usdc: a.usdcIn });
      break;
    case "NeroPSM.Redeemed":
      act("psm.redeem", [a.account, a.to], { amount: a.nrxIn, usdc: a.usdcOut });
      break;
    case "sNRX.Deposit":
      act("snrx.deposit", [a.sender, a.owner], { amount: a.assets, shares: a.shares });
      break;
    case "sNRX.Withdraw":
      act("snrx.withdraw", [a.receiver, a.owner], { amount: a.assets, shares: a.shares });
      break;
    case "sNRX.WithdrawalRequested":
      act("snrx.queue", [a.owner], { requestId: Number(a.requestId), shares: a.shares });
      break;
    case "sNRX.FeeIncome":
      act("snrx.fee", [a.from], { amount: a.assets });
      break;
    case "TokenPool.CCIPSendRequested":
      act("ccip.send", [a.sender, a.receiver], { amount: a.amount, messageId: a.messageId, dest: chainKeys.find((k) => deployment.chains[k].ccipSelector === a.destChainSelector.toString()) });
      break;
    case "TokenPool.CCIPMessageExecuted":
      act("ccip.receive", [a.receiver], { amount: a.amount, messageId: a.messageId });
      break;
    case "AutoSweeper.Swept":
      act("sweep", [a.account], { amount: a.assets });
      break;
    case "Morpho.Borrow":
      act("morpho.borrow", [a.onBehalf], { amount: a.assets, market: marketNames[a.id] });
      break;
    case "Morpho.Repay":
      act("morpho.repay", [a.onBehalf], { amount: a.assets, market: marketNames[a.id] });
      break;
    case "Morpho.SupplyCollateral":
      act("morpho.collateral", [a.onBehalf], { collateral: a.assets, market: marketNames[a.id] });
      break;
    case "Morpho.WithdrawCollateral":
      act("morpho.withdrawCollateral", [a.onBehalf], { collateral: a.assets, market: marketNames[a.id] });
      break;
    case "Morpho.Liquidate":
      act("morpho.liquidate", [a.borrower, a.caller], { amount: a.repaidAssets, collateral: a.seizedAssets, market: marketNames[a.id] });
      break;
    case "AerodromePool.Swap":
      act("pool.swap", [a.sender, a.to], { amount: a.amountIn, out: a.amountOut, tokenIn: a.tokenIn });
      break;
    case "AerodromePool.Mint":
      act("pool.add", [a.sender], { amount0: a.amount0, amount1: a.amount1 });
      break;
    case "AerodromePool.Burn":
      act("pool.remove", [a.sender, a.to], { amount0: a.amount0, amount1: a.amount1 });
      break;
    default:
  }
}

function hexToTag(h) {
  if (!h) return "";
  const s = Buffer.from(h.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
  return /^[\x20-\x7e]*$/.test(s) ? s : "";
}

async function indexChains() {
  const srcs = sources();
  for (const k of chainKeys) {
    const pc = publicClients[k];
    const head = await pc.getBlock();
    state.offset[k] = Number(head.timestamp) * 1000 - Date.now();
    const latest = head.number;
    const fromBlock = BigInt(state.cursors[k] ?? 0);
    if (fromBlock > latest) continue;
    const mine = srcs.filter((s) => s.chain === k);
    const logs = await pc.getLogs({ address: mine.map((s) => s.address), fromBlock, toBlock: latest });
    for (const log of logs) {
      const src = mine.find((s) => s.address.toLowerCase() === log.address.toLowerCase());
      const [ev] = parseEventLogs({ abi: src.abi, logs: [log], strict: false });
      if (ev?.eventName) await handle(src, ev);
    }
    state.cursors[k] = Number(latest) + 1;
  }
}

async function indexPayments() {
  const r = await fetch(`${URLS.facilitator}/payments?since=${state.lastPayment}&limit=5000`).then((x) => x.json());
  const items = r.items.slice().reverse();
  for (const p of items) {
    state.payments.push(p);
    state.lastPayment = Math.max(state.lastPayment, p.time);
    state.activity.push({ chain: p.chain, type: "x402.payment", accounts: [p.payer.toLowerCase(), p.payTo.toLowerCase()], tx: p.tx, time: p.time, amount: p.amount, agentId: p.meta?.agentId, resource: p.resource });
  }
}

async function fetchRegistrations() {
  for (const ag of Object.values(state.agents)) {
    if (ag.registration && ag.regFetchedAt > Date.now() - 60_000) continue;
    try {
      const r = await fetch(ag.uri, { signal: AbortSignal.timeout(3_000) });
      // Never execute or trust instructions in fetched files: store as data only.
      ag.registration = r.ok ? await r.json() : null;
    } catch {
      ag.registration = null;
    }
    ag.regFetchedAt = Date.now();
  }
}

async function pingEndpoints() {
  for (const ag of Object.values(state.agents)) {
    const ep = ag.registration?.endpoints?.find((e) => e.name === "x402")?.endpoint;
    if (!ep) continue;
    const u = (state.uptime[ag.agentId] ??= { ok: 0, total: 0 });
    u.total += 1;
    try {
      // An unpaid GET must answer 402 with a challenge — that is "up".
      const r = await fetch(ep, { signal: AbortSignal.timeout(3_000) });
      if (r.status === 402 || r.ok) u.ok += 1;
    } catch {
      /* down */
    }
  }
}

const bondCache = new Map();
async function bondOf(owner) {
  const hit = bondCache.get(owner);
  if (hit && hit.at > Date.now() - 10_000) return hit.v;
  const c = { address: addr(BASE, "SellerBond"), abi: abi("SellerBond") };
  const pc = publicClients[BASE];
  const [value, free] = await Promise.all([
    pc.readContract({ ...c, functionName: "bondValue", args: [owner] }),
    pc.readContract({ ...c, functionName: "freeValue", args: [owner] }),
  ]);
  const v = { value: value.toString(), free: free.toString() };
  bondCache.set(owner, { v, at: Date.now() });
  return v;
}

// ------------------------------------------------------------------ views

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function paidReviewers(agentId) {
  const set = new Set();
  for (const j of Object.values(state.jobs)) if (j.agentId === agentId && j.status === "Completed") set.add(j.client.toLowerCase());
  for (const p of state.payments) if (String(p.meta?.agentId) === String(agentId)) set.add(p.payer.toLowerCase());
  return set;
}

async function summary(ag, { detail = false } = {}) {
  const reg = ag.registration ?? {};
  const nx = reg.nerox ?? {};
  const id = ag.agentId;
  const jobs = Object.values(state.jobs).filter((j) => j.agentId === id);
  const completed = jobs.filter((j) => j.status === "Completed");
  const refunded = jobs.filter((j) => j.status === "Rejected" && j.fundedAt > 0 || j.status === "Expired");
  const paid = paidReviewers(id);
  const fb = state.feedback.filter((f) => f.agentId === id);
  const counted = fb.filter((f) => paid.has(f.client.toLowerCase()));
  const calls = state.payments.filter((p) => String(p.meta?.agentId) === String(id));
  const callRevenue = calls.reduce((s, p) => s + BigInt(p.amount), 0n);
  const jobRevenue = completed.reduce((s, j) => s + BigInt(j.budget), 0n);
  const u = state.uptime[id];
  const price = nx.x402?.[0]?.amount ?? null;
  const out = {
    agentId: id,
    name: reg.name ?? `Agent #${id}`,
    description: reg.description ?? "",
    image: reg.image,
    category: nx.category ?? "uncategorised",
    skills: nx.skills ?? [],
    owner: ag.owner,
    wallet: ag.wallet,
    uri: ag.uri,
    chain: BASE,
    price,
    priceNrx: price ? fmt(price) : null,
    jobMenu: nx.jobs ?? [],
    endpoints: reg.endpoints ?? [],
    registeredAt: ag.registeredAt,
    reputation: {
      score: counted.length ? Math.round(counted.reduce((s, f) => s + f.score, 0) / counted.length) : null,
      count: counted.length,
      hiddenUnpaid: fb.length - counted.length,
      paidReviewers: paid.size,
    },
    stats: {
      calls: calls.length,
      jobsCompleted: completed.length,
      jobsOpen: jobs.filter((j) => ["Open", "Funded", "Submitted"].includes(j.status)).length,
      refundRate: completed.length + refunded.length ? refunded.length / (completed.length + refunded.length) : 0,
      medianDeliveryMs: median(completed.filter((j) => j.submittedAt && j.fundedAt).map((j) => j.submittedAt - j.fundedAt)),
      uptime: u && u.total ? u.ok / u.total : null,
      revenue: (callRevenue + jobRevenue).toString(),
    },
    bond: ag.owner ? await bondOf(ag.owner) : null,
    sale: ag.sale,
    verified: Boolean(reg.registrations?.some((r) => Number(r.agentId) === id)),
  };
  if (detail) {
    out.registration = reg;
    out.feedback = fb.map((f) => ({ ...f, paidReviewer: paid.has(f.client.toLowerCase()) })).reverse();
    out.jobs = jobs.sort((a, b) => b.jobId - a.jobId);
    out.recentCalls = calls.slice(-25).reverse();
    out.transfers = ag.transfers;
    out.sales = ag.sales;
    out.offers = ag.offers;
  }
  return out;
}

function rankScore(s) {
  const r = s.reputation;
  return (r.score ?? 50) * Math.log2(2 + r.count) + s.stats.calls * 0.05 + s.stats.jobsCompleted * 2;
}

async function search({ q, category, maxPrice, sort = "reputation", forSale, limit = 50 }) {
  let list = await Promise.all(Object.values(state.agents).filter((a) => a.owner).map((a) => summary(a)));
  if (q) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((s) => {
      const hay = [s.name, s.description, s.category, ...s.skills].join(" ").toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (category) list = list.filter((s) => s.category === category);
  if (maxPrice) list = list.filter((s) => s.price !== null && BigInt(s.price) <= parseUnits(String(maxPrice), 6));
  if (forSale === "true" || forSale === true) list = list.filter((s) => s.sale);
  const sorters = {
    reputation: (a, b) => rankScore(b) - rankScore(a),
    price: (a, b) => Number(BigInt(a.price ?? 10n ** 18n) - BigInt(b.price ?? 10n ** 18n)),
    jobs: (a, b) => b.stats.jobsCompleted - a.stats.jobsCompleted,
    newest: (a, b) => b.agentId - a.agentId,
  };
  list.sort(sorters[sort] ?? sorters.reputation);
  return list.slice(0, Number(limit));
}

// ------------------------------------------------------------------ MCP + A2A

const MCP_TOOLS = [
  {
    name: "search_agents",
    description: "Find agents on NeroX Market by skill or task, optionally under a max NRX price per call.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, category: { type: "string", enum: ["data", "research", "code review", "content"] }, maxPriceNrx: { type: "number" } }, required: ["query"] },
  },
  {
    name: "get_agent",
    description: "Get an agent's listing: price, x402 endpoint, job menu, paid-reviewer reputation and bond.",
    inputSchema: { type: "object", properties: { agentId: { type: "number" } }, required: ["agentId"] },
  },
  {
    name: "quote_job",
    description: "Quote an escrowed ERC-8183 job from an agent's job menu, including NeroX fees and the required evaluator.",
    inputSchema: { type: "object", properties: { agentId: { type: "number" }, title: { type: "string" } }, required: ["agentId"] },
  },
];

async function callTool(name, args = {}) {
  if (name === "search_agents") {
    const r = await search({ q: args.query, category: args.category, maxPrice: args.maxPriceNrx, limit: 10 });
    return r.map((s) => ({ agentId: s.agentId, name: s.name, category: s.category, priceNrx: s.priceNrx, reputation: s.reputation, x402: s.endpoints.find((e) => e.name === "x402")?.endpoint }));
  }
  if (name === "get_agent") {
    const ag = state.agents[Number(args.agentId)];
    if (!ag) throw new Error("Unknown agent");
    const { registration, feedback, jobs, recentCalls, ...s } = await summary(ag, { detail: true });
    return s;
  }
  if (name === "quote_job") {
    const ag = state.agents[Number(args.agentId)];
    if (!ag) throw new Error("Unknown agent");
    const s = await summary(ag);
    const item = s.jobMenu.find((j) => !args.title || j.title.toLowerCase().includes(String(args.title).toLowerCase())) ?? s.jobMenu[0];
    if (!item) throw new Error("This agent has no job menu; use its x402 endpoint");
    const budget = parseUnits(String(item.budget), 6);
    const pool = budget > 500_000_000n;
    return {
      agentId: s.agentId, title: item.title, budgetNrx: item.budget, deliveryHours: item.hours,
      platformFeeNrx: fmt((budget * 300n) / 10_000n), evaluatorFeeNrx: pool ? fmt((budget * 150n) / 10_000n) : "0",
      evaluator: pool ? "random bonded pool evaluator (required above 500 NRX)" : "buyer, contract or pool evaluator",
      escrow: addr(BASE, "NeroJobs"),
    };
  }
  throw new Error(`Unknown tool ${name}`);
}

function marketCard() {
  return {
    protocolVersion: "1.0",
    name: "NeroX Market",
    description: "Find, call, hire and buy AI agents. Every sale settles in NRX.",
    url: `${URLS.market}/a2a`,
    version: "0.1.0",
    provider: { organization: "NeroX", url: URLS.market },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    additionalInterfaces: [{ transport: "MCP", url: `${URLS.market}/mcp` }],
    skills: [
      { id: "search_agents", name: "Find an agent", description: "Find me an agent that can do X under N NRX.", tags: ["discovery", "x402"], examples: ["find me a solidity auditor under 1 NRX"] },
      { id: "quote_job", name: "Quote a job", description: "Quote an escrowed job with fees and evaluator rules.", tags: ["erc-8183", "escrow"] },
    ],
  };
}

function parsePriceQuery(text) {
  const m = String(text).match(/(?:under|below|max|<)\s*([\d.]+)\s*nrx/i);
  return { maxPrice: m ? Number(m[1]) : undefined, q: String(text).replace(/(?:under|below|max|<)\s*[\d.]+\s*nrx/i, "").replace(/\b(find|me|an?|agent|that|can|do|for|please)\b/gi, " ").trim() };
}

// ------------------------------------------------------------------ server

export function startMarketApi(port) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, chainOffsetMs: state.offset, agents: Object.keys(state.agents).length, jobs: Object.keys(state.jobs).length, cursors: state.cursors }));

  app.get("/agents", async (req, res) => res.json({ items: await search(req.query) }));
  app.get("/agents/:id", async (req, res) => {
    const ag = state.agents[Number(req.params.id)];
    if (!ag || !ag.owner) return res.status(404).json({ error: "Unknown agent" });
    res.json(await summary(ag, { detail: true }));
  });
  app.get("/categories", (_req, res) => res.json({ items: ["data", "research", "code review", "content"], excluded: ["financial advice", "trading signals", "medical", "weapons", "malware"] }));

  app.get("/jobs", (req, res) => {
    const a = String(req.query.address ?? "").toLowerCase();
    let items = Object.values(state.jobs);
    if (a) items = items.filter((j) => [j.client, j.provider, j.evaluator, j.bondOwner].some((x) => x?.toLowerCase() === a));
    if (req.query.agentId) items = items.filter((j) => j.agentId === Number(req.query.agentId));
    res.json({ items: items.sort((x, y) => y.jobId - x.jobId).map((j) => ({ ...j, agentName: state.agents[j.agentId]?.registration?.name })) });
  });
  app.get("/jobs/:id", (req, res) => {
    const j = state.jobs[Number(req.params.id)];
    if (!j) return res.status(404).json({ error: "Unknown job" });
    res.json({ ...j, agentName: state.agents[j.agentId]?.registration?.name });
  });

  app.get("/evaluators", async (_req, res) => {
    const pc = publicClients[BASE];
    const c = { address: addr(BASE, "NeroJobs"), abi: abi("NeroJobs") };
    const n = Number(await pc.readContract({ ...c, functionName: "poolSize" }));
    const items = [];
    for (let i = 0; i < n; i++) {
      const e = await pc.readContract({ ...c, functionName: "evaluatorPool", args: [BigInt(i)] });
      const judged = Object.values(state.jobs).filter((j) => j.evaluator.toLowerCase() === e.toLowerCase());
      items.push({ address: e, bond: await bondOf(e), judged: judged.length, completed: judged.filter((j) => j.status === "Completed").length, rejected: judged.filter((j) => j.status === "Rejected").length, pending: judged.filter((j) => j.status === "Submitted" || j.status === "Funded").length });
    }
    res.json({ items, contractEvaluators: [deployment.accounts.contractEvaluator.address] });
  });

  app.get("/feedback", (req, res) => {
    const a = String(req.query.client ?? "").toLowerCase();
    res.json({ items: state.feedback.filter((f) => !a || f.client.toLowerCase() === a) });
  });

  app.get("/stats", (_req, res) => {
    const jobs = Object.values(state.jobs);
    const sum = (xs) => xs.reduce((s, x) => s + BigInt(x), 0n).toString();
    res.json({
      agents: Object.values(state.agents).filter((a) => a.owner).length,
      forSale: Object.values(state.agents).filter((a) => a.sale).length,
      calls: state.payments.filter((p) => p.meta?.agentId).length,
      callVolume: sum(state.payments.filter((p) => p.meta?.agentId).map((p) => p.amount)),
      jobs: { total: jobs.length, open: jobs.filter((j) => ["Open", "Funded", "Submitted"].includes(j.status)).length, completed: jobs.filter((j) => j.status === "Completed").length },
      jobVolume: sum(jobs.filter((j) => j.status === "Completed").map((j) => j.budget)),
      saleVolume: sum(Object.values(state.agents).flatMap((a) => a.sales.map((s) => s.price))),
    });
  });

  app.get("/activity", (req, res) => {
    const a = String(req.query.address ?? "").toLowerCase();
    let items = state.activity;
    if (a) items = items.filter((x) => x.accounts.includes(a));
    if (req.query.chain) items = items.filter((x) => x.chain === req.query.chain);
    if (req.query.type) items = items.filter((x) => x.type.startsWith(String(req.query.type)));
    res.json({ items: items.slice().sort((x, y) => x.time - y.time).slice(-Number(req.query.limit ?? 50)).reverse() });
  });

  // Sanctions screening API for the front end (same oracle the contracts can read).
  app.get("/screen/:address", async (req, res) => {
    let a;
    try {
      a = getAddress(req.params.address);
    } catch {
      return res.status(400).json({ error: "Bad address" });
    }
    const results = await Promise.all(chainKeys.map((k) => publicClients[k].readContract({ address: addr(k, "SanctionsOracle"), abi: abi("MockSanctionsOracle"), functionName: "isSanctioned", args: [a] })));
    res.json({ address: a, sanctioned: results.some(Boolean), provider: "Chainalysis-compatible oracle (demo)" });
  });

  // Registration files for agents created through "Sell an agent".
  app.post("/registrations", (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.description || !b.category) return res.status(400).json({ error: "Name, description and category are required" });
    const banned = ["financial advice", "trading signals", "medical"];
    if (banned.includes(String(b.category).toLowerCase())) return res.status(400).json({ error: "That category is excluded at launch" });
    const id = randomUUID().slice(0, 12);
    registrations.data[id] = { ...b, createdAt: Date.now() };
    registrations.save();
    res.json({ id, uri: `${URLS.market}/registrations/${id}.json` });
  });
  app.get("/registrations/:id.json", (req, res) => {
    const r = registrations.data[req.params.id];
    if (!r) return res.status(404).json({ error: "not found" });
    const uri = `${URLS.market}/registrations/${req.params.id}.json`;
    const ag = Object.values(state.agents).find((a) => a.uri === uri);
    const amount = parseUnits(String(r.price ?? "0.01"), 6).toString();
    const endpoints = [];
    if (r.a2aUrl) endpoints.push({ name: "A2A", endpoint: r.a2aUrl, version: "1.0" });
    if (r.mcpUrl) endpoints.push({ name: "MCP", endpoint: r.mcpUrl });
    if (ag) endpoints.push({ name: "x402", endpoint: r.x402Url || `${URLS.agents}/hosted/${ag.agentId}/call`, version: "2" });
    res.json({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: r.name,
      description: r.description,
      image: r.image ?? "",
      endpoints,
      registrations: ag ? [{ agentId: ag.agentId, agentRegistry: `eip155:${deployment.chains.base.chainId}:${addr(BASE, "IdentityRegistry")}` }] : [],
      supportedTrust: ["reputation", "crypto-economic"],
      nerox: {
        category: r.category,
        skills: r.skills ?? [],
        x402: [{ resource: ag ? `${URLS.agents}/hosted/${ag.agentId}/call` : "", network: `eip155:${deployment.chains.base.chainId}`, asset: addr(BASE, "NRX"), amount, symbol: "NRX" }],
        jobs: (r.jobs ?? []).map((j) => ({ ...j, budgetBaseUnits: parseUnits(String(j.budget), 6).toString() })),
      },
    });
  });

  // x402 Bazaar-compatible discovery feed, so listings also surface on Agentic.Market-style directories.
  app.get("/discovery/resources", async (req, res) => {
    const list = await search({ limit: 500 });
    const items = list.filter((s) => s.price).map((s) => {
      const resource = s.endpoints.find((e) => e.name === "x402")?.endpoint;
      const { v1 } = buildRequirements({ chainId: deployment.chains.base.chainId, asset: addr(BASE, "NRX"), payTo: s.wallet, amount: s.price, resource, description: s.description });
      return { resource, type: "http", x402Version: 1, accepts: [v1], lastUpdated: new Date().toISOString(), metadata: { name: s.name, category: s.category, agentId: s.agentId, reputation: s.reputation } };
    });
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 100);
    res.json({ x402Version: 1, items: items.slice(offset, offset + limit), pagination: { limit, offset, total: items.length } });
  });

  app.get("/.well-known/agent-card.json", (_req, res) => res.json(marketCard()));

  // Minimal A2A JSON-RPC: message/send with a natural-language request.
  app.post("/a2a", async (req, res) => {
    const { id, method, params } = req.body ?? {};
    if (method !== "message/send") return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const text = (params?.message?.parts ?? []).filter((p) => p.kind === "text").map((p) => p.text).join(" ");
    const { q, maxPrice } = parsePriceQuery(text);
    const r = await callTool("search_agents", { query: q, maxPriceNrx: maxPrice });
    res.json({
      jsonrpc: "2.0", id,
      result: { kind: "message", role: "agent", messageId: randomUUID(), parts: [{ kind: "text", text: r.length ? `Found ${r.length} agent(s).` : "No matching agents." }, { kind: "data", data: { agents: r } }] },
    });
  });

  // MCP over HTTP (JSON-RPC). Lets other agents search and quote from their tool loop.
  app.post("/mcp", async (req, res) => {
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) {
      const reply = (result) => out.push({ jsonrpc: "2.0", id: m.id, result });
      const error = (code, message) => out.push({ jsonrpc: "2.0", id: m.id, error: { code, message } });
      if (m.id === undefined) continue; // notification
      try {
        if (m.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nerox-market", version: "0.1.0" }, instructions: "Search, inspect and quote NeroX Market agents. Pay agents directly over x402 in NRX." });
        else if (m.method === "tools/list") reply({ tools: MCP_TOOLS });
        else if (m.method === "tools/call") {
          const data = await callTool(m.params?.name, m.params?.arguments);
          reply({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { result: data } });
        } else if (m.method === "ping") reply({});
        else error(-32601, "Method not found");
      } catch (e) {
        reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  });

  if (DEMO) mountDemo(app);

  const loop = async () => {
    try {
      await indexChains();
      await indexPayments();
      await fetchRegistrations();
    } catch (e) {
      console.warn("[market] index:", e.shortMessage ?? e.message);
    }
    setTimeout(loop, 2_000);
  };
  loop();
  setInterval(() => pingEndpoints().catch(() => {}), 15_000);
  setTimeout(() => pingEndpoints().catch(() => {}), 4_000);

  return app.listen(port, () => console.log(`[market] API, A2A and MCP on :${port}`));
}

// ------------------------------------------------------------------ demo controls

function mountDemo(app) {
  const personas = [
    { role: "alice", label: "Alice — holder", description: "Mints, earns, borrows and bridges." },
    { role: "bob", label: "Bob — x402 seller", description: "Sells an API through the Seller Console." },
    { role: "carol", label: "Carol — agent buyer", description: "Calls and hires agents on the Market." },
    { role: "owner2", label: "Dev Studio — agent owner", description: "Owns 5 listed agents, including Solidity Auditor." },
    { role: "eval1", label: "Erin — pool evaluator", description: "Bonded evaluator who rules on jobs." },
    { role: "mallory", label: "Mallory — sanctioned", description: "Fails sanctions screening on connect." },
  ];
  app.get("/demo/personas", (_req, res) => res.json({ items: personas.map((p) => ({ ...p, ...deployment.accounts[p.role] })) }));

  app.post("/demo/faucet", async (req, res) => {
    try {
      const to = getAddress(req.body.address);
      const out = [];
      for (const k of chainKeys) {
        const d = wallet("deployer", k);
        await publicClients[k].request({ method: "hardhat_setBalance", params: [to, "0x56BC75E2D63100000"] }); // 100 ETH gas
        const tok = { abi: abi("MockERC20"), functionName: "mint" };
        out.push((await write(d, k, { ...tok, address: addr(k, "USDC"), args: [to, 5_000_000_000n] })).hash);
        if (k === BASE) {
          out.push((await write(d, k, { ...tok, address: addr(k, "cbBTC"), args: [to, 10_000_000n] })).hash);
          out.push((await write(d, k, { ...tok, address: addr(k, "wstETH"), args: [to, 10n ** 18n] })).hash);
        }
      }
      res.json({ ok: true, sent: "5,000 USDC per chain, 0.1 cbBTC, 1 wstETH, gas", txs: out });
    } catch (e) {
      res.status(500).json({ error: e.shortMessage ?? e.message });
    }
  });

  app.post("/demo/time-warp", async (req, res) => {
    const days = Math.min(Math.max(Number(req.body?.days ?? 30), 1), 365);
    for (const k of chainKeys) {
      await publicClients[k].request({ method: "evm_increaseTime", params: [days * 86400] });
      await publicClients[k].request({ method: "evm_mine", params: [] });
    }
    res.json({ ok: true, days });
  });

  app.post("/demo/price", async (req, res) => {
    try {
      const asset = req.body.asset === "wstETH" ? "wstETH" : "cbBTC";
      const usd = Number(req.body.usd);
      const dec = asset === "cbBTC" ? 8n : 18n;
      const price = (BigInt(Math.round(usd * 1e6)) * 10n ** 36n) / 10n ** dec;
      const { hash } = await write(wallet("deployer", BASE), BASE, { address: addr(BASE, asset === "cbBTC" ? "OracleCbBTC" : "OracleWstETH"), abi: abi("MockOracle"), functionName: "setPrice", args: [price] });
      res.json({ ok: true, asset, usd, tx: hash });
    } catch (e) {
      res.status(500).json({ error: e.shortMessage ?? e.message });
    }
  });

  app.get("/demo/traffic", (_req, res) => res.json({ enabled: trafficEnabled() }));
  app.post("/demo/traffic", (req, res) => {
    setTraffic(Boolean(req.body?.enabled));
    res.json({ enabled: trafficEnabled() });
  });
}
