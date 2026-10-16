const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployCore, deployMarket, u6, DAY } = require("./fixture");

const b32 = (s) => ethers.encodeBytes32String(s);

async function marketFixture() {
  const core = await deployCore();
  const m = await deployMarket(core);
  const { owner, evalA, evalB, carol, admin } = core;
  await m.bondUp(owner, u6(1_000));
  await m.bondUp(evalA, u6(600));
  await m.bondUp(evalB, u6(600));
  await m.jobs.connect(evalA).joinEvaluatorPool();
  await m.jobs.connect(evalB).joinEvaluatorPool();
  await m.jobs.setContractEvaluator(admin.address, true);
  await m.identity.connect(owner)["register(string)"]("https://agents.example/solidity-auditor/registration.json");
  await core.mintNRX(carol, u6(5_000));
  return { ...core, ...m, agentId: 1n };
}

async function createJob(f, { evaluator, budget = u6(250), client = f.carol } = {}) {
  const exp = (await time.latest()) + 2 * DAY;
  const tx = await f.jobs.connect(client).createJob(f.agentId, evaluator ?? client.address, exp, "Audit this contract", budget);
  const ev = (await tx.wait()).logs.map((l) => { try { return f.jobs.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "JobCreated");
  return ev.args.jobId;
}

describe("ERC-8004 registries", () => {
  it("registers an agent as an ERC-721 with the owner as payout wallet", async () => {
    const { identity, owner, agentId } = await loadFixture(marketFixture);
    expect(await identity.ownerOf(agentId)).to.equal(owner.address);
    expect(await identity.getAgentWallet(agentId)).to.equal(owner.address);
    expect(await identity.tokenURI(agentId)).to.contain("registration.json");
  });

  it("changing the agent wallet needs the new wallet's signature", async () => {
    const { identity, owner, bob, carol, agentId } = await loadFixture(marketFixture);
    const net = await ethers.provider.getNetwork();
    const deadline = (await time.latest()) + 600;
    const domain = { name: "ERC8004IdentityRegistry", version: "1", chainId: net.chainId, verifyingContract: identity.target };
    const types = { SetAgentWallet: [{ name: "agentId", type: "uint256" }, { name: "newWallet", type: "address" }, { name: "deadline", type: "uint256" }] };
    const badSig = await carol.signTypedData(domain, types, { agentId, newWallet: bob.address, deadline });
    await expect(identity.connect(owner).setAgentWallet(agentId, bob.address, deadline, badSig))
      .to.be.revertedWithCustomError(identity, "InvalidWalletSignature");
    const sig = await bob.signTypedData(domain, types, { agentId, newWallet: bob.address, deadline });
    await identity.connect(owner).setAgentWallet(agentId, bob.address, deadline, sig);
    expect(await identity.getAgentWallet(agentId)).to.equal(bob.address);
  });

  it("reputation summary counts only the reviewers passed in", async () => {
    const { reputation, carol, bob, alice, owner, agentId } = await loadFixture(marketFixture);
    await reputation.connect(carol).giveFeedback(agentId, 90, b32("job"), ethers.ZeroHash, "", ethers.ZeroHash);
    await reputation.connect(bob).giveFeedback(agentId, 100, b32("call"), ethers.ZeroHash, "", ethers.ZeroHash);
    await reputation.connect(alice).giveFeedback(agentId, 100, b32("call"), ethers.ZeroHash, "", ethers.ZeroHash);
    const [count, avg] = await reputation.getSummary(agentId, [carol.address]);
    expect(count).to.equal(1);
    expect(avg).to.equal(90);
    await expect(reputation.connect(owner).giveFeedback(agentId, 100, b32("x"), ethers.ZeroHash, "", ethers.ZeroHash))
      .to.be.revertedWithCustomError(reputation, "SelfFeedback");
  });
});

describe("NeroJobs (ERC-8183)", () => {
  it("runs Open → Funded → Submitted → Completed, paying 97% to the provider and 3% to treasury", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, carol, owner, treasury, bonds, admin } = f;
    const jobId = await createJob(f, { evaluator: admin.address });
    await nrx.connect(carol).approve(jobs.target, u6(250));
    await jobs.connect(carol).fund(jobId, u6(250));
    expect(await bonds.lockedAssets(owner.address)).to.equal(u6(25));
    await jobs.connect(owner).submit(jobId, ethers.id("report"));
    const before = await nrx.balanceOf(owner.address);
    await jobs.connect(admin).complete(jobId, b32("tests pass"));
    expect((await nrx.balanceOf(owner.address)) - before).to.equal(u6(242.5));
    expect(await nrx.balanceOf(treasury.address)).to.equal(u6(7.5));
    expect(await bonds.lockedAssets(owner.address)).to.equal(0);
    expect(await jobs.isPaidClient(f.agentId, carol.address)).to.equal(true);
    expect((await jobs.getJob(jobId)).status).to.equal(3);
  });

  it("waives the platform fee for sellers in the launch programme", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, carol, owner, treasury, admin } = f;
    await jobs.setFeeWaiver(owner.address, (await time.latest()) + 90 * DAY);
    const jobId = await createJob(f, { evaluator: admin.address });
    await nrx.connect(carol).approve(jobs.target, u6(250));
    await jobs.connect(carol).fund(jobId, u6(250));
    await jobs.connect(owner).submit(jobId, ethers.id("report"));
    await jobs.connect(admin).complete(jobId, b32("ok"));
    expect(await nrx.balanceOf(treasury.address)).to.equal(0);
  });

  it("blocks a provider (or its owner) from evaluating its own job", async () => {
    const f = await loadFixture(marketFixture);
    const exp = (await time.latest()) + 2 * DAY;
    await expect(f.jobs.connect(f.carol).createJob(f.agentId, f.owner.address, exp, "x", u6(10)))
      .to.be.revertedWithCustomError(f.jobs, "SharedOwner");
    await expect(f.jobs.connect(f.owner).createJob(f.agentId, f.owner.address, exp, "x", u6(10)))
      .to.be.revertedWithCustomError(f.jobs, "SharedOwner");
  });

  it("requires a random pool evaluator above the threshold and caps budgets", async () => {
    const f = await loadFixture(marketFixture);
    const exp = (await time.latest()) + 2 * DAY;
    await expect(f.jobs.connect(f.carol).createJob(f.agentId, f.carol.address, exp, "big", u6(600)))
      .to.be.revertedWithCustomError(f.jobs, "PoolEvaluatorRequired");
    await expect(f.jobs.connect(f.carol).createJob(f.agentId, ethers.ZeroAddress, exp, "huge", u6(1_001)))
      .to.be.revertedWithCustomError(f.jobs, "BudgetAboveCap");
    const jobId = await createJob(f, { evaluator: ethers.ZeroAddress, budget: u6(600) });
    const job = await f.jobs.getJob(jobId);
    expect([f.evalA.address, f.evalB.address]).to.include(job.evaluator);
    expect(job.kind).to.equal(2);
  });

  it("pool evaluator gets its fee; a pool rejection refunds and slashes the seller bond", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, snrx, carol, owner, bonds } = f;
    const jobId = await createJob(f, { evaluator: ethers.ZeroAddress, budget: u6(600) });
    const job = await jobs.getJob(jobId);
    const evaluator = [f.evalA, f.evalB].find((e) => e.address === job.evaluator);
    // 1.5% evaluator fee on top of the budget.
    await nrx.connect(carol).approve(jobs.target, u6(609));
    await jobs.connect(carol).fund(jobId, u6(600));
    await jobs.connect(owner).submit(jobId, ethers.id("weak report"));
    const bondBefore = await bonds.bondValue(owner.address);
    const nrxBefore = await nrx.balanceOf(carol.address);
    await jobs.connect(evaluator).reject(jobId, b32("missed scope"));
    expect((await nrx.balanceOf(carol.address)) - nrxBefore).to.equal(u6(600));
    expect(await nrx.balanceOf(evaluator.address)).to.equal(u6(9));
    // 10% penalty moved from the bond to the buyer as sNRX.
    expect(bondBefore - (await bonds.bondValue(owner.address))).to.be.closeTo(u6(60), 2);
    expect(await snrx.convertToAssets(await snrx.balanceOf(carol.address))).to.be.closeTo(u6(60), 2);
  });

  it("a buyer-evaluator rejection refunds without slashing", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, carol, owner, bonds } = f;
    const jobId = await createJob(f);
    await nrx.connect(carol).approve(jobs.target, u6(250));
    await jobs.connect(carol).fund(jobId, u6(250));
    const bondBefore = await bonds.bondValue(owner.address);
    await jobs.connect(carol).reject(jobId, b32("changed mind"));
    expect(await bonds.bondValue(owner.address)).to.equal(bondBefore);
  });

  it("anyone can refund after expiry; non-delivery slashes the bond", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, carol, bob, admin, bonds, owner } = f;
    const jobId = await createJob(f, { evaluator: admin.address });
    await nrx.connect(carol).approve(jobs.target, u6(250));
    await jobs.connect(carol).fund(jobId, u6(250));
    await expect(jobs.connect(bob).claimRefund(jobId)).to.be.revertedWithCustomError(jobs, "NotExpired");
    await time.increase(3 * DAY);
    const before = await nrx.balanceOf(carol.address);
    const bondBefore = await bonds.bondValue(owner.address);
    await jobs.connect(bob).claimRefund(jobId);
    expect((await nrx.balanceOf(carol.address)) - before).to.equal(u6(250));
    expect(bondBefore - (await bonds.bondValue(owner.address))).to.be.closeTo(u6(25), 2);
    expect((await jobs.getJob(jobId)).status).to.equal(5);
  });

  it("funding needs enough free seller bond and the expected budget", async () => {
    const f = await loadFixture(marketFixture);
    const { jobs, nrx, carol, owner, admin } = f;
    const jobId = await createJob(f, { evaluator: admin.address, budget: u6(100) });
    await jobs.connect(owner).setBudget(jobId, u6(120));
    await nrx.connect(carol).approve(jobs.target, u6(120));
    await expect(jobs.connect(carol).fund(jobId, u6(100))).to.be.revertedWithCustomError(jobs, "BudgetMismatch");
    await jobs.connect(carol).fund(jobId, u6(120));
  });
});

describe("SellerBond", () => {
  it("bond withdrawals wait out the timelock and cannot touch locked value", async () => {
    const f = await loadFixture(marketFixture);
    const { bonds, snrx, owner, jobs, nrx, carol, admin } = f;
    const shares = await bonds.shares(owner.address);
    const jobId = await createJob(f, { evaluator: admin.address, budget: u6(500) });
    await nrx.connect(carol).approve(jobs.target, u6(500));
    await jobs.connect(carol).fund(jobId, u6(500));
    await expect(bonds.connect(owner).requestWithdraw(shares)).to.be.revertedWithCustomError(bonds, "BondTooLow");
    const half = shares / 2n;
    await bonds.connect(owner).requestWithdraw(half);
    await expect(bonds.connect(owner).withdraw()).to.be.revertedWithCustomError(bonds, "StillLocked");
    await time.increase(7 * DAY + 1);
    await bonds.connect(owner).withdraw();
    expect(await snrx.balanceOf(owner.address)).to.equal(half);
  });
});

describe("AgentSale", () => {
  it("swaps NRX for the agent atomically, 2.5% to treasury, payout wallet moves too", async () => {
    const f = await loadFixture(marketFixture);
    const { sale, identity, nrx, owner, carol, treasury, agentId } = f;
    await identity.connect(owner).approve(sale.target, agentId);
    await sale.connect(owner).list(agentId, u6(2_000));
    await nrx.connect(carol).approve(sale.target, u6(2_000));
    await expect(sale.connect(carol).buy(agentId, u6(1_000))).to.be.revertedWithCustomError(sale, "PriceChanged");
    const before = await nrx.balanceOf(owner.address);
    await sale.connect(carol).buy(agentId, u6(2_000));
    expect(await identity.ownerOf(agentId)).to.equal(carol.address);
    expect(await identity.getAgentWallet(agentId)).to.equal(carol.address);
    expect((await nrx.balanceOf(owner.address)) - before).to.equal(u6(1_950));
    expect(await nrx.balanceOf(treasury.address)).to.equal(u6(50));
  });

  it("refuses a sale while the agent has open jobs", async () => {
    const f = await loadFixture(marketFixture);
    const { sale, identity, nrx, owner, carol, jobs, admin, agentId } = f;
    const jobId = await createJob(f, { evaluator: admin.address, budget: u6(50) });
    await nrx.connect(carol).approve(jobs.target, u6(50));
    await jobs.connect(carol).fund(jobId, u6(50));
    await identity.connect(owner).approve(sale.target, agentId);
    await sale.connect(owner).list(agentId, u6(100));
    await nrx.connect(carol).approve(sale.target, u6(100));
    await expect(sale.connect(carol).buy(agentId, u6(100))).to.be.revertedWithCustomError(sale, "OpenJobs");
  });

  it("escrows offers that the owner can accept", async () => {
    const f = await loadFixture(marketFixture);
    const { sale, identity, nrx, owner, carol, agentId } = f;
    await nrx.connect(carol).approve(sale.target, u6(800));
    await sale.connect(carol).makeOffer(agentId, u6(800), (await time.latest()) + DAY);
    expect(await nrx.balanceOf(sale.target)).to.equal(u6(800));
    await identity.connect(owner).approve(sale.target, agentId);
    await sale.connect(owner).acceptOffer(agentId, 0);
    expect(await identity.ownerOf(agentId)).to.equal(carol.address);
    expect(await nrx.balanceOf(sale.target)).to.equal(0);
  });
});
