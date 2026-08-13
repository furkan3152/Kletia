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
