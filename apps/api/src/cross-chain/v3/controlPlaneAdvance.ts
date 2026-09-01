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
import { readStellarControlPlaneReadiness } from "../../networks/stellar/controlPlaneReadiness.js";
import { archiveVerifiedStellarTransaction } from "../../networks/stellar/eventArchive.js";
import type {
  Bn254ScalarHex,
  WorkflowEvidenceV3,
  WorkflowPlanV3,
  WorkflowStepStatusV3,
  WorkflowStepV3,
} from "./types.js";

const TRANSACTION_HASH_PATTERN = /^[a-f\d]{64}$/u;

function controlled(code: string, message: string, statusCode = 409, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function bytes32(value: unknown, field: string): Bn254ScalarHex {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_VALUE_INVALID",
      `${field} was not an exact 32-byte value.`,
    );
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function uint(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (error) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_VALUE_INVALID",
      `${field} was not an unsigned integer.`,
      409,
      error,
    );
  }
}

function enumCase(value: unknown): string {
  if (Array.isArray(value) && value.length === 1) return String(value[0]);
  return String(value ?? "");
}

function proofSha256(value: Uint8Array): `0x${string}` {
  return `0x${createHash("sha256")
    .update("KLETIA_POLICY_PROOF_V1", "utf8")
    .update("\u001f", "utf8")
    .update(value)
    .digest("hex")}`;
}

function stellarOwner(plan: WorkflowPlanV3): string {
  const owner = plan.walletBindings.find(
    (binding) => binding.family === "stellar" && binding.network === "testnet",
  );
  if (!owner || !StrKey.isValidEd25519PublicKey(owner.address)) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_OWNER_MISSING",
      "The workflow is not bound to an exact Stellar Testnet owner.",
    );
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
    ) {
      return [];
    }
    const body = event.body.v0;
    if (body.topics.length !== 3) return [];
    try {
      const name = String(scValToNative(body.topics[0]));
      const owner = String(scValToNative(body.topics[1]));
      const nonce = uint(scValToNative(body.topics[2]), "event nonce");
      const data = scValToNative(body.data) as unknown;
      if (
        name !== "workflow_committed" ||
        owner !== input.owner ||
        nonce !== input.nonce ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
      ) {
        return [];
      }
      return [data as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  if (matches.length !== 1) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_EVENT_MISMATCH",
      "The transaction did not emit exactly one sealed workflow_committed event.",
    );
  }
  return matches[0]!;
}

function exactPolicyCommittedEvent(input: {
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
        String(scValToNative(body.topics[0])) !== "policy_committed" ||
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
      "WORKFLOW_V3_RECEIPT_REGISTRY_EVENT_MISMATCH",
      "The transaction did not emit exactly one sealed policy_committed event.",
    );
  }
  return matches[0]!;
}

function exactFinalizedEvent(input: {
  readonly events: readonly xdr.ContractEvent[];
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: bigint;
  readonly eventName: "policy_finalized" | "workflow_finalized";
}): Record<string, unknown> {
  const matches = input.events.flatMap((event) => {
    if (
      event.contractId === null ||
      StrKey.encodeContract(Buffer.from(event.contractId.value)) !== input.contractId ||
      event.type.name !== "contract" || event.body.type !== "v0"
    ) return [];
    const body = event.body.v0;
    if (body.topics.length !== 3) return [];
    try {
      const data = scValToNative(body.data) as unknown;
      if (
        String(scValToNative(body.topics[0])) !== input.eventName ||
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
      "WORKFLOW_V3_FINALIZATION_EVENT_MISMATCH",
      `The transaction did not emit exactly one sealed ${input.eventName} event.`,
    );
  }
  return matches[0]!;
}

async function readWorkflowRecord(input: {
  readonly owner: string;
  readonly nonce: bigint;
  readonly contractId: string;
}): Promise<{ readonly record: Record<string, unknown>; readonly observedAtLedger: number }> {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const account = await server.getAccount(input.owner);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(
      new Contract(input.contractId).call(
        "get",
        new Address(input.owner).toScVal(),
        nativeToScVal(input.nonce, { type: "u64" }),
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
      "WORKFLOW_V3_CONTROL_PLANE_STATE_UNAVAILABLE",
      "The committed workflow record could not be read from the pinned control plane.",
    );
  }
  const value = scValToNative(simulation.result.retval) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_STATE_MISSING",
      "The confirmed transaction did not create its sealed control-plane record.",
    );
  }
  return {
    record: value as Record<string, unknown>,
    observedAtLedger: simulation.latestLedger,
  };
}

function nextStatus(step: WorkflowStepV3, completed: ReadonlySet<string>): WorkflowStepStatusV3 {
  if (step.status === "confirmed" || step.status === "failed" || step.status === "refunded") {
    return step.status;
  }
  if (step.executionReadiness !== "ready") return "blocked";
  if (!step.dependsOn.every((dependency) => completed.has(dependency))) return "planned";
  return step.signer === "none" ? "ready" : "awaiting_signature";
}

export async function verifyAndApplyIntentControlPlaneCommitV3(
  plan: WorkflowPlanV3,
  step: WorkflowStepV3,
  transactionHashInput: unknown,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
  readonly result: {
    readonly schemaVersion: "kletia_control_plane_commit_result_v1";
    readonly transactionHash: string;
    readonly owner: string;
    readonly nonce: string;
    readonly committedAtLedger: string;
    readonly receiptCloseByLedger: number;
    readonly retentionFloorLedger: number;
    readonly externalExecutionTruthProven: false;
  };
}> {
  const transactionHash = String(transactionHashInput ?? "").trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
    throw controlled(
      "WORKFLOW_V3_STELLAR_TRANSACTION_HASH_INVALID",
      "A canonical Stellar transaction hash is required.",
      400,
    );
  }
  if (
    plan.lane !== "testnet" ||
    plan.controlPlane.required !== true ||
    plan.controlPlane.mode !== "stellar_intent_control_plane" ||
    plan.controlPlane.status !== "ready" ||
    plan.controlPlane.proofBinding.status !== "bound" ||
    plan.controlPlane.commitment.status !== "awaiting_signature" ||
    plan.currentStepId !== step.id ||
    step.operation !== "control_plane_commit" ||
    step.protocol !== "kletia-intent-control-plane" ||
    step.chain.key !== "stellar_testnet" ||
    step.method !== "commit" ||
    !step.target ||
    !StrKey.isValidContract(step.target)
  ) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_STEP_INVALID",
      "The workflow is not at its exact Stellar control-plane commit boundary.",
    );
  }
  const readiness = await readStellarControlPlaneReadiness("testnet");
  const runtime = readiness.contracts.find((candidate) => candidate.key === "intentControlPlane");
  if (!readiness.ready || !runtime?.ready || runtime.contractId !== step.target) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_RUNTIME_DRIFT",
      "The live Intent Control Plane no longer matches the sealed deployment.",
      503,
    );
  }
  const owner = stellarOwner(plan);
  const transactionResponse = await fetch(
    new URL(`/transactions/${transactionHash}`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!transactionResponse.ok) {
    throw controlled(
      "WORKFLOW_V3_STELLAR_TRANSACTION_UNAVAILABLE",
      "The Stellar control-plane transaction is not confirmed yet.",
    );
  }
  const transaction = await transactionResponse.json() as {
    readonly successful?: unknown;
    readonly source_account?: unknown;
    readonly ledger?: unknown;
  };
  if (transaction.successful !== true || transaction.source_account !== owner) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_TRANSACTION_REJECTED",
      "The Stellar transaction failed or its source account changed.",
    );
  }
  const operationsResponse = await fetch(
    new URL(`/transactions/${transactionHash}/operations`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!operationsResponse.ok) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_OPERATION_UNAVAILABLE",
      "The exact Stellar operation evidence is unavailable.",
    );
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
  if (!Array.isArray(operations) || operations.length !== 1) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_OPERATION_SHAPE_INVALID",
      "The control-plane transaction must contain one exact contract invocation.",
    );
  }
  const operation = operations[0]!;
  const parameters = operation.parameters;
  if (
    operation.type !== "invoke_host_function" ||
    operation.source_account !== owner ||
    !Array.isArray(parameters) ||
    parameters.length !== 17 ||
    parameters[0]?.type !== "Address" ||
    parameters[1]?.type !== "Sym"
  ) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_INVOCATION_INVALID",
      "The control-plane invocation shape did not match the sealed workflow.",
    );
  }
  let contractId: string;
  let method: string;
  let args: unknown[];
  try {
    contractId = Address.fromScVal(
      xdr.ScVal.fromXdr(String(parameters[0]!.value), "base64"),
    ).toString();
    method = String(scValToNative(xdr.ScVal.fromXdr(String(parameters[1]!.value), "base64")));
    args = parameters.slice(2).map((parameter) =>
      scValToNative(xdr.ScVal.fromXdr(String(parameter.value), "base64")),
    );
  } catch (error) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_INVOCATION_INVALID",
      "The control-plane invocation parameters could not be decoded.",
      409,
      error,
    );
  }
  if (contractId !== step.target || method !== "commit" || args.length !== 15) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_INVOCATION_MISMATCH",
      "The Stellar contract, method or argument count changed after sealing.",
    );
  }
  const binding = plan.controlPlane.proofBinding;
  const [
    nativeOwner,
    nativeNonce,
    workflowRoot,
    policyRoot,
    protocolRoot,
    assetRoot,
    recipientRoot,
    nullifier,
    executionContext,
    lane,
    executionExpiry,
    receiptClose,
    retentionFloor,
    verifierVersion,
    proof,
  ] = args;
  const nonce = uint(nativeNonce, "nonce");
  const executionExpiresAtLedger = Number(uint(executionExpiry, "execution expiry"));
  const receiptCloseByLedger = Number(uint(receiptClose, "receipt deadline"));
  const retentionFloorLedger = Number(uint(retentionFloor, "retention floor"));
  const proofBytes = proof instanceof Uint8Array ? proof : new Uint8Array();
  if (
    String(nativeOwner) !== owner ||
    bytes32(workflowRoot, "workflow root") !== plan.controlPlane.workflowRoot ||
    bytes32(policyRoot, "policy root") !== plan.controlPlane.policyRoot ||
    bytes32(protocolRoot, "protocol registry root") !== binding.protocolRegistryRoot ||
    bytes32(assetRoot, "asset registry root") !== binding.assetRegistryRoot ||
    bytes32(recipientRoot, "recipient policy root") !== binding.recipientPolicyRoot ||
    bytes32(nullifier, "nullifier") !== plan.controlPlane.nullifier ||
    bytes32(executionContext, "execution context") !== binding.executionContextCommitment ||
    enumCase(lane) !== "Testnet" ||
    executionExpiresAtLedger !== binding.executionExpiresAtLedger ||
    !Number.isSafeInteger(receiptCloseByLedger) ||
    !Number.isSafeInteger(retentionFloorLedger) ||
    executionExpiresAtLedger >= receiptCloseByLedger ||
    receiptCloseByLedger >= retentionFloorLedger ||
    Number(uint(verifierVersion, "verifier version")) !== binding.verifierVersion ||
    proofBytes.length !== 256 ||
    proofSha256(proofBytes) !== binding.proofSha256
  ) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_ARGUMENT_MISMATCH",
      "The confirmed control-plane arguments did not match the server-verified device policy.",
    );
  }
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const rpcResult = await rpcServer.getTransaction(transactionHash);
  if (rpcResult.status !== "SUCCESS") {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_RPC_MISMATCH",
      "Stellar RPC did not confirm the control-plane transaction.",
    );
  }
  const events = rpcResult.events.contractEventsXdr.flat();
  const event = exactCommittedEvent({ events, contractId: step.target, owner, nonce });
  const committedAtLedger = Number(transaction.ledger ?? rpcResult.ledger);
  if (
    bytes32(event.workflow_root, "event workflow root") !== plan.controlPlane.workflowRoot ||
    bytes32(event.policy_root, "event policy root") !== plan.controlPlane.policyRoot ||
    bytes32(event.nullifier, "event nullifier") !== plan.controlPlane.nullifier ||
    bytes32(event.public_inputs_hash, "event public inputs hash") !== binding.publicInputsHash ||
    Number(uint(event.verifier_version, "event verifier version")) !== binding.verifierVersion ||
    enumCase(event.lane) !== "Testnet" ||
    Number(uint(event.execution_expires_at_ledger, "event execution expiry")) !== executionExpiresAtLedger ||
    Number(uint(event.receipt_close_by_ledger, "event receipt deadline")) !== receiptCloseByLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_EVENT_MISMATCH",
      "The workflow_committed event did not match the exact sealed policy.",
    );
  }
  const state = await readWorkflowRecord({ owner, nonce, contractId: step.target });
  const record = state.record;
  if (
    String(record.owner) !== owner ||
    uint(record.nonce, "record nonce") !== nonce ||
    bytes32(record.workflow_root, "record workflow root") !== plan.controlPlane.workflowRoot ||
    bytes32(record.policy_root, "record policy root") !== plan.controlPlane.policyRoot ||
    bytes32(record.nullifier, "record nullifier") !== plan.controlPlane.nullifier ||
    bytes32(record.public_inputs_hash, "record public inputs hash") !== binding.publicInputsHash ||
    Number(uint(record.verifier_version, "record verifier version")) !== binding.verifierVersion ||
    enumCase(record.lane) !== "Testnet" ||
    enumCase(record.status) !== "Active" ||
    record.receipt_root !== null ||
    Number(uint(record.committed_at_ledger, "record commit ledger")) !== committedAtLedger ||
    Number(uint(record.execution_expires_at_ledger, "record execution expiry")) !== executionExpiresAtLedger ||
    Number(uint(record.receipt_close_by_ledger, "record receipt deadline")) !== receiptCloseByLedger ||
    Number(uint(record.retention_floor_ledger, "record retention floor")) !== retentionFloorLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_CONTROL_PLANE_STATE_MISMATCH",
      "The persisted Stellar workflow record did not match the confirmed invocation and event.",
    );
  }
  const selectedRoute = plan.routes.find((route) => route.id === plan.selectedRouteId);
  if (!selectedRoute) {
    throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The selected workflow route is missing.");
  }
  const completed = new Set(
    selectedRoute.steps
      .filter((candidate) => candidate.status === "confirmed" || candidate.id === step.id)
      .map((candidate) => candidate.id),
  );
  const routes = plan.routes.map((route) => route.id !== selectedRoute.id
    ? route
    : {
        ...route,
        steps: route.steps.map((candidate) => candidate.id === step.id
          ? { ...candidate, status: "confirmed" as const }
          : { ...candidate, status: nextStatus(candidate, completed) }),
      });
  const updatedRoute = routes.find((route) => route.id === selectedRoute.id)!;
  const next = updatedRoute.steps.find(
    (candidate) => candidate.status === "ready" || candidate.status === "awaiting_signature",
  );
  const archivedEvents = events.flatMap((candidate) => candidate.contractId === null
    ? []
    : [{
        contractId: StrKey.encodeContract(Buffer.from(candidate.contractId.value)),
        eventXdr: candidate.toXdr("base64"),
      }]);
  await archiveVerifiedStellarTransaction({
    transactionHash,
    ledgerSequence: committedAtLedger,
    events: archivedEvents,
  });
  const nextPlan: WorkflowPlanV3 = {
    ...plan,
    routes,
    currentStepId: next?.id ?? null,
    controlPlane: {
      ...plan.controlPlane,
      commitment: {
        status: "confirmed",
        owner,
        nonce: nonce.toString(),
        transactionHash,
        committedAtLedger: String(committedAtLedger),
        receiptCloseByLedger,
        retentionFloorLedger,
      },
      receiptRegistry: {
        ...plan.controlPlane.receiptRegistry,
        status: "awaiting_signature",
      },
    },
  };
  const result = {
    schemaVersion: "kletia_control_plane_commit_result_v1" as const,
    transactionHash,
    owner,
    nonce: nonce.toString(),
    committedAtLedger: String(committedAtLedger),
    receiptCloseByLedger,
    retentionFloorLedger,
    externalExecutionTruthProven: false as const,
  };
  return {
    plan: nextPlan,
    result,
    evidence: {
      stepId: step.id,
      kind: "stellar_ledger",
      reference: transactionHash,
      level: "chain_native_verified",
      observedAt: new Date().toISOString(),
      chain: step.chain,
      details: {
        ...result,
        controlPlaneContractId: step.target,
        observedStateAtLedger: String(state.observedAtLedger),
        proofPersisted: false,
      },
    },
  };
}

export async function verifyAndApplyReceiptRegistryCommitV3(
  plan: WorkflowPlanV3,
  step: WorkflowStepV3,
  transactionHashInput: unknown,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
  readonly result: {
    readonly schemaVersion: "kletia_receipt_registry_commit_result_v1";
    readonly transactionHash: string;
    readonly owner: string;
    readonly nonce: string;
    readonly committedAtLedger: string;
    readonly externalExecutionTruthProven: false;
  };
}> {
  const transactionHash = String(transactionHashInput ?? "").trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
    throw controlled(
      "WORKFLOW_V3_STELLAR_TRANSACTION_HASH_INVALID",
      "A canonical Stellar transaction hash is required.",
      400,
    );
  }
  const lifecycle = plan.controlPlane.commitment;
  if (
    plan.lane !== "testnet" ||
    plan.controlPlane.required !== true ||
    plan.controlPlane.proofBinding.status !== "bound" ||
    lifecycle.status !== "confirmed" ||
    lifecycle.receiptCloseByLedger === null ||
    lifecycle.retentionFloorLedger === null ||
    plan.controlPlane.receiptRegistry.status !== "awaiting_signature" ||
    plan.currentStepId !== step.id ||
    step.operation !== "receipt_registry_commit" ||
    step.protocol !== "kletia-policy-receipt-registry" ||
    step.chain.key !== "stellar_testnet" ||
    step.method !== "commit" ||
    !step.target || !StrKey.isValidContract(step.target)
  ) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_STEP_INVALID",
      "The workflow is not at its exact Stellar receipt-registry commit boundary.",
    );
  }
  const readiness = await readStellarControlPlaneReadiness("testnet");
  const runtime = readiness.contracts.find((candidate) => candidate.key === "policyReceiptRegistry");
  if (!readiness.ready || !runtime?.ready || runtime.contractId !== step.target) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_RUNTIME_DRIFT",
      "The live receipt registry no longer matches the sealed deployment.",
      503,
    );
  }
  const owner = stellarOwner(plan);
  const transactionResponse = await fetch(
    new URL(`/transactions/${transactionHash}`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!transactionResponse.ok) {
    throw controlled(
      "WORKFLOW_V3_STELLAR_TRANSACTION_UNAVAILABLE",
      "The Stellar receipt-registry transaction is not confirmed yet.",
    );
  }
  const transaction = await transactionResponse.json() as {
    readonly successful?: unknown;
    readonly source_account?: unknown;
    readonly ledger?: unknown;
  };
  if (transaction.successful !== true || transaction.source_account !== owner) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_TRANSACTION_REJECTED",
      "The receipt-registry transaction failed or its source account changed.",
    );
  }
  const operationsResponse = await fetch(
    new URL(`/transactions/${transactionHash}/operations`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  const operationsBody = operationsResponse.ok
    ? await operationsResponse.json() as {
        readonly _embedded?: {
          readonly records?: readonly {
            readonly type?: unknown;
            readonly source_account?: unknown;
            readonly parameters?: readonly { readonly type?: unknown; readonly value?: unknown }[];
          }[];
        };
      }
    : null;
  const operations = operationsBody?._embedded?.records;
  if (!Array.isArray(operations) || operations.length !== 1) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_OPERATION_SHAPE_INVALID",
      "The receipt-registry transaction must contain one exact contract invocation.",
    );
  }
  const operation = operations[0]!;
  const parameters = operation.parameters;
  if (
    operation.type !== "invoke_host_function" ||
    operation.source_account !== owner ||
    !Array.isArray(parameters) || parameters.length !== 9 ||
    parameters[0]?.type !== "Address" || parameters[1]?.type !== "Sym"
  ) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_INVOCATION_INVALID",
      "The receipt-registry invocation shape did not match the sealed workflow.",
    );
  }
  let contractId: string;
  let method: string;
  let args: unknown[];
  try {
    contractId = Address.fromScVal(
      xdr.ScVal.fromXdr(String(parameters[0]!.value), "base64"),
    ).toString();
    method = String(scValToNative(xdr.ScVal.fromXdr(String(parameters[1]!.value), "base64")));
    args = parameters.slice(2).map((parameter) =>
      scValToNative(xdr.ScVal.fromXdr(String(parameter.value), "base64")),
    );
  } catch (error) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_INVOCATION_INVALID",
      "The receipt-registry invocation parameters could not be decoded.",
      409,
      error,
    );
  }
  if (contractId !== step.target || method !== "commit" || args.length !== 7) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_INVOCATION_MISMATCH",
      "The receipt-registry contract, method or arguments changed after sealing.",
    );
  }
  const [nativeOwner, nativeNonce, manifestHash, budgetHash, executionExpiry, receiptClose, retentionFloor] = args;
  const nonce = uint(nativeNonce, "nonce");
  const executionExpiresAtLedger = Number(uint(executionExpiry, "execution expiry"));
  const receiptCloseByLedger = Number(uint(receiptClose, "receipt deadline"));
  const retentionFloorLedger = Number(uint(retentionFloor, "retention floor"));
  if (
    String(nativeOwner) !== owner ||
    bytes32(manifestHash, "planning policy commitment") !== plan.controlPlane.planningPolicyCommitment ||
    bytes32(budgetHash, "privacy budget commitment") !== plan.controlPlane.privacyBudgetCommitment ||
    executionExpiresAtLedger !== plan.controlPlane.proofBinding.executionExpiresAtLedger ||
    receiptCloseByLedger !== lifecycle.receiptCloseByLedger ||
    retentionFloorLedger !== lifecycle.retentionFloorLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_ARGUMENT_MISMATCH",
      "The confirmed receipt-registry arguments did not match the sealed policy lifecycle.",
    );
  }
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const rpcResult = await rpcServer.getTransaction(transactionHash);
  if (rpcResult.status !== "SUCCESS") {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_RPC_MISMATCH",
      "Stellar RPC did not confirm the receipt-registry transaction.",
    );
  }
  const events = rpcResult.events.contractEventsXdr.flat();
  const event = exactPolicyCommittedEvent({ events, contractId: step.target, owner, nonce });
  const committedAtLedger = Number(transaction.ledger ?? rpcResult.ledger);
  if (
    bytes32(event.manifest_hash, "event manifest hash") !== plan.controlPlane.planningPolicyCommitment ||
    bytes32(event.privacy_budget_hash, "event privacy budget hash") !== plan.controlPlane.privacyBudgetCommitment ||
    Number(uint(event.execution_expires_at_ledger, "event execution expiry")) !== executionExpiresAtLedger ||
    Number(uint(event.receipt_close_by_ledger, "event receipt deadline")) !== receiptCloseByLedger ||
    Number(uint(event.retention_floor_ledger, "event retention floor")) !== retentionFloorLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_EVENT_MISMATCH",
      "The policy_committed event did not match the exact workflow lifecycle.",
    );
  }
  const state = await readWorkflowRecord({ owner, nonce, contractId: step.target });
  const record = state.record;
  if (
    String(record.owner) !== owner ||
    uint(record.nonce, "record nonce") !== nonce ||
    bytes32(record.manifest_hash, "record manifest hash") !== plan.controlPlane.planningPolicyCommitment ||
    bytes32(record.privacy_budget_hash, "record budget hash") !== plan.controlPlane.privacyBudgetCommitment ||
    record.receipt_hash !== null ||
    enumCase(record.status) !== "Active" ||
    Number(uint(record.committed_at_ledger, "record commit ledger")) !== committedAtLedger ||
    Number(uint(record.execution_expires_at_ledger, "record execution expiry")) !== executionExpiresAtLedger ||
    Number(uint(record.receipt_close_by_ledger, "record receipt deadline")) !== receiptCloseByLedger ||
    Number(uint(record.retention_floor_ledger, "record retention floor")) !== retentionFloorLedger
  ) {
    throw controlled(
      "WORKFLOW_V3_RECEIPT_REGISTRY_STATE_MISMATCH",
      "The persisted receipt-registry record did not match its transaction and event.",
    );
  }
  const selectedRoute = plan.routes.find((route) => route.id === plan.selectedRouteId);
  if (!selectedRoute) throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The selected route is missing.");
  const completed = new Set(
    selectedRoute.steps
      .filter((candidate) => candidate.status === "confirmed" || candidate.id === step.id)
      .map((candidate) => candidate.id),
  );
  const routes = plan.routes.map((route) => route.id !== selectedRoute.id
    ? route
    : {
        ...route,
        steps: route.steps.map((candidate) => candidate.id === step.id
          ? { ...candidate, status: "confirmed" as const }
          : { ...candidate, status: nextStatus(candidate, completed) }),
      });
  const updatedRoute = routes.find((route) => route.id === selectedRoute.id)!;
  const next = updatedRoute.steps.find(
    (candidate) => candidate.status === "ready" || candidate.status === "awaiting_signature",
  );
  const archivedEvents = events.flatMap((candidate) => candidate.contractId === null
    ? []
    : [{
        contractId: StrKey.encodeContract(Buffer.from(candidate.contractId.value)),
        eventXdr: candidate.toXdr("base64"),
      }]);
  await archiveVerifiedStellarTransaction({
    transactionHash,
    ledgerSequence: committedAtLedger,
    events: archivedEvents,
  });
  const nextPlan: WorkflowPlanV3 = {
    ...plan,
    routes,
    currentStepId: next?.id ?? null,
    controlPlane: {
      ...plan.controlPlane,
      receiptRegistry: {
        status: "confirmed",
        owner,
        nonce: nonce.toString(),
        transactionHash,
        committedAtLedger: String(committedAtLedger),
      },
    },
  };
  const result = {
    schemaVersion: "kletia_receipt_registry_commit_result_v1" as const,
    transactionHash,
    owner,
    nonce: nonce.toString(),
    committedAtLedger: String(committedAtLedger),
    externalExecutionTruthProven: false as const,
  };
  return {
    plan: nextPlan,
    result,
    evidence: {
      stepId: step.id,
      kind: "stellar_ledger",
      reference: transactionHash,
      level: "chain_native_verified",
      observedAt: new Date().toISOString(),
      chain: step.chain,
      details: {
        ...result,
        receiptRegistryContractId: step.target,
        observedStateAtLedger: String(state.observedAtLedger),
      },
    },
  };
}

export async function verifyAndApplyControlPlaneFinalizationV3(
  plan: WorkflowPlanV3,
  step: WorkflowStepV3,
  transactionHashInput: unknown,
): Promise<{
  readonly plan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
  readonly result: {
    readonly schemaVersion: "kletia_control_plane_finalization_result_v1";
    readonly operation: "receipt_registry_finalize" | "control_plane_finalize";
    readonly transactionHash: string;
    readonly receiptRoot: `0x${string}`;
    readonly owner: string;
    readonly nonce: string;
    readonly finalizedAtLedger: string;
    readonly externalExecutionTruthProven: false;
  };
}> {
  const transactionHash = String(transactionHashInput ?? "").trim().toLowerCase();
  const receiptRoot = plan.compatibility?.terminalReceiptSha256;
  const registryFinalize = step.operation === "receipt_registry_finalize";
  const lifecycle = registryFinalize
    ? plan.controlPlane.receiptRegistry
    : plan.controlPlane.commitment;
  if (
    !TRANSACTION_HASH_PATTERN.test(transactionHash) ||
    !receiptRoot || !/^0x[a-f\d]{64}$/u.test(receiptRoot) ||
    plan.compatibility?.status !== "completed" ||
    plan.controlPlane.externalExecutionTruthProven !== false ||
    plan.currentStepId !== step.id ||
    (step.operation !== "receipt_registry_finalize" && step.operation !== "control_plane_finalize") ||
    step.chain.key !== "stellar_testnet" || step.method !== "finalize" ||
    step.receiptBinding !== "workflow_receipt_root" ||
    !step.target || !StrKey.isValidContract(step.target) ||
    lifecycle.status !== "confirmed" || !lifecycle.owner || lifecycle.nonce === null ||
    (!registryFinalize && plan.controlPlane.receiptRegistry.status !== "finalized")
  ) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_STEP_INVALID",
      "The workflow is not at an exact owner-signed terminal receipt finalization boundary.",
    );
  }
  const readiness = await readStellarControlPlaneReadiness("testnet");
  const runtimeKey = registryFinalize ? "policyReceiptRegistry" : "intentControlPlane";
  const runtime = readiness.contracts.find((candidate) => candidate.key === runtimeKey);
  if (!readiness.ready || !runtime?.ready || runtime.contractId !== step.target) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_RUNTIME_DRIFT",
      "The live finalization contract no longer matches the sealed deployment.",
      503,
    );
  }
  const owner = stellarOwner(plan);
  if (owner !== lifecycle.owner) {
    throw controlled("WORKFLOW_V3_FINALIZATION_OWNER_MISMATCH", "The finalization owner changed after commit.");
  }
  const nonce = uint(lifecycle.nonce, "finalization nonce");
  const transactionResponse = await fetch(
    new URL(`/transactions/${transactionHash}`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  if (!transactionResponse.ok) {
    throw controlled(
      "WORKFLOW_V3_STELLAR_TRANSACTION_UNAVAILABLE",
      "The Stellar finalization transaction is not confirmed yet.",
    );
  }
  const transaction = await transactionResponse.json() as {
    readonly successful?: unknown;
    readonly source_account?: unknown;
    readonly ledger?: unknown;
  };
  if (transaction.successful !== true || transaction.source_account !== owner) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_TRANSACTION_REJECTED",
      "The finalization transaction failed or its source account changed.",
    );
  }
  const operationsResponse = await fetch(
    new URL(`/transactions/${transactionHash}/operations`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
  );
  const operationsBody = operationsResponse.ok
    ? await operationsResponse.json() as {
        readonly _embedded?: { readonly records?: readonly {
          readonly type?: unknown;
          readonly source_account?: unknown;
          readonly parameters?: readonly { readonly type?: unknown; readonly value?: unknown }[];
        }[] };
      }
    : null;
  const operations = operationsBody?._embedded?.records;
  const operation = Array.isArray(operations) && operations.length === 1
    ? operations[0]
    : undefined;
  const parameters = operation?.parameters;
  if (
    operation?.type !== "invoke_host_function" || operation.source_account !== owner ||
    !Array.isArray(parameters) || parameters.length !== 5 ||
    parameters[0]?.type !== "Address" || parameters[1]?.type !== "Sym"
  ) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_INVOCATION_INVALID",
      "The finalization transaction must contain one exact contract invocation.",
    );
  }
  let contractId: string;
  let method: string;
  let args: unknown[];
  try {
    contractId = Address.fromScVal(
      xdr.ScVal.fromXdr(String(parameters[0]!.value), "base64"),
    ).toString();
    method = String(scValToNative(xdr.ScVal.fromXdr(String(parameters[1]!.value), "base64")));
    args = parameters.slice(2).map((parameter) =>
      scValToNative(xdr.ScVal.fromXdr(String(parameter.value), "base64")),
    );
  } catch (error) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_INVOCATION_INVALID",
      "The finalization invocation could not be decoded.",
      409,
      error,
    );
  }
  if (
    contractId !== step.target || method !== "finalize" || args.length !== 3 ||
    String(args[0]) !== owner || uint(args[1], "finalization nonce") !== nonce ||
    bytes32(args[2], "terminal receipt root") !== receiptRoot
  ) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_ARGUMENT_MISMATCH",
      "The finalization call did not bind the exact owner, nonce and terminal receipt root.",
    );
  }
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const rpcResult = await rpcServer.getTransaction(transactionHash);
  if (rpcResult.status !== "SUCCESS") {
    throw controlled("WORKFLOW_V3_FINALIZATION_RPC_MISMATCH", "Stellar RPC did not confirm finalization.");
  }
  const events = rpcResult.events.contractEventsXdr.flat();
  const eventName = registryFinalize ? "policy_finalized" as const : "workflow_finalized" as const;
  const event = exactFinalizedEvent({ events, contractId: step.target, owner, nonce, eventName });
  const receiptField = registryFinalize ? "receipt_hash" : "receipt_root";
  const finalizedAtLedger = Number(uint(event.finalized_at_ledger, "finalized ledger"));
  if (
    bytes32(event[receiptField], "event receipt root") !== receiptRoot ||
    finalizedAtLedger !== Number(transaction.ledger ?? rpcResult.ledger)
  ) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_EVENT_MISMATCH",
      "The finalization event did not match the exact receipt root and ledger.",
    );
  }
  const state = await readWorkflowRecord({ owner, nonce, contractId: step.target });
  const record = state.record;
  if (
    String(record.owner) !== owner || uint(record.nonce, "record nonce") !== nonce ||
    enumCase(record.status) !== "Finalized" ||
    bytes32(record[receiptField], "stored receipt root") !== receiptRoot
  ) {
    throw controlled(
      "WORKFLOW_V3_FINALIZATION_STATE_MISMATCH",
      "The persisted finalization record did not match the transaction and event.",
    );
  }
  const selectedRoute = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
  if (!selectedRoute) throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The selected route is missing.");
  const completed = new Set(
    selectedRoute.steps
      .filter((candidate) => candidate.status === "confirmed" || candidate.id === step.id)
      .map((candidate) => candidate.id),
  );
  const routes = plan.routes.map((route) => route.id !== selectedRoute.id
    ? route
    : {
        ...route,
        steps: route.steps.map((candidate) => candidate.id === step.id
          ? { ...candidate, status: "confirmed" as const }
          : { ...candidate, status: nextStatus(candidate, completed) }),
      });
  const updatedRoute = routes.find((candidate) => candidate.id === selectedRoute.id)!;
  const next = updatedRoute.steps.find(
    (candidate) => candidate.status === "ready" || candidate.status === "awaiting_signature",
  );
  const nextPlan: WorkflowPlanV3 = {
    ...plan,
    routes,
    currentStepId: next?.id ?? null,
    controlPlane: registryFinalize
      ? {
          ...plan.controlPlane,
          receiptRegistry: {
            ...plan.controlPlane.receiptRegistry,
            status: "finalized" as const,
            receiptRoot,
            finalizedTransactionHash: transactionHash,
            finalizedAtLedger: String(finalizedAtLedger),
          },
        }
      : {
          ...plan.controlPlane,
          commitment: {
            ...plan.controlPlane.commitment,
            status: "finalized" as const,
            receiptRoot,
            finalizedTransactionHash: transactionHash,
            finalizedAtLedger: String(finalizedAtLedger),
          },
        },
  };
  const archivedEvents = events.flatMap((candidate) => candidate.contractId === null
    ? []
    : [{
        contractId: StrKey.encodeContract(Buffer.from(candidate.contractId.value)),
        eventXdr: candidate.toXdr("base64"),
      }]);
  await archiveVerifiedStellarTransaction({
    transactionHash,
    ledgerSequence: finalizedAtLedger,
    events: archivedEvents,
  });
  const result = {
    schemaVersion: "kletia_control_plane_finalization_result_v1" as const,
    operation: step.operation,
    transactionHash,
    receiptRoot,
    owner,
    nonce: nonce.toString(),
    finalizedAtLedger: String(finalizedAtLedger),
    externalExecutionTruthProven: false as const,
  };
  return {
    plan: nextPlan,
    result,
    evidence: {
      stepId: step.id,
      kind: "stellar_ledger",
      reference: transactionHash,
      level: "chain_native_verified",
      observedAt: new Date().toISOString(),
      chain: step.chain,
      details: {
        ...result,
        observedStateAtLedger: String(state.observedAtLedger),
        limitation: "Stellar confirms only the owner-authorized receipt root and lifecycle closure, not foreign-chain truth.",
      },
    },
  };
}
