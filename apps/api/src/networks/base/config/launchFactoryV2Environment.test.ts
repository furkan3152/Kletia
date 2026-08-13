import { describe, expect, it } from "vitest";

import {
  parseBaseLaunchFactoryV2DeploymentEvidence,
} from "./launchFactoryV2Environment.js";

const common = {
  validationStatus: "validated",
  chainId: 8_453,
  observedAtBlock: "50000000",
  factory: "0x90cc932D97966F6Bdd8426184283FF2ff9d3043b",
  factoryCodehash:
    "0xb65a8f83f65961bdb2980f8530c0566013340f7491226c7a27f27efe60338a52",
  treasurySafe: "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC",
  treasurySafeCodehash:
    "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
  pendingTreasury: "0x0000000000000000000000000000000000000000",
  factoryFeeCap: "10000000000000000",
  maxTokenSupply: "1000000000000000000000000000000000000",
  maxNameBytes: "64",
  maxSymbolBytes: "16",
};

describe("Launch Factory V2 governance evidence", () => {
  it("normalizes the historical Timelock schema", () => {
    const evidence = parseBaseLaunchFactoryV2DeploymentEvidence({
      KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON: JSON.stringify({
        ...common,
        schemaVersion: "kletia_launch_factory_v2_deployment_v1",
        ownerTimelock: "0x1B0D1720a9b67Bac0a72E671A69f2772C0BaA47F",
        ownerTimelockCodehash:
          "0x55ecc21176f23ff90b7f884bfd572cecf431538bc89ab5ee5aed3fa59b9dec82",
        ownerTimelockMinDelay: "172800",
      }),
    });
    expect(evidence.ownerAuthorityKind).toBe("timelock");
    expect(evidence.ownerTimelockMinDelay).toBe(172_800n);
  });

  it("accepts only an explicit direct 2-of-2 Safe schema", () => {
    const evidence = parseBaseLaunchFactoryV2DeploymentEvidence({
      KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON: JSON.stringify({
        ...common,
        schemaVersion: "kletia_launch_factory_v2_direct_safe_deployment_v2",
        ownerAuthority: "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D",
        ownerAuthorityCodehash:
          "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
        ownerAuthorityKind: "safe_2_of_2",
      }),
    });
    expect(evidence.ownerAuthorityKind).toBe("safe_2_of_2");
    expect(evidence.ownerTimelockMinDelay).toBeUndefined();
  });

  it("rejects a mislabeled direct authority", () => {
    expect(() =>
      parseBaseLaunchFactoryV2DeploymentEvidence({
        KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON: JSON.stringify({
          ...common,
          schemaVersion: "kletia_launch_factory_v2_direct_safe_deployment_v2",
          ownerAuthority: "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D",
          ownerAuthorityCodehash:
            "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
          ownerAuthorityKind: "timelock",
        }),
      }),
    ).toThrowError();
  });
});
