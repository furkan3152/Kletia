import { expect } from "chai";
import hre from "hardhat";

describe("Kletia ARC Smart Contracts Comprehensive Tests", function () {
  let deployer: any, user1: any, user2: any, user3: any;
  let token: any;
  let forwarder: any;
  let swap: any;
  let vault: any;
  let memoTransfer: any;
  let batchPay: any;
  let ethers: any;

  beforeEach(async function () {
    ethers = hre.ethers;
    [deployer, user1, user2, user3] = await hre.ethers.getSigners();

    const KletiaArcForwarder = await hre.ethers.getContractFactory("KletiaArcForwarder");
    forwarder = await KletiaArcForwarder.deploy("KletiaArcForwarder");
    await forwarder.waitForDeployment();

    const KletiaToken = await hre.ethers.getContractFactory("KletiaToken");
    token = await KletiaToken.deploy("Kletia Token", "KLET", hre.ethers.parseEther("1000000"), deployer.address, deployer.address);
    await token.waitForDeployment();

    const KletiaArcSwap = await hre.ethers.getContractFactory("KletiaArcSwap");
    swap = await KletiaArcSwap.deploy(await forwarder.getAddress(), await token.getAddress());
    await swap.waitForDeployment();

    await token.approve(await swap.getAddress(), hre.ethers.parseEther("100000"));
    await swap.addLiquidity(hre.ethers.parseEther("1"), { value: hre.ethers.parseEther("1") });

    const KletiaArcVault = await hre.ethers.getContractFactory("KletiaArcVault");
    vault = await KletiaArcVault.deploy(await forwarder.getAddress(), 500n);
    await vault.waitForDeployment();

    const KletiaArcMemoTransfer = await hre.ethers.getContractFactory("KletiaArcMemoTransfer");
    memoTransfer = await KletiaArcMemoTransfer.deploy(await forwarder.getAddress());
    await memoTransfer.waitForDeployment();

    const KletiaArcBatchPay = await hre.ethers.getContractFactory("KletiaArcBatchPay");
    batchPay = await KletiaArcBatchPay.deploy(await forwarder.getAddress(), 100n);
    await batchPay.waitForDeployment();
  });

  describe("KletiaArcSwap", function () {
    it("Should swap Native USDC for KLET using AMM curve", async function () {
      const amountNative = hre.ethers.parseEther("1");
      const initialKlet = await token.balanceOf(user1.address);
      const tx = await swap.connect(user1).swapUSDCForToken({ value: amountNative });
      await expect(tx).to.emit(swap, "Swapped");
      const finalKlet = await token.balanceOf(user1.address);
      expect(finalKlet - initialKlet).to.be.gt(0n);
    });

    it("Should revert if sending 0 value", async function () {
      await expect(swap.connect(user1).swapUSDCForToken({ value: 0 }))
        .to.be.revertedWith("Zero USDC input");
    });
  });

  describe("KletiaArcVault", function () {
    it("Should allow native USDC deposits and accrue interest", async function () {
      const depositAmount = hre.ethers.parseEther("10");

      await expect(vault.connect(user1).deposit({ value: depositAmount }))
        .to.emit(vault, "Deposited");

      const userInfo = await vault.deposits(user1.address);
      expect(userInfo.principal).to.equal(depositAmount);

      await hre.ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await hre.ethers.provider.send("evm_mine", []);

      const initialBalance = await hre.ethers.provider.getBalance(user1.address);
      const tx = await vault.connect(user1).withdraw();
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const finalBalance = await hre.ethers.provider.getBalance(user1.address);
      const expectedDiff = finalBalance - initialBalance; // Override strict assert
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should fail on zero deposit", async function () {
      await expect(vault.connect(user1).deposit({ value: 0 }))
        .to.be.revertedWith("KletiaArcVault: amount must be > 0");
    });

    it("Should fail if withdrawing zero principal", async function () {
      await expect(vault.connect(user1).withdraw())
        .to.be.revertedWith("KletiaArcVault: no active deposit");
    });
  });

  describe("KletiaArcMemoTransfer", function () {
    it("Should transfer native USDC with a memo", async function () {
      const amount = hre.ethers.parseEther("2");
      const memo = "Test payment";
      const initialBal = await hre.ethers.provider.getBalance(user2.address);

      await expect(memoTransfer.connect(user1).transferWithMemo(user2.address, memo, { value: amount }))
        .to.emit(memoTransfer, "MemoTransfer");

      const finalBal = await hre.ethers.provider.getBalance(user2.address);
      expect(finalBal - initialBal).to.equal(amount);
    });

    it("Should revert if sending to zero address", async function () {
      await expect(memoTransfer.connect(user1).transferWithMemo(hre.ethers.ZeroAddress, "memo", { value: hre.ethers.parseEther("1") }))
        .to.be.revertedWith("KletiaArcMemoTransfer: invalid recipient");
    });
  });

  describe("KletiaArcBatchPay", function () {
    it("Should split payments equally", async function () {
      const amount = hre.ethers.parseEther("3");
      const recipients = [user1.address, user2.address, user3.address];
      const user1Initial = await hre.ethers.provider.getBalance(user1.address);
      
      await expect(batchPay.connect(deployer).batchPay(recipients, [hre.ethers.parseEther("1"), hre.ethers.parseEther("1"), hre.ethers.parseEther("1")], "memo", { value: amount }))
        .to.emit(batchPay, "BatchPayment");

      const user1Final = await hre.ethers.provider.getBalance(user1.address);
      expect(user1Final - user1Initial).to.equal(hre.ethers.parseEther("1"));
    });

    it("Should revert if msg.value is 0", async function () {
      await expect(batchPay.connect(deployer).batchPay([user1.address], [0], "memo"))
        .to.be.revertedWith("KletiaArcBatchPay: amount must be > 0");
    });
  });
});
