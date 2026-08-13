import { describe, expect, it, vi } from "vitest";

import type { ParsedIntent } from "../../../ai/parser.js";
import type { IntentV2ExecutionConfig } from "./routerV2.js";
import { executeBaseIntentV2Swap } from "./routerV2Integration.js";

const OWNER = "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E";

const baseIntent = (riskTolerance: ParsedIntent["riskTolerance"]): ParsedIntent => ({
  isComplete: true,
  action: "swap",
  message: "Scanning live Base swap routes.",
  amount: "1",
  tokenIn: "WETH",
  tokenOut: "USDC",
  objective: "best_output",
  riskTolerance,
  slippage: "1",
});

const config = {
  mode: "intent_v2",
  chainId: 8453,
  router: "0xf9BaA05c71c2078A43f6831Eca88220b42932413",
  deployment: {},
} as unknown as IntentV2ExecutionConfig;

describe("Base V2 parser constraint compatibility", () => {
  it("treats the parser's balanced default as no extra execution constraint", async () => {
    const reachedRuntimeValidation = new Error("REACHED_RUNTIME_VALIDATION");
    const validateRuntime = vi.fn().mockRejectedValue(reachedRuntimeValidation);

    await expect(
      executeBaseIntentV2Swap(baseIntent("balanced"), OWNER, config, {
        validateRuntime,
      } as never),
    ).rejects.toBe(reachedRuntimeValidation);
    expect(validateRuntime).toHaveBeenCalledOnce();
  });

  it("keeps explicit non-default risk requests fail-closed", async () => {
    const validateRuntime = vi.fn();

    await expect(
      executeBaseIntentV2Swap(baseIntent("aggressive"), OWNER, config, {
        validateRuntime,
      } as never),
    ).rejects.toMatchObject({
      code: "BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED",
    });
    expect(validateRuntime).not.toHaveBeenCalled();
  });
});
