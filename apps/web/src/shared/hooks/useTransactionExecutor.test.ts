import { describe, expect, it } from "vitest";
import {
  assertRequiredAtomicApprovalPath,
  buildAtomicCallBatch,
  resolveWalletExecutionCapabilities,
} from "./useTransactionExecutor";

describe("same-chain atomic wallet execution boundary", () => {
  it("enables atomic calls only for the exact active chain capability", () => {
    const capabilities = {
      "8453": { atomic: { status: "ready" }, paymasterService: { supported: true } },
      "42161": { atomic: { status: "supported" } },
    };
    expect(resolveWalletExecutionCapabilities("base", 8453, capabilities)).toEqual({
      canUseAtomicCalls: true,
      canUsePaymaster: true,
    });
    expect(resolveWalletExecutionCapabilities("arbitrum", 42161, capabilities)).toEqual({
      canUseAtomicCalls: true,
      canUsePaymaster: false,
    });
    expect(resolveWalletExecutionCapabilities("base", 42161, capabilities)).toEqual({
      canUseAtomicCalls: false,
      canUsePaymaster: false,
    });
  });

  it("keeps approvals before the action inside one ordered batch", () => {
    const token = "0x1111111111111111111111111111111111111111" as const;
    const target = "0x2222222222222222222222222222222222222222" as const;
    const calls = buildAtomicCallBatch(
      [{ token, data: "0x1234" }],
      { to: target, data: "0xabcd", value: 7n },
    );
    expect(calls).toEqual([
      { to: token, data: "0x1234", value: 0n },
      { to: target, data: "0xabcd", value: 7n },
    ]);
  });

  it("fails before approval when an atomic-required route lacks capability or simulation", () => {
    expect(() => assertRequiredAtomicApprovalPath(true, 1, false, "capability"))
      .toThrow(/No approvals were sent/u);
    expect(() => assertRequiredAtomicApprovalPath(true, 1, false, "simulation"))
      .toThrow(/Sequential approval fallback was not used/u);
    expect(() => assertRequiredAtomicApprovalPath(false, 1, false, "capability"))
      .not.toThrow();
  });
});
