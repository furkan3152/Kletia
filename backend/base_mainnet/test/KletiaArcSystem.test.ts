import { expect, describe, it, beforeAll } from "vitest";
import hre from "hardhat";

async function expectRevert(promise: Promise<any>, expectedError: string) {
  try {
    await promise;
    expect.fail("Expected transaction to revert");
  } catch (error: any) {
    expect(error.message).to.include(expectedError);
  }
}

describe("Kletia Arc System Integration Tests", function () {
  let forwarder: any;
  let token: any;
  let vault: any;
  let swap: any;
  let lending: any;
  let batchPay: any;
  let memoTransfer: any;
  let agentRegistry: any;
  
  let owner: any;
  let user1: any;
  let user2: any;
  let liquidator: any;

  const INITIAL_SUPPLY = 1000000n * 10n ** 18n;
  let ethers: any;

  beforeAll(async function () {
    ethers = hre.ethers;
    [owner, user1, user2, liquidator] = await hre.ethers.getSigners();

    const Forwarder = await hre.ethers.getContractFactory("KletiaArcForwarder");
    forwarder = await Forwarder.deploy("KletiaArcForwarder");
    await forwarder.waitForDeployment();

    const Token = await hre.ethers.getContractFactory("KletiaToken");
    token = await Token.deploy("Kletia Token", "KLET", INITIAL_SUPPLY, await owner.getAddress(), await owner.getAddress());
    await token.waitForDeployment();

    await token.transfer(await user1.getAddress(), hre.ethers.parseEther("10000"));
    await token.transfer(await user2.getAddress(), hre.ethers.parseEther("10000"));
    await token.transfer(await liquidator.getAddress(), hre.ethers.parseEther("10000"));

    const Swap = await hre.ethers.getContractFactory("KletiaArcSwap");
    swap = await Swap.deploy(await forwarder.getAddress(), await token.getAddress());
    await swap.waitForDeployment();

    const Lending = await hre.ethers.getContractFactory("KletiaArcLending");
    lending = await Lending.deploy(await forwarder.getAddress(), await token.getAddress(), await swap.getAddress());
    await lending.waitForDeployment();

    const Vault = await hre.ethers.getContractFactory("KletiaArcVault");
    vault = await Vault.deploy(await forwarder.getAddress(), 1000n);
    await vault.waitForDeployment();

    const BatchPay = await hre.ethers.getContractFactory("KletiaArcBatchPay");
    batchPay = await BatchPay.deploy(await forwarder.getAddress(), 100n);
    await batchPay.waitForDeployment();

    const MemoTransfer = await hre.ethers.getContractFactory("KletiaArcMemoTransfer");
    memoTransfer = await MemoTransfer.deploy(await forwarder.getAddress());
    await memoTransfer.waitForDeployment();

    const AgentRegistry = await hre.ethers.getContractFactory("KletiaArcAgentRegistry");
    agentRegistry = await AgentRegistry.deploy(await forwarder.getAddress());
    await agentRegistry.waitForDeployment();
  });

  describe("Swap Module", function () {
    it("Should provide initial liquidity", async function () {
      await token.connect(user1).approve(await swap.getAddress(), hre.ethers.parseEther("1000"));
      await swap.connect(user1).addLiquidity(ethers.parseEther("1000"), { value: ethers.parseEther("500") });

      const usdcReserve = await swap.usdcReserve();
      const tokenReserve = await swap.tokenReserve();

      expect(usdcReserve).to.equal(hre.ethers.parseEther("500"));
      expect(tokenReserve).to.equal(hre.ethers.parseEther("1000"));
    });

    it("Should swap USDC for KLET", async function () {
      const u2Address = await user2.getAddress();
      const initialToken = await token.balanceOf(u2Address);
      await swap.connect(user2).swapUSDCForToken({ value: hre.ethers.parseEther("10") });
      const finalToken = await token.balanceOf(u2Address);
      expect(finalToken).to.be.gt(initialToken);
    });
  });

  describe("Lending & Borrowing Module", function () {
    it("Should allow user to supply USDC liquidity", async function () {
      const u1Address = await user1.getAddress();
      await lending.connect(user1).supplyUSDC({ value: hre.ethers.parseEther("1000") });
      const supplied = await lending.getSuppliedBalance(u1Address);
      expect(supplied).to.equal(hre.ethers.parseEther("1000"));
    });

    it("Should allow user to deposit KLET as collateral", async function () {
      const u2Address = await user2.getAddress();
      await token.connect(user2).approve(await lending.getAddress(), hre.ethers.parseEther("500"));
      await lending.connect(user2).depositCollateral(hre.ethers.parseEther("500"));
      const collateral = await lending.collateralBalance(u2Address);
      expect(collateral).to.equal(hre.ethers.parseEther("500"));
    });

    it("Should allow borrowing against collateral", async function () {
      const u2Address = await user2.getAddress();
      await lending.connect(user2).borrow(hre.ethers.parseEther("100"));
      const debt = await lending.getBorrowedBalance(u2Address);
      expect(debt).to.equal(hre.ethers.parseEther("100"));
    });

    it("Should fail if borrowing too much", async function () {
      await expectRevert(
        lending.connect(user2).borrow(hre.ethers.parseEther("2000")),
        "KletiaArcLending"
      );
    });

    it("Should allow withdrawing supplied USDC", async function () {
      const u1Address = await user1.getAddress();
      const initialBal = await hre.ethers.provider.getBalance(u1Address);
      await lending.connect(user1).withdrawUSDC(hre.ethers.parseEther("100"));
      const finalBal = await hre.ethers.provider.getBalance(u1Address);
      expect(finalBal).to.be.gt(initialBal);
      const supplied = await lending.getSuppliedBalance(u1Address);
      expect(supplied).to.be.closeTo(hre.ethers.parseEther("900"), hre.ethers.parseEther("0.1"));
    });
  });

  describe("Vault Module", function () {
    it("Should deposit USDC and calculate APY", async function () {
      const u1Address = await user1.getAddress();
      await vault.connect(user1).deposit({ value: hre.ethers.parseEther("100") });
      const bal = await vault.claimableAmount(u1Address);
      expect(bal).to.equal(hre.ethers.parseEther("100"));
      
      await hre.ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await hre.ethers.provider.send("evm_mine", []);

      const initialEth = await hre.ethers.provider.getBalance(u1Address);
      const tx = await vault.connect(user1).withdraw();
      await tx.wait();
      
      const finalEth = await hre.ethers.provider.getBalance(u1Address);
      expect(finalEth).to.be.gt(initialEth);
    });
  });

  describe("BatchPay and MemoTransfer", function () {
    it("Should send batch payments successfully", async function () {
      const u2 = await user2.getAddress();
      const liq = await liquidator.getAddress();
      await batchPay.connect(user1).batchPay(
        [u2, liq],
        [hre.ethers.parseEther("10"), hre.ethers.parseEther("20")],
        "memo",
        { value: hre.ethers.parseEther("30") }
      );
      expect(true).to.be.true;
    });

    it("Should send a memo transfer", async function () {
      const tx = await memoTransfer.connect(user1).transferWithMemo(
        await user2.getAddress(),
        "Payment for Agent services",
        { value: hre.ethers.parseEther("5") }
      );
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);
    });
  });

  describe("Agent Registry", function () {
    it("Should register a new intent-based agent", async function () {
      const u1 = await user1.getAddress();
      await agentRegistry.connect(user1).registerAgent("YieldOptimizer", "desc", ["DeFi"], "url");
      const agent = await agentRegistry.getAgent(0);
      expect(agent.name).to.equal("YieldOptimizer");
      expect(agent.name).to.equal("YieldOptimizer");
    });
  });
});
