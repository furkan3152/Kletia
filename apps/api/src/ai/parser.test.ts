import { describe, expect, it } from "vitest";

import {
  parseDeterministicArcIntent,
  parseDeterministicBaseIntent,
} from "./parser.js";

describe("deterministic Base x402 intent", () => {
  it("binds an explicit HTTPS GET request and human USDC cap", () => {
    const intent = parseDeterministicBaseIntent(
      "Call https://blockrun.ai/api/v1/surf/wallet/detail with x402 on Base using GET and pay at most 0.0085 USDC",
    );

    expect(intent).toMatchObject({
      isComplete: true,
      action: "x402_request",
      url: "https://blockrun.ai/api/v1/surf/wallet/detail",
      method: "GET",
      maxPayment: "0.0085",
      amount: "0",
    });
  });

  it("does not infer a missing payment cap", () => {
    expect(
      parseDeterministicBaseIntent(
        "Call https://example.com/report with x402 on Base using GET",
      ),
    ).toBeNull();
  });

  it("does not choose between conflicting HTTP methods", () => {
    expect(
      parseDeterministicBaseIntent(
        "Call https://example.com/report with x402 using GET or POST and pay at most 0.01 USDC",
      ),
    ).toBeNull();
  });
});

describe("canonical Base widget examples", () => {
  it.each([
    [
      "Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
      {
        action: "yield_compare",
        tokenIn: "USDC",
        amount: "0",
        objective: "best_rate",
      },
    ],
    [
      "Compare USDC borrow rates and available liquidity across Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
      {
        action: "yield_compare",
        tokenIn: "USDC",
        amount: "0",
        objective: "lowest_borrow_cost",
      },
    ],
    [
      "Buy AERO with 10 USDC on Base Mainnet using the most efficient verified route and show the expected output before execution",
      {
        action: "swap",
        tokenIn: "USDC",
        tokenOut: "AERO",
        amount: "10",
      },
    ],
    [
      "Stake 100 WELL in the Moonwell Safety Module on Base Mainnet and show the expected stkWELL output and risks before execution",
      {
        action: "stake",
        tokenIn: "WELL",
        amount: "100",
        protocol: "moonwell-safety-module",
      },
    ],
  ])("parses %s", (prompt, expected) => {
    expect(parseDeterministicBaseIntent(prompt)).toMatchObject({
      isComplete: true,
      ...expected,
    });
  });
});

describe("multilingual intent input with English output", () => {
  it("keeps Turkish Base swap input while returning English route text", () => {
    const intent = parseDeterministicBaseIntent(
      "Base üzerinde 1 USDC ile WETH satın al",
    );
    expect(intent).toMatchObject({
      isComplete: true,
      action: "swap",
      tokenIn: "USDC",
      tokenOut: "WETH",
      amount: "1",
      message: "Scanning live Base swap routes.",
    });
  });

  it("keeps Turkish Arc input isolated to Arc Testnet", () => {
    const intent = parseDeterministicArcIntent(
      "Arc testnette 1 USDC ile KLET satın al",
    );
    expect(intent).toMatchObject({
      isComplete: true,
      action: "swap",
      tokenIn: "USDC",
      tokenOut: "KLET",
      amount: "1",
      message: "Preparing the live Arc Kletia swap route.",
    });
  });
});

describe("canonical Arc widget examples", () => {
  const recipient = "0x1111111111111111111111111111111111111111";

  it.each([
    [
      "Deposit 1 KLET as collateral in Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval",
      "lending_deposit",
      "KLET",
      "1",
    ],
    [
      "Borrow 1 native USDC from Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval",
      "lending_borrow",
      "USDC",
      "1",
    ],
    [
      "Repay 1 native USDC to Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval",
      "lending_repay",
      "USDC",
      "1",
    ],
    [
      "Withdraw 1 KLET collateral from Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval",
      "lending_withdraw",
      "KLET",
      "1",
    ],
  ])("parses %s", (prompt, action, tokenIn, amount) => {
    expect(parseDeterministicArcIntent(prompt)).toMatchObject({
      isComplete: true,
      action,
      tokenIn,
      amount,
    });
  });

  it.each([
    [
      "Swap 1 USDC to EURC on Arc Testnet, use 0.5% slippage and do not accept less than 0.99 EURC",
      "stable_swap",
    ],
    [
      `Bridge 1 USDC from Arc Testnet to Base Sepolia for ${recipient} using SLOW mode`,
      "appkit_bridge",
    ],
    [
      `Pay 0.1 USDC on Arc to ${recipient} with official memo reference KLETIA-DEMO-001`,
      "official_memo_send",
    ],
    [
      `Atomically pay 0.1 native USDC to ${recipient} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`,
      "atomic_payout",
    ],
    [
      `Send 1 EURC on Arc Testnet to ${recipient} through Circle App Kit`,
      "appkit_send",
    ],
    [
      "Show my Arc staking, vault and lending positions using live onchain data",
      "portfolio",
    ],
  ])("routes %s deterministically", (prompt, action) => {
    expect(parseDeterministicArcIntent(prompt)).toMatchObject({
      isComplete: true,
      action,
    });
  });
});

describe("deterministic Base token deployment identity", () => {
  it("keeps the token name separate from natural-language scaffolding", () => {
    const intent = parseDeterministicBaseIntent(
      "Deploy a token named Test Kletia with symbol TKL and supply 1000",
    );

    expect(intent).toMatchObject({
      isComplete: true,
      action: "deploy_token",
      name: "Test Kletia",
      symbol: "TKL",
      amount: "1000",
      message: "Preparing the verified Base token deployment.",
    });
  });
});
