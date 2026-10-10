const { ethers } = require("hardhat");
const { assert, deploy, reverted } = require("./helpers");

describe("KletiaLaunchFactoryV2 deterministic launches", function () {
  let owner, treasury, creator, recipient, otherCreator, factory;
  const salt = ethers.id("my launch");
  const supply = ethers.parseUnits("1000000", 18);

  beforeEach(async function () {
    [owner, treasury, creator, recipient, otherCreator] = await ethers.getSigners();
    factory = await deploy("KletiaLaunchFactoryV2", owner.address, treasury.address);
  });

  function launch(user = creator, overrides = {}) {
    return factory.connect(user).deployToken(
      overrides.salt ?? salt,
      overrides.name ?? "Kletia Test Token",
      overrides.symbol ?? "KTEST",
      overrides.supply ?? supply,
      overrides.recipient ?? recipient.address,
      overrides.maxFee ?? 0n,
      { value: overrides.value ?? 0n },
    );
  }

  it("deploys at the predicted CREATE2 address and mints the fixed supply only to the recipient", async function () {
    const predicted = await factory.predictTokenAddress(creator.address, salt, "Kletia Test Token", "KTEST", supply, recipient.address);
    await launch();
    assert.equal(await factory.tokenForSalt(creator.address, salt), predicted);
    const token = await ethers.getContractAt("KletiaFixedSupplyTokenV2", predicted);
    assert.equal(await token.totalSupply(), supply);
    assert.equal(await token.balanceOf(recipient.address), supply);
    assert.equal(await token.balanceOf(creator.address), 0n);
    assert.equal(await token.name(), "Kletia Test Token");
    assert.equal(await token.symbol(), "KTEST");
    assert.equal(await token.nonces(recipient.address), 0n);
    await token.connect(recipient).transfer(creator.address, 1n);
    assert.equal(await token.totalSupply(), supply);
  });

  it("prevents reusing a creator salt even with different metadata, while isolating other creators", async function () {
    await launch();
    await reverted(() => launch(creator, { name: "Changed metadata" }), "CreatorSaltAlreadyUsed");
    await launch(otherCreator);
    assert.notEqual(await factory.tokenForSalt(creator.address, salt), await factory.tokenForSalt(otherCreator.address, salt));
  });

  it("enforces the caller fee ceiling, exact value and governance cap, and pays the treasury", async function () {
    const fee = ethers.parseEther("0.005");
    await factory.setDeploymentFee(fee);
    await reverted(() => launch(creator, { value: fee }), "DeploymentFeeExceedsCallerLimit");
    await reverted(() => launch(creator, { maxFee: fee, value: fee - 1n }), "IncorrectNativeValue");
    await reverted(() => factory.setDeploymentFee(ethers.parseEther("0.01") + 1n), "DeploymentFeeAboveHardCap");
    const before = await ethers.provider.getBalance(treasury.address);
    await launch(creator, { maxFee: fee, value: fee });
    assert.equal(await ethers.provider.getBalance(treasury.address) - before, fee);
    assert.equal(await ethers.provider.getBalance(factory.target), 0n);
  });

  it("rejects zero/excess supply, unsafe metadata and forbidden recipients before deploying", async function () {
    for (const [overrides, error] of [
      [{ supply: 0n }, "InvalidSupply"],
      [{ supply: 10n ** 36n + 1n }, "InvalidSupply"],
      [{ name: "" }, "InvalidName"],
      [{ name: "A\nB" }, "InvalidName"],
      [{ name: "A\u202eB" }, "InvalidName"],
      [{ symbol: "K TEST" }, "InvalidSymbol"],
      [{ symbol: "X".repeat(17) }, "InvalidSymbol"],
      [{ recipient: ethers.ZeroAddress }, "InvalidAddress"],
      [{ recipient: factory.target }, "InvalidAddress"],
    ]) {
      await reverted(() => launch(creator, overrides), error);
      assert.equal(await factory.tokenForSalt(creator.address, salt), ethers.ZeroAddress);
    }
  });

  it("requires the nominated treasury to accept and denies fee changes by other accounts", async function () {
    await reverted(() => factory.connect(creator).setDeploymentFee(1), "OwnableUnauthorizedAccount");
    await factory.proposeTreasury(otherCreator.address);
    assert.equal(await factory.treasury(), treasury.address);
    await reverted(() => factory.connect(creator).acceptTreasury(), "UnauthorizedTreasuryAcceptance");
    await factory.connect(otherCreator).acceptTreasury();
    assert.equal(await factory.treasury(), otherCreator.address);
    assert.equal(await factory.pendingTreasury(), ethers.ZeroAddress);
    await reverted(() => factory.renounceOwnership(), "OwnershipRenunciationDisabled");
  });
});
