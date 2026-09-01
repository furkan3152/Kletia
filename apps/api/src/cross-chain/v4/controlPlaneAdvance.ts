import { createHash } from "node:crypto";
import {
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { readStellarControlPlaneV2Readiness } from "../../networks/stellar/controlPlaneV2Readiness.js";
import { archiveVerifiedStellarTransaction } from "../../networks/stellar/eventArchive.js";
import { deriveRouteBoundWorkflowRootV3 } from "../v3/compiler.js";
import { selectedPolicyLeavesV4 } from "./policyProof.js";
import type { WorkflowPlanV4 } from "./types.js";

const TRANSACTION_HASH_PATTERN = /^[a-f\d]{64}$/u;

function controlled(code: string, message: string, statusCode = 409, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function bytes32(value: unknown, field: string): `0x${string}` {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_VALUE_INVALID", `${field} was not an exact 32-byte value.`);
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function uint(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (error) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_VALUE_INVALID", `${field} was not an unsigned integer.`, 409, error);
  }
}

function enumCase(value: unknown): string {
  if (Array.isArray(value) && value.length === 1) return String(value[0]);
  return String(value ?? "");
}

function proofSha256(value: Uint8Array): `0x${string}` {
  return `0x${createHash("sha256")
    .update("KLETIA_POLICY_PROOF_V2", "utf8")
    .update("\u001f", "utf8")
    .update(value)
    .digest("hex")}`;
}

function stellarOwner(plan: WorkflowPlanV4): string {
  const owner = plan.walletBindings.find(
    (binding) => binding.family === "stellar" && binding.network === "testnet",
  );
  if (!owner || !StrKey.isValidEd25519PublicKey(owner.address)) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_OWNER_MISSING", "The workflow has no exact Stellar Testnet owner.");
  }
  return owner.address;
}

function exactCommittedEvent(input: {
  readonly events: readonly xdr.ContractEvent[];
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: bigint;
}): Record<string, unknown> {
  const matches = input.events.flatMap((event) => {
    if (
      event.contractId === null ||
      StrKey.encodeContract(Buffer.from(event.contractId.value)) !== input.contractId ||
      event.type.name !== "contract" ||
      event.body.type !== "v0"
    ) return [];
    const body = event.body.v0;
    if (body.topics.length !== 3) return [];
    try {
      const data = scValToNative(body.data) as unknown;
      if (
        String(scValToNative(body.topics[0])) !== "workflow_v2_committed" ||
        String(scValToNative(body.topics[1])) !== input.owner ||
        uint(scValToNative(body.topics[2]), "event nonce") !== input.nonce ||
        !data || typeof data !== "object" || Array.isArray(data)
      ) return [];
      return [data as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) {
    throw controlled(
      "WORKFLOW_V4_CONTROL_PLANE_EVENT_MISMATCH",
      "The transaction did not emit exactly one matching workflow_v2_committed event.",
    );
  }
  return matches[0]!;
}

async function readWorkflowRecord(input: {
  readonly owner: string;
  readonly nonce: bigint;
  readonly contractId: string;
}) {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const account = await server.getAccount(input.owner);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  }).addOperation(new Contract(input.contractId).call(
    "get",
    new Address(input.owner).toScVal(),
    nativeToScVal(input.nonce, { type: "u64" }),
  )).setTimeout(60).build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation) || !simulation.result) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_STATE_UNAVAILABLE", "The V2 workflow record could not be read.");
  }
  const value = scValToNative(simulation.result.retval) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_STATE_MISSING", "The confirmed transaction did not create its V2 record.");
  }
  return { record: value as Record<string, unknown>, observedAtLedger: simulation.latestLedger };
}

export async function verifyAndApplyIntentControlPlaneCommitV4(
  plan: WorkflowPlanV4,
  transactionHashInput: unknown,
) {
  const transactionHash = String(transactionHashInput ?? "").trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
    throw controlled("WORKFLOW_V4_STELLAR_TRANSACTION_HASH_INVALID", "A canonical Stellar transaction hash is required.", 400);
  }
  const binding = plan.policy.proofBinding;
  const profile = plan.intent.policyProfile?.core;
  const contractId = plan.controlPlane.contractId;
  if (
    plan.lane !== "testnet" ||
    plan.controlPlane.network !== "stellar_testnet" ||
    !plan.controlPlane.ready ||
    !contractId || !StrKey.isValidContract(contractId) ||
    plan.controlPlane.commitment.status !== "awaiting_signature" ||
    binding.status !== "bound" ||
    binding.verifierVersion !== 2 ||
    !binding.routeId || !binding.publicInputsHash || !binding.proofSha256 ||
    !binding.nullifier || !binding.executionContextCommitment || !profile
  ) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_STATE_INVALID", "The workflow is not at its exact V2 commitment boundary.");
  }
  const readiness = await readStellarControlPlaneV2Readiness();
  if (!readiness.ready || readiness.configuration.controlPlane !== contractId) {
    throw controlled(
      "WORKFLOW_V4_CONTROL_PLANE_RUNTIME_DRIFT",
      "The live Intent Control Plane V2 no longer matches the sealed workflow.",
      503,
    );
  }
  const owner = stellarOwner(plan);
  const transactionResponse = await fetch(new URL(`/transactions/${transactionHash}`, STELLAR_TESTNET.horizonUrl), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!transactionResponse.ok) {
    throw controlled("WORKFLOW_V4_STELLAR_TRANSACTION_UNAVAILABLE", "The Stellar commitment is not confirmed yet.");
  }
  const transaction = await transactionResponse.json() as {
    readonly successful?: unknown;
    readonly source_account?: unknown;
    readonly ledger?: unknown;
  };
  if (transaction.successful !== true || transaction.source_account !== owner) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_TRANSACTION_REJECTED", "The Stellar transaction failed or its source changed.");
  }
  const operationsResponse = await fetch(
    new URL(`/transactions/${transactionHash}/operations`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!operationsResponse.ok) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_OPERATION_UNAVAILABLE", "The exact V2 invocation evidence is unavailable.");
  }
  const operationsBody = await operationsResponse.json() as {
    readonly _embedded?: {
      readonly records?: readonly {
        readonly type?: unknown;
        readonly source_account?: unknown;
        readonly parameters?: readonly { readonly type?: unknown; readonly value?: unknown }[];
      }[];
    };
  };
  const operations = operationsBody._embedded?.records;
  const operation = Array.isArray(operations) && operations.length === 1 ? operations[0] : null;
  const parameters = operation?.parameters;
  if (
    !operation || operation.type !== "invoke_host_function" || operation.source_account !== owner ||
    !Array.isArray(parameters) || parameters.length !== 20 ||
    parameters[0]?.type !== "Address" || parameters[1]?.type !== "Sym"
  ) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_INVOCATION_INVALID", "The transaction was not one exact V2 commit invocation.");
  }
  let invokedContract: string;
  let method: string;
  let args: unknown[];
  try {
    invokedContract = Address.fromScVal(xdr.ScVal.fromXdr(String(parameters[0]!.value), "base64")).toString();
    method = String(scValToNative(xdr.ScVal.fromXdr(String(parameters[1]!.value), "base64")));
    args = parameters.slice(2).map((parameter) =>
      scValToNative(xdr.ScVal.fromXdr(String(parameter.value), "base64")));
  } catch (error) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_INVOCATION_INVALID", "The V2 invocation could not be decoded.", 409, error);
  }
  if (invokedContract !== contractId || method !== "commit" || args.length !== 18) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_INVOCATION_MISMATCH", "The V2 contract, method or argument count changed.");
  }
  const [
    nativeOwner, nativeNonce, workflowRoot, policyRoot, protocolRoot, assetRoot, recipientRoot,
    selectedProtocolLeaf, selectedAssetLeaf, selectedRecipientLeaf, nullifier, executionContext,
    lane, executionExpiry, receiptClose, retentionFloor, verifierVersion, proof,
  ] = args;
  const expectedLeaves = selectedPolicyLeavesV4(plan, binding.routeId);
  const expectedWorkflowRoot = deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, binding.routeId);
  const nonce = uint(nativeNonce, "nonce");
  const executionExpiresAtLedger = Number(uint(executionExpiry, "execution expiry"));
  const receiptCloseByLedger = Number(uint(receiptClose, "receipt deadline"));
  const retentionFloorLedger = Number(uint(retentionFloor, "retention floor"));
  const proofBytes = proof instanceof Uint8Array ? proof : new Uint8Array();
  if (
    String(nativeOwner) !== owner ||
    bytes32(workflowRoot, "workflow root") !== expectedWorkflowRoot ||
    bytes32(policyRoot, "policy root") !== profile.policyRoot ||
    bytes32(protocolRoot, "protocol root") !== profile.protocolRegistryRoot ||
    bytes32(assetRoot, "asset root") !== profile.assetRegistryRoot ||
    bytes32(recipientRoot, "recipient root") !== profile.recipientPolicyRoot ||
    bytes32(selectedProtocolLeaf, "selected protocol leaf") !== expectedLeaves.selectedProtocolLeaf ||
    bytes32(selectedAssetLeaf, "selected asset leaf") !== expectedLeaves.selectedAssetLeaf ||
    bytes32(selectedRecipientLeaf, "selected recipient leaf") !== expectedLeaves.selectedRecipientLeaf ||
    bytes32(nullifier, "nullifier") !== binding.nullifier ||
    bytes32(executionContext, "execution context") !== binding.executionContextCommitment ||
    enumCase(lane) !== "Testnet" ||
    executionExpiresAtLedger !== profile.executionExpiresAtLedger ||
    !Number.isSafeInteger(receiptCloseByLedger) || !Number.isSafeInteger(retentionFloorLedger) ||
    executionExpiresAtLedger >= receiptCloseByLedger || receiptCloseByLedger >= retentionFloorLedger ||
    Number(uint(verifierVersion, "verifier version")) !== 2 ||
    proofBytes.length !== 256 || proofSha256(proofBytes) !== binding.proofSha256
  ) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_ARGUMENT_MISMATCH", "The confirmed V2 arguments differ from the bound policy proof.");
  }
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const rpcResult = await rpcServer.getTransaction(transactionHash);
  if (rpcResult.status !== "SUCCESS") {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_RPC_MISMATCH", "Stellar RPC did not confirm the V2 commitment.");
  }
  const events = rpcResult.events.contractEventsXdr.flat();
  const event = exactCommittedEvent({ events, contractId, owner, nonce });
  const committedAtLedger = Number(transaction.ledger ?? rpcResult.ledger);
  if (
    bytes32(event.workflow_root, "event workflow root") !== expectedWorkflowRoot ||
    bytes32(event.policy_root, "event policy root") !== profile.policyRoot ||
    bytes32(event.selected_protocol_leaf, "event protocol leaf") !== expectedLeaves.selectedProtocolLeaf ||
    bytes32(event.selected_asset_leaf, "event asset leaf") !== expectedLeaves.selectedAssetLeaf ||
    bytes32(event.selected_recipient_leaf, "event recipient leaf") !== expectedLeaves.selectedRecipientLeaf ||
    bytes32(event.nullifier, "event nullifier") !== binding.nullifier ||
    bytes32(event.public_inputs_hash, "event public inputs hash") !== binding.publicInputsHash ||
    Number(uint(event.verifier_version, "event verifier version")) !== 2 ||
    enumCase(event.lane) !== "Testnet" ||
    Number(uint(event.execution_expires_at_ledger, "event execution expiry")) !== executionExpiresAtLedger ||
    Number(uint(event.receipt_close_by_ledger, "event receipt deadline")) !== receiptCloseByLedger
  ) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_EVENT_MISMATCH", "The V2 event did not match the sealed policy and selected route.");
  }
  const state = await readWorkflowRecord({ owner, nonce, contractId });
  const record = state.record;
  if (
    String(record.owner) !== owner || uint(record.nonce, "record nonce") !== nonce ||
    bytes32(record.workflow_root, "record workflow root") !== expectedWorkflowRoot ||
    bytes32(record.policy_root, "record policy root") !== profile.policyRoot ||
    bytes32(record.protocol_registry_root, "record protocol root") !== profile.protocolRegistryRoot ||
    bytes32(record.asset_registry_root, "record asset root") !== profile.assetRegistryRoot ||
    bytes32(record.recipient_policy_root, "record recipient root") !== profile.recipientPolicyRoot ||
    bytes32(record.selected_protocol_leaf, "record protocol leaf") !== expectedLeaves.selectedProtocolLeaf ||
    bytes32(record.selected_asset_leaf, "record asset leaf") !== expectedLeaves.selectedAssetLeaf ||
    bytes32(record.selected_recipient_leaf, "record recipient leaf") !== expectedLeaves.selectedRecipientLeaf ||
    bytes32(record.nullifier, "record nullifier") !== binding.nullifier ||
    bytes32(record.execution_context_commitment, "record execution context") !== binding.executionContextCommitment ||
    bytes32(record.public_inputs_hash, "record public inputs hash") !== binding.publicInputsHash ||
    Number(uint(record.verifier_version, "record verifier version")) !== 2 ||
    enumCase(record.lane) !== "Testnet" || enumCase(record.status) !== "Active" || record.receipt_root !== null ||
    Number(uint(record.committed_at_ledger, "record ledger")) !== committedAtLedger ||
    Number(uint(record.execution_expires_at_ledger, "record expiry")) !== executionExpiresAtLedger ||
    Number(uint(record.receipt_close_by_ledger, "record receipt deadline")) !== receiptCloseByLedger ||
    Number(uint(record.retention_floor_ledger, "record retention floor")) !== retentionFloorLedger
  ) {
    throw controlled("WORKFLOW_V4_CONTROL_PLANE_STATE_MISMATCH", "The persisted V2 record did not match invocation and event evidence.");
  }
  await archiveVerifiedStellarTransaction({
    transactionHash,
    ledgerSequence: committedAtLedger,
    events: events.flatMap((candidate) => candidate.contractId === null ? [] : [{
      contractId: StrKey.encodeContract(Buffer.from(candidate.contractId.value)),
      eventXdr: candidate.toXdr("base64"),
    }]),
  });
  const next: WorkflowPlanV4 = {
    ...plan,
    controlPlane: {
      ...plan.controlPlane,
      commitment: {
        status: "confirmed",
        transactionHash,
        nonce: nonce.toString(),
        committedAtLedger: String(committedAtLedger),
        receiptCloseByLedger,
        retentionFloorLedger,
      },
    },
    executionGate: {
      signable: false,
      status: "exact_adapter_required",
      reasons: ["The Stellar V2 commitment is confirmed; the selected financial route still needs exact hydration, simulation and per-step wallet signatures."],
    },
  };
  const evidence = Object.freeze({
    schemaVersion: "kletia_control_plane_commit_evidence_v2" as const,
    transactionHash,
    owner,
    nonce: nonce.toString(),
    committedAtLedger: String(committedAtLedger),
    receiptCloseByLedger,
    retentionFloorLedger,
    observedStateAtLedger: String(state.observedAtLedger),
    contractId,
    level: "chain_native_verified" as const,
    externalExecutionTruthProven: false as const,
  });
  return { plan: next, evidence };
}
