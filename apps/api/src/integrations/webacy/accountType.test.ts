import { describe, expect, it } from "vitest";

import { isEip7702DelegationDesignator } from "./accountType.js";

describe("Webacy account type routing", () => {
  it("recognizes an EIP-7702 delegated account", () => {
    expect(
      isEip7702DelegationDesignator(
        "0xef01001234567890123456789012345678901234567890",
      ),
    ).toBe(true);
  });

  it.each([undefined, "0x", "0x6001600055", "0xef01001234"])(
    "does not classify %s as an EIP-7702 designator",
    (bytecode) => {
      expect(isEip7702DelegationDesignator(bytecode)).toBe(false);
    },
  );
});
