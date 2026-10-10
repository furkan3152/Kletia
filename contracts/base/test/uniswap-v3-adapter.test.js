const { ethers, network } = require("hardhat");
const { assert, deploy, reverted } = require("./helpers");

describe("UniswapV3SwapRouter02Adapter packed paths", function () {
  let input, output, intermediate, wrapped, pool, factory, protocol, adapter, call;

  beforeEach(async function () {
    input = await deploy("SettlementTokenMock", "IN");
    output = await deploy("SettlementTokenMock", "OUT");
    intermediate = await deploy("SettlementTokenMock", "MID");
    wrapped = await deploy("WrappedNativeMock");
    pool = await deploy("SettlementTokenMock", "POOL");
    factory = await deploy("V3FactoryMock");
    protocol = await deploy("V3RouterMock", factory.target, wrapped.target);
    await factory.setPool(input.target, output.target, 3000, pool.target);
    await factory.setPool(input.target, intermediate.target, 500, pool.target);
    await factory.setPool(intermediate.target, output.target, 3000, pool.target);
    adapter = await deploy("UniswapV3SwapRouter02Adapter", protocol.target, factory.target, wrapped.target);
    const [recipient] = await ethers.getSigners();
    call = { tokenIn: input.target, tokenOut: output.target, amountIn: 5n, minAmountOut: 3n, recipient: recipient.address, deadline: 123n };
  });

  function path(tokens, fees) {
    const types = ["address"];
    const values = [tokens[0]];
    fees.forEach((fee, index) => {
      types.push("uint24", "address");
      values.push(fee, tokens[index + 1]);
    });
    return ethers.solidityPacked(types, values);
  }

  it("encodes exactInput for a reviewed multihop path and preserves amount/recipient constraints", async function () {
    const route = path([input.target, intermediate.target, output.target], [500, 3000]);
    const result = await adapter.buildSwapCalldata(call, route);
    assert.equal(result[0], protocol.target);
    assert.equal(result[1], protocol.target);
    const iface = new ethers.Interface(["function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum))"]);
    const args = iface.decodeFunctionData("exactInput", result[2])[0];
    assert.equal(args.path, route);
    assert.equal(args.recipient, call.recipient);
    assert.equal(args.amountIn, call.amountIn);
    assert.equal(args.amountOutMinimum, call.minAmountOut);
  });

  it("rejects malformed packed lengths, endpoint changes, cycles, zero tokens and invalid fee tiers", async function () {
    const valid = path([input.target, output.target], [3000]);
    await reverted(() => adapter.buildSwapCalldata(call, `${valid}00`), "InvalidPathLength");
    await reverted(() => adapter.buildSwapCalldata(call, path([output.target, input.target], [3000])), "InvalidPathEndpoint");
    await reverted(() => adapter.buildSwapCalldata(call, path([input.target, intermediate.target, input.target, output.target], [500, 500, 3000])), "RepeatedPathToken");
    await reverted(() => adapter.buildSwapCalldata(call, path([input.target, ethers.ZeroAddress, output.target], [500, 3000])), "InvalidPathToken");
    for (const fee of [0, 1_000_000]) {
      await reverted(() => adapter.buildSwapCalldata(call, path([input.target, output.target], [fee])), "InvalidPoolFee");
    }
    await reverted(() => adapter.buildSwapCalldata(call, path([input.target, output.target, input.target, output.target, input.target, output.target], [3000, 3000, 3000, 3000, 3000])), "InvalidPathLength");
  });

  it("requires deployed tokens and an existing contract pool for every hop", async function () {
    const [eoa] = await ethers.getSigners();
    await reverted(() => adapter.buildSwapCalldata(call, path([input.target, output.target], [100])), "PoolUnavailable");
    await factory.setPool(input.target, output.target, 100, eoa.address);
    await reverted(() => adapter.buildSwapCalldata(call, path([input.target, output.target], [100])), "PoolUnavailable");
    await reverted(() => adapter.buildSwapCalldata({ ...call, tokenOut: eoa.address }, path([input.target, eoa.address], [3000])), "ContractCodeRequired");
  });

  it("rejects zero settlement bounds/recipients and constructor introspection mismatches", async function () {
    const route = path([input.target, output.target], [3000]);
    await reverted(() => adapter.buildSwapCalldata({ ...call, minAmountOut: 0n }, route), "InvalidSwapAmount");
    await reverted(() => adapter.buildSwapCalldata({ ...call, recipient: ethers.ZeroAddress }, route), "InvalidSwapRecipient");
    await reverted(() => deploy("UniswapV3SwapRouter02Adapter", protocol.target, input.target, wrapped.target), "RouterFactoryMismatch");
    await reverted(() => deploy("UniswapV3SwapRouter02Adapter", protocol.target, factory.target, input.target), "RouterWrappedNativeMismatch");
    await reverted(() => deploy("UniswapV3SwapRouter02Adapter", input.target, factory.target, wrapped.target), "RouterIntrospectionFailed");
  });

  for (const component of ["protocol", "factory", "wrapped"]) {
    it(`rejects changed ${component} runtime before building calldata`, async function () {
      const contract = { protocol, factory, wrapped }[component];
      await network.provider.send("hardhat_setCode", [contract.target, "0x60006000f3"]);
      await reverted(() => adapter.buildSwapCalldata(call, path([input.target, output.target], [3000])), "RuntimeCodeChanged");
    });
  }
});
