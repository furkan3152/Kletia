const { ethers, network } = require("hardhat");
const { assert, deploy, reverted } = require("./helpers");

const swapTypes = {
  SwapIntent: [
    ["owner", "address"], ["tokenIn", "address"], ["tokenOut", "address"],
    ["amountIn", "uint256"], ["minAmountOut", "uint256"], ["recipient", "address"],
    ["adapter", "address"], ["adapterConfigHash", "bytes32"], ["adapterDataHash", "bytes32"],
    ["nonce", "uint256"], ["issuedAt", "uint48"], ["validAfter", "uint48"],
    ["deadline", "uint48"], ["executor", "address"], ["maxFeeBps", "uint16"],
  ].map(([name, type]) => ({ name, type })),
};

describe("KletiaIntentRouterV2 settlement boundaries", function () {
  let governance, guardian, treasury, user, recipient, relayer;
  let router, input, output, wrapped, target, adapter, adapterData;

  beforeEach(async function () {
    [governance, guardian, treasury, user, recipient, relayer] = await ethers.getSigners();
    input = await deploy("SettlementTokenMock", "IN");
    output = await deploy("SettlementTokenMock", "OUT");
    wrapped = await deploy("WrappedNativeMock");
    target = await deploy("SwapTargetMock");
    adapter = await deploy("SwapAdapterMock", target.target);
    router = await deploy("KletiaIntentRouterV2", governance.address, guardian.address, wrapped.target, treasury.address, 10);
    await router.configureAdapter(adapter.target, true);
    await input.mint(user.address, 100_000n);
    await input.connect(user).approve(router.target, 100_000n);
    adapterData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [20_000n]);
  });

  async function intent(overrides = {}) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const config = await router.adapterConfig(adapter.target);
    return {
      owner: user.address, tokenIn: input.target, tokenOut: output.target,
      amountIn: 10_000n, minAmountOut: 19_980n, recipient: recipient.address,
      adapter: adapter.target, adapterConfigHash: config.configHash,
      adapterDataHash: ethers.keccak256(adapterData), nonce: 1n,
      issuedAt: now, validAfter: now, deadline: now + 600,
      executor: ethers.ZeroAddress, maxFeeBps: 10, ...overrides,
    };
  }

  async function signature(swapIntent, domainOverrides = {}) {
    const { chainId } = await ethers.provider.getNetwork();
    return user.signTypedData({
      name: "Kletia Intent Router", version: "2", chainId,
      verifyingContract: router.target, ...domainOverrides,
    }, swapTypes, swapIntent);
  }

  it("settles only the swap delta, delivers net output and fee, and clears protocol allowance", async function () {
    await input.mint(router.target, 7n);
    await output.mint(router.target, 11n);
    const swapIntent = await intent();
    await router.connect(user).executeSwap(swapIntent, adapterData);
    assert.equal(await input.balanceOf(user.address), 90_000n);
    assert.equal(await input.balanceOf(target.target), 10_000n);
    assert.equal(await input.balanceOf(router.target), 7n);
    assert.equal(await output.balanceOf(router.target), 11n);
    assert.equal(await output.balanceOf(recipient.address), 19_980n);
    assert.equal(await output.balanceOf(treasury.address), 20n);
    assert.equal(await target.lastMinimum(), 19_999n);
    assert.equal(await input.allowance(router.target, target.target), 0n);
    assert.equal(await router.isNonceUsed(user.address, swapIntent.nonce), true);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "NonceAlreadyUsed");
  });

  it("handles a treasury recipient without double-counting its output delta", async function () {
    await router.connect(user).executeSwap(await intent({ recipient: treasury.address }), adapterData);
    assert.equal(await output.balanceOf(treasury.address), 20_000n);
  });

  it("accepts a relayed EIP-712 intent and binds every field to its owner signature", async function () {
    const swapIntent = await intent({ executor: relayer.address });
    const signed = await signature(swapIntent);
    await reverted(() => router.connect(relayer).executeSwapWithSignature({ ...swapIntent, recipient: treasury.address }, adapterData, signed), "InvalidSignature");
    await reverted(() => router.connect(guardian).executeSwapWithSignature(swapIntent, adapterData, signed), "WrongExecutor");
    const wrongChain = await signature(swapIntent, { chainId: 8453 });
    await reverted(() => router.connect(relayer).executeSwapWithSignature(swapIntent, adapterData, wrongChain), "InvalidSignature");
    await router.connect(relayer).executeSwapWithSignature(swapIntent, adapterData, signed);
    await reverted(() => router.connect(relayer).executeSwapWithSignature(swapIntent, adapterData, signed), "NonceAlreadyUsed");
  });

  it("invalidates selected unordered nonce bits without blocking neighboring nonces", async function () {
    await router.connect(user).invalidateUnorderedNonces(1n, 2n);
    assert.equal(await router.isNonceUsed(user.address, 257n), true);
    assert.equal(await router.isNonceUsed(user.address, 258n), false);
    const blocked = await intent({ nonce: 257n });
    await reverted(() => router.connect(user).executeSwap(blocked, adapterData), "NonceAlreadyUsed");
    await router.connect(user).executeSwap(await intent({ nonce: 258n }), adapterData);
    await reverted(() => router.connect(user).invalidateUnorderedNonces(0n, 0n), "EmptyNonceMask");
  });

  it("rejects expired, future, and excessive-TTL intents before consuming a nonce", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    for (const [times, error] of [
      [{ issuedAt: now - 20, validAfter: now - 20, deadline: now - 1 }, "IntentExpired"],
      [{ issuedAt: now, validAfter: now + 100, deadline: now + 200 }, "IntentNotYetValid"],
      [{ issuedAt: now, validAfter: now, deadline: now + 3601 }, "IntentTtlTooLong"],
    ]) {
      const swapIntent = await intent(times);
      await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), error);
    }
    assert.equal(await router.isNonceUsed(user.address, 1n), false);
  });

  it("rejects altered adapter data, configuration, returned targets, and signed fee limits", async function () {
    const swapIntent = await intent();
    await reverted(() => router.connect(user).executeSwap(swapIntent, "0x"), "AdapterDataHashMismatch");
    await reverted(() => router.connect(user).executeSwap({ ...swapIntent, adapterConfigHash: ethers.ZeroHash }, adapterData), "AdapterConfigHashMismatch");
    await reverted(() => router.connect(user).executeSwap({ ...swapIntent, maxFeeBps: 9 }, adapterData), "FeeLimitExceeded");
    await adapter.setReturnedAddresses(output.target, target.target);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "AdapterReturnedUnexpectedTarget");
    await adapter.setReturnedAddresses(target.target, output.target);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "AdapterReturnedUnexpectedSpender");
    await adapter.setConfigurationHash(ethers.id("unreviewed change"));
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "AdapterConfigurationChanged");
  });

  for (const component of ["adapter", "target", "wrapped"]) {
    it(`rejects changed ${component} runtime code`, async function () {
      const tokenIn = component === "wrapped" ? wrapped.target : input.target;
      const swapIntent = await intent({ tokenIn });
      const contract = { adapter, target, wrapped }[component];
      await network.provider.send("hardhat_setCode", [contract.target, "0x60006000f3"]);
      await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "RuntimeCodeChanged");
    });
  }

  it("allows the guardian to pause/disable but reserves unpause/enable/fees for governance", async function () {
    await router.connect(guardian).pause();
    await reverted(async () => router.connect(user).executeSwap(await intent(), adapterData), "RouterPaused");
    await reverted(() => router.connect(guardian).unpause(), "OwnableUnauthorizedAccount");
    await reverted(() => router.connect(guardian).setFeeBps(0), "OwnableUnauthorizedAccount");
    await router.unpause();
    await router.connect(guardian).disableAdapter(adapter.target);
    await reverted(async () => router.connect(user).executeSwap(await intent(), adapterData), "AdapterNotEnabled");
    await reverted(() => router.connect(guardian).enableAdapter(adapter.target), "OwnableUnauthorizedAccount");
    await router.enableAdapter(adapter.target);
    await router.connect(user).executeSwap(await intent(), adapterData);
  });

  it("rolls back partial protocol spending, low output, and nonce consumption", async function () {
    const swapIntent = await intent();
    await target.setSpendBps(5_000);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "UnsupportedTokenBehavior");
    assert.equal(await input.balanceOf(user.address), 100_000n);
    assert.equal(await output.balanceOf(recipient.address), 0n);
    assert.equal(await router.isNonceUsed(user.address, 1n), false);
    await target.setSpendBps(10_000);
    const lowOutput = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [19_998n]);
    await reverted(() => router.connect(user).executeSwap({ ...swapIntent, adapterDataHash: ethers.keccak256(lowOutput) }, lowOutput), "InsufficientOutput");
    assert.equal(await input.allowance(router.target, target.target), 0n);
    assert.equal(await router.isNonceUsed(user.address, 1n), false);
  });

  it("fails closed for taxed input/output tokens and residual allowances", async function () {
    const swapIntent = await intent();
    await input.setTransferFee(100);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "UnsupportedTokenBehavior");
    await input.setTransferFee(0);
    await output.setTransferFee(100);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "UnsupportedTokenBehavior");
    await output.setTransferFee(0);
    await input.setStickyAllowance(true);
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData), "ResidualAllowance");
    assert.equal(await input.balanceOf(user.address), 100_000n);
    assert.equal(await router.isNonceUsed(user.address, 1n), false);
  });

  it("uses the smallest gross output that satisfies a net minimum after fee rounding", async function () {
    adapterData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [1n]);
    await router.connect(user).executeSwap(await intent({ minAmountOut: 1n }), adapterData);
    assert.equal(await target.lastMinimum(), 1n);
    assert.equal(await output.balanceOf(recipient.address), 1n);
    assert.equal(await output.balanceOf(treasury.address), 0n);
  });

  it("normalizes direct native input and rejects relayed native capital", async function () {
    const swapIntent = await intent({ tokenIn: ethers.ZeroAddress });
    await reverted(() => router.connect(user).executeSwap(swapIntent, adapterData, { value: 9999n }), "InvalidNativeValue");
    await reverted(() => router.connect(relayer).executeSwapWithSignature(swapIntent, adapterData, "0x", { value: 10_000n }), "RelayedNativeInputUnsupported");
    await router.connect(user).executeSwap(swapIntent, adapterData, { value: 10_000n });
    assert.equal(await wrapped.balanceOf(target.target), 10_000n);
    assert.equal(await wrapped.balanceOf(router.target), 0n);
    assert.equal(await wrapped.allowance(router.target, target.target), 0n);
  });

  it("rejects system recipients, normalized-token self-swaps, and counterfactual signatures", async function () {
    const swapIntent = await intent();
    await reverted(() => router.connect(user).executeSwap({ ...swapIntent, recipient: adapter.target }, adapterData), "ForbiddenRecipient");
    await reverted(() => router.connect(user).executeSwap({ ...swapIntent, tokenOut: input.target }, adapterData), "IdenticalNormalizedTokens");
    const magic = await router.ERC6492_MAGIC();
    await reverted(() => router.connect(relayer).executeSwapWithSignature(swapIntent, adapterData, magic), "CounterfactualSignatureUnsupported");
  });
});
