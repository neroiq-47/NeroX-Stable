// Deploys and seeds the NeroX MVP on two local chains ("Base" and "Ethereum"), links the
// CCIP-style lanes, then hands protocol admin to the 48h timelock.
// Usage: node scripts/deploy-local.mjs  (expects nodes on BASE_RPC / ETH_RPC)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MNEMONIC = "test test test test test test test test test test test junk";
const BASE_RPC = process.env.BASE_RPC || "http://127.0.0.1:8545";
const ETH_RPC = process.env.ETH_RPC || "http://127.0.0.1:8546";
const AGENTS_HOST = process.env.AGENTS_HOST || "http://localhost:4021";

// CCIP chain selectors for Base and Ethereum mainnet, reused for the local lanes.
const SELECTORS = { base: 15971525489660198786n, ethereum: 5009297550715157269n };

const ROLES = {
  deployer: 0, guardian: 1, don1: 2, don2: 3, don3: 4, facilitator: 5, keeper: 6,
  alice: 7, bob: 8, carol: 9, mallory: 10, eval1: 11, eval2: 12, eval3: 13,
  contractEvaluator: 14, owner0: 15, owner1: 16, owner2: 17, owner3: 18, botLp: 19,
};

const u6 = (x) => ethers.parseUnits(String(x), 6);
const u8 = (x) => ethers.parseUnits(String(x), 8);
const u18 = (x) => ethers.parseUnits(String(x), 18);
const DAY = 86400;

function artifact(name) {
  const paths = {
    NRX: "core/NRX.sol/NRX.json",
    NeroPSM: "core/NeroPSM.sol/NeroPSM.json",
    SNRX: "core/SNRX.sol/SNRX.json",
    MorphoLenderStrategy: "core/MorphoLenderStrategy.sol/MorphoLenderStrategy.json",
    NeroTokenPool: "core/NeroTokenPool.sol/NeroTokenPool.json",
    MorphoBlueLite: "mocks/MorphoBlueLite.sol/MorphoBlueLite.json",
    KinkIrm: "mocks/MorphoBlueLite.sol/KinkIrm.json",
    MockOracle: "mocks/MorphoBlueLite.sol/MockOracle.json",
    StablePoolLite: "mocks/StablePoolLite.sol/StablePoolLite.json",
    MockERC20: "mocks/MockERC20.sol/MockERC20.json",
    MockSanctionsOracle: "mocks/MockSanctionsOracle.sol/MockSanctionsOracle.json",
    IdentityRegistry: "market/ERC8004Registries.sol/IdentityRegistry.json",
    ReputationRegistry: "market/ERC8004Registries.sol/ReputationRegistry.json",
    SellerBond: "market/SellerBond.sol/SellerBond.json",
    NeroJobs: "market/NeroJobs.sol/NeroJobs.json",
    AgentSale: "market/AgentSale.sol/AgentSale.json",
    AutoSweeper: "periphery/AutoSweeper.sol/AutoSweeper.json",
    NeroTimelock: "periphery/Timelock.sol/NeroTimelock.json",
  };
  const p = join(root, "artifacts/contracts", paths[name]);
  return JSON.parse(readFileSync(p, "utf8"));
}

function wallets(provider) {
  const out = {};
  for (const [name, i] of Object.entries(ROLES)) {
    const w = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    out[name] = new ethers.NonceManager(w.connect(provider));
    out[name].address = w.address;
    out[name].privateKey = w.privateKey;
  }
  return out;
}

async function deploy(signer, name, args = []) {
  const a = artifact(name);
  const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

const at = (name, address, signer) => new ethers.Contract(address, artifact(name).abi, signer);
async function send(p) {
  const tx = await p;
  return tx.wait();
}

async function deployChain(key, rpc) {
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const net = await provider.getNetwork();
  const w = wallets(provider);
  const d = w.deployer;
  const isBase = key === "base";
  console.log(`\n[${key}] chainId ${net.chainId} — deploying`);

  const usdc = await deploy(d, "MockERC20", ["USD Coin", "USDC", 6, u6(10_000)]);
  const sanctions = await deploy(d, "MockSanctionsOracle");
  await send(sanctions.addToSanctionsList([w.mallory.address]));

  const timelock = await deploy(d, "NeroTimelock", [2 * DAY, [d.address], [d.address], d.address]);
  const nrx = await deploy(d, "NRX", [d.address, u6(5_000_000)]);
  const psm = await deploy(d, "NeroPSM", [
    d.address, w.guardian.address, await usdc.getAddress(), await nrx.getAddress(),
    u6(2_000_000), u6(2_000_000), u6(2_000_000), // seeding caps; beta caps set at handover
  ]);
  await send(nrx.configureMinter(await psm.getAddress(), u6(2_000_000)));
  await send(nrx.grantRole(await nrx.PAUSER_ROLE(), w.guardian.address));
  await send(nrx.grantRole(await nrx.BLOCKLISTER_ROLE(), d.address));

  const snrx = await deploy(d, "SNRX", [d.address, w.guardian.address, await nrx.getAddress(), u6(1_000_000)]);
  await send(snrx.grantRole(await snrx.KEEPER_ROLE(), w.keeper.address));

  const pool = await deploy(d, "NeroTokenPool", [d.address, await nrx.getAddress(), SELECTORS[key], ethers.parseEther("0.0005")]);
  await send(nrx.configureMinter(await pool.getAddress(), u6(1_000_000)));
  for (const s of [w.don1, w.don2, w.don3]) await send(pool.setSigner(s.address, true));
  await send(pool.setQuorum(2));

  const sweeper = await deploy(d, "AutoSweeper", [await nrx.getAddress(), await snrx.getAddress()]);

  const contracts = {
    USDC: usdc, SanctionsOracle: sanctions, Timelock: timelock, NRX: nrx, NeroPSM: psm, sNRX: snrx,
    TokenPool: pool, AutoSweeper: sweeper,
  };
  const markets = {};

  if (isBase) {
    const cbBTC = await deploy(d, "MockERC20", ["Coinbase Wrapped BTC", "cbBTC", 8, u8(0.5)]);
    const wstETH = await deploy(d, "MockERC20", ["Wrapped liquid staked Ether", "wstETH", 18, u18(5)]);
    const morpho = await deploy(d, "MorphoBlueLite");
    const irm = await deploy(d, "KinkIrm");
    // Morpho oracle price: loan units per collateral unit × 1e36.
    const btcOracle = await deploy(d, "MockOracle", [65_000n * 10n ** 6n * 10n ** 36n / 10n ** 8n]);
    const ethOracle = await deploy(d, "MockOracle", [3_400n * 10n ** 6n * 10n ** 36n / 10n ** 18n]);
    const mk = async (collateral, oracle, lltv) => ({
      loanToken: await nrx.getAddress(), collateralToken: await collateral.getAddress(),
      oracle: await oracle.getAddress(), irm: await irm.getAddress(), lltv,
    });
    markets.cbBTC = await mk(cbBTC, btcOracle, u18(0.77));
    markets.wstETH = await mk(wstETH, ethOracle, u18(0.86));
    await send(morpho.createMarket(markets.cbBTC));
    await send(morpho.createMarket(markets.wstETH));
    markets.cbBTC.id = await morpho.id(markets.cbBTC);
    markets.wstETH.id = await morpho.id(markets.wstETH);

    const strategy = await deploy(d, "MorphoLenderStrategy", [d.address, await nrx.getAddress(), await morpho.getAddress()]);
    await send(strategy.setVault(await snrx.getAddress()));
    const strip = ({ id, ...p }) => p;
    await send(strategy.setMarkets([strip(markets.cbBTC), strip(markets.wstETH)], [5_000, 5_000]));
    await send(snrx.setStrategy(await strategy.getAddress()));

    const amm = await deploy(d, "StablePoolLite", [await nrx.getAddress(), await usdc.getAddress()]);

    const identity = await deploy(d, "IdentityRegistry");
    const reputation = await deploy(d, "ReputationRegistry", [await identity.getAddress()]);
    const bonds = await deploy(d, "SellerBond", [d.address, await snrx.getAddress()]);
    const jobs = await deploy(d, "NeroJobs", [d.address, await nrx.getAddress(), await identity.getAddress(), await bonds.getAddress(), d.address]);
    await send(bonds.grantRole(await bonds.JOBS_ROLE(), await jobs.getAddress()));
    await send(jobs.setContractEvaluator(w.contractEvaluator.address, true));
    const sale = await deploy(d, "AgentSale", [d.address, await nrx.getAddress(), await identity.getAddress(), await jobs.getAddress(), d.address]);

    Object.assign(contracts, {
      cbBTC, wstETH, Morpho: morpho, Irm: irm, OracleCbBTC: btcOracle, OracleWstETH: ethOracle,
      MorphoLenderStrategy: strategy, AerodromePool: amm, IdentityRegistry: identity,
      ReputationRegistry: reputation, SellerBond: bonds, NeroJobs: jobs, AgentSale: sale,
    });
  }

  return { key, provider, w, chainId: Number(net.chainId), rpc, contracts, markets };
}

async function link(a, b) {
  const pa = a.contracts.TokenPool, pb = b.contracts.TokenPool;
  // 100,000 NRX bucket, refilling at 100,000 NRX per day.
  const cap = u6(100_000), rate = u6(100_000) / BigInt(DAY);
  await send(pa.configureLane(SELECTORS[b.key], await pb.getAddress(), cap, rate));
  await send(pb.configureLane(SELECTORS[a.key], await pa.getAddress(), cap, rate));
}

async function seedChain(c, agents) {
  const { w, contracts: k } = c;
  const d = w.deployer;
  const isBase = c.key === "base";
  console.log(`[${c.key}] seeding`);
  const usdcBy = (s) => k.USDC.connect(s);
  const mintNRX = async (s, amount) => {
    await send(k.USDC.mint(s.address, amount));
    await send(usdcBy(s).approve(await k.NeroPSM.getAddress(), amount));
    await send(k.NeroPSM.connect(s).mint(amount, s.address));
  };

  // Holders start with USDC; the protocol seeds liquidity and the vault.
  for (const [name, amt] of [["alice", 25_000], ["bob", 5_000], ["carol", 10_000], ["mallory", 1_000]]) {
    await send(k.USDC.mint(w[name].address, u6(amt)));
  }
  await mintNRX(w.carol, u6(isBase ? 4_000 : 1_000));
  await mintNRX(w.alice, u6(isBase ? 1_500 : 800));

  // Native gas for keys that only sign (facilitator/keeper already funded by the node).
  if (isBase) {
    await mintNRX(d, u6(330_000));
    // Protocol-owned liquidity in the Aerodrome-style pool: 100k NRX + 100k USDC.
    await send(k.USDC.mint(d.address, u6(100_000)));
    const ammAddr = await k.AerodromePool.getAddress();
    await send(k.NRX.approve(ammAddr, u6(100_000)));
    await send(k.USDC.approve(ammAddr, u6(100_000)));
    const t0 = await k.AerodromePool.token0();
    const [a0, a1] = t0.toLowerCase() === (await k.NRX.getAddress()).toLowerCase()
      ? [u6(100_000), u6(100_000)] : [u6(100_000), u6(100_000)];
    await send(k.AerodromePool.addLiquidity(a0, a1, 0, d.address));

    // sNRX: protocol deposits 200k NRX; 90% goes to Morpho as supply.
    const snrxAddr = await k.sNRX.getAddress();
    await send(k.NRX.approve(snrxAddr, u6(200_000)));
    await send(k.sNRX.deposit(u6(200_000), d.address));

    // A borrower bot uses the markets so sNRX has real borrower interest.
    const bot = w.botLp;
    const morphoAddr = await k.Morpho.getAddress();
    await send(k.cbBTC.mint(bot.address, u8(2.2)));
    await send(k.wstETH.mint(bot.address, u18(36)));
    await send(k.cbBTC.connect(bot).approve(morphoAddr, u8(2.2)));
    await send(k.wstETH.connect(bot).approve(morphoAddr, u18(36)));
    const strip = ({ id, ...p }) => p;
    await send(k.Morpho.connect(bot).supplyCollateralAndBorrow(strip(c.markets.cbBTC), u8(2.2), u6(70_000), bot.address));
    await send(k.Morpho.connect(bot).supplyCollateralAndBorrow(strip(c.markets.wstETH), u18(36), u6(70_000), bot.address));
    // Alice holds some collateral to try Borrow.
    await send(k.cbBTC.mint(w.alice.address, u8(0.25)));
    await send(k.wstETH.mint(w.alice.address, u18(3)));

    await seedMarket(c, agents);
  } else {
    await mintNRX(d, u6(60_000));
    const snrxAddr = await k.sNRX.getAddress();
    await send(k.NRX.approve(snrxAddr, u6(40_000)));
    await send(k.sNRX.deposit(u6(40_000), d.address));
  }
}

async function seedMarket(c, agents) {
  const { w, contracts: k } = c;
  const d = w.deployer;
  const owners = [w.owner0, w.owner1, w.owner2, w.owner3];
  const snrxAddr = await k.sNRX.getAddress();
  const bondAddr = await k.SellerBond.getAddress();
  const psmAddr = await k.NeroPSM.getAddress();

  // Owners and evaluators: USDC → NRX → sNRX → bond.
  const bondUp = async (s, nrxAmount) => {
    await send(k.USDC.mint(s.address, nrxAmount));
    await send(k.USDC.connect(s).approve(psmAddr, nrxAmount));
    await send(k.NeroPSM.connect(s).mint(nrxAmount, s.address));
    await send(k.NRX.connect(s).approve(snrxAddr, nrxAmount));
    await send(k.sNRX.connect(s).deposit(nrxAmount, s.address));
    const shares = await k.sNRX.balanceOf(s.address);
    await send(k.sNRX.connect(s).approve(bondAddr, shares));
    await send(k.SellerBond.connect(s).deposit(shares));
  };
  for (const o of owners) await bondUp(o, u6(2_500));
  for (const e of [w.eval1, w.eval2, w.eval3]) {
    await bondUp(e, u6(1_000));
    await send(k.NeroJobs.connect(e).joinEvaluatorPool());
  }
  // Launch incentive: the first verified sellers trade fee-free for 90 days.
  const now = (await c.provider.getBlock("latest")).timestamp;
  await send(k.NeroJobs.setFeeWaiver(w.owner0.address, now + 90 * DAY));

  const ids = [];
  for (const a of agents) {
    const o = owners[a.owner];
    const uri = `${AGENTS_HOST}/agents/${a.slug}/registration.json`;
    const tx = await k.IdentityRegistry.connect(o)["register(string)"](uri);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return k.IdentityRegistry.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Registered");
    ids.push({ slug: a.slug, agentId: Number(ev.args.agentId), owner: o.address });
    if (a.forSale) {
      await send(k.IdentityRegistry.connect(o).approve(await k.AgentSale.getAddress(), ev.args.agentId));
      await send(k.AgentSale.connect(o).list(ev.args.agentId, u6(a.forSale)));
    }
  }

  // Some history: completed jobs from paying clients, plus sybil reviews that the ranking ignores.
  const jobsAddr = await k.NeroJobs.getAddress();
  const history = [
    ["solidity-auditor", w.carol, 250, 96], ["pr-reviewer", w.carol, 30, 91], ["deep-research", w.carol, 40, 88],
    ["lit-review", w.alice, 60, 93], ["copy-editor", w.carol, 20, 84], ["gas-optimizer", w.carol, 80, 90],
  ];
  for (const [slug, client, budget, score] of history) {
    const agent = ids.find((x) => x.slug === slug);
    const provider = owners[agents.find((x) => x.slug === slug).owner];
    const exp = (await c.provider.getBlock("latest")).timestamp + 3 * DAY;
    const r = await (await k.NeroJobs.connect(client).createJob(agent.agentId, w.contractEvaluator.address, exp, `Seed job for ${slug}`, u6(budget))).wait();
    const jobId = k.NeroJobs.interface.parseLog(r.logs.find((l) => l.address.toLowerCase() === jobsAddr.toLowerCase())).args.jobId;
    await send(k.NRX.connect(client).approve(jobsAddr, u6(budget)));
    await send(k.NeroJobs.connect(client).fund(jobId, u6(budget)));
    await send(k.NeroJobs.connect(provider).submit(jobId, ethers.id(`deliverable:${slug}:${jobId}`)));
    await send(k.NeroJobs.connect(w.contractEvaluator).complete(jobId, ethers.encodeBytes32String("checks passed")));
    await send(k.ReputationRegistry.connect(client).giveFeedback(agent.agentId, score, ethers.encodeBytes32String("job"), ethers.ZeroHash, "", ethers.ZeroHash));
  }
  // Unpaid wallets inflating a rival — hidden by paid-reviewer-only ranking.
  const sybilTarget = ids.find((x) => x.slug === "market-scan");
  for (const s of [w.botLp, w.mallory, w.keeper]) {
    await send(k.ReputationRegistry.connect(s).giveFeedback(sybilTarget.agentId, 100, ethers.encodeBytes32String("call"), ethers.ZeroHash, "", ethers.ZeroHash));
  }
  c.agentIds = ids;
}

async function handover(c) {
  // Money contracts move behind the 48h timelock; the guardian keeps pause.
  const tl = await c.contracts.Timelock.getAddress();
  const ADMIN = ethers.ZeroHash;
  // Capped beta: 250k NRX per day in and out of the PSM, 2M NRX outstanding.
  await send(c.contracts.NeroPSM.setCaps(u6(250_000), u6(250_000), u6(2_000_000)));
  for (const name of ["NRX", "NeroPSM", "sNRX", "TokenPool"]) {
    const ct = c.contracts[name];
    await send(ct.grantRole(ADMIN, tl));
  }
  // MINTER_ADMIN on NRX also moves to the timelock.
  await send(c.contracts.NRX.grantRole(await c.contracts.NRX.MINTER_ADMIN_ROLE(), tl));
  for (const name of ["NeroPSM", "NRX", "sNRX", "TokenPool"]) {
    const ct = c.contracts[name];
    if (name === "NRX") await send(ct.renounceRole(await ct.MINTER_ADMIN_ROLE(), c.w.deployer.address));
    await send(ct.renounceRole(ADMIN, c.w.deployer.address));
  }
}

async function serialise(c) {
  const contracts = {};
  for (const [k, v] of Object.entries(c.contracts)) contracts[k] = await v.getAddress();
  return {
    key: c.key,
    name: c.key === "base" ? "Base (local)" : "Ethereum (local)",
    chainId: c.chainId,
    rpc: c.rpc,
    ccipSelector: SELECTORS[c.key].toString(),
    contracts,
    markets: Object.fromEntries(Object.entries(c.markets).map(([k, m]) => [k, { ...m, lltv: m.lltv.toString() }])),
  };
}

async function main() {
  const agents = JSON.parse(readFileSync(join(root, "seed/agents.json"), "utf8"));
  const base = await deployChain("base", BASE_RPC);
  const eth = await deployChain("ethereum", ETH_RPC);
  await link(base, eth);
  await seedChain(base, agents);
  await seedChain(eth, agents);
  await handover(base);
  await handover(eth);
  // The seed ran "yesterday": roll both chains a day so today's PSM caps start fresh.
  for (const c of [base, eth]) {
    await c.provider.send("evm_increaseTime", [DAY]);
    await c.provider.send("evm_mine", []);
  }

  const accounts = {};
  for (const [name, i] of Object.entries(ROLES)) {
    const wl = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
    accounts[name] = { index: i, address: wl.address };
  }
  const out = {
    generatedAt: new Date().toISOString(),
    chains: { base: await serialise(base), ethereum: await serialise(eth) },
    accounts,
    agents: agents.map((a) => ({ ...a, ...base.agentIds.find((x) => x.slug === a.slug) })),
  };
  const file = join(root, "deployments/local.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
