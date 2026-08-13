const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const contract = (name) => `contracts/${name}.sol:${name}`;

describe("KletiaArcVaultV2 reserve invariants", function () {
  async function deployVault(apyBps = 1_000n) {
    const [owner, guardian, alice, bob] = await ethers.getSigners();
    const forwarder = await ethers.deployContract(
      contract("KletiaArcForwarder"),
      ["KletiaArcForwarder"],
    );
    await forwarder.waitForDeployment();
    const vault = await ethers.deployContract(contract("KletiaArcVaultV2"), [
      await forwarder.getAddress(),
      owner.address,
      guardian.address,
      apyBps,
    ]);
    await vault.waitForDeployment();
    return { vault, owner, guardian, alice, bob };
  }

  it("never spends another depositor's principal as interest", async function () {
    const { vault, alice, bob } = await deployVault();
    const deposit = ethers.parseEther("10");
    await (await vault.connect(alice).deposit({ value: deposit })).wait();
    await (await vault.connect(bob).deposit({ value: deposit })).wait();
    await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await assert.rejects(
      vault.connect(alice).withdraw(),
      /VaultInsolvent/,
    );

    await (await vault.connect(alice).emergencyWithdraw()).wait();
    assert.equal(await vault.totalDeposited(), deposit);
    assert.equal(
      await ethers.provider.getBalance(await vault.getAddress()),
      deposit,
    );
    assert.equal((await vault.deposits(bob.address))[0], deposit);
  });

  it("pays full principal and accrued interest only when globally solvent", async function () {
    const { vault, owner, alice, bob } = await deployVault();
    const deposit = ethers.parseEther("10");
    await (await vault.connect(alice).deposit({ value: deposit })).wait();
    await (await vault.connect(bob).deposit({ value: deposit })).wait();
    await ethers.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await (
      await vault.connect(owner).fundVault({ value: ethers.parseEther("3") })
    ).wait();
    const requiredBefore = await vault.requiredReserve();
    assert.ok(
      (await ethers.provider.getBalance(await vault.getAddress())) >=
        requiredBefore,
    );

    await (await vault.connect(alice).withdraw()).wait();
    await (await vault.connect(bob).withdraw()).wait();
    assert.equal(await vault.totalDeposited(), 0n);
    assert.equal(await vault.totalInterestLiability(), 0n);
  });

  it("checkpoints the global liability before an APY change", async function () {
    const { vault, owner, alice } = await deployVault(1_000n);
    await (
      await vault.connect(alice).deposit({ value: ethers.parseEther("10") })
    ).wait();
    await ethers.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.connect(owner).setAPY(2_000n)).wait();
    await ethers.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    const interest = await vault.pendingInterest(alice.address);
    const expected = ethers.parseEther("1.495");
    assert.ok(interest >= expected);
    assert.ok(interest < ethers.parseEther("1.501"));
  });

  it("lets the guardian pause new deposits without trapping principal", async function () {
    const { vault, guardian, alice, bob } = await deployVault();
    const deposit = ethers.parseEther("2");
    await (await vault.connect(alice).deposit({ value: deposit })).wait();
    await (await vault.connect(guardian).pause()).wait();

    await assert.rejects(
      vault.connect(bob).deposit({ value: deposit }),
      /EnforcedPause/,
    );
    await (await vault.connect(alice).emergencyWithdraw()).wait();
    assert.equal(await vault.totalDeposited(), 0n);
  });

  it("rejects unsafe deployment and APY parameters", async function () {
    const [owner, guardian] = await ethers.getSigners();
    const forwarder = await ethers.deployContract(
      contract("KletiaArcForwarder"),
      ["KletiaArcForwarder"],
    );
    await forwarder.waitForDeployment();

    await assert.rejects(
      ethers.deployContract(contract("KletiaArcVaultV2"), [
        ethers.ZeroAddress,
        owner.address,
        guardian.address,
        1_000n,
      ]),
      /InvalidAddress/,
    );
    await assert.rejects(
      ethers.deployContract(contract("KletiaArcVaultV2"), [
        await forwarder.getAddress(),
        owner.address,
        guardian.address,
        5_001n,
      ]),
      /APYAboveMaximum/,
    );
  });
});
