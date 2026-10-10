const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function deploy(name, ...args) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function reverted(action, errorName) {
  await assert.rejects(action, (error) => {
    assert.match(error.message, new RegExp(errorName));
    return true;
  });
}

module.exports = { assert, deploy, reverted };
