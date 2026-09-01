import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { prepareStellarContractCall } from "./cctp";

const STELLAR_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const RECEIPT_WINDOW_LEDGERS = 120_960;
const RETENTION_WINDOW_LEDGERS = 241_920;
const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

type Hex32 = `0x${string}`;

export interface DevicePolicyProofEnvelopeV3 {
  readonly schemaVersion: "kletia_policy_proof_envelope_v1";
  readonly routeId: string;
  readonly workflowRoot: Hex32;
  readonly policyRoot: Hex32;
  readonly protocolRegistryRoot: Hex32;
  readonly assetRegistryRoot: Hex32;
  readonly recipientPolicyRoot: Hex32;
  readonly executionExpiresAtLedger: number;
  readonly nullifier: Hex32;
  readonly executionContextCommitment: Hex32;
  readonly verifierVersion: number;
  readonly proof: `0x${string}`;
}

export interface BoundControlPlanePlanV3 {
  readonly version: 3;
  readonly schemaVersion: "kletia_workflow_plan_v3";
  readonly lane: "testnet";
  readonly selectedRouteId: string;
  readonly walletBindings: readonly ({
    readonly family: "stellar";
    readonly network: "testnet";
    readonly address: string;
  } | {
    readonly family: "evm";
    readonly chainId: number;
    readonly address: string;
  })[];
  readonly controlPlane: {
    readonly required: true;
    readonly mode: "stellar_intent_control_plane";
    readonly network: "stellar_testnet";
    readonly status: "ready";
    readonly workflowRoot: Hex32;
    readonly planningPolicyCommitment: Hex32;
    readonly privacyBudgetCommitment: Hex32;
    readonly policyRoot: Hex32;
    readonly nullifier: Hex32;
    readonly proofBinding: {
      readonly status: "bound";
      readonly routeId: string;
      readonly verifierVersion: number;
      readonly protocolRegistryRoot: Hex32;
      readonly assetRegistryRoot: Hex32;
      readonly recipientPolicyRoot: Hex32;
      readonly executionExpiresAtLedger: number;
      readonly executionContextCommitment: Hex32;
      readonly publicInputsHash: Hex32;
      readonly proofSha256: Hex32;
      readonly verifiedAtLedger: string;
    };
    readonly externalExecutionTruthProven: false;
  };
  readonly routes: readonly {
    readonly id: string;
    readonly steps: readonly {
      readonly operation: string;
      readonly target?: string;
      readonly method?: string;
    }[];
  }[];
}

export interface ControlPlaneLifecycleV1 {
  readonly executionExpiresAtLedger: number;
  readonly receiptCloseByLedger: number;
  readonly retentionFloorLedger: number;
  readonly derivedAtLedger: number;
}

export interface PreparedControlPlaneXdrV1 {
  readonly schemaVersion: "kletia_control_plane_prepared_xdr_v1";
  readonly operation:
    | "intent_control_plane_commit"
    | "receipt_registry_commit"
    | "receipt_registry_finalize"
    | "intent_control_plane_finalize";
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: string;
  readonly xdr: string;
  readonly lifecycle?: ControlPlaneLifecycleV1;
  readonly proofPersisted: false;
  readonly enforcingSimulationPassed: true;
}

function bytes(value: string, expectedLength: number, field: string): Uint8Array {
  if (!new RegExp(`^0x[a-f\\d]{${expectedLength * 2}}$`, "iu").test(value)) {
    throw new Error(`${field} is not an exact ${expectedLength}-byte hex value.`);
  }
  const output = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return output;
}

function scalar(value: string, field: string): Hex32 {
  const encoded = value.toLowerCase();
  const decoded = bytes(encoded, 32, field);
  const numeric = BigInt(encoded);
  if (numeric <= 0n || numeric >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error(`${field} is outside the canonical BN254 scalar field.`);
  }
  if (decoded.length !== 32) throw new Error(`${field} is invalid.`);
  return encoded as Hex32;
}

function bytes32ScVal(value: string, field: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(bytes(value, 32, field));
}

function u32Scalar(value: number): Hex32 {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("A policy uint32 public input is invalid.");
  }
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

async function digest(parts: readonly Uint8Array[], domain = ""): Promise<Hex32> {
  const domainBytes = domain
    ? new TextEncoder().encode(`${domain}\u001f`)
    : new Uint8Array();
  const length = domainBytes.length + parts.reduce((sum, part) => sum + part.length, 0);
  const payload = new Uint8Array(length);
  payload.set(domainBytes, 0);
  let offset = domainBytes.length;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return `0x${Array.from(hash, (entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function ownerForPlan(plan: BoundControlPlanePlanV3): string {
  const owner = plan.walletBindings.find(
    (binding) => binding.family === "stellar" && binding.network === "testnet",
  );
  if (!owner || !StrKey.isValidEd25519PublicKey(owner.address)) {
    throw new Error("The bound workflow does not contain its exact Stellar Testnet owner.");
  }
  return owner.address;
}

function assertStepTarget(
  plan: BoundControlPlanePlanV3,
  operation: string,
  contractId: string,
  method: string,
): void {
  const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
  const step = route?.steps.find((candidate) => candidate.operation === operation);
  if (!step || step.target !== contractId || step.method !== method) {
    throw new Error(`The ${operation} target did not match the sealed workflow plan.`);
  }
}

async function readNextNonce(input: {
  source: string;
  contractId: string;
}): Promise<{ nonce: bigint; latestLedger: number }> {
  const server = new rpc.Server(STELLAR_TESTNET_RPC, { timeout: 10_000 });
  const account = await server.getAccount(input.source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(input.contractId).call(
        "next_nonce",
        new Address(input.source).toScVal(),
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
    throw new Error("The exact control-plane nonce could not be read without restoration.");
  }
  const nonce = BigInt(String(scValToNative(simulation.result.retval)));
  if (nonce < 0n || nonce > 0xffff_ffff_ffff_ffffn) {
    throw new Error("The control-plane nonce is invalid.");
  }
  return { nonce, latestLedger: simulation.latestLedger };
}

function lifecycleAt(
  latestLedger: number,
  executionExpiresAtLedger: number,
): ControlPlaneLifecycleV1 {
  const receiptCloseByLedger = latestLedger + RECEIPT_WINDOW_LEDGERS;
  const retentionFloorLedger = latestLedger + RETENTION_WINDOW_LEDGERS;
  if (
    !Number.isSafeInteger(latestLedger) ||
    executionExpiresAtLedger <= latestLedger ||
    executionExpiresAtLedger >= receiptCloseByLedger ||
    receiptCloseByLedger >= retentionFloorLedger ||
    retentionFloorLedger > 0xffff_ffff
  ) {
    throw new Error("The proof expiry no longer fits the reviewed control-plane lifecycle windows.");
  }
  return {
    executionExpiresAtLedger,
    receiptCloseByLedger,
    retentionFloorLedger,
    derivedAtLedger: latestLedger,
  };
}

async function assertProofMatchesBoundPlan(
  plan: BoundControlPlanePlanV3,
  proof: DevicePolicyProofEnvelopeV3,
): Promise<void> {
  if (
    plan.version !== 3 ||
    plan.schemaVersion !== "kletia_workflow_plan_v3" ||
    plan.lane !== "testnet" ||
    plan.controlPlane.mode !== "stellar_intent_control_plane" ||
    plan.controlPlane.proofBinding.status !== "bound" ||
    plan.controlPlane.externalExecutionTruthProven !== false ||
    proof.schemaVersion !== "kletia_policy_proof_envelope_v1" ||
    proof.routeId !== plan.selectedRouteId ||
    proof.routeId !== plan.controlPlane.proofBinding.routeId ||
    scalar(proof.workflowRoot, "workflowRoot") !== plan.controlPlane.workflowRoot ||
    scalar(proof.policyRoot, "policyRoot") !== plan.controlPlane.policyRoot ||
    scalar(proof.nullifier, "nullifier") !== plan.controlPlane.nullifier ||
    scalar(proof.protocolRegistryRoot, "protocolRegistryRoot") !== plan.controlPlane.proofBinding.protocolRegistryRoot ||
    scalar(proof.assetRegistryRoot, "assetRegistryRoot") !== plan.controlPlane.proofBinding.assetRegistryRoot ||
    scalar(proof.recipientPolicyRoot, "recipientPolicyRoot") !== plan.controlPlane.proofBinding.recipientPolicyRoot ||
    scalar(proof.executionContextCommitment, "executionContextCommitment") !== plan.controlPlane.proofBinding.executionContextCommitment ||
    proof.executionExpiresAtLedger !== plan.controlPlane.proofBinding.executionExpiresAtLedger ||
    proof.verifierVersion !== plan.controlPlane.proofBinding.verifierVersion
  ) {
    throw new Error("The device proof no longer matches the server-bound control-plane plan.");
  }
  const proofBytes = bytes(proof.proof, 256, "proof");
  const publicInputs = [
    proof.workflowRoot,
    proof.policyRoot,
    proof.protocolRegistryRoot,
    proof.assetRegistryRoot,
    proof.recipientPolicyRoot,
    u32Scalar(1),
    u32Scalar(proof.executionExpiresAtLedger),
    proof.nullifier,
    proof.executionContextCommitment,
  ].map((entry, index) => bytes(entry, 32, `publicInputs[${index}]`));
  const [publicInputsHash, proofSha256] = await Promise.all([
    digest(publicInputs),
    digest([proofBytes], "KLETIA_POLICY_PROOF_V1"),
  ]);
  if (
    publicInputsHash !== plan.controlPlane.proofBinding.publicInputsHash ||
    proofSha256 !== plan.controlPlane.proofBinding.proofSha256
  ) {
    throw new Error("The device proof hash or public-input hash changed after server verification.");
  }
}

export async function prepareIntentControlPlaneCommit(input: {
  readonly plan: BoundControlPlanePlanV3;
  readonly proof: DevicePolicyProofEnvelopeV3;
  readonly contractId: string;
}): Promise<PreparedControlPlaneXdrV1> {
  if (!StrKey.isValidContract(input.contractId)) {
    throw new Error("The Intent Control Plane contract ID is invalid.");
  }
  assertStepTarget(input.plan, "control_plane_commit", input.contractId, "commit");
  await assertProofMatchesBoundPlan(input.plan, input.proof);
  const owner = ownerForPlan(input.plan);
  const state = await readNextNonce({ source: owner, contractId: input.contractId });
  const lifecycle = lifecycleAt(state.latestLedger, input.proof.executionExpiresAtLedger);
  const xdrEnvelope = await prepareStellarContractCall({
    source: owner,
    contractId: input.contractId,
    method: "commit",
    args: [
      new Address(owner).toScVal(),
      nativeToScVal(state.nonce, { type: "u64" }),
      bytes32ScVal(input.proof.workflowRoot, "workflowRoot"),
      bytes32ScVal(input.proof.policyRoot, "policyRoot"),
      bytes32ScVal(input.proof.protocolRegistryRoot, "protocolRegistryRoot"),
      bytes32ScVal(input.proof.assetRegistryRoot, "assetRegistryRoot"),
      bytes32ScVal(input.proof.recipientPolicyRoot, "recipientPolicyRoot"),
      bytes32ScVal(input.proof.nullifier, "nullifier"),
      bytes32ScVal(input.proof.executionContextCommitment, "executionContextCommitment"),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Testnet")]),
      nativeToScVal(lifecycle.executionExpiresAtLedger, { type: "u32" }),
      nativeToScVal(lifecycle.receiptCloseByLedger, { type: "u32" }),
      nativeToScVal(lifecycle.retentionFloorLedger, { type: "u32" }),
      nativeToScVal(input.proof.verifierVersion, { type: "u32" }),
      xdr.ScVal.scvBytes(bytes(input.proof.proof, 256, "proof")),
    ],
  });
  return {
    schemaVersion: "kletia_control_plane_prepared_xdr_v1",
    operation: "intent_control_plane_commit",
    contractId: input.contractId,
    owner,
    nonce: state.nonce.toString(),
    xdr: xdrEnvelope,
    lifecycle,
    proofPersisted: false,
    enforcingSimulationPassed: true,
  };
}

export async function prepareReceiptRegistryCommit(input: {
  readonly plan: BoundControlPlanePlanV3;
  readonly contractId: string;
  readonly lifecycle: ControlPlaneLifecycleV1;
}): Promise<PreparedControlPlaneXdrV1> {
  if (!StrKey.isValidContract(input.contractId)) {
    throw new Error("The Policy Receipt Registry contract ID is invalid.");
  }
  assertStepTarget(input.plan, "receipt_registry_commit", input.contractId, "commit");
  const owner = ownerForPlan(input.plan);
  const state = await readNextNonce({ source: owner, contractId: input.contractId });
  if (
    input.lifecycle.executionExpiresAtLedger !== input.plan.controlPlane.proofBinding.executionExpiresAtLedger ||
    state.latestLedger >= input.lifecycle.executionExpiresAtLedger ||
    state.latestLedger >= input.lifecycle.receiptCloseByLedger
  ) {
    throw new Error("The shared control-plane lifecycle expired before receipt-registry commit.");
  }
  const xdrEnvelope = await prepareStellarContractCall({
    source: owner,
    contractId: input.contractId,
    method: "commit",
    args: [
      new Address(owner).toScVal(),
      nativeToScVal(state.nonce, { type: "u64" }),
      bytes32ScVal(input.plan.controlPlane.planningPolicyCommitment, "planningPolicyCommitment"),
      bytes32ScVal(input.plan.controlPlane.privacyBudgetCommitment, "privacyBudgetCommitment"),
      nativeToScVal(input.lifecycle.executionExpiresAtLedger, { type: "u32" }),
      nativeToScVal(input.lifecycle.receiptCloseByLedger, { type: "u32" }),
      nativeToScVal(input.lifecycle.retentionFloorLedger, { type: "u32" }),
    ],
  });
  return {
    schemaVersion: "kletia_control_plane_prepared_xdr_v1",
    operation: "receipt_registry_commit",
    contractId: input.contractId,
    owner,
    nonce: state.nonce.toString(),
    xdr: xdrEnvelope,
    lifecycle: input.lifecycle,
    proofPersisted: false,
    enforcingSimulationPassed: true,
  };
}

async function prepareFinalize(input: {
  readonly plan: BoundControlPlanePlanV3;
  readonly contractId: string;
  readonly nonce: string;
  readonly receiptRoot: Hex32;
  readonly operation: "receipt_registry_finalize" | "control_plane_finalize";
}): Promise<PreparedControlPlaneXdrV1> {
  if (!StrKey.isValidContract(input.contractId) || !/^\d+$/u.test(input.nonce)) {
    throw new Error("The finalization contract or nonce is invalid.");
  }
  assertStepTarget(input.plan, input.operation, input.contractId, "finalize");
  const owner = ownerForPlan(input.plan);
  const xdrEnvelope = await prepareStellarContractCall({
    source: owner,
    contractId: input.contractId,
    method: "finalize",
    args: [
      new Address(owner).toScVal(),
      nativeToScVal(BigInt(input.nonce), { type: "u64" }),
      bytes32ScVal(input.receiptRoot, "receiptRoot"),
    ],
  });
  return {
    schemaVersion: "kletia_control_plane_prepared_xdr_v1",
    operation: input.operation === "receipt_registry_finalize"
      ? "receipt_registry_finalize"
      : "intent_control_plane_finalize",
    contractId: input.contractId,
    owner,
    nonce: input.nonce,
    xdr: xdrEnvelope,
    proofPersisted: false,
    enforcingSimulationPassed: true,
  };
}

export function prepareReceiptRegistryFinalize(input: {
  readonly plan: BoundControlPlanePlanV3;
  readonly contractId: string;
  readonly nonce: string;
  readonly receiptRoot: Hex32;
}): Promise<PreparedControlPlaneXdrV1> {
  return prepareFinalize({ ...input, operation: "receipt_registry_finalize" });
}

export function prepareIntentControlPlaneFinalize(input: {
  readonly plan: BoundControlPlanePlanV3;
  readonly contractId: string;
  readonly nonce: string;
  readonly receiptRoot: Hex32;
}): Promise<PreparedControlPlaneXdrV1> {
  return prepareFinalize({ ...input, operation: "control_plane_finalize" });
}
