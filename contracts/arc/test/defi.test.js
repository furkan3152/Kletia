const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const { deploy, mined, reverts, timestampOf, nextTimestamp, eventFrom } = require("./helpers");

const WAD = 10n ** 18n;
const YEAR = 365 * 24 * 60 * 60;

describe("Arc Swap local liquidity and settlement", function () {
  let owner, alice, bob, forwarder, token, swap;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    token = await deploy("ArcFinanceTokenMock");
    swap = await deploy("KletiaArcSwap", forwarder.target, token.target);
    for (const signer of [alice, bob]) {
      await mined(token.mint(signer.address, 100n * WAD));
      await mined(token.connect(signer).approve(swap.target, ethers.MaxUint256));
    }
  });

  it("mints proportional liquidity, locks the minimum, and burns LP for reserve shares", async function () {
    await mined(swap.connect(alice).addLiquidity(WAD, { value: WAD }));
    assert.equal(await swap.totalSupply(), WAD);
    assert.equal(await swap.balanceOf(alice.address), WAD - 1000n);
    assert.equal(await swap.balanceOf("0x000000000000000000000000000000000000dEaD"), 1000n);
    await mined(swap.connect(bob).addLiquidity(2n * WAD, { value: WAD }));
    assert.equal(await swap.balanceOf(bob.address), WAD);
    assert.equal(await token.balanceOf(bob.address), 99n * WAD);
    await mined(swap.connect(bob).removeLiquidity(WAD));
    assert.equal(await swap.balanceOf(bob.address), 0n);
    assert.equal(await token.balanceOf(bob.address), 100n * WAD);
    assert.equal(await swap.reserveUSDC(), WAD);
    assert.equal(await swap.reserveToken(), WAD);
  });

  it("settles both swap directions according to the reserves and fee without decreasing k", async function () {
    await mined(swap.connect(alice).addLiquidity(10n * WAD, { value: 10n * WAD }));
    const initialK = (await swap.reserveUSDC()) * (await swap.reserveToken());
    const expectedToken = await swap.previewSwapUSDCForToken(WAD);
    const receipt = await mined(swap.connect(bob).swapUSDCForToken({ value: WAD }));
    assert.equal(eventFrom(swap, receipt, "Swapped").amountOut, expectedToken);
    assert.equal(await token.balanceOf(bob.address), 100n * WAD + expectedToken);
    assert.ok((await swap.reserveUSDC()) * (await swap.reserveToken()) >= initialK);
    const expectedNative = await swap.previewSwapTokenForUSDC(WAD);
    const reverse = await mined(swap.connect(bob).swapTokenForUSDC(WAD));
    assert.equal(eventFrom(swap, reverse, "Swapped").amountOut, expectedNative);
    assert.equal(await swap.reserveUSDC(), await ethers.provider.getBalance(swap.target));
    assert.equal(await swap.reserveToken(), await token.balanceOf(swap.target));
    assert.ok((await swap.reserveUSDC()) * (await swap.reserveToken()) >= initialK);
  });

  it("rejects impossible input/liquidity bounds and rolls back failed token payments", async function () {
    await reverts(() => swap.connect(alice).addLiquidity(WAD), /Zero USDC added/);
    await reverts(() => swap.connect(alice).addLiquidity(0, { value: WAD }), /Zero token added/);
    await reverts(() => swap.connect(alice).swapUSDCForToken({ value: WAD }), /Zero token output/);
    await mined(swap.connect(alice).addLiquidity(WAD, { value: WAD }));
    await reverts(() => swap.connect(bob).addLiquidity(WAD - 1n, { value: WAD }), /Too much token required/);
    await reverts(() => swap.connect(bob).removeLiquidity(1), /Insufficient LP balance/);
    await reverts(() => swap.connect(bob).swapTokenForUSDC(0), /Zero token input/);
    await mined(token.setRejectTransfers(true));
    await reverts(() => swap.connect(bob).swapUSDCForToken({ value: WAD }), /Token transfer failed/);
    assert.equal(await swap.reserveUSDC(), WAD);
    assert.equal(await swap.reserveToken(), WAD);
    assert.equal(await ethers.provider.getBalance(swap.target), WAD);
    await reverts(() => swap.connect(alice).removeLiquidity(1_000_000n), /Token transfer failed/);
    assert.equal(await swap.balanceOf(alice.address), WAD - 1000n);
  });

  it("characterizes current deployment: a reserve move can execute below a prior preview without min-output/deadline checks", async function () {
    await mined(swap.connect(alice).addLiquidity(10n * WAD, { value: 10n * WAD }));
    const priorPreview = await swap.previewSwapUSDCForToken(WAD);
    await mined(swap.connect(alice).swapUSDCForToken({ value: 5n * WAD }));
    const receipt = await mined(swap.connect(bob).swapUSDCForToken({ value: WAD }));
    assert.ok(eventFrom(swap, receipt, "Swapped").amountOut < priorPreview);
    assert.equal(swap.interface.getFunction("swapUSDCForToken").inputs.length, 0);
    assert.equal(swap.interface.getFunction("swapTokenForUSDC").inputs.length, 1);
  });
});

describe("Arc Staking principal, rewards and cooldown", function () {
  let owner, alice, bob, forwarder, staking;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    staking = await deploy("KletiaArcStaking", forwarder.target, 1000, 100);
  });

  it("keeps unfunded claims pending and pays funded rewards without consuming principal", async function () {
    const deposit = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(deposit);
    await nextTimestamp(start + YEAR);
    await network.provider.send("evm_mine");
    assert.equal(await staking.pendingRewards(alice.address), WAD / 10n);
    await reverts(() => staking.connect(alice).claimRewards(), /insufficient reward pool/);
    assert.equal(await staking.totalStaked(), WAD);
    await mined(staking.fundRewards({ value: WAD }));
    const receipt = await mined(staking.connect(alice).claimRewards());
    const payout = eventFrom(staking, receipt, "RewardsClaimed").amount;
    assert.ok(payout >= WAD / 10n);
    assert.equal(await staking.rewardPoolBalance(), WAD - payout);
    assert.equal(await staking.contractBalance(), 2n * WAD - payout);
    assert.equal((await staking.stakers(alice.address)).stakedAmount, WAD);
    assert.equal((await staking.stakers(alice.address)).accruedRewards, 0n);
  });

  it("accrues before a topup and returns pending principal only after cooldown", async function () {
    const first = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(first);
    await nextTimestamp(start + YEAR / 2);
    await mined(staking.connect(alice).stake({ value: WAD }));
    assert.equal((await staking.stakers(alice.address)).accruedRewards, WAD / 20n);
    const unstake = await mined(staking.connect(alice).unstake(WAD));
    const requestedAt = await timestampOf(unstake);
    assert.equal(await staking.totalStaked(), WAD);
    assert.equal((await staking.stakers(alice.address)).pendingUnstake, WAD);
    await reverts(() => staking.connect(alice).unstake(1), /existing unstake pending/);
    await reverts(() => staking.connect(alice).claimUnstaked(), /cooldown not elapsed/);
    await nextTimestamp(requestedAt + 100);
    await mined(staking.connect(alice).claimUnstaked());
    assert.equal((await staking.stakers(alice.address)).pendingUnstake, 0n);
    assert.equal(await staking.contractBalance(), WAD);
    await reverts(() => staking.connect(alice).claimUnstaked(), /no pending unstake/);
  });

  it("restricts economics and owner transitions, enforces caps and rejects invalid user amounts", async function () {
    await reverts(() => staking.connect(alice).setAPR(0), /caller is not the owner/);
    await reverts(() => staking.setAPR(3001), /APR too high/);
    await reverts(() => staking.setCooldownPeriod(0), /cooldown must be > 0/);
    await reverts(() => staking.connect(alice).fundRewards({ value: WAD }), /caller is not the owner/);
    await reverts(() => staking.connect(alice).stake(), /amount too small/);
    await reverts(() => staking.connect(alice).unstake(1), /insufficient staked balance/);
    await reverts(() => staking.transferOwnership(ethers.ZeroAddress), /invalid new owner/);
    await mined(staking.transferOwnership(bob.address));
    await reverts(() => staking.setAPR(0), /caller is not the owner/);
    await mined(staking.connect(bob).setAPR(0));
  });

  it("characterizes current deployment: APR changes reprice uncheckpointed historical rewards", async function () {
    const receipt = await mined(staking.connect(alice).stake({ value: WAD }));
    const start = await timestampOf(receipt);
    await nextTimestamp(start + YEAR);
    await network.provider.send("evm_mine");
    assert.equal(await staking.pendingRewards(alice.address), WAD / 10n);
    await mined(staking.setAPR(0));
    assert.equal(await staking.pendingRewards(alice.address), 0n);
    assert.equal((await staking.stakers(alice.address)).stakedAmount, WAD);
  });
});

describe("Arc Lending collateral and debt transitions", function () {
  let owner, supplier, borrower, liquidator, forwarder, token, pool, lending;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, supplier, borrower, liquidator] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    token = await deploy("ArcFinanceTokenMock");
    pool = await deploy("ArcPricePoolMock");
    lending = await deploy("KletiaArcLending", forwarder.target, token.target, pool.target);
    await mined(token.mint(borrower.address, 10n * WAD));
    await mined(token.connect(borrower).approve(lending.target, ethers.MaxUint256));
  });

  async function openPosition(amount = WAD / 2n) {
    await mined(lending.connect(supplier).supplyUSDC({ value: 2n * WAD }));
    await mined(lending.connect(borrower).depositCollateral(WAD));
    await network.provider.send("evm_increaseTime", [3600]);
    await mined(lending.connect(borrower).borrow(amount));
  }

  it("initializes TWAP, supplies liquidity, borrows within LTV and repays with excess refund", async function () {
    await openPosition();
    assert.equal(await lending.twapPrice(), WAD);
    assert.equal(await lending.getSuppliedBalance(supplier.address), 2n * WAD);
    assert.equal(await lending.getBorrowedBalance(borrower.address), WAD / 2n);
    assert.ok(await lending.healthFactor(borrower.address) > WAD);
    assert.ok(await lending.currentBorrowRate() > 0n);
    const receipt = await mined(lending.connect(borrower).repay({ value: WAD }));
    assert.equal(eventFrom(lending, receipt, "USDCRepaid").amount, WAD);
    assert.equal(await lending.getBorrowedBalance(borrower.address), 0n);
    await mined(lending.connect(borrower).withdrawCollateral(WAD));
    assert.equal(await lending.collateralBalance(borrower.address), 0n);
    assert.equal(await token.balanceOf(borrower.address), 10n * WAD);
    await mined(lending.connect(supplier).withdrawUSDC(2n * WAD));
    assert.ok(await ethers.provider.getBalance(lending.target) < WAD / 1000n);
  });

  it("rejects missing TWAP, excessive LTV, liquidity withdrawal and unsafe collateral removal atomically", async function () {
    await reverts(() => lending._getKletPrice(), /TWAP not initialized/);
    await reverts(() => lending.connect(borrower).supplyUSDC(), /Zero supply/);
    await reverts(() => lending.connect(borrower).depositCollateral(0), /Zero deposit/);
    await openPosition();
    const beforeDebt = await lending.scaledBorrowedUSDC(borrower.address);
    await reverts(() => lending.connect(borrower).borrow(WAD), /Exceeds max borrow LTV/);
    assert.equal(await lending.scaledBorrowedUSDC(borrower.address), beforeDebt);
    await reverts(() => lending.connect(borrower).withdrawCollateral(WAD), /Health factor too low/);
    assert.equal(await lending.collateralBalance(borrower.address), WAD);
    await reverts(() => lending.connect(supplier).withdrawUSDC(2n * WAD), /Insufficient pool liquidity/);
    assert.equal(await lending.scaledSuppliedUSDC(supplier.address), 2n * WAD);
    await reverts(() => lending.connect(liquidator).liquidate(borrower.address, { value: WAD }), /Position is healthy/);
    await reverts(() => lending.connect(borrower).liquidate(borrower.address, { value: WAD }), /Cannot liquidate self/);
  });

  it("liquidates an unhealthy position, transfers bounded collateral and clears the repaid debt", async function () {
    await openPosition(6n * WAD / 10n);
    await mined(pool.setPrice(7n * WAD / 10n));
    await network.provider.send("evm_increaseTime", [3600]);
    await mined(lending.connect(supplier).supplyUSDC({ value: 1n }));
    assert.ok(await lending.healthFactor(borrower.address) < WAD);
    await reverts(() => lending.connect(liquidator).liquidate(borrower.address, { value: 1n }), /Insufficient repayment/);
    const receipt = await mined(lending.connect(liquidator).liquidate(borrower.address, { value: WAD }));
    const event = eventFrom(lending, receipt, "Liquidated");
    assert.ok(event.collateralSeized > 0n && event.collateralSeized < WAD);
    assert.equal(await token.balanceOf(liquidator.address), event.collateralSeized);
    assert.equal(await lending.collateralBalance(borrower.address), WAD - event.collateralSeized);
    assert.ok(await lending.getBorrowedBalance(borrower.address) <= 1n);
  });

  it("rolls back collateral accounting when the token declines transfer", async function () {
    await mined(token.setRejectTransfers(true));
    await reverts(() => lending.connect(borrower).depositCollateral(WAD), /Transfer failed/);
    assert.equal(await lending.collateralBalance(borrower.address), 0n);
    await mined(token.setRejectTransfers(false));
    await mined(lending.connect(borrower).depositCollateral(WAD));
    await mined(token.setRejectTransfers(true));
    await reverts(() => lending.connect(borrower).withdrawCollateral(WAD), /Transfer failed/);
    assert.equal(await lending.collateralBalance(borrower.address), WAD);
  });

  it("characterizes current deployment: an oracle outage leaves stale TWAP usable for later borrows", async function () {
    await openPosition(WAD / 4n);
    const priceTimestamp = await lending.lastTwapTimestamp();
    await mined(pool.setUnavailable(true));
    await network.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
    await mined(lending.connect(borrower).borrow(WAD / 10n));
    assert.equal(await lending.lastTwapTimestamp(), priceTimestamp);
    assert.equal(await lending.twapPrice(), WAD);
    assert.ok(await lending.getBorrowedBalance(borrower.address) >= 35n * WAD / 100n);
  });
});
