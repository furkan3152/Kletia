const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const ROUTER =
  "contracts/v2/core/KletiaIntentRouterV2.sol:KletiaIntentRouterV2";
const LAUNCH =
  "contracts/v2/launch/KletiaLaunchFactoryV2.sol:KletiaLaunchFactoryV2";
const REGISTRY =
  "contracts/v2/registry/KletiaX402ServiceAttestationRegistryV1.sol:KletiaX402ServiceAttestationRegistryV1";

describe("Base V2 governance and launch boundaries", function () {
  async function deployCodeStub() {
    const factory = await ethers.getContractFactory(
      "contracts/x402/X402Factory.sol:X402Factory",
    );
    const stub = await factory.deploy();
    await stub.waitForDeployment();
    return stub;
  }

  it("pins owner, guardian, treasury, wrapped-native code and fee cap", async function () {
    const [owner, guardian, treasury] = await ethers.getSigners();
    const wrappedNative = await deployCodeStub();
    const router = await ethers.deployContract(ROUTER, [
      owner.address,
      guardian.address,
      await wrappedNative.getAddress(),
      treasury.address,
      10,
    ]);
    await router.waitForDeployment();

    assert.equal(await router.owner(), owner.address);
    assert.equal(await router.guardian(), guardian.address);
    assert.equal(await router.treasury(), treasury.address);
    assert.equal(await router.wrappedNative(), await wrappedNative.getAddress());
    assert.equal(await router.feeBps(), 10n);

    await assert.rejects(
      ethers.deployContract(ROUTER, [
        owner.address,
        guardian.address,
        await wrappedNative.getAddress(),
        treasury.address,
        101,
      ]),
    );
    await assert.rejects(
      ethers.deployContract(ROUTER, [
        owner.address,
        guardian.address,
        treasury.address,
        treasury.address,
        10,
      ]),
    );
  });

  it("deploys deterministic fixed-supply tokens without treasury dilution", async function () {
    const [owner, treasury, recipient] = await ethers.getSigners();
    const factory = await ethers.deployContract(LAUNCH, [
      owner.address,
      treasury.address,
    ]);
    await factory.waitForDeployment();
    const userSalt = ethers.id("professional-launch-v1");
    const supply = ethers.parseEther("1000000");
    const predicted = await factory.predictTokenAddress(
      owner.address,
      userSalt,
      "Kletia Test",
      "KTST",
      supply,
      recipient.address,
    );

    await (
      await factory.deployToken(
        userSalt,
        "Kletia Test",
        "KTST",
        supply,
        recipient.address,
        0,
      )
    ).wait();

    const token = await ethers.getContractAt("KletiaFixedSupplyTokenV2", predicted);
    assert.equal(await token.totalSupply(), supply);
    assert.equal(await token.balanceOf(recipient.address), supply);
    assert.equal(await factory.tokenForSalt(owner.address, userSalt), predicted);
    await assert.rejects(
      factory.deployToken(
        userSalt,
        "Kletia Test",
        "KTST",
        supply,
        recipient.address,
        0,
      ),
    );
  });

  it("keeps x402 claims publisher-bound and explicitly revocable", async function () {
    const [owner, guardian, publisher, payTo] = await ethers.getSigners();
    const registry = await ethers.deployContract(REGISTRY, [
      owner.address,
      guardian.address,
    ]);
    await registry.waitForDeployment();
    const serviceId = ethers.id("https://service.example/resource");
    const manifestDigest = ethers.id("manifest-v1");
    const publisherDataHash = ethers.id("publisher-data-v1");
    const latest = await ethers.provider.getBlock("latest");
    const expiresAt = BigInt(latest.timestamp + 3_600);

    const key = await registry.connect(publisher).attestAsPublisher.staticCall(
      serviceId,
      manifestDigest,
      payTo.address,
      publisherDataHash,
      expiresAt,
    );
    await (
      await registry
        .connect(publisher)
        .attestAsPublisher(
          serviceId,
          manifestDigest,
          payTo.address,
          publisherDataHash,
          expiresAt,
        )
    ).wait();

    const [stored, activeStatus] = await registry.getAttestation(
      key,
      publisher.address,
    );
    assert.equal(stored.revokedAt, 0n);
    assert.equal(stored.kind, 1n);
    assert.notEqual(activeStatus, 0n);
    await assert.rejects(registry.connect(guardian).revoke(key));
    await (await registry.connect(publisher).revoke(key)).wait();
    const [revoked, revokedStatus] = await registry.getAttestation(
      key,
      publisher.address,
    );
    assert.notEqual(revoked.revokedAt, 0n);
    assert.notEqual(revokedStatus, activeStatus);
  });
});
