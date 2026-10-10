const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { deploy } = require("./helpers");

const generatedPins = fs.readFileSync(
  path.resolve(__dirname, "../../../apps/api/src/networks/arc/reviewedRuntimePins.ts"),
  "utf8",
);
const identities = JSON.parse(
  generatedPins.match(/ARC_REVIEWED_V2_RUNTIMES\s*=\s*(\{[\s\S]*?\})\s*as const/u)[1],
);
const forwarder = generatedPins.match(/ARC_REVIEWED_FORWARDER = "(0x[\da-fA-F]{40})"/u)[1];
const token = generatedPins.match(/ARC_REVIEWED_TOKEN = "(0x[\da-fA-F]{40})"/u)[1];
const alternateForwarder = "0x4444444444444444444444444444444444444444";

async function fixture() {
  // These are local test accounts only. No public-chain address is modified.
  await network.provider.send("hardhat_setCode", [forwarder, "0x60006000f3"]);
  await network.provider.send("hardhat_setCode", [alternateForwarder, "0x60006000f3"]);
  const tokenMock = await deploy("ArcFinanceTokenMock");
  await network.provider.send("hardhat_setCode", [token, await ethers.provider.getCode(tokenMock.target)]);
  const swap = await deploy("KletiaArcSwapV2", forwarder, token);
  const staking = await deploy("KletiaArcStakingV2", forwarder, 500, 3600);
  const lending = await deploy("KletiaArcLendingV2", forwarder, token, swap.target);
  return { swap, staking, lending, tokenMock };
}

async function runtimeHash(contract) {
  return ethers.keccak256(await ethers.provider.getCode(contract.target));
}

describe("Arc reviewed V2 runtime identities", () => {
  let snapshot;
  beforeEach(async () => { snapshot = await network.provider.send("evm_snapshot"); });
  afterEach(async () => { await network.provider.send("evm_revert", [snapshot]); });

  it("matches the actual local deployments with the canonical constructor immutables", async () => {
    const contracts = await fixture();
    for (const kind of ["swap", "staking", "lending"]) {
      const runtime = await ethers.provider.getCode(contracts[kind].target);
      assert.equal(ethers.keccak256(runtime), identities[kind].runtimeCodehash, kind);
      assert.equal((runtime.length - 2) / 2, identities[kind].runtimeBytes, kind);
      assert.equal(await contracts[kind].trustedForwarder(), forwarder);
    }
    assert.equal(await contracts.swap.token(), token);
    assert.equal(await contracts.lending.kletToken(), token);
    assert.equal(await contracts.lending.swapPool(), contracts.swap.target);
  });

  it("changes the pinned identity when a forwarder or token constructor binding changes", async () => {
    const { swap, tokenMock } = await fixture();
    const wrongForwarders = {
      swap: await deploy("KletiaArcSwapV2", alternateForwarder, token),
      staking: await deploy("KletiaArcStakingV2", alternateForwarder, 500, 3600),
      lending: await deploy("KletiaArcLendingV2", alternateForwarder, token, swap.target),
    };
    for (const kind of ["swap", "staking", "lending"]) {
      assert.notEqual(await runtimeHash(wrongForwarders[kind]), identities[kind].runtimeCodehash, kind);
    }
    const wrongSwapToken = await deploy("KletiaArcSwapV2", forwarder, tokenMock.target);
    const wrongLendingToken = await deploy("KletiaArcLendingV2", forwarder, tokenMock.target, swap.target);
    assert.notEqual(await runtimeHash(wrongSwapToken), identities.swap.runtimeCodehash);
    assert.notEqual(await runtimeHash(wrongLendingToken), identities.lending.runtimeCodehash);
  });
});
