// Buyer side: sign an EIP-3009 authorization for a 402 challenge and retry the request.
import {
  HEADERS,
  SCHEME,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  decodeHeader,
  encodeHeader,
  normaliseRequirement,
} from "./protocol.js";

function randomNonce() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign a payment for one requirement.
 * @param {{ address: string, signTypedData: (args: object) => Promise<string> }} signer
 *   A viem account/wallet client, or anything with the same signTypedData shape.
 * @param {object} rawRequirement  a v1 or v2 requirement from the challenge
 * @param {1|2} version
 */
export async function createPayment(signer, rawRequirement, version, { now = Math.floor(Date.now() / 1000), resource } = {}) {
  const r = normaliseRequirement(rawRequirement);
  if (r.scheme !== SCHEME) throw new Error(`Unsupported scheme ${r.scheme}`);
  const authorization = {
    from: signer.address,
    to: r.payTo,
    value: r.amount.toString(),
    validAfter: String(now - 600),
    validBefore: String(now + r.maxTimeoutSeconds),
    nonce: randomNonce(),
  };
  const signature = await signer.signTypedData({
    domain: { name: r.extra.name ?? "NeroX USD", version: r.extra.version ?? "1", chainId: r.chainId, verifyingContract: r.asset },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  const payload = { signature, authorization };
  if (version === 1) return { x402Version: 1, scheme: SCHEME, network: rawRequirement.network, payload };
  return { x402Version: 2, resource, accepted: rawRequirement, payload, extensions: {} };
}

/** Parse a 402 response into the challenge for both versions, whichever the server sent. */
export async function readChallenge(res) {
  const v2 = res.headers.get(HEADERS.v2Required);
  let body;
  try {
    body = await res.clone().json();
  } catch {
    body = undefined;
  }
  return { v2: v2 ? decodeHeader(v2) : undefined, v1: body?.x402Version === 1 ? body : undefined };
}

/**
 * Wrap fetch so a 402 is paid in NRX and retried once.
 * @param {typeof fetch} fetchFn
 * @param {{ address: string, signTypedData: Function }} signer
 * @param {object} [opts]
 * @param {bigint} [opts.maxAmount]   refuse to pay more than this (base units)
 * @param {1|2} [opts.preferVersion]
 * @param {(asset: string, chainId: number) => boolean} [opts.acceptAsset]
 * @param {(step: object) => void} [opts.onStep]  trace hook for UIs
 * @param {(chainId: number) => Promise<number>|number} [opts.now]  chain time in seconds; pass the
 *   latest block timestamp when the chain clock can differ from the local clock
 */
export function wrapFetchWithPayment(fetchFn, signer, opts = {}) {
  const { maxAmount, preferVersion = 2, acceptAsset = () => true, onStep = () => {}, now } = opts;
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    onStep({ kind: "request", url, at: Date.now() });
    const first = await fetchFn(input, init);
    if (first.status !== 402) return first;

    const challenge = await readChallenge(first);
    onStep({ kind: "challenge", status: 402, v1: challenge.v1, v2: challenge.v2, at: Date.now() });
    const useV2 = challenge.v2 && (preferVersion === 2 || !challenge.v1);
    const accepts = (useV2 ? challenge.v2.accepts : challenge.v1?.accepts) ?? [];
    const req = accepts.find((a) => {
      const n = normaliseRequirement(a);
      return n.scheme === SCHEME && acceptAsset(n.asset, n.chainId);
    });
    if (!req) throw new Error("No acceptable x402 payment option");
    const n = normaliseRequirement(req);
    if (maxAmount !== undefined && n.amount > maxAmount) {
      throw new Error(`Price ${n.amount} exceeds max ${maxAmount}`);
    }
    const version = useV2 ? 2 : 1;
    const nowTs = now ? Number(await now(n.chainId)) : Math.floor(Date.now() / 1000);
    const payment = await createPayment(signer, req, version, { resource: challenge.v2?.resource, now: nowTs });
    onStep({ kind: "signed", version, authorization: payment.payload.authorization, at: Date.now() });

    const headers = new Headers(init.headers);
    headers.set(version === 2 ? HEADERS.v2Payment : HEADERS.v1Payment, encodeHeader(payment));
    const second = await fetchFn(input, { ...init, headers });
    const settleHeader = second.headers.get(HEADERS.v2Response) ?? second.headers.get(HEADERS.v1Response);
    const settlement = settleHeader ? decodeHeader(settleHeader) : undefined;
    onStep({ kind: "result", status: second.status, settlement, at: Date.now() });
    return second;
  };
}
