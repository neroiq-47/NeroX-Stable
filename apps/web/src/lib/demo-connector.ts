"use client";
// Demo wallet: signs with the local chain's unlocked dev accounts, one per persona.
// Real users connect an injected wallet (MetaMask, Rabby, Coinbase Wallet) instead.
import { createConnector } from "wagmi";
import { getAddress, numberToHex, type Address } from "viem";
import { CHAINS, CHAIN_KEYS, personaAddress } from "./config";

const KEY = "nerox.persona";
const CONNECTED = "nerox.demo.connected";
let role = "alice";
try {
  role = localStorage.getItem(KEY) || "alice";
} catch {}

type Listener = (role: string) => void;
const listeners = new Set<Listener>();
let emitAccounts: ((a: Address[]) => void) | undefined;

export function currentPersona() {
  return role;
}
export function onPersona(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function setPersona(r: string) {
  role = r;
  try {
    localStorage.setItem(KEY, r);
  } catch {}
  emitAccounts?.([personaAddress(r)]);
  for (const l of listeners) l(r);
}

async function rpc(url: string, method: string, params: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
  return j.result;
}

export function demoWallet() {
  let chainId = CHAINS.base.id;
  return createConnector((config) => {
    const provider = {
      async request({ method, params }: { method: string; params?: unknown }) {
        const url = CHAINS[CHAIN_KEYS.find((k) => CHAINS[k].id === chainId) ?? "base"].rpcUrls.default.http[0];
        switch (method) {
          case "eth_accounts":
          case "eth_requestAccounts":
            return [personaAddress(role)];
          case "eth_chainId":
            return numberToHex(chainId);
          case "wallet_switchEthereumChain": {
            const id = Number((params as [{ chainId: string }])[0].chainId);
            chainId = id;
            config.emitter.emit("change", { chainId: id });
            return null;
          }
          case "wallet_getCapabilities":
            // No EIP-5792 batching: the dApp falls back to sequential steps.
            throw Object.assign(new Error("Method not supported"), { code: 4200 });
          default:
            return rpc(url, method, params);
        }
      },
      on() {},
      removeListener() {},
    };
    return {
      id: "nerox-demo",
      name: "Demo wallet",
      type: "nerox-demo",
      async setup() {
        emitAccounts = (accounts) => config.emitter.emit("change", { accounts });
      },
      async connect(params?: { chainId?: number }) {
        if (params?.chainId) chainId = params.chainId;
        try {
          localStorage.setItem(CONNECTED, "1");
        } catch {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { accounts: [personaAddress(role)], chainId } as any;
      },
      async disconnect() {
        try {
          localStorage.removeItem(CONNECTED);
        } catch {}
      },
      async getAccounts() {
        return [personaAddress(role)];
      },
      async getChainId() {
        return chainId;
      },
      async getProvider() {
        return provider;
      },
      async isAuthorized() {
        try {
          return localStorage.getItem(CONNECTED) === "1";
        } catch {
          return false;
        }
      },
      async switchChain({ chainId: id }: { chainId: number }) {
        chainId = id;
        config.emitter.emit("change", { chainId: id });
        return CHAIN_KEYS.map((k) => CHAINS[k]).find((c) => c.id === id)!;
      },
      onAccountsChanged(accounts: string[]) {
        config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged(id: string) {
        config.emitter.emit("change", { chainId: Number(id) });
      },
      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };
  });
}
