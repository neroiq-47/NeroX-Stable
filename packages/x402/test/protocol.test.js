import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  buildRequirements, buildChallenge, decodeHeader, encodeHeader, normaliseRequirement, readPaymentHeader,
  TRANSFER_WITH_AUTHORIZATION_TYPES, HEADERS, chainIdFromNetwork,
} from "../src/protocol.js";
import { createPayment } from "../src/client.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NRX = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const SELLER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const reqs = buildRequirements({ chainId: 31337, asset: NRX, payTo: SELLER, amount: 2500n, resource: "http://x/agents/weather" });

test("builds matching v1 and v2 requirements", () => {
  assert.equal(reqs.v1.network, "base-local");
  assert.equal(reqs.v2.network, "eip155:31337");
  assert.equal(reqs.v1.maxAmountRequired, "2500");
  assert.equal(reqs.v2.amount, "2500");
  assert.deepEqual(normaliseRequirement(reqs.v1).amount, normaliseRequirement(reqs.v2).amount);
  assert.equal(chainIdFromNetwork("ethereum-local"), 31338);
});

test("challenge carries a v1 body and a v2 header for the same price", () => {
  const c = buildChallenge(reqs);
  assert.equal(c.body.x402Version, 1);
  const v2 = decodeHeader(c.headers[HEADERS.v2Required]);
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.accepts[0].amount, c.body.accepts[0].maxAmountRequired);
  assert.equal(v2.resource.url, "http://x/agents/weather");
});

test("base64 header round-trips unicode", () => {
  const o = { a: "naïve — ✓", n: 1 };
  assert.deepEqual(decodeHeader(encodeHeader(o)), o);
});

for (const version of [1, 2]) {
  test(`v${version} payment signs a verifiable EIP-3009 authorization`, async () => {
    const raw = version === 1 ? reqs.v1 : reqs.v2;
    const p = await createPayment(account, raw, version, { now: 1_700_000_000 });
    assert.equal(p.x402Version, version);
    const a = p.payload.authorization;
    assert.equal(a.to, SELLER);
    assert.equal(a.value, "2500");
    const ok = await verifyTypedData({
      address: account.address,
      domain: { name: "NeroX USD", version: "1", chainId: 31337, verifyingContract: NRX },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.payload.signature,
    });
    assert.ok(ok);
    const headerName = version === 1 ? HEADERS.v1Payment : HEADERS.v2Payment;
    const read = readPaymentHeader((n) => (n === headerName ? encodeHeader(p) : undefined));
    assert.equal(read.version, version);
  });
}
