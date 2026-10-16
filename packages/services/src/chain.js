import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { MNEMONIC, loadDeployment } from "./config.js";

export const deployment = loadDeployment();
export const chainKeys = Object.keys(deployment.chains);

export const chains = Object.fromEntries(
  chainKeys.map((k) => {
    const c = deployment.chains[k];
    return [k, defineChain({
      id: c.chainId,
      name: c.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [c.rpc] } },
    })];
  }),
);

export const publicClients = Object.fromEntries(
  chainKeys.map((k) => [k, createPublicClient({ chain: chains[k], transport: http(deployment.chains[k].rpc), pollingInterval: 1000 })]),
);

export function keyByChainId(chainId) {
  return chainKeys.find((k) => deployment.chains[k].chainId === Number(chainId));
}

export function account(role) {
  const a = deployment.accounts[role];
  if (!a) throw new Error(`Unknown role ${role}`);
  return mnemonicToAccount(MNEMONIC, { addressIndex: a.index });
}

const walletCache = new Map();
export function wallet(role, chainKey) {
  const id = `${role}:${chainKey}`;
  if (!walletCache.has(id)) {
    walletCache.set(id, createWalletClient({ account: account(role), chain: chains[chainKey], transport: http(deployment.chains[chainKey].rpc) }));
  }
  return walletCache.get(id);
}

/** Wallet client for an arbitrary HD index (seeded agent owners etc.). */
export function walletAt(index, chainKey) {
  const id = `#${index}:${chainKey}`;
  if (!walletCache.has(id)) {
    walletCache.set(id, createWalletClient({ account: mnemonicToAccount(MNEMONIC, { addressIndex: index }), chain: chains[chainKey], transport: http(deployment.chains[chainKey].rpc) }));
  }
  return walletCache.get(id);
}

// One in-flight transaction per sender per chain, so nonces never collide.
const queues = new Map();
export function serial(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  return next;
}

/** writeContract + wait, serialised per sender. */
export async function write(walletClient, chainKey, params) {
  return serial(`${walletClient.account.address}:${chainKey}`, async () => {
    const pc = publicClients[chainKey];
    const { request } = await pc.simulateContract({ ...params, account: walletClient.account });
    const hash = await walletClient.writeContract(request);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    return { hash, receipt };
  });
}

export const addr = (chainKey, name) => deployment.chains[chainKey].contracts[name];

/** Latest block timestamp — the chain clock can run ahead of wall time after a demo time-warp. */
export async function chainNow(chainId) {
  const k = keyByChainId(chainId);
  const b = await publicClients[k].getBlock();
  return Number(b.timestamp);
}
