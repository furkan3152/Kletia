const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const FACTORY_CONTRACT = "contracts/x402/X402Factory.sol:X402Factory";
const GATEWAY_CONTRACT = "contracts/x402/X402Gateway.sol:X402Gateway";

describe("X402Factory", function () {
  it("creates an owner-bound gateway with the requested asset and price", async function () {
    const [owner, token] = await ethers.getSigners();
    const factory = await ethers.deployContract(FACTORY_CONTRACT);
    await factory.waitForDeployment();

    await (await factory.createGateway(token.address, 8_500n)).wait();

    assert.equal(await factory.allGatewaysLength(), 1n);
    const [gatewayAddress] = await factory.getOwnerGateways(owner.address);
    const gateway = await ethers.getContractAt(
      GATEWAY_CONTRACT,
      gatewayAddress,
    );

    assert.equal(await gateway.owner(), owner.address);
    assert.equal(await gateway.usdc(), token.address);
    assert.equal(await gateway.pricePerCall(), 8_500n);
  });

  it("rejects a zero payment-token address", async function () {
    const factory = await ethers.deployContract(FACTORY_CONTRACT);
    await factory.waitForDeployment();

    await assert.rejects(factory.createGateway(ethers.ZeroAddress, 8_500n));
  });
});
