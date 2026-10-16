import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");
const contractsDir = join(ROOT, "..", "contracts");

export const MNEMONIC = "test test test test test test test test test test test junk";

export const PORTS = {
  facilitator: Number(process.env.FACILITATOR_PORT || 4020),
  agents: Number(process.env.AGENTS_PORT || 4021),
  market: Number(process.env.MARKET_PORT || 4022),
  relayer: Number(process.env.RELAYER_PORT || 4023),
};

const host = process.env.PUBLIC_HOST || "http://localhost";
export const URLS = {
  facilitator: process.env.FACILITATOR_URL || `${host}:${PORTS.facilitator}`,
  agents: process.env.AGENTS_URL || `${host}:${PORTS.agents}`,
  market: process.env.MARKET_URL || `${host}:${PORTS.market}`,
  relayer: process.env.RELAYER_URL || `${host}:${PORTS.relayer}`,
};

export const DEMO = process.env.NEROX_DEMO !== "0";
export const DATA_DIR = process.env.NEROX_DATA_DIR || join(ROOT, "data");

export function loadDeployment() {
  const file = process.env.NEROX_DEPLOYMENT || join(contractsDir, "deployments/local.json");
  if (!existsSync(file)) throw new Error(`No deployment at ${file}. Run the demo deploy first.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const abiCache = {};
export function abi(name) {
  if (!abiCache[name]) abiCache[name] = JSON.parse(readFileSync(join(contractsDir, "abi", `${name}.json`), "utf8"));
  return abiCache[name];
}

export const FEES = {
  callBps: 100, // 1% of x402 payments made through the Agent Market
};
