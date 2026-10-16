// Facilitator side: verify and settle an "exact" EIP-3009 payment on-chain.
import { verifyTypedData, getAddress, parseAbi } from "viem";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, normaliseRequirement, chainIdFromNetwork } from "./protocol.js";

export const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function paused() view returns (bool)",
  "function blocklisted(address) view returns (bool)",
]);

/** Seconds of headroom the facilitator needs to land the transaction before validBefore. */
const SETTLE_BUFFER = 6;

/**
 * @param {object} args
 * @param {object} args.paymentPayload   v1 or v2 payload
 * @param {object} args.paymentRequirements  the requirement the server selected
 * @param {import('viem').PublicClient} args.publicClient  for the requirement's chain
 * @param {(addr: string) => Promise<boolean>} [args.isSanctioned]
 * @returns {Promise<{isValid: boolean, invalidReason?: string, payer?: string}>}
 */
export async function verifyExactPayment({ paymentPayload, paymentRequirements, publicClient, isSanctioned }) {
  const req = normaliseRequirement(paymentRequirements);
  const p = paymentPayload?.payload;
  const auth = p?.authorization;
  const fail = (invalidReason) => ({ isValid: false, invalidReason, payer: auth?.from });
  if (!p || !auth || !p.signature) return fail("invalid_payload");

  const payloadNetwork = paymentPayload.x402Version === 2 ? paymentPayload.accepted?.network : paymentPayload.network;
  if ((paymentPayload.scheme ?? paymentPayload.accepted?.scheme) !== "exact") return fail("unsupported_scheme");
  if (chainIdFromNetwork(payloadNetwork) !== req.chainId) return fail("invalid_network");
  const chainId = await publicClient.getChainId();
  if (chainId !== req.chainId) return fail("invalid_network");

  let to;
  try {
    to = getAddress(auth.to);
  } catch {
    return fail("invalid_exact_evm_payload_recipient_mismatch");
  }
  if (to !== getAddress(req.payTo)) return fail("invalid_exact_evm_payload_recipient_mismatch");
  if (BigInt(auth.value) < req.amount) return fail("invalid_exact_evm_payload_authorization_value");

  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);
  if (BigInt(auth.validBefore) < BigInt(now + SETTLE_BUFFER)) return fail("invalid_exact_evm_payload_authorization_valid_before");
  if (BigInt(auth.validAfter) > BigInt(now)) return fail("invalid_exact_evm_payload_authorization_valid_after");

  const ok = await verifyTypedData({
    address: auth.from,
    domain: { name: req.extra.name ?? "NeroX USD", version: req.extra.version ?? "1", chainId: req.chainId, verifyingContract: req.asset },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: p.signature,
  }).catch(() => false);
  if (!ok) return fail("invalid_exact_evm_payload_signature");

  const [used, balance, paused, blocked] = await Promise.all([
    publicClient.readContract({ address: req.asset, abi: EIP3009_ABI, functionName: "authorizationState", args: [auth.from, auth.nonce] }),
    publicClient.readContract({ address: req.asset, abi: EIP3009_ABI, functionName: "balanceOf", args: [auth.from] }),
    publicClient.readContract({ address: req.asset, abi: EIP3009_ABI, functionName: "paused" }).catch(() => false),
    publicClient.readContract({ address: req.asset, abi: EIP3009_ABI, functionName: "blocklisted", args: [auth.from] }).catch(() => false),
  ]);
  if (used) return fail("invalid_exact_evm_payload_authorization_nonce_used");
  if (balance < BigInt(auth.value)) return fail("insufficient_funds");
  if (paused) return fail("asset_paused");
  if (blocked) return fail("payer_blocklisted");
  if (isSanctioned && (await isSanctioned(auth.from))) return fail("payer_sanctioned");

  return { isValid: true, payer: getAddress(auth.from) };
}

/**
 * Submit transferWithAuthorization from the facilitator's gas wallet.
 * @returns {Promise<{success: boolean, errorReason?: string, transaction: string, network: string, payer: string}>}
 */
export async function settleExactPayment({ paymentPayload, paymentRequirements, publicClient, walletClient, isSanctioned }) {
  const network = paymentRequirements.network;
  const v = await verifyExactPayment({ paymentPayload, paymentRequirements, publicClient, isSanctioned });
  if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network, payer: v.payer ?? "" };
  const req = normaliseRequirement(paymentRequirements);
  const { authorization: a, signature } = paymentPayload.payload;
  try {
    const hash = await walletClient.writeContract({
      address: req.asset,
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature],
      chain: walletClient.chain,
      account: walletClient.account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { success: false, errorReason: "transaction_reverted", transaction: hash, network, payer: v.payer };
    return { success: true, transaction: hash, network, payer: v.payer, blockNumber: Number(receipt.blockNumber) };
  } catch (e) {
    return { success: false, errorReason: "unexpected_settle_error", detail: e.shortMessage ?? e.message, transaction: "", network, payer: v.payer };
  }
}
