const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const contract = (path, name) => `contracts/${path}.sol:${name}`;

describe("Arc protocol contract boundaries", function () {
  async function deployFixture() {
    const [owner, treasury, user] = await ethers.getSigners();
    const forwarder = await ethers.deployContract(
      contract("KletiaArcForwarder", "KletiaArcForwarder"),
      ["KletiaArcForwarder"],
    );
    await forwarder.waitForDeployment();

    const token = await ethers.deployContract(
      contract("KletiaToken", "KletiaToken"),
      [
        "Kletia Token",
        "KLET",
        ethers.parseEther("1000000"),
        owner.address,
        treasury.address,
      ],
    );
    await token.waitForDeployment();

    const swap = await ethers.deployContract(
      contract("KletiaArcSwap", "KletiaArcSwap"),
      [await forwarder.getAddress(), await token.getAddress()],
    );
    await swap.waitForDeployment();

    return { owner, treasury, user, forwarder, token, swap };
  }

  it("binds fixed-supply KLET distribution and the ERC-2771 trust root", async function () {
    const { owner, treasury, forwarder, token, swap } = await deployFixture();
    const supply = ethers.parseEther("1000000");

    assert.equal(await token.totalSupply(), supply);
    assert.equal(await token.balanceOf(owner.address), (supply * 90n) / 100n);
    assert.equal(await token.balanceOf(treasury.address), (supply * 10n) / 100n);
    assert.equal(await swap.token(), await token.getAddress());
    assert.equal(
      await swap.isTrustedForwarder(await forwarder.getAddress()),
      true,
    );
  });

  it("deploys every active application contract with the same forwarder", async function () {
    const { owner, forwarder, token, swap } = await deployFixture();
    const trustedForwarder = await forwarder.getAddress();
    const tokenAddress = await token.getAddress();
    const swapAddress = await swap.getAddress();
    const deployments = [
      ["KletiaArcLending", [trustedForwarder, tokenAddress, swapAddress]],
      ["KletiaArcBatchPay", [trustedForwarder, 50]],
      ["KletiaArcVault", [trustedForwarder, 1_000]],
      ["KletiaArcMemoTransfer", [trustedForwarder]],
      ["KletiaArcAgentRegistry", [trustedForwarder]],
      ["KletiaArcStaking", [trustedForwarder, 1_000, 86_400]],
    ];

    for (const [name, args] of deployments) {
      const instance = await ethers.deployContract(contract(name, name), args);
      await instance.waitForDeployment();
      assert.equal(await instance.isTrustedForwarder(trustedForwarder), true);
      if (name !== "KletiaArcLending") {
        assert.equal(await instance.owner(), owner.address);
      }
    }
  });

  it("rejects unsafe constructor parameters and empty value operations", async function () {
    const { forwarder, token, user } = await deployFixture();
    const trustedForwarder = await forwarder.getAddress();

    await assert.rejects(
      ethers.deployContract(contract("KletiaArcSwap", "KletiaArcSwap"), [
        trustedForwarder,
        ethers.ZeroAddress,
      ]),
    );
    await assert.rejects(
      ethers.deployContract(
        contract("KletiaArcBatchPay", "KletiaArcBatchPay"),
        [trustedForwarder, 0],
      ),
    );
    await assert.rejects(
      ethers.deployContract(contract("KletiaArcVault", "KletiaArcVault"), [
        trustedForwarder,
        5_001,
      ]),
    );

    const vault = await ethers.deployContract(
      contract("KletiaArcVault", "KletiaArcVault"),
      [trustedForwarder, 1_000],
    );
    await vault.waitForDeployment();
    await assert.rejects(vault.connect(user).deposit({ value: 0 }));

    assert.notEqual(await token.getAddress(), ethers.ZeroAddress);
  });
});
