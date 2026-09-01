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

import { prepareStellarContractCall } from "../../networks/stellar/runtime/cctp";
import type {
  DevicePolicyProofEnvelopeV4,
  ScalarHexV4,
  WorkflowPlanV4View,
} from "./types";

const STELLAR_TESTNET_RPC = "https://soroban-testnet.stellar.org";
const RECEIPT_WINDOW_LEDGERS = 120_960;
const RETENTION_WINDOW_LEDGERS = 241_920;
const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export interface PreparedControlPlaneCommitV2 {
  readonly schemaVersion: "kletia_control_plane_prepared_xdr_v2";
  readonly operation: "intent_control_plane_v2_commit";
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: string;
  readonly xdr: string;
  readonly lifecycle: {
    readonly executionExpiresAtLedger: number;
    readonly receiptCloseByLedger: number;
    readonly retentionFloorLedger: number;
    readonly derivedAtLedger: number;
  };
  readonly proofPersisted: false;
  readonly enforcingSimulationPassed: true;
}

function hexBytes(value: string, expectedLength: number, field: string): Uint8Array {
  if (!new RegExp(`^0x[a-f\\d]{${expectedLength * 2}}$`, "iu").test(value)) {
    throw new Error(`${field} is not an exact ${expectedLength}-byte hex value.`);
  }
  const output = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return output;
}

function scalar(value: string, field: string): ScalarHexV4 {
  const normalized = value.toLowerCase();
  hexBytes(normalized, 32, field);
  const numeric = BigInt(normalized);
  if (numeric <= 0n || numeric >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error(`${field} is outside the canonical BN254 scalar field.`);
  }
  return normalized as ScalarHexV4;
}

function bytes32ScVal(value: string, field: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(hexBytes(value, 32, field));
}

function u32Scalar(value: number): ScalarHexV4 {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("A Policy V2 uint32 public input is invalid.");
  }
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

async function digest(parts: readonly Uint8Array[], domain = ""): Promise<ScalarHexV4> {
  const prefix = domain ? new TextEncoder().encode(`${domain}\u001f`) : new Uint8Array();
  const payload = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + part.length, 0));
  payload.set(prefix, 0);
  let offset = prefix.length;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  return `0x${Array.from(hash, (entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

function stellarOwner(plan: WorkflowPlanV4View): string {
  const binding = plan.walletBindings.find(
    (candidate) => candidate.family === "stellar" && candidate.network === "testnet",
  );
  if (!binding || !StrKey.isValidEd25519PublicKey(binding.address)) {
    throw new Error("The V4 workflow is not bound to an exact Stellar Testnet owner.");
  }
  return binding.address;
}

async function readNextNonce(input: { readonly owner: string; readonly contractId: string }) {
  const server = new rpc.Server(STELLAR_TESTNET_RPC, { timeout: 10_000 });
  const account = await server.getAccount(input.owner);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(new Contract(input.contractId).call(
    "next_nonce",
    new Address(input.owner).toScVal(),
  )).setTimeout(60).build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation) || !simulation.result) {
    throw new Error("The exact V2 control-plane nonce could not be read without restoration.");
  }
  const nonce = BigInt(String(scValToNative(simulation.result.retval)));
  if (nonce < 0n || nonce > 0xffff_ffff_ffff_ffffn) {
    throw new Error("The V2 control-plane nonce is invalid.");
  }
  return { nonce, latestLedger: simulation.latestLedger };
}

function lifecycle(latestLedger: number, executionExpiresAtLedger: number) {
  const receiptCloseByLedger = latestLedger + RECEIPT_WINDOW_LEDGERS;
  const retentionFloorLedger = latestLedger + RETENTION_WINDOW_LEDGERS;
  if (
    !Number.isSafeInteger(latestLedger) ||
    executionExpiresAtLedger <= latestLedger ||
    executionExpiresAtLedger >= receiptCloseByLedger ||
    receiptCloseByLedger >= retentionFloorLedger ||
    retentionFloorLedger > 0xffff_ffff
  ) {
    throw new Error("The signed policy expiry no longer fits the reviewed V2 lifecycle windows.");
  }
  return { executionExpiresAtLedger, receiptCloseByLedger, retentionFloorLedger, derivedAtLedger: latestLedger };
}

async function assertProofBinding(
  plan: WorkflowPlanV4View,
  proof: DevicePolicyProofEnvelopeV4,
): Promise<void> {
  if (
    plan.version !== 4 ||
    plan.schemaVersion !== "kletia_workflow_plan_v4" ||
    plan.lane !== "testnet" ||
    plan.controlPlane.network !== "stellar_testnet" ||
    !plan.controlPlane.ready ||
    plan.controlPlane.commitment.status !== "awaiting_signature" ||
    plan.policy.proofBinding.status !== "bound" ||
    proof.schemaVersion !== "kletia_policy_proof_envelope_v2" ||
    proof.routeId !== plan.selectedRouteId ||
    proof.routeId !== plan.policy.proofBinding.routeId ||
    proof.environmentLane !== 1 ||
    proof.verifierVersion !== 2
  ) {
    throw new Error("The local Policy V2 proof no longer matches the signable workflow state.");
  }
  const publicInputs = [
    proof.workflowRoot,
    proof.policyRoot,
    proof.protocolRegistryRoot,
    proof.assetRegistryRoot,
    proof.recipientPolicyRoot,
    proof.selectedProtocolLeaf,
    proof.selectedAssetLeaf,
    proof.selectedRecipientLeaf,
    u32Scalar(proof.environmentLane),
    u32Scalar(proof.executionExpiresAtLedger),
    proof.nullifier,
    proof.executionContextCommitment,
  ].map((value, index) => hexBytes(scalar(value, `publicInputs[${index}]`), 32, `publicInputs[${index}]`));
  const proofBytes = hexBytes(proof.proof, 256, "proof");
  const [publicInputsHash, proofSha256] = await Promise.all([
    digest(publicInputs),
    digest([proofBytes], "KLETIA_POLICY_PROOF_V2"),
  ]);
  if (
    publicInputsHash !== plan.policy.proofBinding.publicInputsHash ||
    proofSha256 !== plan.policy.proofBinding.proofSha256
  ) {
    throw new Error("The Policy V2 proof or its exact twelve public inputs changed after server verification.");
  }
}

export async function prepareIntentControlPlaneV2Commit(input: {
  readonly plan: WorkflowPlanV4View;
  readonly proof: DevicePolicyProofEnvelopeV4;
}): Promise<PreparedControlPlaneCommitV2> {
  const contractId = input.plan.controlPlane.contractId ?? "";
  if (!StrKey.isValidContract(contractId)) {
    throw new Error("The live-attested Intent Control Plane V2 contract ID is unavailable.");
  }
  await assertProofBinding(input.plan, input.proof);
  const owner = stellarOwner(input.plan);
  const state = await readNextNonce({ owner, contractId });
  const timing = lifecycle(state.latestLedger, input.proof.executionExpiresAtLedger);
  const prepared = await prepareStellarContractCall({
    source: owner,
    contractId,
    method: "commit",
    args: [
      new Address(owner).toScVal(),
      nativeToScVal(state.nonce, { type: "u64" }),
      bytes32ScVal(input.proof.workflowRoot, "workflowRoot"),
      bytes32ScVal(input.proof.policyRoot, "policyRoot"),
      bytes32ScVal(input.proof.protocolRegistryRoot, "protocolRegistryRoot"),
      bytes32ScVal(input.proof.assetRegistryRoot, "assetRegistryRoot"),
      bytes32ScVal(input.proof.recipientPolicyRoot, "recipientPolicyRoot"),
      bytes32ScVal(input.proof.selectedProtocolLeaf, "selectedProtocolLeaf"),
      bytes32ScVal(input.proof.selectedAssetLeaf, "selectedAssetLeaf"),
      bytes32ScVal(input.proof.selectedRecipientLeaf, "selectedRecipientLeaf"),
      bytes32ScVal(input.proof.nullifier, "nullifier"),
      bytes32ScVal(input.proof.executionContextCommitment, "executionContextCommitment"),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Testnet")]),
      nativeToScVal(timing.executionExpiresAtLedger, { type: "u32" }),
      nativeToScVal(timing.receiptCloseByLedger, { type: "u32" }),
      nativeToScVal(timing.retentionFloorLedger, { type: "u32" }),
      nativeToScVal(input.proof.verifierVersion, { type: "u32" }),
      xdr.ScVal.scvBytes(hexBytes(input.proof.proof, 256, "proof")),
    ],
  });
  return {
    schemaVersion: "kletia_control_plane_prepared_xdr_v2",
    operation: "intent_control_plane_v2_commit",
    contractId,
    owner,
    nonce: state.nonce.toString(),
    xdr: prepared,
    lifecycle: timing,
    proofPersisted: false,
    enforcingSimulationPassed: true,
  };
}
