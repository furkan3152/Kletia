import { Networks, StrKey } from "@stellar/stellar-sdk";
import { poseidon8 } from "poseidon-lite";

import {
  canonicalJsonV4,
  randomBytes32HexV4,
  randomScalarV4,
  scalarHexV4,
  sha256V4,
} from "./canonical";
import {
  assetLeafV4,
  buildPolicyMerkleTreeV4,
  pathForPolicyLeafV4,
  protocolLeafV4,
  recipientLeafV4,
} from "./policyMerkle";
import type {
  LocalPolicyWitnessV4,
  PolicyOptionsV4,
  PolicyProfileCoreV4,
  PolicyProfileV4,
  SelectedPolicyWitnessV4,
} from "./types";

const UINT64_LIMIT = 2n ** 64n;

function parseAtomic(value: string, field: string): bigint {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be an unsigned atomic amount.`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= UINT64_LIMIT) {
    throw new Error(`${field} exceeds the reviewed Policy V2 64-bit range.`);
  }
  return parsed;
}

function canonicalSets(values: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const sets = values.map((set) => [...set].map((entry) => entry.toLowerCase()).sort());
  return sets.sort((left, right) => left.join("\u001f").localeCompare(right.join("\u001f")));
}

export function policyProfileSigningMessageV4(core: PolicyProfileCoreV4): string {
  if (core.owner.family !== "stellar") throw new Error("A Stellar policy owner is required.");
  return [
    "KLETIA_POLICY_PROFILE_V1",
    core.owner.network === "testnet" ? "stellar:testnet" : "stellar:public",
    sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", core),
    canonicalJsonV4(core),
  ].join("\n");
}

export function createUnsignedPolicyProfileV4(input: {
  readonly options: PolicyOptionsV4;
  readonly stellarAddress: string;
  readonly minimumAmountAtomic: string;
  readonly maximumAmountAtomic: string;
  readonly executionExpiresAtLedger: number;
  readonly risk: PolicyProfileCoreV4["risk"];
  readonly validityMs?: number;
}): { readonly core: PolicyProfileCoreV4; readonly localWitness: LocalPolicyWitnessV4 } {
  const minimumAmount = parseAtomic(input.minimumAmountAtomic, "Minimum amount");
  const maximumAmount = parseAtomic(input.maximumAmountAtomic, "Maximum amount");
  if (minimumAmount > maximumAmount) throw new Error("The minimum amount cannot exceed the maximum amount.");
  if (!Number.isSafeInteger(input.executionExpiresAtLedger) || input.executionExpiresAtLedger <= 0) {
    throw new Error("A live positive Stellar ledger expiry is required.");
  }
  const expectedNetwork = input.options.lane === "testnet" ? "testnet" : "public";
  if (!StrKey.isValidEd25519PublicKey(input.stellarAddress)) {
    throw new Error("Connect a valid Stellar G-account before authorizing the policy.");
  }
  const protocolSets = canonicalSets(input.options.allowedRouteProtocolSets);
  const assetSets = canonicalSets(input.options.allowedRouteAssetSets);
  const protocolTree = buildPolicyMerkleTreeV4(
    "protocol",
    protocolSets.map(protocolLeafV4),
  );
  const assetTree = buildPolicyMerkleTreeV4("asset", assetSets.map(assetLeafV4));
  const recipientTree = buildPolicyMerkleTreeV4(
    "recipient",
    input.options.recipientMaterials.map(recipientLeafV4),
  );
  const policySalt = randomScalarV4();
  const ownerSecret = randomScalarV4();
  const environmentLane = input.options.lane === "production" ? 0n : 1n;
  const policyRoot = poseidon8([
    minimumAmount,
    maximumAmount,
    environmentLane,
    BigInt(input.executionExpiresAtLedger),
    protocolTree.root,
    assetTree.root,
    recipientTree.root,
    policySalt,
  ]);
  const now = Date.now();
  const validityMs = input.validityMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(validityMs) || validityMs <= 0 || validityMs > 30 * 24 * 60 * 60_000) {
    throw new Error("Policy validity must be between one millisecond and thirty days.");
  }
  const nonce = randomBytes32HexV4();
  const core: PolicyProfileCoreV4 = {
    schemaVersion: "kletia_policy_profile_core_v1",
    policyId: `policy_${nonce.slice(2, 18)}`,
    owner: { family: "stellar", network: expectedNetwork, address: input.stellarAddress },
    lane: input.options.lane,
    allowedChains: [...input.options.allowedChains].map((entry) => entry.toLowerCase()).sort(),
    allowedProtocols: [...input.options.allowedProtocols].map((entry) => entry.toLowerCase()).sort(),
    allowedAssets: [...input.options.allowedAssets].map((entry) => entry.toLowerCase()).sort(),
    allowedRouteProtocolSets: protocolSets,
    allowedRouteAssetSets: assetSets,
    policyCircuit: "kletia_policy_v2",
    verifierVersion: 2,
    publicInputCount: 12,
    policyRoot: scalarHexV4(policyRoot),
    protocolRegistryRoot: scalarHexV4(protocolTree.root),
    assetRegistryRoot: scalarHexV4(assetTree.root),
    recipientPolicyRoot: scalarHexV4(recipientTree.root),
    privacyBudgetCommitment: input.options.privacyBudgetCommitment,
    risk: input.risk,
    executionExpiresAtLedger: input.executionExpiresAtLedger,
    validFrom: now - 1_000,
    expiresAt: now + validityMs,
    nonce,
    requireStellarControlPlane: true,
    perFinancialStepWalletApproval: true,
    solverMayCustodyUserFunds: false,
  };
  return {
    core,
    localWitness: {
      schemaVersion: "kletia_local_policy_witness_v2",
      minimumAmountAtomic: minimumAmount.toString(),
      maximumAmountAtomic: maximumAmount.toString(),
      policySalt: policySalt.toString(),
      ownerSecret: ownerSecret.toString(),
      protocolTree,
      assetTree,
      recipientTree,
    },
  };
}

export async function signPolicyProfileV4(
  core: PolicyProfileCoreV4,
  stellarAddress: string,
): Promise<PolicyProfileV4> {
  if (core.owner.family !== "stellar" || core.owner.address !== stellarAddress) {
    throw new Error("The active Stellar account no longer matches the policy owner.");
  }
  const { signMessage } = await import("@stellar/freighter-api");
  const signed = await signMessage(policyProfileSigningMessageV4(core), {
    networkPassphrase: core.lane === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
    address: stellarAddress,
  });
  if (signed.error || !signed.signedMessage) {
    throw new Error(signed.error?.message || "Freighter rejected the policy profile signature.");
  }
  if (signed.signerAddress !== stellarAddress) {
    throw new Error("The Freighter signer changed while authorizing the policy profile.");
  }
  const signature = typeof signed.signedMessage === "string"
    ? signed.signedMessage
    : btoa(String.fromCharCode(...signed.signedMessage));
  return {
    schemaVersion: "kletia_policy_profile_v1",
    core,
    profileHash: sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", core),
    authorization: {
      scheme: "stellar_sep53",
      signer: core.owner,
      signature,
    },
  };
}

export function selectLocalPolicyWitnessV4(input: {
  readonly witness: LocalPolicyWitnessV4;
  readonly protocolSet: readonly string[];
  readonly assetSet: readonly string[];
  readonly recipientMaterial: PolicyOptionsV4["recipientMaterials"][number];
}): SelectedPolicyWitnessV4 {
  return {
    schemaVersion: "kletia_selected_policy_witness_v2",
    minimumAmountAtomic: input.witness.minimumAmountAtomic,
    maximumAmountAtomic: input.witness.maximumAmountAtomic,
    policySalt: input.witness.policySalt,
    ownerSecret: input.witness.ownerSecret,
    protocol: pathForPolicyLeafV4(input.witness.protocolTree, protocolLeafV4(input.protocolSet)),
    asset: pathForPolicyLeafV4(input.witness.assetTree, assetLeafV4(input.assetSet)),
    recipient: pathForPolicyLeafV4(input.witness.recipientTree, recipientLeafV4(input.recipientMaterial)),
  };
}
