// Demo traffic: a buyer agent pays seeded agents and Seller Console sandbox endpoints over
// real x402, so dashboards, the payments table and reputation have live data.
import { wrapFetchWithPayment } from "@nerox/x402";
import { account, addr, deployment, keyByChainId, chainNow } from "./chain.js";
import { URLS } from "./config.js";

let enabled = process.env.NEROX_TRAFFIC !== "0";
let timer;
const queries = ["London", "EUR/USD", "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432", "ACME", "agent payments", "Solidity reentrancy", "copy for launch page", "x402"];

export const trafficEnabled = () => enabled;
export function setTraffic(on) {
  enabled = on;
  if (on && !timer) schedule();
}

const buyer = account("carol");
const pay = wrapFetchWithPayment(fetch, buyer, {
  maxAmount: 2_000_000n, // never more than 2 NRX per call
  acceptAsset: (asset, chainId) => {
    const k = keyByChainId(chainId);
    return k && asset.toLowerCase() === addr(k, "NRX").toLowerCase();
  },
  now: chainNow,
});

async function once() {
  const r = Math.random();
  if (r < 0.75) {
    const agents = deployment.agents;
    const a = agents[Math.floor(Math.random() * agents.length)];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const res = await pay(`${URLS.agents}/agents/${a.slug}/call?q=${encodeURIComponent(q)}`);
    if (res.status !== 200) console.warn(`[traffic] ${a.slug} → ${res.status}`);
  } else {
    const { items } = await fetch(`${URLS.facilitator}/console/all-endpoints`).then((x) => x.json());
    if (!items.length) return;
    const e = items[Math.floor(Math.random() * items.length)];
    const chainId = e.chains[Math.floor(Math.random() * e.chains.length)];
    const res = await pay(`${e.sandboxUrl}?chainId=${chainId}`);
    if (res.status !== 200) console.warn(`[traffic] sandbox ${e.id} → ${res.status}`);
  }
}

function schedule() {
  timer = setTimeout(async () => {
    timer = undefined;
    if (!enabled) return;
    try {
      await once();
    } catch (e) {
      console.warn("[traffic]", e.message);
    }
    schedule();
  }, 2_500 + Math.random() * 4_500);
}

export function startTraffic() {
  if (enabled) setTimeout(schedule, 8_000);
}
