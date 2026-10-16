// Seller side: Express/Connect-style middleware that prices a route in NRX.
// Serves challenges in both x402 v1 and v2 formats, verifies and settles through a facilitator.
import { HEADERS, buildChallenge, buildRequirements, encodeHeader, readPaymentHeader, chainIdFromNetwork } from "./protocol.js";

export function facilitatorClient(url) {
  const post = async (path, body) => {
    const res = await fetch(new URL(path, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    if (!res.ok && res.status !== 400) throw new Error(`facilitator ${path} ${res.status}`);
    return res.json();
  };
  return {
    verify: (paymentPayload, paymentRequirements) =>
      post("/verify", { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements, meta) =>
      post("/settle", { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements, meta }),
    supported: async () => (await fetch(new URL("/supported", url))).json(),
  };
}

function selectRequirement(header, reqs) {
  if (header.version === 2) {
    const a = header.accepted;
    if (!a) return undefined;
    return reqs.find(
      (r) => r.v2.network === a.network && r.v2.asset.toLowerCase() === a.asset?.toLowerCase() && r.v2.payTo.toLowerCase() === a.payTo?.toLowerCase(),
    )?.v2;
  }
  const chainId = chainIdFromNetwork(header.payload?.network);
  return reqs.find((r) => chainIdFromNetwork(r.v1.network) === chainId)?.v1;
}

/**
 * @param {object} opts
 * @param {string} opts.facilitatorUrl
 * @param {(req) => Array<{chainId:number, asset:string, payTo:string, amount:string|bigint, description?:string, mimeType?:string}> | undefined} opts.price
 *   Return the accepted payment options for this request, or undefined if the route is free.
 * @param {(req, settlement) => object} [opts.meta]  extra context logged by the facilitator
 */
export function paymentMiddleware({ facilitatorUrl, price, meta }) {
  const fac = facilitatorClient(facilitatorUrl);
  return async (req, res, next) => {
    try {
      const options = await price(req);
      if (!options || options.length === 0) return next();
      const resource = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
      const reqs = options.map((o) => buildRequirements({ ...o, resource }));
      const challenge = buildChallenge(reqs, { resource });
      res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");

      const deny = (error) => {
        const c = buildChallenge(reqs, { resource, error });
        for (const [k, v] of Object.entries(c.headers)) res.setHeader(k, v);
        return res.status(402).json(c.body);
      };

      const header = readPaymentHeader((n) => req.get(n));
      if (!header) return deny("Payment required");
      const selected = selectRequirement(header, reqs);
      if (!selected) return deny("No matching payment requirement");

      const v = await fac.verify(header.payload, selected);
      if (!v.isValid) return deny(v.invalidReason ?? "Invalid payment");
      // Settle before serving so the seller is never left unpaid for delivered work.
      const s = await fac.settle(header.payload, selected, meta ? meta(req) : undefined);
      if (!s.success) return deny(s.errorReason ?? "Settlement failed");

      const encoded = encodeHeader(s);
      res.setHeader(header.version === 2 ? HEADERS.v2Response : HEADERS.v1Response, encoded);
      req.x402 = { ...s, version: header.version, requirement: selected, payer: v.payer, challenge: challenge.v2 };
      return next();
    } catch (e) {
      return next(e);
    }
  };
}
