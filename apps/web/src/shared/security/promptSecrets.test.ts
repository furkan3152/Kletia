import { describe, expect, it } from "vitest";

import { containsSensitivePromptMaterial } from "./promptSecrets";

describe("prompt secret boundary", () => {
  it("rejects private keys, bearer tokens and labeled API secrets", () => {
    expect(
      containsSensitivePromptMaterial(
        `0x${"ab".repeat(32)}`,
      ),
    ).toBe(true);
    expect(
      containsSensitivePromptMaterial("Authorization: Bearer example-token-123"),
    ).toBe(true);
    expect(containsSensitivePromptMaterial("api_key=example-secret-value")).toBe(
      true,
    );
  });

  it("does not block ordinary addresses or intent language", () => {
    expect(
      containsSensitivePromptMaterial(
        "Swap 10 USDC to ETH on Base for 0x1111111111111111111111111111111111111111",
      ),
    ).toBe(false);
  });
});
