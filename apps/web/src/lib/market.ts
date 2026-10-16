import type { Address } from "viem";

export type JobMenuItem = { title: string; budget: string; hours: number; budgetBaseUnits: string };
export type Agent = {
  agentId: number; name: string; description: string; image?: string; category: string; skills: string[];
  owner: Address; wallet: Address; uri: string; price: string | null; priceNrx: string | null; jobMenu: JobMenuItem[];
  endpoints: { name: string; endpoint: string; version?: string }[]; registeredAt: number; verified: boolean;
  reputation: { score: number | null; count: number; hiddenUnpaid: number; paidReviewers: number };
  stats: { calls: number; jobsCompleted: number; jobsOpen: number; refundRate: number; medianDeliveryMs: number | null; uptime: number | null; revenue: string };
  bond: { value: string; free: string } | null;
  sale: { seller: Address; price: string; listedAt: number } | null;
};
export type Job = {
  jobId: number; client: Address; provider: Address; evaluator: Address; agentId: number; agentName?: string; budget: string; evaluatorFee: string;
  bondLocked: string; bondOwner: Address; createdAt: number; fundedAt: number; submittedAt: number; expiredAt: number;
  status: "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired"; kind: "Buyer" | "Contract" | "Pool"; deliverable: string; description: string;
  events: { type: string; tx: string; time: number; reason?: string; slashed?: string }[];
};
export type AgentDetail = Agent & {
  registration: Record<string, unknown>;
  feedback: { agentId: number; client: Address; score: number; tag: string; tx: string; time: number; paidReviewer: boolean }[];
  jobs: Job[];
  recentCalls: { id: string; time: number; payer: Address; amount: string; tx: string; x402Version: number }[];
  transfers: { from: Address; to: Address; tx: string; time: number }[];
  sales: { seller: Address; buyer: Address; price: string; fee: string; tx: string; time: number }[];
  offers: { offerId: number; buyer: Address; amount: string; expiresAt: number; active: boolean }[];
};
export const CATEGORIES = ["data", "research", "code review", "content"];
export const x402Endpoint = (a: Agent) => a.endpoints.find((e) => e.name === "x402")?.endpoint;
export const statusTone = (s: Job["status"]) => (s === "Completed" ? "chip-signal" : s === "Rejected" || s === "Expired" ? "chip-danger" : s === "Submitted" ? "chip-brand" : "");
