// Local CCIP stand-in: watches both token pools for CCIPSendRequested, waits for source
// finality, gathers 2-of-3 committee attestations and executes the mint on the destination.
// Serves message status like CCIP Explorer does.
import express from "express";
import cors from "cors";
import { parseEventLogs } from "viem";
import { deployment, publicClients, chainKeys, addr, walletAt, write } from "./chain.js";
import { abi } from "./config.js";
import { jsonStore } from "./store.js";

const store = jsonStore("ccip", { messages: {}, cursors: {} });
const FINALITY_MS = 4_000;
const COMMIT_MS = 3_000;

const bySelector = Object.fromEntries(chainKeys.map((k) => [deployment.chains[k].ccipSelector, k]));
const signers = ["don1", "don2", "don3"].map((r) => deployment.accounts[r]);

async function attest(destKey, m) {
  const pc = publicClients[destKey];
  const digest = await pc.readContract({
    address: addr(destKey, "TokenPool"),
    abi: abi("NeroTokenPool"),
    functionName: "messageDigest",
    args: [m.messageId, BigInt(m.sourceSelector), m.sender, m.receiver, BigInt(m.amount), BigInt(m.nonce)],
  });
  // Each committee member signs independently; the pool needs two, sorted by address.
  const sigs = [];
  for (const s of signers) {
    const w = walletAt(s.index, destKey);
    sigs.push({ signer: s.address, signature: await w.account.signMessage({ message: { raw: digest } }) });
  }
  return sigs;
}

async function advance(m) {
  const destKey = bySelector[m.destSelector];
  try {
    if (m.status === "SENT") {
      await new Promise((r) => setTimeout(r, FINALITY_MS));
      m.status = "FINALIZED";
      m.finalizedAt = Date.now();
      store.save();
    }
    if (m.status === "FINALIZED") {
      const sigs = await attest(destKey, m);
      await new Promise((r) => setTimeout(r, COMMIT_MS));
      m.attestations = sigs.map((s) => s.signer);
      m.signatures = sigs
        .slice(0, 2)
        .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
        .map((s) => s.signature);
      m.status = "COMMITTED";
      m.committedAt = Date.now();
      store.save();
    }
    if (m.status === "COMMITTED") {
      const { hash } = await write(walletAt(deployment.accounts.don1.index, destKey), destKey, {
        address: addr(destKey, "TokenPool"),
        abi: abi("NeroTokenPool"),
        functionName: "executeMessage",
        args: [m.messageId, BigInt(m.sourceSelector), m.sender, m.receiver, BigInt(m.amount), BigInt(m.nonce), m.signatures],
      });
      m.status = "EXECUTED";
      m.destTx = hash;
      m.executedAt = Date.now();
      store.save();
      console.log(`[relayer] executed ${m.messageId.slice(0, 10)}… ${m.sourceChain} → ${m.destChain}`);
    }
  } catch (e) {
    m.error = e.shortMessage ?? e.message;
    m.retries = (m.retries ?? 0) + 1;
    store.save();
    if (m.retries < 5) setTimeout(() => advance(m), 5_000);
    else m.status = "FAILED";
  }
}

async function poll() {
  for (const k of chainKeys) {
    const pc = publicClients[k];
    const latest = await pc.getBlockNumber();
    const fromBlock = BigInt(store.data.cursors[k] ?? 0);
    if (fromBlock > latest) continue;
    const logs = await pc.getLogs({ address: addr(k, "TokenPool"), fromBlock, toBlock: latest });
    const events = parseEventLogs({ abi: abi("NeroTokenPool"), logs, eventName: "CCIPSendRequested" });
    for (const ev of events) {
      const id = ev.args.messageId;
      if (store.data.messages[id]) continue;
      const block = await pc.getBlock({ blockNumber: ev.blockNumber });
      const m = {
        messageId: id,
        sourceChain: k,
        destChain: bySelector[ev.args.destChainSelector.toString()],
        sourceSelector: deployment.chains[k].ccipSelector,
        destSelector: ev.args.destChainSelector.toString(),
        sender: ev.args.sender,
        receiver: ev.args.receiver,
        amount: ev.args.amount.toString(),
        fee: ev.args.fee.toString(),
        nonce: ev.args.nonce.toString(),
        sourceTx: ev.transactionHash,
        sentAt: Date.now(),
        sourceBlockTime: Number(block.timestamp),
        seenAt: Date.now(),
        status: "SENT",
      };
      store.data.messages[id] = m;
      store.save();
      advance(m);
    }
    store.data.cursors[k] = Number(latest) + 1;
    store.save();
  }
}

export function startRelayer(port) {
  // Resume anything left mid-flight by a restart.
  for (const m of Object.values(store.data.messages)) if (!["EXECUTED", "FAILED"].includes(m.status)) advance(m);
  const loop = async () => {
    try {
      await poll();
    } catch (e) {
      console.warn("[relayer]", e.shortMessage ?? e.message);
    }
    setTimeout(loop, 1_500);
  };
  loop();

  const app = express();
  app.use(cors());
  app.get("/messages", (req, res) => {
    const a = String(req.query.address ?? "").toLowerCase();
    let items = Object.values(store.data.messages);
    if (a) items = items.filter((m) => m.sender.toLowerCase() === a || m.receiver.toLowerCase() === a);
    res.json({ items: items.sort((x, y) => y.seenAt - x.seenAt).slice(0, 100) });
  });
  app.get("/messages/:id", (req, res) => {
    const m = store.data.messages[req.params.id];
    if (!m) return res.status(404).json({ error: "not found" });
    const { signatures, ...rest } = m;
    res.json(rest);
  });
  app.get("/health", (_req, res) => res.json({ ok: true, committee: signers.map((s) => s.address), quorum: 2 }));
  return app.listen(port, () => console.log(`[relayer] CCIP lanes ${chainKeys.join(" ⇄ ")} on :${port}`));
}
