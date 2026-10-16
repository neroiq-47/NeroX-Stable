# NeroX-Stable

NeroX: stable money for the machine economy. NRX is a 1:1 USD-backed stablecoin built for x402 agent payments on Ethereum, Base and BNB Chain. sNRX is a savings vault earning from real borrowers. Includes the NeroX dApp (mint, earn, borrow, bridge) and the Agent Market, where AI agents are called, hired and bought in NRX.

This repository is a full-scale MVP demo built to the five specs (Design System v1, dApp MVP Scope, x402 Stablecoin MVP Scope, Agent Market Plan and Design, Lite Paper). It runs end to end on two local chains: real contracts, real EIP-3009 x402 payments, a real facilitator, a CCIP-style relayer, an indexer, and the dApp.

## Run it

```bash
npm install
npm run demo            # chains → deploy + seed → services → dApp on http://localhost:3000
npm run demo -- --no-web
npm test                # 40 contract tests + x402 protocol tests
```

Requires Node 22. `npm run demo` starts:

| Process | Port | What it is |
| --- | --- | --- |
| Base (local) | 8545 | Hardhat chain, chain ID 31337, 1 s interval mining |
| Ethereum (local) | 8546 | Hardhat chain, chain ID 31338 |
| Facilitator + Seller Console API | 4020 | x402 `/verify`, `/settle`, `/supported`, settle log, SIWE console, keeper |
| Agents host | 4021 | 20 seeded agents: ERC-8004 registration files, A2A cards, x402-paid endpoints, job workers, demo evaluators, console sandboxes |
| Market API | 4022 | Indexer, search, paid-reviewer reputation, A2A agent, MCP server, Bazaar feed, sanctions screening, demo controls |
| CCIP relayer | 4023 | Burn → finality → 2-of-3 attestation → mint, message status |
| dApp | 3000 | Next.js App Router |

In the dApp, press **Connect** and pick a demo persona (each is a funded dev account):

- **Alice** — holder: mint, stake, borrow, bridge, pools
- **Bob** — x402 seller: Seller Console
- **Carol** — agent buyer: call and hire agents (also drives background traffic)
- **Dev Studio** — owns five listed agents, including Solidity Auditor
- **Erin** — bonded pool evaluator
- **Mallory** — sanctioned; blocked by the screening gate

**Demo controls** (footer): faucet, fast-forward 30 days (accrues borrower interest so sNRX grows), drop the cbBTC price (see health factor and liquidation warnings), toggle background agent traffic. Add `?geo=IR` to any URL to see geo-gating; `?geo=GB` clears it.

## What's in the box

```
packages/contracts   Solidity (Hardhat): protocol, market, local stand-ins, tests, deploy/seed
packages/x402        x402 v1 + v2 "exact" scheme for NRX: challenges, signing, middleware, verify/settle
packages/services    Facilitator, agents host, CCIP relayer, market indexer/API, keeper, demo traffic
apps/web             Next.js dApp + Agent Market (wagmi/viem, NeroX design system)
scripts/demo.mjs     One-command orchestrator
```

### Contracts (`packages/contracts/contracts`)

| Contract | Spec | Notes |
| --- | --- | --- |
| `core/NRX.sol` | ERC-20 + EIP-2612 + EIP-3009, burn/mint | 6 decimals; role-gated minters with allowances; per-chain supply cap; pause; blocklist; ERC-1271-aware signatures |
| `core/NeroPSM.sol` | 1:1 USDC ⇄ NRX | Daily mint/redeem caps, global cap, fees ≤ 1%, permit one-tx mint/redeem, guardian pause |
| `core/SNRX.sol` | ERC-4626 vault | Virtual shares (offset 6), 10% idle buffer, withdrawal queue, deposit cap, fee-income top-ups, permit deposit |
| `core/MorphoLenderStrategy.sol` | Morpho lender adapter | Supplies vault NRX to NeroX markets by weight |
| `core/NeroTokenPool.sol` | CCIP burn/mint pool | Token-bucket rate limits both directions, 2-of-3 attestation quorum, replay protection |
| `periphery/Timelock.sol` | Timelock + Safe | 48 h; NRX, PSM, sNRX and pool admin move behind it at the end of the deploy |
| `periphery/AutoSweeper.sol` | Seller auto-sweep | Opt-in threshold rule, capped allowance budget, deposits into sNRX for the seller |
| `market/ERC8004Registries.sol` | ERC-8004 identity + reputation | Signature-verified agent wallet; wallet follows ownership on sale; reviewer-filtered summaries |
| `market/NeroJobs.sol` | ERC-8183 escrow | Open → Funded → Submitted → Completed/Rejected/Expired; buyer/contract/pool evaluators; random pool pick; shared-owner block; 3% fee on completion; fee waivers; 1,000 NRX cap; pool required above 500 NRX; bond lock/slash; open refund after expiry |
| `market/SellerBond.sol` | sNRX bonds | Lock per open job, slash only by NeroJobs, 7-day withdrawal timelock |
| `market/AgentSale.sol` | Buy an agent | Atomic NRX ⇄ ERC-8004 token swap, 2.5% fee, escrowed offers, blocked while jobs are open |

**Local stand-ins** (in `mocks/`) replace venues the MVP wraps rather than rebuilds: `MorphoBlueLite` (Morpho Blue share maths, LLTV, liquidation incentive, kinked IRM), `StablePoolLite` (Aerodrome sAMM stable invariant, 0.05% fee), `MockERC20` (USDC, cbBTC, wstETH with permit and faucet), `MockOracle`, `MockSanctionsOracle` (Chainalysis interface). On mainnet these are the canonical deployments.

### x402 (`packages/x402`)

Every challenge is served in **both** formats: a v1 JSON body (`accepts[].maxAmountRequired`, `X-PAYMENT`) and a v2 `PAYMENT-REQUIRED` header (CAIP-2 networks, `PAYMENT-SIGNATURE`), so x402-fetch v1 agents and `@x402/*` v2 agents can both pay. Settlement is EIP-3009 `transferWithAuthorization` submitted by the facilitator's gas wallet; the facilitator checks recipient, amount, validity window, signature, nonce, balance, pause, blocklist and sanctions. Clients sign against the chain clock (`now` option), since the demo can fast-forward chain time.

### dApp (`apps/web`)

Screens: Dashboard, Mint/Redeem, Earn (sNRX), Pools, Borrow, Bridge, x402 Seller Console, Transparency, and the Market (Browse, Listing with Call/Hire/Buy, My jobs, Sell an agent, Evaluator).

Guardrails from the dApp scope: verified address book (the app refuses any other target), simulate-before-sign on every write, exact approvals or EIP-2612 permits (never unlimited), EIP-5792 batching with a sequential "Step 1 of 2" fallback, health-factor guard at 80% of LLTV with liquidation price, bridge rate-limit headroom check, pause awareness, pending transactions that survive reloads, sanctions screening on connect, terms on first connect, edge geo-gating, a capped-beta banner, CSP headers, and NRX copy that never uses yield words (yield language lives only on Earn, in lime).

## Simplifications to know about

- **Two local chains** stand in for Base and Ethereum; BNB Chain appears in the switcher as "medium phase".
- **CCIP**: the relayer plays the DON with a 2-of-3 signer committee. Production uses Chainlink CCIP lanes and `BurnMintTokenPool`.
- **Market call fee (1%)** is recorded per settlement and invoiced to the seller rather than split on-chain, because an EIP-3009 signature binds the payee.
- **Wallets**: the demo connector signs with unlocked dev accounts; injected wallets (MetaMask etc.) also work. RainbowKit/WalletConnect would replace the connect sheet in production.
- **Storage**: services persist to JSON files in `packages/services/data` instead of Postgres/Redis; console sessions are in memory.
- **Agents** return deterministic stand-in outputs behind real x402 paywalls; deliverables are hashed on-chain and checked by the contract evaluator.
- No audits have been done. This is a demo, not a deployment.
