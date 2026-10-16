// Deterministic stand-in outputs for the 20 seeded demo agents. Real agents run models;
// the demo only needs believable, repeatable responses behind a real x402 paywall.
import { createHash } from "node:crypto";

const h = (s) => createHash("sha256").update(String(s)).digest();
const pick = (buf, i, arr) => arr[buf[i % buf.length] % arr.length];
const num = (buf, i, lo, hi, dp = 0) => {
  const v = lo + ((buf[i % buf.length] * 256 + buf[(i + 1) % buf.length]) / 65535) * (hi - lo);
  return Number(v.toFixed(dp));
};

const brains = {
  "weather-oracle": (q, b) => ({
    location: q || "London",
    now: { tempC: num(b, 0, -5, 34, 1), condition: pick(b, 1, ["clear", "cloudy", "light rain", "showers", "fog", "windy"]), windKph: num(b, 2, 0, 45) },
    forecast: [1, 2, 3].map((d) => ({ day: d, highC: num(b, d + 3, 4, 36), lowC: num(b, d + 6, -6, 18), rainPct: num(b, d + 9, 0, 90) })),
  }),
  "fx-rates": (q, b) => {
    const pair = (q || "EUR/USD").toUpperCase();
    return { pair, mid: num(b, 0, 0.6, 1.6, 5), bid: num(b, 0, 0.6, 1.6, 5) - 0.0001, ask: num(b, 0, 0.6, 1.6, 5) + 0.0001, asOf: new Date().toISOString() };
  },
  "onchain-analytics": (q, b) => ({
    address: q || "0x0000000000000000000000000000000000000000",
    label: pick(b, 0, ["active trader", "LP", "bridge user", "dormant", "agent wallet"]),
    txCount30d: num(b, 1, 0, 900), chains: ["base", "ethereum"].slice(0, 1 + (b[2] % 2)),
    topProtocols: [pick(b, 3, ["Aerodrome", "Morpho", "Uniswap", "Aave"]), pick(b, 4, ["CCIP", "Curve", "Pendle"])],
  }),
  "company-filings": (q, b) => ({
    ticker: (q || "ACME").toUpperCase(), period: "FY2025",
    revenueUsdM: num(b, 0, 50, 90_000), operatingMarginPct: num(b, 1, -10, 38, 1),
    segments: ["Products", "Services", "Licensing"].slice(0, 1 + (b[2] % 3)),
    topRisks: ["Supply concentration", "FX exposure", "Regulatory change"].slice(0, 1 + (b[3] % 3)),
  }),
  "geo-lookup": (q, b) => ({ query: q || "10 Downing St", lat: num(b, 0, -60, 70, 5), lng: num(b, 1, -170, 170, 5), country: pick(b, 2, ["GB", "US", "DE", "SG", "AE", "BR"]), tz: pick(b, 3, ["Europe/London", "America/New_York", "Asia/Singapore"]) }),
  "deep-research": (q, b) => ({
    question: q || "State of agent payments in 2026",
    summary: "Agent payments run on HTTP 402 with stablecoin settlement; discovery and escrowed hiring remain fragmented.",
    findings: ["x402 is live on Base, Ethereum (self-hosted facilitators) and BNB Chain", "ERC-8004 registries give agents portable identity and reputation", "ERC-8183 standardises escrowed jobs with evaluators"],
    sources: num(b, 0, 8, 24), confidence: pick(b, 1, ["medium", "high"]),
  }),
  "market-scan": (q, b) => ({ company: q || "Acme", competitors: ["Northwind", "Globex", "Initech"].slice(0, 2 + (b[0] % 2)), pricePosition: pick(b, 1, ["premium", "mid-market", "budget"]), notes: "Pricing scraped from public pages." }),
  "patent-search": (q, b) => ({ invention: q || "Gasless payment authorization", hits: num(b, 0, 2, 40), closest: [`US${num(b, 1, 10_000_000, 12_000_000)}B2`, `EP${num(b, 2, 3_000_000, 4_200_000)}A1`], noveltyRisk: pick(b, 3, ["low", "medium", "high"]) }),
  "lit-review": (q, b) => ({ topic: q || "LLM tool use", papers: num(b, 0, 12, 40), keyFindings: ["Tool-augmented agents outperform on long-horizon tasks", "Evaluation remains inconsistent across benchmarks"], period: "2024–2026" }),
  "news-digest": (q, b) => ({ topic: q || "stablecoins", items: [1, 2, 3].map((i) => ({ headline: `${pick(b, i, ["Regulators", "Issuers", "Banks", "Exchanges"])} ${pick(b, i + 3, ["publish", "expand", "review", "pause"])} ${pick(b, i + 6, ["stablecoin rules", "x402 support", "reserve reports", "agent payments"])}`, sentiment: pick(b, i + 9, ["neutral", "positive", "negative"]) })) }),
  "solidity-auditor": (q, b) => ({ target: (q || "contract").slice(0, 60), findings: [{ severity: pick(b, 0, ["low", "medium", "high"]), title: "Unchecked return value on external call" }, { severity: "info", title: "Consider custom errors to save gas" }], score: num(b, 1, 62, 97) }),
  "ts-linter": (q, b) => ({ files: 1, issues: num(b, 0, 0, 14), rules: ["no-floating-promises", "strict-boolean-expressions"].slice(0, 1 + (b[1] % 2)), fixable: num(b, 2, 0, 8) }),
  "pr-reviewer": (q, b) => ({ verdict: pick(b, 0, ["approve", "request changes", "comment"]), comments: num(b, 1, 0, 12), summary: "Logic is sound; add a test for the empty-input path." }),
  "gas-optimizer": (q, b) => ({ savingsPct: num(b, 0, 2, 31, 1), suggestions: ["Pack storage slots in struct Job", "Cache array length in loops", "Use calldata for read-only params"].slice(0, 1 + (b[1] % 3)) }),
  "test-writer": (q, b) => ({ testsGenerated: num(b, 0, 4, 40), coverageBefore: num(b, 1, 20, 60), coverageAfter: num(b, 2, 70, 98), framework: pick(b, 3, ["foundry", "hardhat", "vitest"]) }),
  translator: (q, b) => ({ source: q || "Hello, world", target: pick(b, 0, ["es", "fr", "de", "ja", "pt"]), text: pick(b, 1, ["Hola, mundo", "Bonjour, le monde", "Hallo, Welt", "こんにちは世界", "Olá, mundo"]) }),
  summarizer: (q) => ({ length: "short", summary: (q || "NeroX is stable money for the machine economy.").split(/\s+/).slice(0, 18).join(" ") + "…" }),
  "copy-editor": (q, b) => ({ edits: num(b, 0, 1, 25), readability: pick(b, 1, ["grade 7", "grade 9", "grade 11"]), text: (q || "Your copy here").replace(/\s+/g, " ").trim() }),
  "alt-text": (q, b) => ({ image: q || "https://example.com/image.png", alt: `${pick(b, 0, ["A chart", "A person", "A city street", "A product photo"])} ${pick(b, 1, ["at dusk", "on a white background", "with labelled axes", "in close-up"])}` }),
  "seo-brief": (q, b) => ({ query: q || "agent payments", intent: pick(b, 0, ["informational", "commercial"]), keywords: ["x402", "stablecoin api payments", "pay per call api"].slice(0, 2 + (b[1] % 2)), wordCount: num(b, 2, 900, 2200) }),
};

export function runAgent(slug, input) {
  const b = h(`${slug}:${input}`);
  const fn = brains[slug] ?? ((q) => ({ echo: q, note: "Hosted agent response" }));
  return fn(input, b);
}

export function deliverableFor(slug, description, jobId) {
  return {
    jobId: String(jobId),
    agent: slug,
    brief: description,
    deliveredAt: new Date().toISOString(),
    result: runAgent(slug, `${description}#${jobId}`),
  };
}
