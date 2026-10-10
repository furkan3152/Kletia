const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

async function deploy(name, ...args) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function mined(transaction) {
  return (await transaction).wait();
}

async function reverts(transaction, reason) {
  await assert.rejects(async () => mined(transaction()), reason);
}

async function timestampOf(receipt) {
  return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
}

async function nextTimestamp(timestamp) {
  await network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
}

function eventFrom(contract, receipt, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    const event = contract.interface.parseLog(log);
    if (event?.name === name) return event.args;
  }
  assert.fail(`Missing ${name} event`);
}

async function signedRequest(forwarder, signer, target, data, value = 0n, overrides = {}) {
  const block = await ethers.provider.getBlock("latest");
  const request = {
    from: signer.address,
    to: target.target,
    value,
    gas: 1_000_000n,
    nonce: await forwarder.nonces(signer.address),
    deadline: block.timestamp + 3600,
    data,
    ...overrides,
  };
  const signature = await signer.signTypedData(
    {
      name: "Kletia Arc Test Forwarder",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: forwarder.target,
    },
    {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    },
    request,
  );
  const { nonce, ...executeRequest } = request;
  return { ...executeRequest, signature };
}

module.exports = {
  deploy,
  mined,
  reverts,
  timestampOf,
  nextTimestamp,
  eventFrom,
  signedRequest,
};
