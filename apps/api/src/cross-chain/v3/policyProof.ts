import { createHash } from "node:crypto";
import { poseidon2 } from "poseidon-lite";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { readStellarControlPlaneReadiness } from "../../networks/stellar/controlPlaneReadiness.js";
import { deriveRouteBoundWorkflowRootV3 } from "./compiler.js";
import type {
  Bn254ScalarHex,
  WorkflowPlanV3,
  WorkflowStepV3,
} from "./types.js";

const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);
const PROOF_HEX_PATTERN = /^0x[a-f\d]{512}$/iu;
const MAX_VERIFIER_VERSION = 0xffff_ffff;
// The browser derives receipt_close_by from the live ledger using this same
// reviewed window. Binding a proof that cannot fit that lifecycle would create
// a permanently unusable workflow record.
const RECEIPT_WINDOW_LEDGERS = 120_960;

function controlled(code: string, message: string, statusCode = 409, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function scalar(value: unknown, field: string): Bn254ScalarHex {
  const encoded = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f\d]{64}$/u.test(encoded)) {
    throw controlled("WORKFLOW_V3_POLICY_SCALAR_INVALID", `${field} must be an exact 32-byte BN254 scalar.`, 400);
  }
  const parsed = BigInt(encoded);
  if (parsed <= 0n || parsed >= BN254_SCALAR_FIELD_MODULUS) {
    throw controlled("WORKFLOW_V3_POLICY_SCALAR_NON_CANONICAL", `${field} is outside the canonical BN254 scalar field.`, 400);
  }
  return encoded as Bn254ScalarHex;
}

function u32(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_VERIFIER_VERSION) {
    throw controlled("WORKFLOW_V3_POLICY_INTEGER_INVALID", `${field} must be a positive uint32.`, 400);
  }
  return parsed;
}

function u32Scalar(value: number): Bn254ScalarHex {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function sha256Hex(domain: string, parts: readonly Uint8Array[]): `0x${string}` {
  const digest = createHash("sha256");
  if (domain) digest.update(domain, "utf8").update("\u001f", "utf8");
  for (const part of parts) digest.update(part);
  return `0x${digest.digest("hex")}`;
}

function domainField(domain: string, value: string): bigint {
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\u001f", "utf8")
    .update(value, "utf8")
    .digest("hex");
  const field = BigInt(`0x${digest}`) % BN254_SCALAR_FIELD_MODULUS;
  return field === 0n ? 1n : field;
}

function deterministicMerkleRoot(leaf: bigint, namespace: string): Bn254ScalarHex {
  let root = leaf;
  for (let index = 0; index < 16; index += 1) {
    const sibling = domainField(
      "KLETIA_POLICY_MERKLE_SIBLING_V1",
      `${namespace}:${index}`,
    );
    root = poseidon2([root, sibling]);
  }
  return `0x${root.toString(16).padStart(64, "0")}`;
}

/**
 * Roots accepted by the application policy verifier. They are deterministic
 * derivatives of the exact reviewed route, corridor asset and final wallet;
 * an untrusted browser cannot choose a private one-element allowlist anymore.
 */
export function derivePolicyRegistryRootsV3(
  plan: WorkflowPlanV3,
  routeId: string,
): {
  readonly protocolRegistryRoot: Bn254ScalarHex;
  readonly assetRegistryRoot: Bn254ScalarHex;
  readonly recipientPolicyRoot: Bn254ScalarHex;
} {
  const route = plan.routes.find((candidate) => candidate.id === routeId);
  const recipient = plan.walletBindings.find(
    (candidate) => candidate.family === "evm" && candidate.chainId === 421_614,
  );
  if (!route || !recipient || recipient.family !== "evm") {
    throw controlled(
      "WORKFLOW_V3_POLICY_REGISTRY_CONTEXT_INVALID",
      "The reviewed route, asset corridor or final recipient binding is missing.",
      409,
    );
  }
  return derivePolicyRegistryRootsFromMaterialV3({
    routeId: route.id,
    solverRouteHash: route.solverRouteHash,
    recipient: recipient.address,
  });
}

export function derivePolicyRegistryRootsFromMaterialV3(input: {
  readonly routeId: string;
  readonly solverRouteHash: `0x${string}`;
  readonly recipient: string;
}): {
  readonly protocolRegistryRoot: Bn254ScalarHex;
  readonly assetRegistryRoot: Bn254ScalarHex;
  readonly recipientPolicyRoot: Bn254ScalarHex;
} {
  const protocolLeaf = domainField(
    "KLETIA_POLICY_PROTOCOL_LEAF_V1",
    `${input.routeId}:${input.solverRouteHash}`,
  );
  const assetLeaf = domainField(
    "KLETIA_POLICY_ASSET_LEAF_V1",
    "arc:5042002:USDC:arbitrum-sepolia:421614:USDC",
  );
  const recipientLeaf = domainField(
    "KLETIA_POLICY_RECIPIENT_LEAF_V1",
    input.recipient.toLowerCase(),
  );
  return {
    protocolRegistryRoot: deterministicMerkleRoot(protocolLeaf, "protocol"),
    assetRegistryRoot: deterministicMerkleRoot(assetLeaf, "asset"),
    recipientPolicyRoot: deterministicMerkleRoot(recipientLeaf, "recipient"),
  };
}

export interface PolicyProofEnvelopeV3 {
  readonly schemaVersion: "kletia_policy_proof_envelope_v1";
  readonly routeId: string;
  readonly workflowRoot: Bn254ScalarHex;
  readonly policyRoot: Bn254ScalarHex;
  readonly protocolRegistryRoot: Bn254ScalarHex;
  readonly assetRegistryRoot: Bn254ScalarHex;
  readonly recipientPolicyRoot: Bn254ScalarHex;
  readonly executionExpiresAtLedger: number;
  readonly nullifier: Bn254ScalarHex;
  readonly executionContextCommitment: Bn254ScalarHex;
  readonly verifierVersion: number;
  /** Standard uncompressed A(64) || B(128) || C(64) encoding. */
  readonly proof: `0x${string}`;
}

interface ParsedPolicyProofV3 extends PolicyProofEnvelopeV3 {
  readonly publicInputs: readonly Bn254ScalarHex[];
  readonly publicInputsHash: `0x${string}`;
  readonly proofSha256: `0x${string}`;
}

function parsePolicyProofEnvelope(
  plan: WorkflowPlanV3,
  input: unknown,
): ParsedPolicyProofV3 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw controlled("WORKFLOW_V3_POLICY_PROOF_INVALID", "A structured device policy proof is required.", 400);
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.schemaVersion !== "kletia_policy_proof_envelope_v1") {
    throw controlled("WORKFLOW_V3_POLICY_PROOF_VERSION_INVALID", "The device policy-proof schema is unsupported.", 400);
  }
  const routeId = String(candidate.routeId ?? "").trim();
  const expectedWorkflowRoot = deriveRouteBoundWorkflowRootV3(plan, routeId);
  const workflowRoot = scalar(candidate.workflowRoot, "workflowRoot");
  if (workflowRoot !== expectedWorkflowRoot) {
    throw controlled(
      "WORKFLOW_V3_POLICY_WORKFLOW_ROOT_MISMATCH",
      "The device proof was not bound to this exact workflow and selected route.",
    );
  }
  const policyRoot = scalar(candidate.policyRoot, "policyRoot");
  const protocolRegistryRoot = scalar(candidate.protocolRegistryRoot, "protocolRegistryRoot");
  const assetRegistryRoot = scalar(candidate.assetRegistryRoot, "assetRegistryRoot");
  const recipientPolicyRoot = scalar(candidate.recipientPolicyRoot, "recipientPolicyRoot");
  const expectedRegistryRoots = derivePolicyRegistryRootsV3(plan, routeId);
  if (
    protocolRegistryRoot !== expectedRegistryRoots.protocolRegistryRoot ||
    assetRegistryRoot !== expectedRegistryRoots.assetRegistryRoot ||
    recipientPolicyRoot !== expectedRegistryRoots.recipientPolicyRoot
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_REGISTRY_ROOT_MISMATCH",
      "The proof registry roots were not derived from the exact reviewed route, corridor asset and final recipient.",
      409,
    );
  }
  const executionExpiresAtLedger = u32(candidate.executionExpiresAtLedger, "executionExpiresAtLedger");
  const nullifier = scalar(candidate.nullifier, "nullifier");
  const executionContextCommitment = scalar(
    candidate.executionContextCommitment,
    "executionContextCommitment",
  );
  const verifierVersion = u32(candidate.verifierVersion, "verifierVersion");
  const proof = String(candidate.proof ?? "").trim().toLowerCase();
  if (!PROOF_HEX_PATTERN.test(proof)) {
    throw controlled(
      "WORKFLOW_V3_POLICY_PROOF_ENCODING_INVALID",
      "The policy proof must be exactly 256 bytes in A || B || C encoding.",
      400,
    );
  }
  const publicInputs = [
    workflowRoot,
    policyRoot,
    protocolRegistryRoot,
    assetRegistryRoot,
    recipientPolicyRoot,
    u32Scalar(plan.lane === "production" ? 0 : 1),
    u32Scalar(executionExpiresAtLedger),
    nullifier,
    executionContextCommitment,
  ] as const;
  return {
    schemaVersion: "kletia_policy_proof_envelope_v1",
    routeId,
    workflowRoot,
    policyRoot,
    protocolRegistryRoot,
    assetRegistryRoot,
    recipientPolicyRoot,
    executionExpiresAtLedger,
    nullifier,
    executionContextCommitment,
    verifierVersion,
    proof: proof as `0x${string}`,
    publicInputs,
    // This exactly matches the Soroban registries: SHA-256 of nine concatenated
    // big-endian 32-byte public inputs, with no JSON or textual encoding.
    publicInputsHash: sha256Hex(
      "",
      publicInputs.map((entry) => decodeHex(entry)),
    ),
    proofSha256: sha256Hex("KLETIA_POLICY_PROOF_V1", [decodeHex(proof)]),
  };
}

export interface PolicyProofVerificationV3 {
  readonly accepted: boolean;
  readonly observedAtLedger: string;
  readonly registryContractId: string;
  readonly verifierContractId: string;
  readonly verifierVersion: number;
}

export interface PolicyProofVerificationDependenciesV3 {
  readonly verify: (input: {
    readonly plan: WorkflowPlanV3;
    readonly verifierVersion: number;
    readonly publicInputs: readonly Bn254ScalarHex[];
    readonly proof: Uint8Array;
  }) => Promise<PolicyProofVerificationV3>;
}

async function verifyWithPinnedRegistry(input: {
  readonly plan: WorkflowPlanV3;
  readonly verifierVersion: number;
  readonly publicInputs: readonly Bn254ScalarHex[];
  readonly proof: Uint8Array;
}): Promise<PolicyProofVerificationV3> {
  const readiness = await readStellarControlPlaneReadiness(input.plan.lane);
  if (!readiness.ready || readiness.lane !== "testnet") {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_NOT_READY",
      "The exact Stellar control-plane deployment and verifier artifacts are not ready.",
      503,
    );
  }
  const registry = readiness.contracts.find((entry) => entry.key === "policyVerifierRegistry");
  const verifier = readiness.policyVerifier;
  const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  if (
    !registry?.ready ||
    !registry.contractId ||
    !verifier?.ready ||
    verifier.version !== input.verifierVersion ||
    !source
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_VERIFIER_MISMATCH",
      "The requested verifier version did not match the reviewed live registry record.",
      503,
    );
  }
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(
      new Contract(registry.contractId).call(
        "verify",
        nativeToScVal(input.verifierVersion, { type: "u32" }),
        xdr.ScVal.scvVec(
          input.publicInputs.map((entry) => xdr.ScVal.scvBytes(decodeHex(entry))),
        ),
        xdr.ScVal.scvBytes(input.proof),
      ),
    )
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_PROOF_SIMULATION_FAILED",
      "The exact policy proof did not pass the pinned Stellar verifier-registry simulation.",
      409,
    );
  }
  const accepted = scValToNative(simulation.result.retval) === true;
  return {
    accepted,
    observedAtLedger: String(simulation.latestLedger),
    registryContractId: registry.contractId,
    verifierContractId: verifier.verifierContractId,
    verifierVersion: verifier.version,
  };
}

const DEFAULT_DEPENDENCIES: PolicyProofVerificationDependenciesV3 = {
  verify: verifyWithPinnedRegistry,
};

function updateControlPlaneStep(
  step: WorkflowStepV3,
  routeId: string,
): WorkflowStepV3 {
  if (step.operation !== "control_plane_commit") return step;
  return {
    ...step,
    executionReadiness: "ready",
    status: step.id.startsWith(`${routeId}-`) ? "awaiting_signature" : step.status,
    unavailableReason:
      step.id.startsWith(`${routeId}-`)
        ? undefined
        : step.unavailableReason,
  };
}

export async function verifyAndBindPolicyProofV3(
  plan: WorkflowPlanV3,
  input: unknown,
  dependencies: PolicyProofVerificationDependenciesV3 = DEFAULT_DEPENDENCIES,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: Omit<PolicyProofVerificationV3, "accepted"> & {
    readonly publicInputsHash: `0x${string}`;
    readonly proofSha256: `0x${string}`;
    readonly proofPersisted: false;
    readonly externalExecutionTruthProven: false;
  };
}> {
  if (
    plan.coordinationMarket.required &&
    plan.coordinationMarket.status !== "winner_selected"
  ) {
    throw controlled(
      "WORKFLOW_V3_AUCTION_WINNER_REQUIRED",
      "The competitive workflow must bind a live Stellar commit-reveal winner before its route policy proof can be accepted.",
    );
  }
  if (
    !plan.controlPlane.required ||
    plan.controlPlane.mode !== "stellar_intent_control_plane" ||
    plan.controlPlane.status !== "ready" ||
    plan.controlPlane.proofBinding.status !== "device_proof_required" ||
    plan.expiresAt <= Date.now()
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_PROOF_NOT_BINDABLE",
      "This workflow is expired, does not require the Stellar control plane, or is not at the device-proof boundary.",
    );
  }
  const parsed = parsePolicyProofEnvelope(plan, input);
  const verification = await dependencies.verify({
    plan,
    verifierVersion: parsed.verifierVersion,
    publicInputs: parsed.publicInputs,
    proof: decodeHex(parsed.proof),
  });
  if (!verification.accepted || verification.verifierVersion !== parsed.verifierVersion) {
    throw controlled(
      "WORKFLOW_V3_POLICY_PROOF_REJECTED",
      "The pinned Stellar verifier registry rejected the route-bound policy proof.",
    );
  }
  const observedAtLedger = Number(verification.observedAtLedger);
  if (
    !Number.isSafeInteger(observedAtLedger) ||
    observedAtLedger <= 0 ||
    parsed.executionExpiresAtLedger <= observedAtLedger ||
    parsed.executionExpiresAtLedger >= observedAtLedger + RECEIPT_WINDOW_LEDGERS
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_EXPIRY_OUTSIDE_LIFECYCLE",
      "The policy proof expiry cannot fit the reviewed Stellar execution and receipt lifecycle.",
    );
  }
  const route = plan.routes.find((candidate) => candidate.id === parsed.routeId);
  if (!route) {
    throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The policy proof selected an unknown workflow route.");
  }
  const routes = plan.routes.map((candidate) =>
    candidate.id === route.id
      ? { ...candidate, steps: candidate.steps.map((step) => updateControlPlaneStep(step, route.id)) }
      : candidate,
  );
  const boundRoute = routes.find((candidate) => candidate.id === route.id);
  const firstReadyStep = boundRoute?.steps.find(
    (step) => step.status === "awaiting_signature" || step.status === "ready",
  );
  return {
    plan: {
      ...plan,
      selectedRouteId: route.id,
      currentStepId: firstReadyStep?.id ?? null,
      routes,
      controlPlane: {
        ...plan.controlPlane,
        workflowRoot: parsed.workflowRoot,
        policyRoot: parsed.policyRoot,
        nullifier: parsed.nullifier,
        proofBinding: {
          schemaVersion: "kletia_policy_proof_binding_v1",
          status: "bound",
          routeId: route.id,
          verifierVersion: parsed.verifierVersion,
          protocolRegistryRoot: parsed.protocolRegistryRoot,
          assetRegistryRoot: parsed.assetRegistryRoot,
          recipientPolicyRoot: parsed.recipientPolicyRoot,
          executionExpiresAtLedger: parsed.executionExpiresAtLedger,
          executionContextCommitment: parsed.executionContextCommitment,
          publicInputsHash: parsed.publicInputsHash,
          proofSha256: parsed.proofSha256,
          verifiedAtLedger: verification.observedAtLedger,
        },
        commitment: {
          ...plan.controlPlane.commitment,
          status: "awaiting_signature",
        },
      },
    },
    evidence: {
      observedAtLedger: verification.observedAtLedger,
      registryContractId: verification.registryContractId,
      verifierContractId: verification.verifierContractId,
      verifierVersion: verification.verifierVersion,
      publicInputsHash: parsed.publicInputsHash,
      proofSha256: parsed.proofSha256,
      proofPersisted: false,
      externalExecutionTruthProven: false,
    },
  };
}
