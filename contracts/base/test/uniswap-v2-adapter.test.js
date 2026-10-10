const { ethers, network } = require("hardhat");
const { assert, deploy, reverted } = require("./helpers");

describe("UniswapV2CompatibleAdapter typed routes", function () {
  let input, output, wrapped, pair, factory, protocol, adapter, call;

  beforeEach(async function () {
    input = await deploy("SettlementTokenMock", "IN");
    output = await deploy("SettlementTokenMock", "OUT");
    wrapped = await deploy("WrappedNativeMock");
    pair = await deploy("SettlementTokenMock", "PAIR");
    factory = await deploy("V2FactoryMock");
    protocol = await deploy("V2RouterMock", factory.target, wrapped.target);
    await factory.setPair(input.target, output.target, pair.target);
    adapter = await deploy("UniswapV2CompatibleAdapter", protocol.target, factory.target, wrapped.target);
    const [recipient] = await ethers.getSigners();
    call = { tokenIn: input.target, tokenOut: output.target, amountIn: 5n, minAmountOut: 3n, recipient: recipient.address, deadline: 123n };
  });

  function route(path) {
    return ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [path]);
  }

  it("builds the reviewed exact-input call with router, spender, recipient, bounds and deadline", async function () {
    const result = await adapter.buildSwapCalldata(call, route([input.target, output.target]));
    assert.equal(result[0], protocol.target);
    assert.equal(result[1], protocol.target);
    const iface = new ethers.Interface(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"]);
    const args = iface.decodeFunctionData("swapExactTokensForTokens", result[2]);
    assert.equal(args[0], call.amountIn);
    assert.equal(args[1], call.minAmountOut);
    assert.deepEqual(Array.from(args[2]), [input.target, output.target]);
    assert.equal(args[3], call.recipient);
    assert.equal(args[4], call.deadline);
  });

  it("rejects incorrect endpoints, zero-address tokens, missing pairs and overlong routes", async function () {
    await reverted(() => adapter.buildSwapCalldata(call, route([output.target, input.target])), "InvalidPathEndpoint");
    await reverted(() => adapter.buildSwapCalldata(call, route([input.target, ethers.ZeroAddress, output.target])), "InvalidPathToken");
    await reverted(() => adapter.buildSwapCalldata(call, route([input.target, wrapped.target, output.target])), "PairUnavailable");
    await reverted(() => adapter.buildSwapCalldata(call, route([input.target, output.target, input.target, output.target, input.target, output.target])), "InvalidPathLength");
  });

  it("rejects target runtime drift after adapter deployment", async function () {
    await network.provider.send("hardhat_setCode", [protocol.target, "0x60006000f3"]);
    await reverted(() => adapter.buildSwapCalldata(call, route([input.target, output.target])), "RuntimeCodeChanged");
  });
});
