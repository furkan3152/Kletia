const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const {
  deploy,
  mined,
  reverts,
  timestampOf,
  nextTimestamp,
  eventFrom,
  signedRequest,
} = require("./helpers");

const YEAR = 365 * 24 * 60 * 60;

describe("KletiaArcVaultV2", function () {
  let owner, guardian, alice, bob, relayer, forwarder, vault;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, guardian, alice, bob, relayer] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    vault = await deploy("KletiaArcVaultV2", forwarder.target, owner.address, guardian.address, 1000n);
  });

  async function freezeAfterYear() {
    const firstDeposit = await mined(vault.connect(alice).deposit({ value: 3_000_000n }));
    const start = await timestampOf(firstDeposit);
    await mined(vault.connect(bob).deposit({ value: 1_000_000n }));
    await nextTimestamp(start + YEAR + 1);
    await mined(vault.setAPY(0));
  }

  it("validates the trusted forwarder and caps APY", async function () {
    await reverts(
      () => deploy("KletiaArcVaultV2", alice.address, owner.address, guardian.address, 1000n),
      /InvalidAddress/,
    );
    await reverts(
      () => deploy("KletiaArcVaultV2", forwarder.target, owner.address, ethers.ZeroAddress, 1000n),
      /InvalidAddress/,
    );
    await reverts(
      () => deploy("KletiaArcVaultV2", forwarder.target, owner.address, guardian.address, 5001n),
      /APYAboveMaximum/,
    );
    await reverts(() => vault.setAPY(5001n), /APYAboveMaximum/);
    await reverts(() => vault.renounceOwnership(), /RenounceOwnershipDisabled/);
    await reverts(() => vault.connect(alice).deposit(), /InvalidAmount/);
    await reverts(() => vault.fundVault(), /InvalidAmount/);
  });

  it("keeps pre-topup interest and applies each APY only to its own period", async function () {
    const receipt = await mined(vault.connect(alice).deposit({ value: 1_000_000n }));
    const start = await timestampOf(receipt);
    await nextTimestamp(start + YEAR / 2);
    await mined(vault.connect(alice).deposit({ value: 1_000_000n }));
    let account = await vault.deposits(alice.address);
    assert.equal(account.principal, 2_000_000n);
    assert.equal(account.accruedInterest, 50_000n);

    await nextTimestamp(start + YEAR);
    await mined(vault.setAPY(2000n));
    assert.equal(await vault.pendingInterest(alice.address), 150_000n);

    await nextTimestamp(start + YEAR * 2);
    await mined(vault.setAPY(0));
    assert.equal(await vault.pendingInterest(alice.address), 550_000n);
    assert.equal(await vault.claimableAmount(alice.address), 2_550_000n);
    const liability = await vault.totalInterestLiability();
    assert.ok(liability >= 550_000n && liability <= 550_002n);
    assert.equal(await vault.requiredReserve(), 2_000_000n + liability);
  });

  it("requires reserves for all depositors before paying any user's interest", async function () {
    await freezeAfterYear();
    const claim = await vault.claimableAmount(alice.address);
    assert.equal(claim, 3_300_000n);
    assert.ok(await vault.vaultBalance() >= claim);
    const status = await vault.reserveStatus();
    assert.equal(status.principalLiability, 4_000_000n);
    assert.ok(status.interestLiability >= 400_000n);
    assert.equal(status.fullyCollateralized, false);
    assert.equal(status.surplus, 0n);

    await reverts(() => vault.connect(alice).withdraw(), /VaultInsolvent/);
    assert.equal(await vault.totalDeposited(), 4_000_000n);
    assert.equal((await vault.deposits(alice.address)).principal, 3_000_000n);
    assert.equal((await vault.deposits(bob.address)).principal, 1_000_000n);
    assert.equal(await vault.vaultBalance(), 4_000_000n);
  });

  it("allows emergency exits to forfeit interest while preserving the remaining principal", async function () {
    await freezeAfterYear();
    await mined(vault.connect(guardian).pause());
    const first = await mined(vault.connect(alice).emergencyWithdraw());
    const withdrawal = eventFrom(vault, first, "EmergencyWithdrawn");
    assert.equal(withdrawal.user, alice.address);
    assert.equal(withdrawal.principal, 3_000_000n);
    assert.equal(withdrawal.forfeitedInterest, 300_000n);
    assert.equal(await vault.vaultBalance(), 1_000_000n);
    assert.equal(await vault.totalDeposited(), 1_000_000n);
    assert.equal(await vault.pendingInterest(alice.address), 0n);
    assert.equal(await vault.pendingInterest(bob.address), 100_000n);
    await reverts(() => vault.connect(bob).withdraw(), /VaultInsolvent/);

    await mined(vault.connect(bob).emergencyWithdraw());
    assert.equal(await vault.vaultBalance(), 0n);
    assert.equal(await vault.totalDeposited(), 0n);
    assert.equal(await vault.totalInterestLiability(), 0n);
    assert.equal(await vault.requiredReserve(), 0n);
    await reverts(() => vault.connect(alice).emergencyWithdraw(), /NoActiveDeposit/);
  });

  it("pays funded claims and clears rounding liability when the last depositor exits", async function () {
    await freezeAfterYear();
    const required = await vault.requiredReserve();
    await mined(vault.fundVault({ value: required - await vault.vaultBalance() + 100n }));
    assert.equal((await vault.reserveStatus()).fullyCollateralized, true);
    await mined(vault.pause());

    const first = eventFrom(vault, await mined(vault.connect(alice).withdraw()), "Withdrawn");
    assert.equal(first.principal, 3_000_000n);
    assert.equal(first.interest, 300_000n);
    assert.equal(first.totalPayout, 3_300_000n);
    assert.equal((await vault.reserveStatus()).fullyCollateralized, true);
    assert.equal(await vault.vaultBalance(), required + 100n - 3_300_000n);

    const last = eventFrom(vault, await mined(vault.connect(bob).withdraw()), "Withdrawn");
    assert.equal(last.totalPayout, 1_100_000n);
    assert.equal(await vault.totalDeposited(), 0n);
    assert.equal(await vault.totalInterestLiability(), 0n);
    assert.equal(await vault.requiredReserve(), 0n);
    assert.equal(await vault.vaultBalance(), required + 100n - 4_400_000n);
  });

  it("restricts pause and ownership changes while leaving withdrawals available", async function () {
    await mined(vault.setAPY(0));
    await mined(vault.connect(alice).deposit({ value: 1000n }));
    await reverts(() => vault.connect(alice).pause(), /UnauthorizedGuardian/);
    await reverts(() => vault.connect(guardian).setAPY(10), /OwnableUnauthorizedAccount/);
    await mined(vault.connect(guardian).pause());
    await reverts(() => vault.connect(bob).deposit({ value: 1000n }), /EnforcedPause/);
    await reverts(() => vault.connect(guardian).unpause(), /OwnableUnauthorizedAccount/);
    await mined(vault.connect(alice).withdraw());
    await mined(vault.transferOwnership(bob.address));
    assert.equal(await vault.owner(), owner.address);
    await reverts(() => vault.connect(alice).acceptOwnership(), /OwnableUnauthorizedAccount/);
    await mined(vault.connect(bob).acceptOwnership());
    await reverts(() => vault.unpause(), /OwnableUnauthorizedAccount/);
    await mined(vault.connect(bob).unpause());
    await mined(vault.connect(alice).deposit({ value: 1000n }));
  });

  it("blocks emergency payout if the total principal reserve is breached", async function () {
    await mined(vault.connect(alice).deposit({ value: 1000n }));
    await mined(vault.connect(bob).deposit({ value: 1000n }));
    // Simulate a reserve shortfall; production exposes no owner reserve-drain method.
    await network.provider.send("hardhat_setBalance", [vault.target, ethers.toQuantity(1500n)]);
    await reverts(() => vault.connect(alice).emergencyWithdraw(), /PrincipalReserveBreached/);
    assert.equal(await vault.totalDeposited(), 2000n);
    assert.equal((await vault.deposits(alice.address)).principal, 1000n);
    assert.equal(await vault.vaultBalance(), 1500n);
  });

  it("restores accounting on failed payout and rejects withdrawal callbacks", async function () {
    await mined(vault.setAPY(0));
    const receiver = await deploy("ArcTestReceiver");
    await mined(receiver.invoke(vault.target, vault.interface.encodeFunctionData("deposit"), { value: 1000n }));
    await mined(receiver.setRejectPayment(true));
    await reverts(
      () => receiver.invoke(vault.target, vault.interface.encodeFunctionData("withdraw")),
      /NativeTransferFailed/,
    );
    assert.equal((await vault.deposits(receiver.target)).principal, 1000n);
    assert.equal(await vault.totalDeposited(), 1000n);
    assert.equal(await vault.vaultBalance(), 1000n);

    await mined(receiver.setRejectPayment(false));
    await mined(receiver.setReentry(vault.target, vault.interface.encodeFunctionData("withdraw"), 0));
    await mined(receiver.invoke(vault.target, vault.interface.encodeFunctionData("withdraw")));
    assert.equal(await receiver.reentryAttempted(), true);
    assert.equal(await receiver.reentrySucceeded(), false);
    assert.equal(await vault.totalDeposited(), 0n);
    assert.equal(await ethers.provider.getBalance(receiver.target), 1000n);
  });

  it("credits signed forwarded deposits and sends sponsored withdrawals to the signer", async function () {
    await mined(vault.setAPY(0));
    const deposit = await signedRequest(forwarder, alice, vault, vault.interface.encodeFunctionData("deposit"), 1000n);
    assert.equal(await forwarder.verify(deposit), true);
    const receipt = await mined(forwarder.connect(relayer).execute(deposit, { value: 1000n }));
    assert.equal(eventFrom(vault, receipt, "Deposited").user, alice.address);
    assert.equal((await vault.deposits(alice.address)).principal, 1000n);
    assert.equal((await vault.deposits(relayer.address)).principal, 0n);
    assert.equal((await vault.deposits(forwarder.target)).principal, 0n);

    const withdrawal = await signedRequest(forwarder, alice, vault, vault.interface.encodeFunctionData("withdraw"));
    const balance = await ethers.provider.getBalance(alice.address);
    await mined(forwarder.connect(relayer).execute(withdrawal));
    assert.equal(await ethers.provider.getBalance(alice.address), balance + 1000n);
    assert.equal(await vault.totalDeposited(), 0n);
    assert.equal(await forwarder.nonces(alice.address), 2n);
    await reverts(() => forwarder.connect(relayer).execute(withdrawal), /ERC2771ForwarderInvalidSigner/);
  });
});
