#!/usr/bin/env node
// One command for the full local MVP:
//   two chains (Base + Ethereum, local) → deploy + seed → services → dApp.
// Usage: npm run demo            (add --no-web to skip the Next.js app)
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const children = [];

function run(name, cmd, argv, opts = {}) {
  const p = spawn(cmd, argv, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`.padEnd(10);
  const out = (d) => {
    for (const line of String(d).split("\n")) if (line.trim() && !opts.quiet?.(line)) console.log(`${tag} ${line}`);
  };
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  children.push(p);
  return p;
}

function once(name, cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = run(name, cmd, argv, opts);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`))));
  });
}

async function waitRpc(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`RPC ${url} did not start`);
}

function shutdown() {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const contracts = join(root, "packages/contracts");
const hh = join(root, "node_modules/.bin/hardhat");
const quietNode = (l) => /eth_|^\s*$|Contract call|Transaction:|From:|To:|Value:|Gas used|Block #|Contract deployment|WARNING|accounts|Account #|Private Key|Mined empty block|^\s+/.test(l);

console.log("NeroX demo — starting local chains");
if (!existsSync(join(contracts, "artifacts"))) await once("compile", hh, ["compile"], { cwd: contracts });
await once("abi", "node", ["scripts/export-abis.mjs"], { cwd: contracts });
run("base", hh, ["node", "--port", "8545"], { cwd: contracts, env: { NEROX_CHAIN_ID: "31337", NEROX_INTERVAL_MINING: "1" }, quiet: quietNode });
run("eth", hh, ["node", "--port", "8546"], { cwd: contracts, env: { NEROX_CHAIN_ID: "31338", NEROX_INTERVAL_MINING: "1" }, quiet: quietNode });
await waitRpc("http://127.0.0.1:8545");
await waitRpc("http://127.0.0.1:8546");

await once("deploy", "node", ["scripts/deploy-local.mjs"], { cwd: contracts });
// Fresh chains each run, so service state starts fresh too.
rmSync(join(root, "packages/services/data"), { recursive: true, force: true });
run("services", "node", ["src/index.js"], { cwd: join(root, "packages/services") });

if (!args.has("--no-web")) {
  const web = join(root, "apps/web");
  const mode = args.has("--prod") ? ["run", "start"] : ["run", "dev"];
  if (args.has("--prod")) await once("build", "npm", ["run", "build"], { cwd: web });
  run("web", "npm", mode, { cwd: web });
  console.log("\nNeroX dApp → http://localhost:3000   (Market API :4022, facilitator :4020, agents :4021, CCIP :4023)\n");
}
