import { describe, expect, it } from "vitest";

import {
  BASE_X402_ATTESTATION_GUARDIAN_ADDRESS,
  BASE_X402_ATTESTATION_OWNER_ADDRESS,
  BASE_X402_ATTESTATION_REGISTRY_ADDRESS,
  resolveBaseX402AttestationRegistryConfig,
} from "./x402AttestationRegistry.js";

describe("Base x402 attestation deployment binding", () => {
  it("uses the exact public production tuple when env mirrors are absent", () => {
    expect(resolveBaseX402AttestationRegistryConfig({})).toEqual({
      registry: BASE_X402_ATTESTATION_REGISTRY_ADDRESS,
      expectedOwner: BASE_X402_ATTESTATION_OWNER_ADDRESS,
      expectedGuardian: BASE_X402_ATTESTATION_GUARDIAN_ADDRESS,
    });
  });

  it("rejects malformed environment overrides instead of falling back", () => {
    expect(() =>
      resolveBaseX402AttestationRegistryConfig({
        KLETIA_X402_ATTESTATION_REGISTRY_ADDRESS: "not-an-address",
      }),
    ).toThrowError(/unavailable/i);
  });
});
