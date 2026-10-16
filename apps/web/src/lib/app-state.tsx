"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { CHAINS, CHAIN_KEYS, chainKeyOf, SERVICES, type ChainKey } from "./config";
import { publicClients } from "./clients";

export type PendingTx = {
  hash: `0x${string}`;
  chain: ChainKey;
  label: string;
  status: "pending" | "success" | "reverted";
  time: number;
  ccipMessageId?: string;
  step?: string;
};

type Ctx = {
  chain: ChainKey;
  setChain: (k: ChainKey) => Promise<void>;
  txs: PendingTx[];
  addTx: (t: PendingTx) => void;
  updateTx: (hash: string, patch: Partial<PendingTx>) => void;
  clearTxs: () => void;
  screening: { status: "idle" | "checking" | "clear" | "sanctioned" | "error"; address?: string };
  termsAccepted: boolean;
  acceptTerms: () => void;
};

const AppContext = createContext<Ctx | null>(null);
const TX_KEY = "nerox.pending";
const CHAIN_KEY = "nerox.chain";
const TERMS_KEY = "nerox.terms.v1";

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [uiChain, setUiChain] = useState<ChainKey>("base");
  const [txs, setTxs] = useState<PendingTx[]>([]);
  const [terms, setTerms] = useState(true);
  const [screening, setScreening] = useState<Ctx["screening"]>({ status: "idle" });

  useEffect(() => {
    setUiChain(load<ChainKey>(CHAIN_KEY, "base"));
    setTxs(load<PendingTx[]>(TX_KEY, []));
    setTerms(load<boolean>(TERMS_KEY, false));
  }, []);

  const chain: ChainKey = (isConnected && chainKeyOf(chainId)) || uiChain;

  const setChain = useCallback(
    async (k: ChainKey) => {
      setUiChain(k);
      save(CHAIN_KEY, k);
      if (isConnected && chainId !== CHAINS[k].id) await switchChainAsync({ chainId: CHAINS[k].id });
    },
    [isConnected, chainId, switchChainAsync],
  );

  const addTx = useCallback((t: PendingTx) => {
    setTxs((prev) => {
      const next = [t, ...prev.filter((x) => x.hash !== t.hash)].slice(0, 20);
      save(TX_KEY, next);
      return next;
    });
  }, []);
  const updateTx = useCallback((hash: string, patch: Partial<PendingTx>) => {
    setTxs((prev) => {
      const next = prev.map((x) => (x.hash === hash ? { ...x, ...patch } : x));
      save(TX_KEY, next);
      return next;
    });
  }, []);
  const clearTxs = useCallback(() => {
    setTxs([]);
    save(TX_KEY, []);
  }, []);

  // Pending transactions survive reloads: re-watch anything still pending.
  useEffect(() => {
    for (const t of txs.filter((x) => x.status === "pending")) {
      publicClients[t.chain]
        .waitForTransactionReceipt({ hash: t.hash, timeout: 120_000 })
        .then((r) => updateTx(t.hash, { status: r.status === "success" ? "success" : "reverted" }))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs.length]);

  // Every wallet is screened once on connect, before any write.
  useEffect(() => {
    if (!address) return setScreening({ status: "idle" });
    let cancelled = false;
    setScreening({ status: "checking", address });
    fetch(`${SERVICES.market}/screen/${address}`)
      .then((r) => r.json())
      .then((j) => !cancelled && setScreening({ status: j.sanctioned ? "sanctioned" : "clear", address }))
      .catch(() => !cancelled && setScreening({ status: "error", address }));
    return () => {
      cancelled = true;
    };
  }, [address]);

  const acceptTerms = useCallback(() => {
    setTerms(true);
    save(TERMS_KEY, true);
  }, []);

  const value = useMemo(
    () => ({ chain, setChain, txs, addTx, updateTx, clearTxs, screening, termsAccepted: terms, acceptTerms }),
    [chain, setChain, txs, addTx, updateTx, clearTxs, screening, terms, acceptTerms],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

export const chainName = (k: ChainKey) => CHAINS[k].name;
export { CHAIN_KEYS };
