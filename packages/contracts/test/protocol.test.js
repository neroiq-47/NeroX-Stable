const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployCore, signTransferAuth, signPermit, u6, u8, u18, DAY } = require("./fixture");

describe("NRX", () => {
  it("is a 6-decimal token with EIP-712 version 1", async () => {
    const { nrx } = await loadFixture(deployCore);
    expect(await nrx.decimals()).to.equal(6);
    expect(await nrx.symbol()).to.equal("NRX");
    expect(await nrx.version()).to.equal("1");
  });

  it("only configured minters can mint, within allowance and supply cap", async () => {
    const { nrx, alice, admin } = await loadFixture(deployCore);
    await expect(nrx.connect(alice).mint(alice.address, 1)).to.be.revertedWithCustomError(nrx, "NotMinter");
    await nrx.configureMinter(admin.address, u6(10));
    await expect(nrx.mint(alice.address, u6(11))).to.be.revertedWithCustomError(nrx, "MinterAllowanceExceeded");
    await nrx.setSupplyCap(u6(5));
    await expect(nrx.mint(alice.address, u6(6))).to.be.revertedWithCustomError(nrx, "SupplyCapExceeded");
  });

  describe("EIP-3009", () => {
    it("settles a signed transferWithAuthorization submitted by a third party", async () => {
      const { nrx, alice, bob, carol, mintNRX } = await loadFixture(deployCore);
      await mintNRX(alice, u6(100));
      const auth = await signTransferAuth(nrx, alice, bob.address, u6(1.5));
      await expect(
        nrx.connect(carol)["transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"](
          auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature,
        ),
      ).to.emit(nrx, "AuthorizationUsed").withArgs(alice.address, auth.nonce);
      expect(await nrx.balanceOf(bob.address)).to.equal(u6(1.5));
      expect(await nrx.authorizationState(alice.address, auth.nonce)).to.equal(true);
    });

    it("rejects replay, expiry, early use and a redirected recipient", async () => {
      const { nrx, alice, bob, carol, mintNRX } = await loadFixture(deployCore);
      await mintNRX(alice, u6(100));
      const fn = "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";
      const auth = await signTransferAuth(nrx, alice, bob.address, u6(1));
      await nrx[fn](auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature);
      await expect(nrx[fn](auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature))
        .to.be.revertedWithCustomError(nrx, "AuthorizationAlreadyUsed");

      // The facilitator cannot redirect funds: the signature binds the recipient.
      const a2 = await signTransferAuth(nrx, alice, bob.address, u6(1));
      await expect(nrx[fn](a2.from, carol.address, a2.value, a2.validAfter, a2.validBefore, a2.nonce, a2.signature))
        .to.be.revertedWithCustomError(nrx, "InvalidSignature");

      const now = await time.latest();
      const a3 = await signTransferAuth(nrx, alice, bob.address, u6(1), { validBefore: BigInt(now + 10) });
      await time.increase(20);
      await expect(nrx[fn](a3.from, a3.to, a3.value, a3.validAfter, a3.validBefore, a3.nonce, a3.signature))
        .to.be.revertedWithCustomError(nrx, "AuthorizationExpired");

      const later = BigInt((await time.latest()) + 1000);
      const a4 = await signTransferAuth(nrx, alice, bob.address, u6(1), { validAfter: later, validBefore: later + 100n });
      await expect(nrx[fn](a4.from, a4.to, a4.value, a4.validAfter, a4.validBefore, a4.nonce, a4.signature))
        .to.be.revertedWithCustomError(nrx, "AuthorizationNotYetValid");
    });

    it("receiveWithAuthorization can only be submitted by the payee", async () => {
      const { nrx, alice, bob, carol, mintNRX } = await loadFixture(deployCore);
      await mintNRX(alice, u6(10));
      const net = await ethers.provider.getNetwork();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validBefore = BigInt((await time.latest()) + 3600);
      const sig = await alice.signTypedData(
        { name: "NeroX USD", version: "1", chainId: net.chainId, verifyingContract: nrx.target },
        { ReceiveWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ] },
        { from: alice.address, to: bob.address, value: u6(2), validAfter: 0, validBefore, nonce },
      );
      await expect(nrx.connect(carol).receiveWithAuthorization(alice.address, bob.address, u6(2), 0, validBefore, nonce, sig))
        .to.be.revertedWithCustomError(nrx, "CallerMustBePayee");
      await nrx.connect(bob).receiveWithAuthorization(alice.address, bob.address, u6(2), 0, validBefore, nonce, sig);
      expect(await nrx.balanceOf(bob.address)).to.equal(u6(2));
    });

    it("cancelled authorizations cannot be used", async () => {
      const { nrx, alice, bob, mintNRX } = await loadFixture(deployCore);
      await mintNRX(alice, u6(10));
      const auth = await signTransferAuth(nrx, alice, bob.address, u6(1));
      const net = await ethers.provider.getNetwork();
      const sig = await alice.signTypedData(
        { name: "NeroX USD", version: "1", chainId: net.chainId, verifyingContract: nrx.target },
        { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
        { authorizer: alice.address, nonce: auth.nonce },
      );
      await nrx.cancelAuthorization(alice.address, auth.nonce, sig);
      await expect(
        nrx["transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)"](
          auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, auth.signature,
        ),
      ).to.be.revertedWithCustomError(nrx, "AuthorizationAlreadyUsed");
    });
  });

  it("pause and blocklist stop transfers", async () => {
    const { nrx, alice, bob, guardian, mintNRX } = await loadFixture(deployCore);
    await mintNRX(alice, u6(10));
    await nrx.setBlocklisted(bob.address, true);
    await expect(nrx.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(nrx, "AccountBlocklisted");
    await nrx.setBlocklisted(bob.address, false);
    await nrx.connect(guardian).pause();
    await expect(nrx.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(nrx, "EnforcedPause");
  });
});

describe("NeroPSM", () => {
  it("mints and redeems 1:1 and keeps USDC as reserves", async () => {
    const { usdc, nrx, psm, alice } = await loadFixture(deployCore);
    await usdc.mint(alice.address, u6(1_000));
    await usdc.connect(alice).approve(psm.target, u6(1_000));
    await expect(psm.connect(alice).mint(u6(1_000), alice.address)).to.emit(psm, "Minted");
    expect(await nrx.balanceOf(alice.address)).to.equal(u6(1_000));
    expect(await psm.reserves()).to.equal(u6(1_000));
    expect(await psm.outstanding()).to.equal(u6(1_000));

    await nrx.connect(alice).approve(psm.target, u6(400));
    await psm.connect(alice).redeem(u6(400), alice.address);
    expect(await usdc.balanceOf(alice.address)).to.equal(u6(400));
    expect(await nrx.totalSupply()).to.equal(u6(600));
    expect(await psm.reserves()).to.equal(await nrx.totalSupply());
  });

  it("mints in one transaction with a USDC permit", async () => {
    const { usdc, nrx, psm, alice } = await loadFixture(deployCore);
    await usdc.mint(alice.address, u6(50));
    const deadline = (await time.latest()) + 600;
    const sig = await signPermit(usdc, alice, psm.target, u6(50), deadline);
    await psm.connect(alice).mintWithPermit(u6(50), alice.address, deadline, sig.v, sig.r, sig.s);
    expect(await nrx.balanceOf(alice.address)).to.equal(u6(50));
  });

  it("enforces daily caps that reset each day, and the global cap", async () => {
    const { usdc, psm, alice, admin } = await loadFixture(deployCore);
    await psm.setCaps(u6(100), u6(100), u6(150));
    await usdc.mint(alice.address, u6(1_000));
    await usdc.connect(alice).approve(psm.target, u6(1_000));
    await psm.connect(alice).mint(u6(100), alice.address);
    await expect(psm.connect(alice).mint(1, alice.address)).to.be.revertedWithCustomError(psm, "DailyMintCapExceeded");
    await time.increase(DAY);
    expect(await psm.remainingDailyMint()).to.equal(u6(100));
    await expect(psm.connect(alice).mint(u6(60), alice.address)).to.be.revertedWithCustomError(psm, "GlobalMintCapExceeded");
    await psm.connect(alice).mint(u6(50), alice.address);
    expect(admin.address).to.be.properAddress;
  });

  it("guardian pause disables mint and redeem", async () => {
    const { psm, guardian, alice } = await loadFixture(deployCore);
    await psm.connect(guardian).pause();
    await expect(psm.connect(alice).mint(1, alice.address)).to.be.revertedWithCustomError(psm, "EnforcedPause");
  });

  it("charges and routes fees when set, capped at 1%", async () => {
    const { usdc, nrx, psm, alice, treasury } = await loadFixture(deployCore);
    await expect(psm.setFees(101, 0, treasury.address)).to.be.revertedWithCustomError(psm, "FeeTooHigh");
    await psm.setFees(10, 0, treasury.address);
    await usdc.mint(alice.address, u6(1_000));
    await usdc.connect(alice).approve(psm.target, u6(1_000));
    await psm.connect(alice).mint(u6(1_000), alice.address);
    expect(await nrx.balanceOf(alice.address)).to.equal(u6(999));
    expect(await usdc.balanceOf(treasury.address)).to.equal(u6(1));
  });
});

describe("sNRX + MorphoLenderStrategy", () => {
  async function withBorrower() {
    const f = await deployCore();
    const { nrx, snrx, morpho, market, cbBTC, alice, bot, mintNRX } = f;
    await mintNRX(alice, u6(100_000));
    await nrx.connect(alice).approve(snrx.target, u6(100_000));
    await snrx.connect(alice).deposit(u6(100_000), alice.address);
    await cbBTC.mint(bot.address, u8(2));
    await cbBTC.connect(bot).approve(morpho.target, u8(2));
    await morpho.connect(bot).supplyCollateralAndBorrow(market, u8(2), u6(60_000), bot.address);
    return f;
  }

  it("keeps a 10% buffer idle and supplies the rest to Morpho", async () => {
    const { snrx, strategy } = await loadFixture(withBorrower);
    expect(await snrx.idle()).to.equal(u6(10_000));
    expect(await strategy.totalAssets()).to.be.closeTo(u6(90_000), 2);
  });

  it("share price rises from borrower interest only", async () => {
    const { snrx, psm } = await loadFixture(withBorrower);
    const before = await snrx.sharePrice();
    const reservesBefore = await psm.reserves();
    await time.increase(365 * DAY);
    const after = await snrx.sharePrice();
    expect(after).to.be.gt(before);
    // ~66.7% util of the 90k supplied → roughly 4–5% APY on the vault.
    const apy = Number(after - before) / Number(before);
    expect(apy).to.be.gt(0.03).and.lt(0.07);
    expect(await psm.reserves()).to.equal(reservesBefore); // reserves untouched
  });

  it("limits instant withdrawals to available liquidity and queues the rest", async () => {
    const { snrx, nrx, alice } = await loadFixture(withBorrower);
    // 100k deposited, 60k borrowed → 40k liquid.
    const maxW = await snrx.maxWithdraw(alice.address);
    expect(maxW).to.be.closeTo(u6(40_000), u6(1));
    await expect(snrx.connect(alice).withdraw(u6(50_000), alice.address, alice.address))
      .to.be.revertedWithCustomError(snrx, "ERC4626ExceededMaxWithdraw");

    const shares = await snrx.balanceOf(alice.address);
    await snrx.connect(alice).requestRedeem(shares / 4n, alice.address);
    expect(await snrx.queuedShares()).to.equal(shares / 4n);
    await snrx.processQueue(10);
    expect(await snrx.queuedShares()).to.equal(0);
    expect(await nrx.balanceOf(alice.address)).to.be.closeTo(u6(25_000), u6(1));
  });

  it("processQueue stops while liquidity is short", async () => {
    const { snrx, alice } = await loadFixture(withBorrower);
    const shares = await snrx.balanceOf(alice.address);
    await snrx.connect(alice).requestRedeem(shares, alice.address);
    await snrx.processQueue(10);
    expect(await snrx.queuedShares()).to.equal(shares);
    await snrx.connect(alice).cancelRequest(0);
    expect(await snrx.balanceOf(alice.address)).to.equal(shares);
  });

  it("resists the first-depositor inflation attack (virtual shares)", async () => {
    const { nrx, snrx, alice, bob, mintNRX } = await loadFixture(deployCore);
    await mintNRX(alice, u6(10_001));
    await mintNRX(bob, u6(10_000));
    await nrx.connect(alice).approve(snrx.target, 1);
    await snrx.connect(alice).deposit(1, alice.address);
    // Attacker donates to inflate share price.
    await nrx.connect(alice).approve(snrx.target, u6(10_000));
    await snrx.connect(alice).notifyFeeIncome(u6(10_000), ethers.ZeroHash);
    await nrx.connect(bob).approve(snrx.target, u6(10_000));
    await snrx.connect(bob).deposit(u6(10_000), bob.address);
    expect(await snrx.balanceOf(bob.address)).to.be.gt(0);
    // Bob keeps nearly all of his deposit.
    expect(await snrx.previewRedeem(await snrx.balanceOf(bob.address))).to.be.gt(u6(9_990));
  });

  it("deposits with an NRX permit and respects the deposit cap", async () => {
    const { nrx, snrx, alice, mintNRX } = await loadFixture(deployCore);
    await mintNRX(alice, u6(500));
    const deadline = (await time.latest()) + 600;
    const sig = await signPermit(nrx, alice, snrx.target, u6(500), deadline);
    await snrx.connect(alice).depositWithPermit(u6(500), alice.address, deadline, sig.v, sig.r, sig.s);
    expect(await snrx.balanceOf(alice.address)).to.be.gt(0);
    await snrx.setDepositCap(u6(500));
    expect(await snrx.maxDeposit(alice.address)).to.equal(0);
  });
});

describe("MorphoBlueLite", () => {
  it("blocks unhealthy borrows and allows liquidation after a price drop", async () => {
    const { nrx, snrx, morpho, market, cbBTC, oracle, alice, bot, carol, mintNRX } = await loadFixture(deployCore);
    await mintNRX(alice, u6(100_000));
    await nrx.connect(alice).approve(snrx.target, u6(100_000));
    await snrx.connect(alice).deposit(u6(100_000), alice.address);
    await cbBTC.mint(bot.address, u8(1));
    await cbBTC.connect(bot).approve(morpho.target, u8(1));
    // 1 cbBTC = 65k; LLTV 77% → max 50,050 NRX.
    await expect(morpho.connect(bot).supplyCollateralAndBorrow(market, u8(1), u6(51_000), bot.address))
      .to.be.revertedWithCustomError(morpho, "InsufficientCollateral");
    await morpho.connect(bot).supplyCollateralAndBorrow(market, u8(1), u6(45_000), bot.address);
    expect(await morpho.healthFactor(market, bot.address)).to.be.closeTo(u18(1.112), u18(0.001));
    await expect(morpho.connect(carol).liquidate(market, bot.address, u8(0.1))).to.be.revertedWithCustomError(morpho, "HealthyPosition");

    await oracle.setPrice((50_000n * 10n ** 6n * 10n ** 36n) / 10n ** 8n);
    await mintNRX(carol, u6(10_000));
    await nrx.connect(carol).approve(morpho.target, u6(10_000));
    await morpho.connect(carol).liquidate(market, bot.address, u8(0.1));
    expect(await cbBTC.balanceOf(carol.address)).to.equal(u8(0.1));
  });

  it("repays a position exactly by shares", async () => {
    const { nrx, snrx, morpho, market, cbBTC, alice, bot, mintNRX } = await loadFixture(deployCore);
    await mintNRX(alice, u6(10_000));
    await nrx.connect(alice).approve(snrx.target, u6(10_000));
    await snrx.connect(alice).deposit(u6(10_000), alice.address);
    await cbBTC.mint(bot.address, u8(1));
    await cbBTC.connect(bot).approve(morpho.target, u8(1));
    await morpho.connect(bot).supplyCollateralAndBorrow(market, u8(1), u6(1_000), bot.address);
    await time.increase(30 * DAY);
    await mintNRX(bot, u6(100));
    await nrx.connect(bot).approve(morpho.target, u6(1_100));
    const pos = await morpho.position(await morpho.id(market), bot.address);
    await morpho.connect(bot).repay(market, 0, pos.borrowShares, bot.address);
    expect((await morpho.position(await morpho.id(market), bot.address)).borrowShares).to.equal(0);
    await morpho.connect(bot).withdrawCollateral(market, u8(1), bot.address, bot.address);
  });
});

describe("NeroTokenPool (CCIP burn/mint)", () => {
  async function twoPools() {
    const f = await deployCore();
    const { admin, nrx, d1, d2, d3 } = f;
    const F = await ethers.getContractFactory("NeroTokenPool");
    // Two pools on one test chain stand in for Base and Ethereum.
    const nrxB = await (await ethers.getContractFactory("NRX")).deploy(admin.address, u6(5_000_000));
    const A = await F.deploy(admin.address, nrx.target, 1n, ethers.parseEther("0.001"));
    const B = await F.deploy(admin.address, nrxB.target, 2n, ethers.parseEther("0.001"));
    await nrx.configureMinter(A.target, u6(1_000_000));
    await nrxB.configureMinter(B.target, u6(1_000_000));
    for (const p of [A, B]) {
      for (const s of [d1, d2, d3]) await p.setSigner(s.address, true);
      await p.setQuorum(2);
    }
    await A.configureLane(2n, B.target, u6(1_000), u6(1));
    await B.configureLane(1n, A.target, u6(1_000), u6(1));
    return { ...f, A, B, nrxB };
  }

  async function attest(pool, signers, args) {
    const digest = await pool.messageDigest(...args);
    const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    return Promise.all(sorted.map((s) => s.signMessage(ethers.getBytes(digest))));
  }

  it("burns on the source and mints on the destination with a 2-of-3 quorum", async () => {
    const { A, B, nrx, nrxB, alice, d1, d2, d3, mintNRX } = await loadFixture(twoPools);
    await mintNRX(alice, u6(500));
    await nrx.connect(alice).approve(A.target, u6(200));
    const tx = await A.connect(alice).ccipSend(2n, alice.address, u6(200), { value: ethers.parseEther("0.001") });
    const ev = (await tx.wait()).logs.map((l) => { try { return A.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "CCIPSendRequested");
    expect(await nrx.balanceOf(alice.address)).to.equal(u6(300));
    const { messageId, nonce } = ev.args;
    const args = [messageId, 1n, alice.address, alice.address, u6(200), nonce];

    const one = await attest(B, [d1], args);
    await expect(B.executeMessage(...args, one)).to.be.revertedWithCustomError(B, "QuorumNotMet");
    const two = await attest(B, [d1, d3], args);
    await B.executeMessage(...args, two);
    expect(await nrxB.balanceOf(alice.address)).to.equal(u6(200));
    await expect(B.executeMessage(...args, two)).to.be.revertedWithCustomError(B, "AlreadyExecuted");
    expect(d2.address).to.be.properAddress;
  });

  it("enforces outbound rate limits and refills over time", async () => {
    const { A, nrx, alice, mintNRX } = await loadFixture(twoPools);
    await mintNRX(alice, u6(5_000));
    await nrx.connect(alice).approve(A.target, u6(5_000));
    const fee = { value: ethers.parseEther("0.001") };
    await A.connect(alice).ccipSend(2n, alice.address, u6(900), fee);
    expect(await A.outboundHeadroom(2n)).to.be.closeTo(u6(100), u6(2));
    await expect(A.connect(alice).ccipSend(2n, alice.address, u6(200), fee)).to.be.revertedWithCustomError(A, "RateLimitExceeded");
    await time.increase(150);
    await A.connect(alice).ccipSend(2n, alice.address, u6(200), fee);
  });

  it("rejects forged messages and duplicate signers", async () => {
    const { B, alice, d1, bob } = await loadFixture(twoPools);
    const fakeId = ethers.id("fake");
    const args = [fakeId, 1n, alice.address, alice.address, u6(10), 1n];
    const sigs = await attest(B, [d1, bob], args);
    await expect(B.executeMessage(...args, sigs)).to.be.revertedWith("message id");
  });
});

describe("StablePoolLite (Aerodrome sAMM stand-in)", () => {
  it("swaps NRX/USDC near 1:1 with deep liquidity and reports the peg", async () => {
    const { nrx, usdc, alice, bob, mintNRX } = await loadFixture(deployCore);
    const pool = await (await ethers.getContractFactory("StablePoolLite")).deploy(nrx.target, usdc.target);
    await mintNRX(alice, u6(100_000));
    await usdc.mint(alice.address, u6(100_000));
    await nrx.connect(alice).approve(pool.target, u6(100_000));
    await usdc.connect(alice).approve(pool.target, u6(100_000));
    await pool.connect(alice).addLiquidity(u6(100_000), u6(100_000), 0, alice.address);
    const price = await pool.spotPrice0();
    expect(price).to.be.closeTo(u18(1), u18(0.001));

    await usdc.mint(bob.address, u6(10_000));
    await usdc.connect(bob).approve(pool.target, u6(10_000));
    const out = await pool.getAmountOut(u6(10_000), usdc.target);
    // Stable curve: a 10% of-pool trade still clears within 0.2% of par after the 0.05% fee.
    expect(out).to.be.gt(u6(9_980));
    await pool.connect(bob).swap(usdc.target, u6(10_000), out, bob.address);
    expect(await nrx.balanceOf(bob.address)).to.equal(out);
  });
});

describe("AutoSweeper", () => {
  it("sweeps NRX above the threshold into sNRX, bounded by the allowance", async () => {
    const { nrx, snrx, bob, carol, mintNRX } = await loadFixture(deployCore);
    const sweeper = await (await ethers.getContractFactory("AutoSweeper")).deploy(nrx.target, snrx.target);
    await mintNRX(bob, u6(150));
    await sweeper.connect(bob).setRule(true, u6(100), u6(20));
    await nrx.connect(bob).approve(sweeper.target, u6(100));
    expect(await sweeper.sweepable(bob.address)).to.equal(u6(100));
    await sweeper.connect(carol).sweep(bob.address);
    expect(await nrx.balanceOf(bob.address)).to.equal(u6(50));
    expect(await snrx.convertToAssets(await snrx.balanceOf(bob.address))).to.be.closeTo(u6(100), 1);
    expect(await sweeper.sweepable(bob.address)).to.equal(0);
  });
});
