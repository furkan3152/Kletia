const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("KletiaArcMemoTransfer", function () {
  it("records and forwards an Arc-native payment with its memo", async function () {
    const [sender, recipient] = await ethers.getSigners();
    const transfer = await ethers.deployContract("KletiaArcMemoTransfer", [
      ethers.ZeroAddress,
    ]);
    await transfer.waitForDeployment();

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    await (
      await transfer.transferWithMemo(recipient.address, "invoice-42", {
        value: 1_000_000_000_000_000_000n,
      })
    ).wait();
    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    const record = await transfer.getTransfer(0n);

    assert.equal(recipientAfter - recipientBefore, 1_000_000_000_000_000_000n);
    assert.equal(record.from, sender.address);
    assert.equal(record.to, recipient.address);
    assert.equal(record.amount, 1_000_000_000_000_000_000n);
    assert.equal(record.memo, "invoice-42");
    assert.equal(await transfer.totalTransfers(), 1n);
  });

  it("rejects a self-transfer", async function () {
    const [sender] = await ethers.getSigners();
    const transfer = await ethers.deployContract("KletiaArcMemoTransfer", [
      ethers.ZeroAddress,
    ]);
    await transfer.waitForDeployment();

    await assert.rejects(
      transfer.transferWithMemo(sender.address, "invalid", { value: 1n }),
    );
  });
});
