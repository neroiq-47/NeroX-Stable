// x402 wire formats for the "exact" EVM scheme, in both protocol versions.
//
// v1 (x402-fetch and most installed agents):
//   402 body  { x402Version: 1, error, accepts: [PaymentRequirementsV1] }
//   request   X-PAYMENT: base64(JSON PaymentPayloadV1)
//   response  X-PAYMENT-RESPONSE: base64(JSON SettleResponse)
// v2 (@x402/* packages):
//   402 header PAYMENT-REQUIRED: base64(JSON PaymentRequiredV2)
//   request    PAYMENT-SIGNATURE: base64(JSON PaymentPayloadV2)
//   response   PAYMENT-RESPONSE: base64(JSON SettleResponse)
// NeroX serves both on every challenge so v1-only clients are not locked out.

export const HEADERS = {
  v1Payment: "x-payment",
  v1Response: "x-payment-response",
  v2Required: "payment-required",
  v2Payment: "payment-signature",
  v2Response: "payment-response",
};

export const SCHEME = "exact";

/** Local demo chains, plus the public chains NRX targets. */
export const NETWORKS = {
  31337: { v1: "base-local", caip2: "eip155:31337", name: "Base (local)" },
  31338: { v1: "ethereum-local", caip2: "eip155:31338", name: "Ethereum (local)" },
  8453: { v1: "base", caip2: "eip155:8453", name: "Base" },
  84532: { v1: "base-sepolia", caip2: "eip155:84532", name: "Base Sepolia" },
  1: { v1: "ethereum", caip2: "eip155:1", name: "Ethereum" },
  56: { v1: "bsc", caip2: "eip155:56", name: "BNB Chain" },
};

export function chainIdFromNetwork(network) {
  if (typeof network === "number") return network;
  if (network?.startsWith("eip155:")) return Number(network.slice(7));
  const hit = Object.entries(NETWORKS).find(([, n]) => n.v1 === network);
  return hit ? Number(hit[0]) : undefined;
}

export function networkNames(chainId) {
  const n = NETWORKS[chainId];
  if (!n) throw new Error(`Unsupported chain ${chainId}`);
  return n;
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// ------------------------------------------------------------------ base64 JSON

export function encodeHeader(obj) {
  const json = JSON.stringify(obj);
  if (typeof Buffer !== "undefined") return Buffer.from(json, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeHeader(value) {
  if (!value) return undefined;
  const json =
    typeof Buffer !== "undefined"
      ? Buffer.from(value, "base64").toString("utf8")
      : decodeURIComponent(escape(atob(value)));
  return JSON.parse(json);
}

// ------------------------------------------------------------------ requirements

/**
 * Build the requirement for one resource in both formats.
 * @param {object} o
 * @param {number} o.chainId
 * @param {string} o.asset   NRX address on that chain
 * @param {string} o.payTo   seller payout wallet
 * @param {string|bigint} o.amount  price in NRX base units (6 decimals)
 * @param {string} o.resource  absolute URL
 * @param {string} [o.description]
 * @param {string} [o.mimeType]
 * @param {number} [o.maxTimeoutSeconds]
 * @param {object} [o.outputSchema]
 */
export function buildRequirements(o) {
  const net = networkNames(o.chainId);
  const extra = { name: "NeroX USD", version: "1", symbol: "NRX", decimals: 6 };
  const maxTimeoutSeconds = o.maxTimeoutSeconds ?? 60;
  const v1 = {
    scheme: SCHEME,
    network: net.v1,
    maxAmountRequired: String(o.amount),
    resource: o.resource,
    description: o.description ?? "",
    mimeType: o.mimeType ?? "application/json",
    payTo: o.payTo,
    maxTimeoutSeconds,
    asset: o.asset,
    outputSchema: o.outputSchema,
    extra,
  };
  const v2 = {
    scheme: SCHEME,
    network: net.caip2,
    amount: String(o.amount),
    asset: o.asset,
    payTo: o.payTo,
    maxTimeoutSeconds,
    extra,
  };
  return { v1, v2 };
}

/** Full 402 challenge: a v1 JSON body and a v2 PAYMENT-REQUIRED header for the same price. */
export function buildChallenge(reqs, { resource, description, mimeType, error = "Payment required" } = {}) {
  const list = Array.isArray(reqs) ? reqs : [reqs];
  const body = { x402Version: 1, error, accepts: list.map((r) => r.v1) };
  const v2 = {
    x402Version: 2,
    error,
    resource: { url: resource ?? list[0].v1.resource, description: description ?? list[0].v1.description, mimeType: mimeType ?? list[0].v1.mimeType },
    accepts: list.map((r) => r.v2),
    extensions: { bazaar: { discoverable: true } },
  };
  return { body, headers: { [HEADERS.v2Required]: encodeHeader(v2) }, v2 };
}

/** Normalise either requirement shape to { chainId, amount, asset, payTo, maxTimeoutSeconds, extra }. */
export function normaliseRequirement(r) {
  return {
    scheme: r.scheme,
    chainId: chainIdFromNetwork(r.network),
    network: r.network,
    amount: BigInt(r.amount ?? r.maxAmountRequired),
    asset: r.asset,
    payTo: r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds ?? 60,
    extra: r.extra ?? {},
    resource: r.resource,
  };
}

/** Pull { version, payload, requirement? } out of an incoming request's headers. */
export function readPaymentHeader(getHeader) {
  const v2 = getHeader(HEADERS.v2Payment);
  if (v2) {
    const p = decodeHeader(v2);
    return { version: 2, payload: p, accepted: p.accepted };
  }
  const v1 = getHeader(HEADERS.v1Payment);
  if (v1) return { version: 1, payload: decodeHeader(v1) };
  return undefined;
}

export function evmPayloadOf(paymentPayload) {
  return paymentPayload?.payload; // { signature, authorization }
}
