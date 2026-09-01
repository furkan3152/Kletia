import { createHash } from "node:crypto";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { WorkflowPlanV4 } from "./types.js";
import { scalarFromMaterialV4 } from "./canonical.js";
import { deriveRouteBoundWorkflowRootV3 } from "../v3/compiler.js";
import { recipientPolicyMaterialV4, routeAssetSetV4, routeProtocolSetV4 } from "./compiler.js";
import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { readStellarControlPlaneV2Readiness } from "../../networks/stellar/controlPlaneV2Readiness.js";

const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);
const PROOF_HEX_PATTERN = /^0x[a-f\d]{512}$/iu;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function scalar(value: unknown, field: string): `0x${string}` {
  const encoded = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f\d]{64}$/u.test(encoded)) {
    throw controlled("WORKFLOW_V4_POLICY_SCALAR_INVALID", `${field} must be an exact 32-byte BN254 scalar.`, 400);
  }
  const parsed = BigInt(encoded);
  if (parsed <= 0n || parsed >= BN254_SCALAR_FIELD_MODULUS) {
    throw controlled("WORKFLOW_V4_POLICY_SCALAR_INVALID", `${field} is outside the canonical BN254 scalar field.`, 400);
  }
  return encoded as `0x${string}`;
}

function publicInputsHash(inputs: readonly `0x${string}`[]): `0x${string}` {
  const digest = createHash("sha256");
  inputs.forEach((input) => digest.update(Buffer.from(input.slice(2), "hex")));
  return `0x${digest.digest("hex")}`;
}

function proofSha256(proof: `0x${string}`): `0x${string}` {
  return `0x${createHash("sha256")
    .update("KLETIA_POLICY_PROOF_V2", "utf8")
    .update("\u001f", "utf8")
    .update(Buffer.from(proof.slice(2), "hex"))
    .digest("hex")}`;
}

export function selectedPolicyLeavesV4(plan: WorkflowPlanV4, routeId: string) {
  const route = plan.routes.find((candidate) => candidate.id === routeId);
  if (!route || routeId !== plan.selectedRouteId) {
    throw controlled("WORKFLOW_V4_POLICY_ROUTE_MISMATCH", "The policy proof route is not the selected canonical route.");
  }
  return Object.freeze({
    selectedProtocolLeaf: scalarFromMaterialV4("KLETIA_POLICY_PROTOCOL_LEAF_V2", {
      protocols: routeProtocolSetV4(route),
    }),
    selectedAssetLeaf: scalarFromMaterialV4("KLETIA_POLICY_ASSET_LEAF_V2", routeAssetSetV4(plan.intent.legs, route)),
    selectedRecipientLeaf: scalarFromMaterialV4(
      "KLETIA_POLICY_RECIPIENT_LEAF_V2",
      recipientPolicyMaterialV4(plan.compatibility.plan),
    ),
  });
}

export interface PolicyProofEnvelopeV4 {
  readonly schemaVersion: "kletia_policy_proof_envelope_v2";
  readonly routeId: string;
  readonly workflowRoot: `0x${string}`;
  readonly policyRoot: `0x${string}`;
  readonly protocolRegistryRoot: `0x${string}`;
  readonly assetRegistryRoot: `0x${string}`;
  readonly recipientPolicyRoot: `0x${string}`;
  readonly selectedProtocolLeaf: `0x${string}`;
  readonly selectedAssetLeaf: `0x${string}`;
  readonly selectedRecipientLeaf: `0x${string}`;
  readonly environmentLane: 0 | 1;
  readonly executionExpiresAtLedger: number;
  readonly nullifier: `0x${string}`;
  readonly executionContextCommitment: `0x${string}`;
  readonly verifierVersion: 2;
  readonly proof: `0x${string}`;
}

export interface PolicyProofVerifierV4 {
  readonly verify: (input: {
    readonly plan: WorkflowPlanV4;
    readonly publicInputs: readonly `0x${string}`[];
    readonly proof: Uint8Array;
    readonly verifierVersion: 2;
  }) => Promise<{ readonly accepted: boolean; readonly observedAtLedger: string }>;
}

export const stellarPolicyProofVerifierV4: PolicyProofVerifierV4 = {
  verify: async ({ publicInputs, proof, verifierVersion }) => {
    const readiness = await readStellarControlPlaneV2Readiness();
    if (!readiness.ready) {
      throw controlled(
        "WORKFLOW_V4_POLICY_V2_RUNTIME_UNAVAILABLE",
        "The exact Policy V2 verifier, registry and Intent Control Plane V2 deployment are not live-attested.",
        503,
      );
    }
    const registry = readiness.configuration.registry;
    const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
    const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 15_000 });
    const account = await server.getAccount(source);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    }).addOperation(new Contract(registry).call(
      "verify",
      nativeToScVal(verifierVersion, { type: "u32" }),
      xdr.ScVal.scvVec(publicInputs.map((entry) =>
        xdr.ScVal.scvBytes(Buffer.from(entry.slice(2), "hex")))),
      xdr.ScVal.scvBytes(proof),
    )).setTimeout(60).build();
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation) || !simulation.result) {
      throw controlled("WORKFLOW_V4_POLICY_PROOF_SIMULATION_FAILED", "Policy V2 verification did not pass exact Stellar simulation.");
    }
    return {
      accepted: scValToNative(simulation.result.retval) === true,
      observedAtLedger: String(simulation.latestLedger),
    };
  },
};

function parseEnvelope(plan: WorkflowPlanV4, value: unknown): {
  readonly envelope: PolicyProofEnvelopeV4;
  readonly publicInputs: readonly `0x${string}`[];
  readonly publicInputsHash: `0x${string}`;
  readonly proofSha256: `0x${string}`;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("WORKFLOW_V4_POLICY_PROOF_INVALID", "A structured Policy V2 proof envelope is required.", 400);
  }
  if (!plan.intent.policyProfile || plan.policy.proofBinding.status !== "device_proof_required") {
    throw controlled("WORKFLOW_V4_POLICY_PROOF_NOT_BINDABLE", "This workflow is not at the Policy V2 proof boundary.");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "kletia_policy_proof_envelope_v2" || input.verifierVersion !== 2) {
    throw controlled("WORKFLOW_V4_POLICY_PROOF_VERSION_INVALID", "Only Kletia Policy V2 with twelve public inputs is accepted.", 400);
  }
  const routeId = String(input.routeId ?? "").trim();
  const expectedLeaves = selectedPolicyLeavesV4(plan, routeId);
  const expectedWorkflowRoot = deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, routeId);
  const workflowRoot = scalar(input.workflowRoot, "workflowRoot");
  const policyRoot = scalar(input.policyRoot, "policyRoot");
  const protocolRegistryRoot = scalar(input.protocolRegistryRoot, "protocolRegistryRoot");
  const assetRegistryRoot = scalar(input.assetRegistryRoot, "assetRegistryRoot");
  const recipientPolicyRoot = scalar(input.recipientPolicyRoot, "recipientPolicyRoot");
  const selectedProtocolLeaf = scalar(input.selectedProtocolLeaf, "selectedProtocolLeaf");
  const selectedAssetLeaf = scalar(input.selectedAssetLeaf, "selectedAssetLeaf");
  const selectedRecipientLeaf = scalar(input.selectedRecipientLeaf, "selectedRecipientLeaf");
  const nullifier = scalar(input.nullifier, "nullifier");
  const executionContextCommitment = scalar(input.executionContextCommitment, "executionContextCommitment");
  const profile = plan.intent.policyProfile.core;
  if (
    workflowRoot !== expectedWorkflowRoot ||
    policyRoot !== profile.policyRoot ||
    protocolRegistryRoot !== profile.protocolRegistryRoot ||
    assetRegistryRoot !== profile.assetRegistryRoot ||
    recipientPolicyRoot !== profile.recipientPolicyRoot ||
    selectedProtocolLeaf !== expectedLeaves.selectedProtocolLeaf ||
    selectedAssetLeaf !== expectedLeaves.selectedAssetLeaf ||
    selectedRecipientLeaf !== expectedLeaves.selectedRecipientLeaf
  ) {
    throw controlled("WORKFLOW_V4_POLICY_PUBLIC_INPUT_MISMATCH", "Policy V2 public inputs did not match the signed profile and exact selected route.");
  }
  const environmentLane = Number(input.environmentLane);
  if (environmentLane !== (plan.lane === "production" ? 0 : 1)) {
    throw controlled("WORKFLOW_V4_POLICY_LANE_MISMATCH", "Policy V2 lane did not match the workflow lane.");
  }
  const executionExpiresAtLedger = Number(input.executionExpiresAtLedger);
  if (!Number.isSafeInteger(executionExpiresAtLedger) || executionExpiresAtLedger <= 0 || executionExpiresAtLedger > 0xffff_ffff) {
    throw controlled("WORKFLOW_V4_POLICY_EXPIRY_INVALID", "Policy V2 execution expiry must be a positive uint32 ledger.", 400);
  }
  if (executionExpiresAtLedger !== profile.executionExpiresAtLedger) {
    throw controlled("WORKFLOW_V4_POLICY_EXPIRY_MISMATCH", "Policy V2 proof expiry did not match the user-signed policy profile.");
  }
  const proof = String(input.proof ?? "").trim().toLowerCase() as `0x${string}`;
  if (!PROOF_HEX_PATTERN.test(proof)) {
    throw controlled("WORKFLOW_V4_POLICY_PROOF_ENCODING_INVALID", "Policy V2 proof must be exactly 256 bytes in A || B || C encoding.", 400);
  }
  const laneScalar = `0x${BigInt(environmentLane).toString(16).padStart(64, "0")}` as `0x${string}`;
  const expiryScalar = `0x${BigInt(executionExpiresAtLedger).toString(16).padStart(64, "0")}` as `0x${string}`;
  const publicInputs = [
    workflowRoot,
    policyRoot,
    protocolRegistryRoot,
    assetRegistryRoot,
    recipientPolicyRoot,
    selectedProtocolLeaf,
    selectedAssetLeaf,
    selectedRecipientLeaf,
    laneScalar,
    expiryScalar,
    nullifier,
    executionContextCommitment,
  ] as const;
  return {
    envelope: {
      schemaVersion: "kletia_policy_proof_envelope_v2",
      routeId,
      workflowRoot,
      policyRoot,
      protocolRegistryRoot,
      assetRegistryRoot,
      recipientPolicyRoot,
      selectedProtocolLeaf,
      selectedAssetLeaf,
      selectedRecipientLeaf,
      environmentLane,
      executionExpiresAtLedger,
      nullifier,
      executionContextCommitment,
      verifierVersion: 2,
      proof,
    },
    publicInputs,
    publicInputsHash: publicInputsHash(publicInputs),
    proofSha256: proofSha256(proof),
  };
}

export async function verifyAndBindPolicyProofV4(
  plan: WorkflowPlanV4,
  value: unknown,
  verifier: PolicyProofVerifierV4,
) {
  if (plan.expiresAt <= Date.now()) {
    throw controlled("WORKFLOW_V4_EXPIRED", "The canonical workflow expired before policy-proof binding.");
  }
  const parsed = parseEnvelope(plan, value);
  const result = await verifier.verify({
    plan,
    publicInputs: parsed.publicInputs,
    proof: new Uint8Array(Buffer.from(parsed.envelope.proof.slice(2), "hex")),
    verifierVersion: 2,
  });
  if (!result.accepted || !/^\d+$/u.test(result.observedAtLedger)) {
    throw controlled("WORKFLOW_V4_POLICY_PROOF_REJECTED", "The pinned Stellar Policy V2 verifier rejected this proof.");
  }
  const next: WorkflowPlanV4 = {
    ...plan,
    policy: {
      ...plan.policy,
      proofBinding: {
        status: "bound",
        routeId: parsed.envelope.routeId,
        verifierVersion: 2,
        publicInputsHash: parsed.publicInputsHash,
        proofSha256: parsed.proofSha256,
        nullifier: parsed.envelope.nullifier,
        executionContextCommitment: parsed.envelope.executionContextCommitment,
        verifiedAtLedger: result.observedAtLedger,
      },
    },
    controlPlane: {
      ...plan.controlPlane,
      commitment: {
        ...plan.controlPlane.commitment,
        status: "awaiting_signature",
      },
    },
    executionGate: plan.controlPlane.ready
      ? {
          signable: true,
          status: "control_plane_commit_required",
          reasons: ["Policy V2 is bound; the owner must separately sign the exact Stellar V2 commitment before any financial step can hydrate."],
        }
      : plan.executionGate,
  };
  return Object.freeze({
    plan: next,
    evidence: Object.freeze({
      schemaVersion: "kletia_policy_proof_evidence_v2" as const,
      routeId: parsed.envelope.routeId,
      verifierVersion: 2 as const,
      publicInputsHash: parsed.publicInputsHash,
      proofSha256: parsed.proofSha256,
      proofPersisted: false as const,
      observedAtLedger: result.observedAtLedger,
      externalExecutionTruthProven: false as const,
    }),
  });
}
