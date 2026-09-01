import { createHash } from "node:crypto";
import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { assertStellarAccount, STELLAR_TESTNET } from "./config.js";
import { STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256 } from "./policyRegistryManifest.js";
import { assertStellarPolicyRegistryReady } from "./policyRegistryReadiness.js";

const COMMITMENT_PATTERN = /^0x[a-f0-9]{64}$/u;
const EXECUTION_WINDOW_LEDGERS = 17_280;
const RECEIPT_WINDOW_LEDGERS = 120_960;
const RETENTION_WINDOW_LEDGERS = 241_920;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): `0x${string}` {
  return `0x${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function commitment(value: unknown, field: string): `0x${string}` {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    !COMMITMENT_PATTERN.test(normalized) ||
    normalized === `0x${"00".repeat(32)}`
  ) {
    throw controlled(
      "STELLAR_POLICY_COMMITMENT_INVALID",
      `${field} must be a non-zero, browser-generated 32-byte blinded commitment.`,
      400,
    );
  }
  return normalized as `0x${string}`;
}

function bytes32ScVal(value: `0x${string}`): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(value.slice(2), "hex"));
}

function normalizeEnum(value: unknown, field: string): string {
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  ) {
    return value[0];
  }
  if (typeof value === "string") return value;
  throw controlled(
    "STELLAR_POLICY_REGISTRY_STATE_INVALID",
    `The policy registry returned an invalid ${field}.`,
    503,
  );
}

function bytes32Hex(value: unknown, field: string): `0x${string}` {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_STATE_INVALID",
      `The policy registry returned an invalid ${field}.`,
      503,
    );
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function integer(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_STATE_INVALID",
      `The policy registry returned an invalid ${field}.`,
      503,
    );
  }
}

async function simulateInvocation(input: {
  contractId: string;
  source: string;
  method: string;
  args: readonly xdr.ScVal[];
  authMode?: "record" | "enforce";
}) {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 8_000 });
  let account;
  try {
    account = await server.getAccount(input.source);
  } catch {
    throw controlled(
      "STELLAR_POLICY_OWNER_UNAVAILABLE",
      "The Stellar policy owner account could not be observed on Testnet.",
      503,
    );
  }
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(input.contractId).call(input.method, ...input.args))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(
    transaction,
    undefined,
    input.authMode,
  );
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw controlled(
      rpc.Api.isSimulationRestore(simulation)
        ? "STELLAR_POLICY_REGISTRY_RESTORE_REQUIRED"
        : "STELLAR_POLICY_REGISTRY_SIMULATION_FAILED",
      rpc.Api.isSimulationRestore(simulation)
        ? "Policy registry state requires an explicit footprint restoration before this call can be prepared."
        : `The exact ${input.method} invocation did not pass Stellar recording simulation.`,
      rpc.Api.isSimulationRestore(simulation) ? 409 : 503,
    );
  }
  return {
    latestLedger: simulation.latestLedger,
    value: scValToNative(simulation.result.retval) as unknown,
    authorizationCount: simulation.result.auth.length,
  };
}

async function readMethod(
  contractId: string,
  owner: string,
  method: string,
  args: readonly xdr.ScVal[],
) {
  return simulateInvocation({ contractId, source: owner, method, args });
}

export interface StellarPolicyRegistryRecordState {
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: string;
  readonly policyCommitment: `0x${string}`;
  readonly privacyBudgetCommitment: `0x${string}`;
  readonly receiptHash: `0x${string}` | null;
  readonly recordStatus: "Active" | "Finalized" | "Cancelled";
  readonly effectiveStatus:
    | "Active"
    | "ExecutionExpiredAwaitingReceipt"
    | "ReceiptWindowClosed"
    | "Finalized"
    | "Cancelled";
  readonly committedAtLedger: number;
  readonly executionExpiresAtLedger: number;
  readonly receiptCloseByLedger: number;
  readonly updatedAtLedger: number;
  readonly retentionFloorLedger: number;
  readonly nextNonce: string;
  readonly active: boolean;
  readonly canFinalize: boolean;
  readonly observedAtLedger: number;
}

export async function readStellarPolicyRegistryRecord(input: {
  owner: unknown;
  nonce: string | bigint;
}): Promise<StellarPolicyRegistryRecordState | null> {
  const readiness = await assertStellarPolicyRegistryReady();
  const owner = assertStellarAccount(input.owner);
  const nonce = integer(input.nonce, "nonce");
  const ownerArg = new Address(owner).toScVal();
  const nonceArg = nativeToScVal(nonce, { type: "u64" });
  const [recordRead, statusRead, activeRead, finalizeRead, nonceRead] =
    await Promise.all([
      readMethod(readiness.contractId, owner, "get", [ownerArg, nonceArg]),
      readMethod(readiness.contractId, owner, "effective_status", [ownerArg, nonceArg]),
      readMethod(readiness.contractId, owner, "is_active", [ownerArg, nonceArg]),
      readMethod(readiness.contractId, owner, "can_finalize", [ownerArg, nonceArg]),
      readMethod(readiness.contractId, owner, "next_nonce", [ownerArg]),
    ]);
  if (recordRead.value === null) return null;
  if (
    !recordRead.value ||
    typeof recordRead.value !== "object" ||
    Array.isArray(recordRead.value)
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_STATE_INVALID",
      "The policy registry record had an invalid shape.",
      503,
    );
  }
  const record = recordRead.value as Record<string, unknown>;
  const recordOwner = String(record.owner ?? "");
  const recordNonce = integer(record.nonce, "record nonce");
  if (recordOwner !== owner || recordNonce !== nonce) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_STATE_MISMATCH",
      "The policy registry record identity did not match the requested owner and nonce.",
      409,
    );
  }
  const recordStatus = normalizeEnum(record.status, "record status");
  const effectiveStatus = normalizeEnum(statusRead.value, "effective status");
  if (!["Active", "Finalized", "Cancelled"].includes(recordStatus)) {
    throw controlled("STELLAR_POLICY_REGISTRY_STATE_INVALID", "The stored policy status is invalid.", 503);
  }
  if (
    ![
      "Active",
      "ExecutionExpiredAwaitingReceipt",
      "ReceiptWindowClosed",
      "Finalized",
      "Cancelled",
    ].includes(effectiveStatus)
  ) {
    throw controlled("STELLAR_POLICY_REGISTRY_STATE_INVALID", "The effective policy status is invalid.", 503);
  }
  const receiptHash = record.receipt_hash === null
    ? null
    : bytes32Hex(record.receipt_hash, "receipt hash");
  return {
    contractId: readiness.contractId,
    owner,
    nonce: nonce.toString(),
    policyCommitment: bytes32Hex(record.manifest_hash, "manifest hash"),
    privacyBudgetCommitment: bytes32Hex(
      record.privacy_budget_hash,
      "privacy budget hash",
    ),
    receiptHash,
    recordStatus: recordStatus as StellarPolicyRegistryRecordState["recordStatus"],
    effectiveStatus:
      effectiveStatus as StellarPolicyRegistryRecordState["effectiveStatus"],
    committedAtLedger: Number(integer(record.committed_at_ledger, "commit ledger")),
    executionExpiresAtLedger: Number(
      integer(record.execution_expires_at_ledger, "execution expiry"),
    ),
    receiptCloseByLedger: Number(
      integer(record.receipt_close_by_ledger, "receipt deadline"),
    ),
    updatedAtLedger: Number(integer(record.updated_at_ledger, "update ledger")),
    retentionFloorLedger: Number(
      integer(record.retention_floor_ledger, "retention floor"),
    ),
    nextNonce: integer(nonceRead.value, "next nonce").toString(),
    active: activeRead.value === true,
    canFinalize: finalizeRead.value === true,
    observedAtLedger: Math.max(
      recordRead.latestLedger,
      statusRead.latestLedger,
      activeRead.latestLedger,
      finalizeRead.latestLedger,
      nonceRead.latestLedger,
    ),
  };
}

export interface PreparedStellarPolicyRegistryCommit {
  readonly schemaVersion: "kletia_stellar_policy_registry_prepared_commit_v1";
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: string;
  readonly policyCommitment: `0x${string}`;
  readonly privacyBudgetCommitment: `0x${string}`;
  readonly executionExpiresAtLedger: number;
  readonly receiptCloseByLedger: number;
  readonly retentionFloorLedger: number;
  readonly expectedWasmSha256: string;
  readonly stateObservedAtLedger: number;
  readonly recordingSimulationLatestLedger: number;
  readonly invocationSha256: `0x${string}`;
  readonly enforcingSimulationRequiredBeforeSigning: true;
}

export async function prepareStellarPolicyRegistryCommit(input: {
  owner: unknown;
  policyCommitment: unknown;
  privacyBudgetCommitment: unknown;
}): Promise<PreparedStellarPolicyRegistryCommit> {
  const readiness = await assertStellarPolicyRegistryReady();
  const owner = assertStellarAccount(input.owner);
  const policyCommitment = commitment(
    input.policyCommitment,
    "policyCommitment",
  );
  const privacyBudgetCommitment = commitment(
    input.privacyBudgetCommitment,
    "privacyBudgetCommitment",
  );
  if (policyCommitment === privacyBudgetCommitment) {
    throw controlled(
      "STELLAR_POLICY_COMMITMENT_DOMAIN_COLLISION",
      "Policy and Privacy Budget commitments must be independently domain-separated.",
      400,
    );
  }
  const ownerArg = new Address(owner).toScVal();
  const nonceRead = await readMethod(
    readiness.contractId,
    owner,
    "next_nonce",
    [ownerArg],
  );
  const nonce = integer(nonceRead.value, "next nonce");
  const baseLedger = Math.max(
    Number(readiness.observedAtLedger),
    nonceRead.latestLedger,
  );
  const executionExpiresAtLedger = baseLedger + EXECUTION_WINDOW_LEDGERS;
  const receiptCloseByLedger = baseLedger + RECEIPT_WINDOW_LEDGERS;
  const retentionFloorLedger = baseLedger + RETENTION_WINDOW_LEDGERS;
  if (
    !Number.isSafeInteger(retentionFloorLedger) ||
    executionExpiresAtLedger >= receiptCloseByLedger ||
    receiptCloseByLedger > retentionFloorLedger
  ) {
    throw controlled(
      "STELLAR_POLICY_LEDGER_WINDOW_INVALID",
      "Policy registry ledger windows could not be represented safely.",
      503,
    );
  }
  const invocation = {
    schemaVersion: "kletia_policy_registry_call_v1",
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    contractId: readiness.contractId,
    method: "commit",
    owner,
    nonce: nonce.toString(),
    policyCommitment,
    privacyBudgetCommitment,
    executionExpiresAtLedger,
    receiptCloseByLedger,
    retentionFloorLedger,
  } as const;
  const simulation = await simulateInvocation({
    contractId: readiness.contractId,
    source: owner,
    method: "commit",
    args: [
      ownerArg,
      nativeToScVal(nonce, { type: "u64" }),
      bytes32ScVal(policyCommitment),
      bytes32ScVal(privacyBudgetCommitment),
      nativeToScVal(executionExpiresAtLedger, { type: "u32" }),
      nativeToScVal(receiptCloseByLedger, { type: "u32" }),
      nativeToScVal(retentionFloorLedger, { type: "u32" }),
    ],
    authMode: "record",
  });
  if (simulation.authorizationCount < 1) {
    throw controlled(
      "STELLAR_POLICY_OWNER_AUTH_NOT_RECORDED",
      "The reviewed registry did not record the expected owner authorization.",
      503,
    );
  }
  return {
    schemaVersion: "kletia_stellar_policy_registry_prepared_commit_v1",
    contractId: readiness.contractId,
    owner,
    nonce: nonce.toString(),
    policyCommitment,
    privacyBudgetCommitment,
    executionExpiresAtLedger,
    receiptCloseByLedger,
    retentionFloorLedger,
    expectedWasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
    stateObservedAtLedger: baseLedger,
    recordingSimulationLatestLedger: simulation.latestLedger,
    invocationSha256: sha256(invocation),
    enforcingSimulationRequiredBeforeSigning: true,
  };
}

export interface PreparedStellarPolicyRegistryFinalize {
  readonly contractId: string;
  readonly owner: string;
  readonly nonce: string;
  readonly receiptHash: `0x${string}`;
  readonly expectedWasmSha256: string;
  readonly stateObservedAtLedger: number;
  readonly recordingSimulationLatestLedger: number;
  readonly invocationSha256: `0x${string}`;
  readonly enforcingSimulationRequiredBeforeSigning: true;
}

export async function prepareStellarPolicyRegistryFinalize(input: {
  owner: unknown;
  nonce: string | bigint;
  receiptHash: unknown;
  expectedPolicyCommitment: unknown;
  expectedPrivacyBudgetCommitment: unknown;
}): Promise<PreparedStellarPolicyRegistryFinalize> {
  const readiness = await assertStellarPolicyRegistryReady();
  const owner = assertStellarAccount(input.owner);
  const nonce = integer(input.nonce, "nonce");
  const receiptHash = commitment(input.receiptHash, "receiptHash");
  const expectedPolicyCommitment = commitment(
    input.expectedPolicyCommitment,
    "expectedPolicyCommitment",
  );
  const expectedPrivacyBudgetCommitment = commitment(
    input.expectedPrivacyBudgetCommitment,
    "expectedPrivacyBudgetCommitment",
  );
  const state = await readStellarPolicyRegistryRecord({ owner, nonce });
  if (
    !state ||
    state.contractId !== readiness.contractId ||
    state.policyCommitment !== expectedPolicyCommitment ||
    state.privacyBudgetCommitment !== expectedPrivacyBudgetCommitment ||
    state.receiptHash !== null ||
    state.recordStatus !== "Active" ||
    state.canFinalize !== true
  ) {
    throw controlled(
      "STELLAR_POLICY_RECORD_NOT_FINALIZABLE",
      "The exact stored policy record is absent, terminal, mismatched, or outside its receipt-close window.",
      409,
    );
  }
  const invocation = {
    schemaVersion: "kletia_policy_registry_call_v1",
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    contractId: readiness.contractId,
    method: "finalize",
    owner,
    nonce: nonce.toString(),
    receiptHash,
  } as const;
  const simulation = await simulateInvocation({
    contractId: readiness.contractId,
    source: owner,
    method: "finalize",
    args: [
      new Address(owner).toScVal(),
      nativeToScVal(nonce, { type: "u64" }),
      bytes32ScVal(receiptHash),
    ],
    authMode: "record",
  });
  if (simulation.authorizationCount < 1) {
    throw controlled(
      "STELLAR_POLICY_OWNER_AUTH_NOT_RECORDED",
      "The reviewed registry did not record the expected owner authorization.",
      503,
    );
  }
  return {
    contractId: readiness.contractId,
    owner,
    nonce: nonce.toString(),
    receiptHash,
    expectedWasmSha256: STELLAR_POLICY_REGISTRY_RELEASE_WASM_SHA256,
    stateObservedAtLedger: state.observedAtLedger,
    recordingSimulationLatestLedger: simulation.latestLedger,
    invocationSha256: sha256(invocation),
    enforcingSimulationRequiredBeforeSigning: true,
  };
}
