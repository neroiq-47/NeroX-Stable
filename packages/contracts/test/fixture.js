const { ethers } = require("hardhat");

const u6 = (x) => ethers.parseUnits(String(x), 6);
const u8 = (x) => ethers.parseUnits(String(x), 8);
const u18 = (x) => ethers.parseUnits(String(x), 18);
const DAY = 86400;

async function deployCore() {
  const [admin, guardian, alice, bob, carol, d1, d2, d3, evalA, evalB, owner, treasury, bot] = await ethers.getSigners();
  const F = (n) => ethers.getContractFactory(n);

  const usdc = await (await F("MockERC20")).deploy("USD Coin", "USDC", 6, u6(10_000));
  const nrx = await (await F("NRX")).deploy(admin.address, u6(5_000_000));
  const psm = await (await F("NeroPSM")).deploy(
    admin.address, guardian.address, usdc.target, nrx.target, u6(250_000), u6(250_000), u6(2_000_000),
  );
  await nrx.configureMinter(psm.target, u6(2_000_000));
  await nrx.grantRole(await nrx.PAUSER_ROLE(), guardian.address);
  await nrx.grantRole(await nrx.BLOCKLISTER_ROLE(), admin.address);

  const cbBTC = await (await F("MockERC20")).deploy("cbBTC", "cbBTC", 8, u8(1));
  const morpho = await (await F("MorphoBlueLite")).deploy();
  const irm = await (await F("KinkIrm")).deploy();
  const oracle = await (await F("MockOracle")).deploy((65_000n * 10n ** 6n * 10n ** 36n) / 10n ** 8n);
  const market = { loanToken: nrx.target, collateralToken: cbBTC.target, oracle: oracle.target, irm: irm.target, lltv: u18(0.77) };
  await morpho.createMarket(market);

  const snrx = await (await F("SNRX")).deploy(admin.address, guardian.address, nrx.target, u6(1_000_000));
  const strategy = await (await F("MorphoLenderStrategy")).deploy(admin.address, nrx.target, morpho.target);
  await strategy.setVault(snrx.target);
  await strategy.setMarkets([market], [10_000]);
  await snrx.setStrategy(strategy.target);

  const mintNRX = async (who, amount) => {
    await usdc.mint(who.address, amount);
    await usdc.connect(who).approve(psm.target, amount);
    await psm.connect(who).mint(amount, who.address);
  };

  return { admin, guardian, alice, bob, carol, d1, d2, d3, evalA, evalB, owner, treasury, bot, usdc, nrx, psm, cbBTC, morpho, irm, oracle, market, snrx, strategy, mintNRX };
}

async function deployMarket(core) {
  const F = (n) => ethers.getContractFactory(n);
  const { admin, nrx, snrx, treasury } = core;
  const identity = await (await F("IdentityRegistry")).deploy();
  const reputation = await (await F("ReputationRegistry")).deploy(identity.target);
  const bonds = await (await F("SellerBond")).deploy(admin.address, snrx.target);
  const jobs = await (await F("NeroJobs")).deploy(admin.address, nrx.target, identity.target, bonds.target, treasury.address);
  await bonds.grantRole(await bonds.JOBS_ROLE(), jobs.target);
  const sale = await (await F("AgentSale")).deploy(admin.address, nrx.target, identity.target, jobs.target, treasury.address);

  const bondUp = async (who, amount) => {
    await core.mintNRX(who, amount);
    await nrx.connect(who).approve(snrx.target, amount);
    await snrx.connect(who).deposit(amount, who.address);
    const shares = await snrx.balanceOf(who.address);
    await snrx.connect(who).approve(bonds.target, shares);
    await bonds.connect(who).deposit(shares);
  };
  return { identity, reputation, bonds, jobs, sale, bondUp };
}

async function signTransferAuth(token, signer, to, value, { validAfter = 0n, validBefore, nonce } = {}) {
  const net = await ethers.provider.getNetwork();
  const latest = await ethers.provider.getBlock("latest");
  validBefore = validBefore ?? BigInt(latest.timestamp + 3600);
  nonce = nonce ?? ethers.hexlify(ethers.randomBytes(32));
  const domain = { name: await token.name(), version: "1", chainId: net.chainId, verifyingContract: token.target };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  };
  const msg = { from: signer.address, to, value, validAfter, validBefore, nonce };
  const signature = await signer.signTypedData(domain, types, msg);
  return { ...msg, signature };
}

async function signPermit(token, owner, spender, value, deadline) {
  const net = await ethers.provider.getNetwork();
  const domain = { name: await token.name(), version: "1", chainId: net.chainId, verifyingContract: token.target };
  const types = {
    Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
  };
  const nonce = await token.nonces(owner.address);
  const sig = await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce, deadline });
  return ethers.Signature.from(sig);
}

module.exports = { deployCore, deployMarket, signTransferAuth, signPermit, u6, u8, u18, DAY };
