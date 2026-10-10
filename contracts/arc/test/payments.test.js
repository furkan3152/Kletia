const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const { deploy, mined, reverts, eventFrom, signedRequest } = require("./helpers");

describe("Arc native payments and ERC-2771 forwarding", function () {
  let owner, alice, bob, carol, relayer, forwarder, batch, memo;

  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    [owner, alice, bob, carol, relayer] = await ethers.getSigners();
    forwarder = await deploy("KletiaArcForwarder", "Kletia Arc Test Forwarder");
    batch = await deploy("KletiaArcBatchPay", forwarder.target, 2n);
    memo = await deploy("KletiaArcMemoTransfer", forwarder.target);
  });

  it("distributes the exact batch value and records recipients and sender history", async function () {
    const bobBefore = await ethers.provider.getBalance(bob.address);
    const carolBefore = await ethers.provider.getBalance(carol.address);
    const receipt = await mined(batch.connect(alice).batchPay(
      [bob.address, carol.address], [1000n, 2000n], "October payroll", { value: 3000n },
    ));
    assert.equal(await ethers.provider.getBalance(bob.address), bobBefore + 1000n);
    assert.equal(await ethers.provider.getBalance(carol.address), carolBefore + 2000n);
    assert.equal(await ethers.provider.getBalance(batch.target), 0n);
    assert.equal(await batch.totalBatches(), 1n);
    const record = await batch.getBatch(0);
    assert.equal(record.id, 0n);
    assert.equal(record.sender, alice.address);
    assert.equal(record.totalAmount, 3000n);
    assert.equal(record.recipientCount, 2n);
    assert.equal(record.memo, "October payroll");
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(alice.address)), [0n]);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(bob.address)), []);
    const event = eventFrom(batch, receipt, "BatchPayment");
    assert.equal(event.sender, alice.address);
    assert.equal(event.batchId, 0n);
    assert.equal(event.totalAmount, 3000n);
    await reverts(() => batch.getBatch(1), /batch does not exist/);
  });

  it("rejects batch bounds and mismatched value before transferring anything", async function () {
    const cases = [
      [[], [], "", 0n, /empty recipients/],
      [[bob.address], [], "", 0n, /array length mismatch/],
      [[bob.address, carol.address, owner.address], [1n, 1n, 1n], "", 3n, /exceeds max recipients/],
      [[ethers.ZeroAddress], [1n], "", 1n, /invalid recipient/],
      [[bob.address], [0n], "", 0n, /amount must be > 0/],
      [[bob.address], [1n], "a".repeat(257), 1n, /memo too long/],
      [[bob.address], [1000n], "", 999n, /msg.value does not match/],
      [[bob.address], [1000n], "", 1001n, /msg.value does not match/],
    ];
    const before = await ethers.provider.getBalance(bob.address);
    for (const [recipients, amounts, note, value, reason] of cases) {
      await reverts(() => batch.connect(alice).batchPay(recipients, amounts, note, { value }), reason);
    }
    assert.equal(await ethers.provider.getBalance(bob.address), before);
    assert.equal(await batch.nextBatchId(), 0n);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(alice.address)), []);

    // The byte limit permits a 256-byte memo and an empty batch memo.
    await mined(batch.connect(alice).batchPay([bob.address], [1n], "a".repeat(256), { value: 1n }));
    await mined(batch.connect(alice).batchPay([bob.address], [1n], "", { value: 1n }));
    assert.equal(await batch.totalBatches(), 2n);
  });

  it("rolls back earlier batch recipients if a later recipient rejects payment", async function () {
    const receiver = await deploy("ArcTestReceiver");
    await mined(receiver.setRejectPayment(true));
    const before = await ethers.provider.getBalance(bob.address);
    await reverts(
      () => batch.connect(alice).batchPay([bob.address, receiver.target], [1000n, 1000n], "atomic", { value: 2000n }),
      /Native USDC transfer failed/,
    );
    assert.equal(await ethers.provider.getBalance(bob.address), before);
    assert.equal(await ethers.provider.getBalance(receiver.target), 0n);
    assert.equal(await ethers.provider.getBalance(batch.target), 0n);
    assert.equal(await batch.nextBatchId(), 0n);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(alice.address)), []);
  });

  it("rejects a nested batch payment without preventing the outer payment", async function () {
    const receiver = await deploy("ArcTestReceiver");
    await mined(receiver.setReentry(
      batch.target, batch.interface.encodeFunctionData("batchPay", [[bob.address], [1n], "nested"]), 1n,
    ));
    const before = await ethers.provider.getBalance(bob.address);
    await mined(batch.connect(alice).batchPay([receiver.target], [1000n], "outer", { value: 1000n }));
    assert.equal(await receiver.reentryAttempted(), true);
    assert.equal(await receiver.reentrySucceeded(), false);
    assert.equal(await ethers.provider.getBalance(receiver.target), 1000n);
    assert.equal(await ethers.provider.getBalance(bob.address), before);
    assert.equal(await batch.totalBatches(), 1n);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(receiver.target)), []);
  });

  it("records memo payments in both histories and uses sequential IDs", async function () {
    const before = await ethers.provider.getBalance(bob.address);
    const receipt = await mined(memo.connect(alice).transferWithMemo(bob.address, "invoice 42", { value: 1000n }));
    await mined(memo.connect(carol).transferWithMemo(bob.address, "invoice 43", { value: 2000n }));
    assert.equal(await ethers.provider.getBalance(bob.address), before + 3000n);
    assert.equal(await ethers.provider.getBalance(memo.target), 0n);
    const record = await memo.getTransfer(0);
    assert.equal(record.id, 0n);
    assert.equal(record.from, alice.address);
    assert.equal(record.to, bob.address);
    assert.equal(record.amount, 1000n);
    assert.equal(await memo.getMemo(0), "invoice 42");
    assert.deepEqual(Array.from(await memo.getSentTransferIds(alice.address)), [0n]);
    assert.deepEqual(Array.from(await memo.getReceivedTransferIds(bob.address)), [0n, 1n]);
    assert.equal(await memo.sentTransferCount(alice.address), 1n);
    assert.equal(await memo.receivedTransferCount(bob.address), 2n);
    assert.equal(await memo.totalTransfers(), 2n);
    const event = eventFrom(memo, receipt, "MemoTransfer");
    assert.equal(event.from, alice.address);
    assert.equal(event.to, bob.address);
    assert.equal(event.transferId, 0n);
    await reverts(() => memo.getTransfer(2), /transfer does not exist/);
    await reverts(() => memo.getMemo(2), /transfer does not exist/);
  });

  it("enforces memo recipient, amount, and UTF-8 byte limits", async function () {
    const cases = [
      [ethers.ZeroAddress, "note", 1n, /invalid recipient/],
      [alice.address, "note", 1n, /cannot transfer to self/],
      [bob.address, "note", 0n, /amount must be > 0/],
      [bob.address, "", 1n, /memo cannot be empty/],
      [bob.address, "é".repeat(129), 1n, /memo too long/],
    ];
    for (const [recipient, note, value, reason] of cases) {
      await reverts(() => memo.connect(alice).transferWithMemo(recipient, note, { value }), reason);
    }
    assert.equal(await memo.nextTransferId(), 0n);
    await mined(memo.connect(alice).transferWithMemo(bob.address, "é".repeat(128), { value: 1n }));
    assert.equal(await memo.totalTransfers(), 1n);
  });

  it("restores memo IDs and histories on failure and blocks recipient reentrancy", async function () {
    const receiver = await deploy("ArcTestReceiver");
    await mined(receiver.setRejectPayment(true));
    await reverts(
      () => memo.connect(alice).transferWithMemo(receiver.target, "failed", { value: 1000n }),
      /Native USDC transfer failed/,
    );
    assert.equal(await memo.nextTransferId(), 0n);
    assert.deepEqual(Array.from(await memo.getSentTransferIds(alice.address)), []);
    assert.deepEqual(Array.from(await memo.getReceivedTransferIds(receiver.target)), []);
    assert.equal(await ethers.provider.getBalance(memo.target), 0n);

    await mined(receiver.setRejectPayment(false));
    await mined(receiver.setReentry(
      memo.target, memo.interface.encodeFunctionData("transferWithMemo", [bob.address, "nested"]), 1n,
    ));
    await mined(memo.connect(alice).transferWithMemo(receiver.target, "outer", { value: 1000n }));
    assert.equal(await receiver.reentryAttempted(), true);
    assert.equal(await receiver.reentrySucceeded(), false);
    assert.equal(await ethers.provider.getBalance(receiver.target), 1000n);
    assert.equal(await memo.totalTransfers(), 1n);
    assert.deepEqual(Array.from(await memo.getSentTransferIds(receiver.target)), []);
    assert.equal((await memo.getTransfer(0)).memo, "outer");
  });

  it("attributes forwarded payments to the signer and rejects replay", async function () {
    const batchRequest = await signedRequest(
      forwarder, alice, batch, batch.interface.encodeFunctionData("batchPay", [[bob.address], [1000n], "sponsored"]), 1000n,
    );
    assert.equal(await forwarder.verify(batchRequest), true);
    await mined(forwarder.connect(relayer).execute(batchRequest, { value: 1000n }));
    assert.equal((await batch.getBatch(0)).sender, alice.address);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(alice.address)), [0n]);
    assert.deepEqual(Array.from(await batch.getBatchIdsBySender(relayer.address)), []);
    assert.equal(await forwarder.verify(batchRequest), false);
    await reverts(() => forwarder.connect(relayer).execute(batchRequest, { value: 1000n }), /ERC2771ForwarderInvalidSigner/);
    assert.equal(await batch.totalBatches(), 1n);

    const memoRequest = await signedRequest(
      forwarder, alice, memo, memo.interface.encodeFunctionData("transferWithMemo", [bob.address, "sponsored memo"]), 2000n,
    );
    const before = await ethers.provider.getBalance(bob.address);
    const receipt = await mined(forwarder.connect(relayer).execute(memoRequest, { value: 2000n }));
    assert.equal(eventFrom(memo, receipt, "MemoTransfer").from, alice.address);
    assert.equal((await memo.getTransfer(0)).from, alice.address);
    assert.equal(await ethers.provider.getBalance(bob.address), before + 2000n);
    assert.deepEqual(Array.from(await memo.getSentTransferIds(alice.address)), [0n]);
    assert.deepEqual(Array.from(await memo.getSentTransferIds(forwarder.target)), []);
    assert.equal(await forwarder.nonces(alice.address), 2n);
  });

  it("uses the forwarded signer for the self-transfer guard and rolls back a failed request nonce", async function () {
    const request = await signedRequest(
      forwarder, alice, memo, memo.interface.encodeFunctionData("transferWithMemo", [alice.address, "self"]), 1000n,
    );
    await reverts(() => forwarder.connect(relayer).execute(request, { value: 1000n }), /FailedCall/);
    assert.equal(await forwarder.nonces(alice.address), 0n);
    assert.equal(await memo.totalTransfers(), 0n);
    assert.equal(await ethers.provider.getBalance(forwarder.target), 0n);
  });

  it("rejects expired or tampered signatures before making payments", async function () {
    const latest = await ethers.provider.getBlock("latest");
    const expired = await signedRequest(
      forwarder, alice, memo, memo.interface.encodeFunctionData("transferWithMemo", [bob.address, "expired"]), 1000n,
      { deadline: latest.timestamp - 1 },
    );
    assert.equal(await forwarder.verify(expired), false);
    await reverts(() => forwarder.connect(relayer).execute(expired, { value: 1000n }), /ERC2771ForwarderExpiredRequest/);
    const valid = await signedRequest(
      forwarder, alice, memo, memo.interface.encodeFunctionData("transferWithMemo", [bob.address, "original"]), 1000n,
    );
    const tampered = { ...valid, data: memo.interface.encodeFunctionData("transferWithMemo", [carol.address, "altered"]) };
    assert.equal(await forwarder.verify(tampered), false);
    await reverts(() => forwarder.connect(relayer).execute(tampered, { value: 1000n }), /ERC2771ForwarderInvalidSigner/);
    assert.equal(await forwarder.nonces(alice.address), 0n);
    assert.equal(await memo.totalTransfers(), 0n);
  });

  it("honors signed owner calls and prevents untrusted calldata suffix spoofing", async function () {
    await reverts(() => batch.connect(alice).setMaxRecipients(10), /caller is not the owner/);
    await reverts(() => batch.setMaxRecipients(0), /max must be > 0/);
    await reverts(() => memo.connect(alice).transferOwnership(bob.address), /caller is not the owner/);
    await reverts(() => memo.transferOwnership(ethers.ZeroAddress), /invalid new owner/);

    const spoofedData = ethers.concat([
      batch.interface.encodeFunctionData("setMaxRecipients", [10]), owner.address,
    ]);
    await reverts(() => alice.sendTransaction({ to: batch.target, data: spoofedData }), /caller is not the owner/);
    const request = await signedRequest(
      forwarder, owner, batch, batch.interface.encodeFunctionData("setMaxRecipients", [10]),
    );
    await mined(forwarder.connect(relayer).execute(request));
    assert.equal(await batch.maxRecipientsPerBatch(), 10n);

    const transfer = await signedRequest(
      forwarder, owner, memo, memo.interface.encodeFunctionData("transferOwnership", [alice.address]),
    );
    await mined(forwarder.connect(relayer).execute(transfer));
    assert.equal(await memo.owner(), alice.address);
    await reverts(() => memo.transferOwnership(bob.address), /caller is not the owner/);
    await mined(memo.connect(alice).transferOwnership(bob.address));
    assert.equal(await memo.owner(), bob.address);
  });
});
