import { getAddress, type Address, type Hex } from "viem";
import { ARC_REVIEWED_V2_RUNTIMES } from "./reviewedRuntimePins.js";

export type ArcDefiProtocol = "swap" | "staking" | "lending";
export interface ArcReviewedDeployment {
  readonly address: Address;
  readonly runtimeCodehash: Hex;
}

export const ARC_LEGACY_DEFI_CONTRACTS = Object.freeze({
  swap: getAddress("0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8"),
  staking: getAddress("0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07"),
  lending: getAddress("0x2748a478Ec0f6D90FfdE89b27721f469126835F7"),
});

/** Unset means withdrawal-only legacy mode; arbitrary operator hashes cannot establish source identity. */
export function configuredArcDefiDeployments(env: Readonly<Record<string, string | undefined>>): Readonly<Record<ArcDefiProtocol, ArcReviewedDeployment | null>> {
  const output = {} as Record<ArcDefiProtocol, ArcReviewedDeployment | null>;
  for (const kind of ["swap", "staking", "lending"] as const) {
    const prefix = `ARC_${kind.toUpperCase()}_V2`;
    const rawAddress = env[`${prefix}_ADDRESS`]?.trim();
    const hash = env[`${prefix}_RUNTIME_CODEHASH`]?.trim().toLowerCase();
    if (!rawAddress && !hash) {
      output[kind] = null;
      continue;
    }
    if (!rawAddress || !hash) throw new Error(`${prefix}_ADDRESS and ${prefix}_RUNTIME_CODEHASH must be configured together.`);
    const address = getAddress(rawAddress);
    if (address === ARC_LEGACY_DEFI_CONTRACTS[kind] || /^0x0{40}$/iu.test(address)) {
      throw new Error(`${prefix}_ADDRESS must be a new nonzero V2 deployment, not the legacy contract.`);
    }
    if (hash !== ARC_REVIEWED_V2_RUNTIMES[kind].runtimeCodehash) {
      throw new Error(`${prefix}_RUNTIME_CODEHASH must match the compiled reviewed V2 source with canonical token and forwarder.`);
    }
    output[kind] = { address, runtimeCodehash: hash as Hex };
  }
  return Object.freeze(output);
}
