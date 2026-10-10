const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const { deploy, mined, reverts, timestampOf, nextTimestamp, eventFrom, signedRequest } = require("./helpers");

const WAD = 10n ** 18n;
const YEAR = 365 * 24 * 60 * 60;

describe("KletiaArcSwapV2 bound execution", function () {
  let owner, alice, bob, forwarder, token, swap;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    token = await deploy("ArcFinanceTokenMock");
    swap = await deploy("KletiaArcSwapV2", forwarder.target, token.target);
    for (const user of [alice, bob]) {
      await mined(token.mint(user.address, 100n * WAD));
      await mined(token.connect(user).approve(swap.target, ethers.MaxUint256));
    }
    await mined(swap.connect(alice).addLiquidity(10n * WAD, { value: 10n * WAD }));
  });

  async function deadline() {
    return (await ethers.provider.getBlock("latest")).timestamp + 600;
  }

  it("executes both directions at the exact quoted minimum and updates real reserves", async function () {
    const minimum = await swap.previewSwapUSDCForToken(WAD);
    const receipt = await mined(swap.connect(bob).swapUSDCForToken(minimum, await deadline(), { value: WAD }));
    assert.equal(eventFrom(swap, receipt, "Swapped").amountOut, minimum);
    assert.equal(await token.balanceOf(bob.address), 100n * WAD + minimum);
    const nativeMinimum = await swap.previewSwapTokenForUSDC(WAD);
    const reverse = await mined(swap.connect(bob).swapTokenForUSDC(WAD, nativeMinimum, await deadline()));
    assert.equal(eventFrom(swap, reverse, "Swapped").amountOut, nativeMinimum);
    assert.equal(await swap.reserveUSDC(), await ethers.provider.getBalance(swap.target));
    assert.equal(await swap.reserveToken(), await token.balanceOf(swap.target));
  });

  it("rejects a quote made stale by a reserve move and rolls back native input and token allowance", async function () {
    const minimum = await swap.previewSwapUSDCForToken(WAD);
    await mined(swap.connect(alice).swapUSDCForToken(1, await deadline(), { value: 5n * WAD }));
    const reserves = [await swap.reserveUSDC(), await swap.reserveToken()];
    const balance = await token.balanceOf(bob.address);
    await reverts(async () => swap.connect(bob).swapUSDCForToken(minimum, await deadline(), { value: WAD }), /InsufficientSwapOutput/);
    assert.equal(await swap.reserveUSDC(), reserves[0]);
    assert.equal(await swap.reserveToken(), reserves[1]);
    assert.equal(await token.balanceOf(bob.address), balance);
    const reverseMinimum = await swap.previewSwapTokenForUSDC(WAD);
    await reverts(async () => swap.connect(bob).swapTokenForUSDC(WAD, reverseMinimum + 1n, await deadline()), /InsufficientSwapOutput/);
    assert.equal(await token.balanceOf(bob.address), balance);
    assert.equal(await token.allowance(bob.address, swap.target), ethers.MaxUint256);
  });

  it("rejects expired and unbounded swaps before any reserve changes", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await reverts(() => swap.connect(bob).swapUSDCForToken(1, now - 1, { value: WAD }), /SwapExpired/);
    await reverts(() => swap.connect(bob).swapTokenForUSDC(WAD, 1, now - 1), /SwapExpired/);
    await reverts(async () => swap.connect(bob).swapUSDCForToken(0, await deadline(), { value: WAD }), /InvalidMinimumOutput/);
    await reverts(async () => swap.connect(bob).swapTokenForUSDC(WAD, 0, await deadline()), /InvalidMinimumOutput/);
    assert.equal(await swap.reserveUSDC(), 10n * WAD);
    assert.equal(await swap.reserveToken(), 10n * WAD);
  });

  it("binds forwarded output bounds to the signer and refuses modified calldata", async function () {
    const minimum = await swap.previewSwapUSDCForToken(WAD);
    const data = swap.interface.encodeFunctionData("swapUSDCForToken", [minimum, await deadline()]);
    const request = await signedRequest(forwarder, bob, swap, data, WAD);
    const altered = { ...request, data: swap.interface.encodeFunctionData("swapUSDCForToken", [1n, await deadline()]) };
    await reverts(() => forwarder.execute(altered, { value: WAD }), /ERC2771ForwarderInvalidSigner/);
    await mined(forwarder.execute(request, { value: WAD }));
    assert.equal(await token.balanceOf(bob.address), 100n * WAD + minimum);
    assert.equal(await token.balanceOf(owner.address), 0n);
  });

  it("rejects taxed token collections and deliveries instead of accepting an incorrect amount", async function () {
    await mined(token.setTransferFee(100));
    await reverts(async () => swap.connect(bob).swapTokenForUSDC(WAD, 1, await deadline()), /UnsupportedTokenBehavior/);
    await reverts(async () => swap.connect(bob).swapUSDCForToken(1, await deadline(), { value: WAD }), /UnsupportedTokenBehavior/);
    await reverts(() => swap.connect(bob).addLiquidity(WAD, { value: WAD }), /UnsupportedTokenBehavior/);
    assert.equal(await swap.reserveUSDC(), 10n * WAD);
    assert.equal(await swap.reserveToken(), 10n * WAD);
    assert.equal(await token.balanceOf(bob.address), 100n * WAD);
    assert.equal(await ethers.provider.getBalance(swap.target), 10n * WAD);
  });
});

describe("KletiaArcStakingV2 APR checkpoints", function () {
  let owner, alice, bob, forwarder, staking;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    staking = await deploy("KletiaArcStakingV2", forwarder.target, 1000, 100);
  });

  it("preserves already-earned rewards when APR becomes zero and pays them from funded reserves", async function () {
    const first = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(first);
    await nextTimestamp(start + YEAR);
    await mined(staking.setAPR(0));
    assert.equal(await staking.pendingRewards(alice.address), WAD / 10n);
    await nextTimestamp(start + YEAR * 2);
    await mined(staking.fundRewards({ value: WAD }));
    assert.equal(await staking.pendingRewards(alice.address), WAD / 10n);
    const receipt = await mined(staking.connect(alice).claimRewards());
    assert.equal(eventFrom(staking, receipt, "RewardsClaimed").amount, WAD / 10n);
    assert.equal(await staking.pendingRewards(alice.address), 0n);
    assert.equal(await staking.totalStaked(), WAD);
    assert.equal(await staking.rewardPoolBalance(), 9n * WAD / 10n);
  });

  it("applies each APR only to its own time period across multiple users and topups", async function () {
    const first = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(first);
    await nextTimestamp(start + YEAR);
    await mined(staking.setAPR(2000));
    await nextTimestamp(start + YEAR + YEAR / 2);
    await mined(staking.connect(bob).stake({ value: WAD }));
    await nextTimestamp(start + YEAR * 2);
    await mined(staking.setAPR(0));
    assert.equal(await staking.pendingRewards(alice.address), 3n * WAD / 10n);
    assert.equal(await staking.pendingRewards(bob.address), WAD / 10n);
    await mined(staking.connect(alice).stake({ value: WAD }));
    assert.equal((await staking.stakers(alice.address)).accruedRewards, 3n * WAD / 10n);
    assert.equal((await staking.getStakerInfo(alice.address)).accruedRewards, 3n * WAD / 10n);
    await mined(staking.connect(alice).unstake(2n * WAD));
    assert.equal(await staking.pendingRewards(alice.address), 3n * WAD / 10n);
    assert.equal(await staking.totalStaked(), WAD);
  });

  it("leaves checkpoints and earned rewards unchanged when an unfunded reward claim fails", async function () {
    const first = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(first);
    await nextTimestamp(start + YEAR);
    await mined(staking.setAPR(0));
    const global = await staking.globalRewardIndex();
    const accountCheckpoint = await staking.rewardIndexCheckpoint(alice.address);
    await reverts(() => staking.connect(alice).claimRewards(), /insufficient reward pool/);
    assert.equal(await staking.globalRewardIndex(), global);
    assert.equal(await staking.rewardIndexCheckpoint(alice.address), accountCheckpoint);
    assert.equal(await staking.pendingRewards(alice.address), WAD / 10n);
  });
});

describe("KletiaArcLendingV2 oracle failures", function () {
  let owner, supplier, borrower, liquidator, forwarder, token, pool, lending;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, supplier, borrower, liquidator] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    token = await deploy("ArcFinanceTokenMock");
    pool = await deploy("ArcPricePoolMock");
    lending = await deploy("KletiaArcLendingV2", forwarder.target, token.target, pool.target);
    await mined(token.mint(borrower.address, WAD));
    await mined(token.connect(borrower).approve(lending.target, WAD));
    await mined(lending.connect(supplier).supplyUSDC({ value: 2n * WAD }));
    await mined(lending.connect(borrower).depositCollateral(WAD));
    await network.provider.send("evm_increaseTime", [3600]);
    await mined(lending.connect(borrower).borrow(WAD / 2n));
  });

  it("uses current observations and initializes a positive TWAP before issuing debt", async function () {
    assert.equal(await lending.twapPrice(), WAD);
    assert.equal(await lending.getBorrowedBalance(borrower.address), WAD / 2n);
    assert.ok(await lending.healthFactor(borrower.address) > WAD);
    assert.equal(await lending.MAX_ORACLE_AGE(), 900n);
    await mined(lending.refreshOracle());
    assert.equal(await lending.lastTwapTimestamp(), BigInt((await ethers.provider.getBlock("latest")).timestamp));
  });

  it("rejects unavailable observations for debt, indebted collateral removal and liquidation without mutating accounts", async function () {
    await mined(pool.setUnavailable(true));
    const scaledDebt = await lending.scaledBorrowedUSDC(borrower.address);
    const collateral = await lending.collateralBalance(borrower.address);
    await reverts(() => lending.connect(borrower).borrow(WAD / 10n), /OracleUnavailable/);
    await reverts(() => lending.connect(borrower).withdrawCollateral(1n), /OracleUnavailable/);
    await reverts(() => lending.connect(liquidator).liquidate(borrower.address, { value: WAD }), /OracleUnavailable/);
    await reverts(() => lending.refreshOracle(), /OracleUnavailable/);
    assert.equal(await lending.scaledBorrowedUSDC(borrower.address), scaledDebt);
    assert.equal(await lending.collateralBalance(borrower.address), collateral);
  });

  it("rejects stale observation timestamps even when the pool answers successfully", async function () {
    await mined(pool.setFrozen(true));
    await network.provider.send("evm_increaseTime", [901]);
    await reverts(() => lending.connect(borrower).borrow(WAD / 10n), /OracleObservationStale/);
    await reverts(() => lending._getKletPrice(), /OracleObservationStale/);
    assert.equal(await lending.getBorrowedBalance(borrower.address), WAD / 2n);
    await mined(pool.setFrozen(false));
    await mined(lending.connect(borrower).borrow(WAD / 10n));
    assert.ok(await lending.getBorrowedBalance(borrower.address) >= 6n * WAD / 10n);
  });

  it("allows debt repayment, liquidity withdrawals and debt-free collateral exits during an oracle outage", async function () {
    await mined(pool.setUnavailable(true));
    await mined(lending.connect(borrower).repay({ value: WAD }));
    assert.equal(await lending.getBorrowedBalance(borrower.address), 0n);
    await mined(lending.connect(borrower).withdrawCollateral(WAD));
    assert.equal(await token.balanceOf(borrower.address), WAD);
    await mined(lending.connect(supplier).withdrawUSDC(WAD));
    assert.ok(await lending.getSuppliedBalance(supplier.address) >= WAD);
  });
});
