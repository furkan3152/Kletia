/**
 * Intent service: the stateful half of the engine. Plans and persists
 * intents, prepares wallet-ready payloads, verifies submitted references
 * on-chain, polls cross-network settlement and emits events for every
 * transition. All writes use optimistic concurrency through the store and
 * are serialised per intent inside one process.
 */
import {
  assertStepTransition,
  CHAINS,
  deriveIntentStatus,
  fromBaseUnits,
  isBaseUnitAmount,
  isEvmAddress,
  isStepDone,
  parseAccountId,
  parseAssetId,
  type IntentGraph,
  type IntentPreview,
  type IntentStatus,
  type IntentStep,
  type StepEvidence,
  type StepExecutionPayload,
  type StepStatus,
  validateIntentRequest,
  type IntentRequest,
} from "@kletia/core";
import { isPlatformError, PlatformError, toPlatformError } from "../errors.js";
import { ADAPTERS, adapterForStep, configureAdapters, isContractAdapter } from "./adapters/registry.js";
import type { ContractPreparedPayload, PlannedStepPreview, PreparedPayload, ProtocolAdapter, SettlementResult, StepFailure, VerificationResult } from "./adapters/types.js";
import { firstPreparedAt, isReferenceRejection, landedPayload, REFERENCE_STALE_MS, referenceFormatValid, referenceKey } from "./adapters/verification.js";
import { quoteBindingFor } from "./binding.js";
import { sameAddress } from "./accounts.js";
import { assetFromRef, sameAsset } from "./assets.js";
import { evmChainId, isEvmNetwork } from "./chains/evm.js";
import { assertSolanaTransactionOwner } from "./chains/solana.js";
import { decodeContractCall, isCanonicalCall, boundValues } from "./contracts/bindings.js";
import { assertContractAmount } from "./contracts/caps.js";
import {
  configureContractDirectory,
  contractDirectory,
  contractsEnabled,
  reportContractAnomaly,
  withActivationRetry,
  type ContractDirectory,
  type RegisteredContract,
} from "./contracts/directory.js";
import { emitGraphChanges, platformEvents } from "./events.js";
import { resolveRecipientName } from "./names.js";
import { actionForStep, planIntentWithPreviews, stepRecipientName, summarize, withIntentTtl } from "./planner.js";
import { payloadExposure, pinNonces, solanaBlockHeight } from "./policy/execution.js";
import { policyGate, policyGateActive, type ExposureHandle } from "./policy/gate.js";
import { plannedPreviews, previewEnforced, previewIntent, previewPreparedStep, rememberPlannedPreviews, SIMULATION_RETRY_AFTER_SECONDS, type PreparedPreview } from "./preview/index.js";
import { decodeStepRef, encodeStepRef, MAX_PREPARED_FLOORS } from "./stepRef.js";
import { createIntentStore, type IntentStore } from "./store.js";
import { INTENT_ID_PATTERN, nextTimestamp, roundUsd, STEP_ID_PATTERN } from "./util.js";

/** Payloads expire quickly: Solana blockhashes and provider quotes go stale. */
export const PAYLOAD_TTL_SECONDS = 90;
/** Cross-network steps unresolved this long become indeterminate (manual review, never auto-retried). */
const SETTLEMENT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** Most wallet transactions one step may need (and so most references one submit may carry). */
export const MAX_STEP_TRANSACTIONS = 4;
const MAX_REFERENCES = MAX_STEP_TRANSACTIONS;

let store: IntentStore | null = null;

export function getIntentStore(): IntentStore {
  store ??= createIntentStore();
  return store;
}

export interface PlatformConfiguration {
  /** Intent persistence (tests, custom storage). */
  readonly store?: IntentStore;
  /** Protocol adapters to plan and execute with; `null` restores the built-in set. */
  readonly adapters?: readonly ProtocolAdapter[] | null;
  /** Contract registry hook for call / action steps; `null` removes it (steps then fail with CONTRACTS_DISABLED). */
  readonly contracts?: ContractDirectory | null;
}

/** Overrides the intent store, the protocol adapters and/or the contract directory (tests, embedders). */
export function configurePlatform(options: PlatformConfiguration): void {
  if (options.store) store = options.store;
  if (options.adapters !== undefined) configureAdapters(options.adapters);
  if (options.contracts !== undefined) configureContractDirectory(options.contracts);
}

const locks = new Map<string, Promise<unknown>>();

/** Serialises mutations of one intent within this process. */
async function withIntentLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}

function assertIntentId(id: string): void {
  if (typeof id !== "string" || !INTENT_ID_PATTERN.test(id)) {
    throw new PlatformError("INTENT_NOT_FOUND", "Intent not found.", 404);
  }
}

async function loadIntent(id: string): Promise<IntentGraph> {
  assertIntentId(id);
  const graph = await getIntentStore().get(id);
  if (!graph) throw new PlatformError("INTENT_NOT_FOUND", "Intent not found.", 404);
  return graph;
}

function findStep(graph: IntentGraph, stepId: string): IntentStep {
  const step = typeof stepId === "string" && STEP_ID_PATTERN.test(stepId)
    ? graph.steps.find((candidate) => candidate.id === stepId)
    : undefined;
  if (!step) throw new PlatformError("STEP_NOT_FOUND", `Step ${String(stepId).slice(0, 8)} does not exist in this intent.`, 404);
  return step;
}

/** Walks a chain of statuses, asserting each hop is a legal lifecycle transition. */
function transition(step: IntentStep, ...path: StepStatus[]): StepStatus {
  let current = step.status;
  for (const next of path) {
    try {
      assertStepTransition(current, next);
    } catch {
      throw new PlatformError("STEP_TRANSITION_INVALID", `Step ${step.id} cannot move from ${current} to ${next}.`, 409);
    }
    current = next;
  }
  return current;
}

function deriveStatus(graph: IntentGraph, steps: readonly IntentStep[], now: number): IntentStatus {
  if (graph.status === "cancelled") return "cancelled";
  return deriveIntentStatus(steps, graph.expiresAt, now);
}

function withSteps(graph: IntentGraph, steps: readonly IntentStep[], now: number): IntentGraph {
  return {
    ...graph,
    steps,
    status: deriveStatus(graph, steps, now),
    updatedAt: nextTimestamp(graph.updatedAt, now),
    summary: summarize(steps, graph.edges, graph.summary.signaturesRequired, graph.summary.title),
  };
}

function replaceStep(steps: readonly IntentStep[], next: IntentStep): IntentStep[] {
  return steps.map((step) => (step.id === next.id ? next : step));
}

/** Pending steps whose dependencies are all done become ready. */
function unlockDependents(steps: readonly IntentStep[]): IntentStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.map((step) => {
    if (step.status !== "pending") return step;
    const done = step.dependsOn.every((dependency) => {
      const parent = byId.get(dependency);
      return parent !== undefined && isStepDone(parent);
    });
    return done ? { ...step, status: transition(step, "ready") } : step;
  });
}

function emitSideEffects(before: IntentGraph, after: IntentGraph): void {
  for (const step of after.steps) {
    const previous = before.steps.find((candidate) => candidate.id === step.id);
    if (!previous) continue;
    if (previous.status !== "submitted" && step.status === "submitted") {
      const reference = step.references?.[step.references.length - 1];
      platformEvents.emit("activity.recorded", {
        id: `${after.id}:${step.id}`,
        network: step.network,
        title: step.title,
        ...(reference ? { reference, url: CHAINS[step.network].explorer.tx.replace("{hash}", encodeURIComponent(reference)) } : {}),
      });
    }
    if (previous.status !== step.status && (step.status === "settled" || step.status === "settling" || step.status === "failed")) {
      const account = parseAccountId(step.account);
      if (account) {
        platformEvents.emit("portfolio.invalidated", { account: account.id, network: step.network, reason: `intent ${after.id} step ${step.id} ${step.status}` });
      }
      const recipient = step.recipient ? parseAccountId(step.recipient) : null;
      if (step.status === "settled" && recipient && recipient.id !== account?.id) {
        platformEvents.emit("portfolio.invalidated", { account: recipient.id, network: recipient.chain.key, reason: `intent ${after.id} step ${step.id} settled` });
      }
    }
  }
}

async function commit(before: IntentGraph, after: IntentGraph): Promise<IntentGraph> {
  await getIntentStore().update(after.id, after, before.updatedAt);
  emitGraphChanges(before, after);
  emitSideEffects(before, after);
  return after;
}

/* ---------------------------------------------------------------- create */

export interface CreateIntentOptions {
  /** API key id of the caller; enables listing and idempotent clientReference. */
  readonly ownerKeyId?: string;
  /**
   * The authenticated key making the request when it differs from the owner
   * (Rule Book decision log); null for public callers such as link
   * visitors. Default: the owner.
   */
  readonly actorKeyId?: string | null;
  /** Plan and quote without persisting. */
  readonly dryRun?: boolean;
  /** Also compute the asset-change preview (stage `plan`) from the quotes' own transactions. */
  readonly preview?: boolean;
  /** Stage of that preview: `plan` (default) or `indicative` (placeholder accounts, link quotes). */
  readonly previewStage?: "plan" | "indicative";
  /**
   * Checks the planned graph before the Rule Book evaluates it and before
   * anything is stored or returned (dry runs too); a throw refuses the
   * intent. Intent links check their envelope here.
   */
  readonly verifyPlan?: (graph: IntentGraph) => void | Promise<void>;
  /**
   * The intent link this intent is created through: sets `metadata.linkId`,
   * which callers can never set themselves (links reserve uses and force
   * strict simulation by it). Engine-internal (planLinkIntent).
   */
  readonly linkId?: string;
}

export interface CreatedIntent {
  readonly intent: IntentGraph;
  /** True when a repeated `clientReference` returned the intent created by an earlier request. */
  readonly replayed: boolean;
  /** The plan-stage asset-change preview, when requested. */
  readonly preview?: IntentPreview;
}

/** Plan-stage preview of a created intent; RPC trouble yields `unavailable` steps, never a failed create. */
async function planPreview(intent: IntentGraph, stage: "plan" | "indicative" = "plan"): Promise<IntentPreview | undefined> {
  try {
    return await previewIntent(intent, { stage });
  } catch (error) {
    console.warn("[platform] plan preview failed:", toPlatformError(error).message);
    return undefined;
  }
}

/**
 * Validates a request as the planner does, and applies the link marker:
 * `metadata.linkId` is reserved for intents created through a link.
 */
function intentRequestFor(input: unknown, linkId: string | undefined): IntentRequest {
  const validated = validateIntentRequest(input);
  if (!validated.ok) throw new PlatformError("INVALID_REQUEST", "The intent request is invalid.", 400, validated.issues);
  const request = validated.value;
  if (request.metadata?.linkId !== undefined) {
    throw new PlatformError("INVALID_REQUEST", "metadata.linkId is reserved for intents created through an intent link.", 400, [
      { path: "metadata.linkId", message: "Reserved." },
    ]);
  }
  return linkId === undefined ? request : { ...request, metadata: { ...request.metadata, linkId } };
}

/** Plans (and unless `dryRun`, stores) an intent, reporting whether it was an idempotent replay. */
export async function createIntentDetailed(request: unknown, options: CreateIntentOptions = {}): Promise<CreatedIntent> {
  try {
    const clientReference =
      typeof request === "object" && request !== null && "clientReference" in request &&
        typeof (request as { clientReference: unknown }).clientReference === "string"
        ? (request as { clientReference: string }).clientReference
        : undefined;
    const create = async (): Promise<CreatedIntent> => {
      if (!options.dryRun && options.ownerKeyId && clientReference) {
        const existing = await getIntentStore().findByClientReference(options.ownerKeyId, clientReference);
        if (existing) return { intent: existing, replayed: true };
      }
      const gate = policyGate();
      const actorKeyId = options.actorKeyId === undefined ? options.ownerKeyId : options.actorKeyId ?? undefined;
      // Rule Book (policy design §4.3): request-level rules first, then the constraints the auction sees are narrowed.
      const guard = await gate.beforePlan({
        ...(options.ownerKeyId ? { ownerKeyId: options.ownerKeyId } : {}),
        ...(actorKeyId ? { actorKeyId } : {}),
        request: intentRequestFor(request, options.linkId),
        dryRun: options.dryRun === true,
      });
      const planned = await planIntentWithPreviews(guard.request, { ...(options.ownerKeyId ? { ownerKeyId: options.ownerKeyId } : {}) });
      const previews = planned.previews;
      await options.verifyPlan?.(planned.graph);
      // The planned graph is evaluated in full: deny refuses here; allow and confirm stamp the intent.
      const decided = await gate.afterPlan(guard, planned.graph);
      let graph = decided.ttlMs !== undefined ? withIntentTtl(planned.graph, decided.ttlMs) : planned.graph;
      if (decided.stamp) graph = { ...graph, policy: decided.stamp };
      // Plan-time quote transactions stay in memory (never in the graph) for previews until the quotes expire.
      rememberPlannedPreviews(graph.id, previews);
      if (options.dryRun) return { intent: graph, replayed: false };
      try {
        await getIntentStore().create(graph, { ...(options.ownerKeyId ? { ownerKeyId: options.ownerKeyId } : {}) });
      } catch (error) {
        // Another instance won the race for this clientReference: replay its intent.
        if (options.ownerKeyId && clientReference && isPlatformError(error) && error.code === "CLIENT_REFERENCE_EXISTS") {
          const existing = await getIntentStore().findByClientReference(options.ownerKeyId, clientReference);
          if (existing) return { intent: existing, replayed: true };
        }
        throw error;
      }
      emitGraphChanges(null, graph);
      // Approval holds reference the stored intent.
      await gate.afterCreate(guard, graph);
      return { intent: graph, replayed: false };
    };
    // Concurrent retries of one clientReference must not create two intents: the lock covers
    // this process, the store's unique (owner, clientReference) constraint covers instances.
    const created = options.ownerKeyId && clientReference && !options.dryRun
      ? await withIntentLock(`client:${options.ownerKeyId}:${clientReference}`, create)
      : await create();
    if (!options.preview) return created;
    const preview = await planPreview(created.intent, options.previewStage);
    return preview ? { ...created, preview } : created;
  } catch (error) {
    throw toPlatformError(error);
  }
}

export async function createIntent(request: unknown, options: CreateIntentOptions = {}): Promise<IntentGraph> {
  return (await createIntentDetailed(request, options)).intent;
}

/* ------------------------------------------------------------------ read */

export async function getIntent(id: string): Promise<IntentGraph> {
  try {
    const graph = await loadIntent(id);
    const now = Date.now();
    const status = deriveStatus(graph, graph.steps, now);
    if (status === graph.status) return graph;
    // Time-based transitions (e.g. planned -> expired) are persisted lazily.
    return await withIntentLock(id, async () => {
      const latest = await loadIntent(id);
      const derived = deriveStatus(latest, latest.steps, now);
      if (derived === latest.status) return latest;
      const next: IntentGraph = { ...latest, status: derived, updatedAt: nextTimestamp(latest.updatedAt, now) };
      return commit(latest, next).catch(() => latest);
    });
  } catch (error) {
    throw toPlatformError(error);
  }
}

export async function listIntents(ownerKeyId: string, limit = 50): Promise<IntentGraph[]> {
  try {
    if (!ownerKeyId) throw new PlatformError("API_KEY_REQUIRED", "Listing intents requires an API key.", 401);
    return await getIntentStore().listByOwner(ownerKeyId, limit);
  } catch (error) {
    throw toPlatformError(error);
  }
}

/**
 * The API key id that created an intent (webhook routing): null for intents
 * created without a key, undefined when no such intent is stored.
 */
export async function getIntentOwner(id: string): Promise<string | null | undefined> {
  try {
    if (typeof id !== "string" || !INTENT_ID_PATTERN.test(id)) return undefined;
    return await getIntentStore().ownerOf(id);
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* --------------------------------------------------------------- prepare */

export interface PreparedStepResult {
  readonly intent: IntentGraph;
  /** The payload; `payload.preview` is the simulated effect of exactly these transactions. */
  readonly payload: StepExecutionPayload;
  /** The whole intent's preview with this step freshly simulated (stage `prepare`). */
  readonly preview?: IntentPreview;
  /**
   * `matched`: the acknowledged preview was found and nothing material changed;
   * `unknown`: the digest is not in the preview store (expired, another
   * instance): not an error, the client should show the fresh preview.
   */
  readonly previewAck?: "matched" | "unknown";
}

export interface PrepareStepOptions {
  /** Digest (`sha256:…`) of the preview the user saw; a materially worse payload is refused (PREVIEW_CHANGED). */
  readonly acknowledgedPreview?: string;
}

function assertExecutable(graph: IntentGraph, now: number): void {
  const status = deriveStatus(graph, graph.steps, now);
  if (status === "cancelled") throw new PlatformError("INTENT_CANCELLED", "This intent was cancelled.", 409);
  if (status === "expired") throw new PlatformError("INTENT_EXPIRED", "This intent expired before execution started. Create a new one to re-quote.", 410);
  if (status === "completed") throw new PlatformError("INTENT_COMPLETED", "This intent is already completed.", 409);
  const deadline = graph.request.constraints?.deadline;
  if (deadline !== undefined && deadline * 1000 <= now) {
    throw new PlatformError("DEADLINE_PASSED", "The intent's deadline has passed.", 410);
  }
}

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;

/**
 * Engine-level guard on adapter output: every transaction is on the step
 * network and sent / fee-paid (and, on Solana, solely signed) by the step
 * account, whatever the adapter claims about itself.
 */
function validatePayload(step: IntentStep, prepared: Pick<PreparedPayload, "transactions" | "records">): void {
  const account = parseAccountId(step.account);
  if (!account) throw new PlatformError("STEP_INVALID", "Step account is invalid.", 500);
  const count = prepared.transactions.length;
  if (count === 0 || count > MAX_REFERENCES || prepared.records.length !== count) {
    throw new PlatformError("PAYLOAD_INVALID", "The adapter produced an invalid transaction count.", 502);
  }
  for (const [index, transaction] of prepared.transactions.entries()) {
    const record = prepared.records[index];
    if (transaction.network !== step.network || record?.network !== step.network || record.vm !== transaction.vm) {
      throw new PlatformError("PAYLOAD_INVALID", "Payload transaction is on another network.", 502);
    }
    if (transaction.vm === "evm") {
      if (!isEvmNetwork(step.network) || transaction.chainId !== evmChainId(step.network)) {
        throw new PlatformError("PAYLOAD_INVALID", "Payload transaction targets another chain.", 502);
      }
      if (!isEvmAddress(transaction.from) || transaction.from.toLowerCase() !== account.address.toLowerCase()) {
        throw new PlatformError("PAYLOAD_INVALID", "Payload transaction is not sent by the step account.", 502);
      }
      if (!isEvmAddress(transaction.to) || !HEX_DATA.test(transaction.data) || !isBaseUnitAmount(transaction.value)) {
        throw new PlatformError("PAYLOAD_INVALID", "Payload transaction has a malformed target, calldata or value.", 502);
      }
      if ((record.to ?? "").toLowerCase() !== transaction.to.toLowerCase()) {
        throw new PlatformError("PAYLOAD_INVALID", "Payload record does not match its transaction.", 502);
      }
    } else {
      if (CHAINS[step.network].vm !== "svm" || transaction.feePayer !== account.address || transaction.encoding !== "base64") {
        throw new PlatformError("PAYLOAD_INVALID", "Payload transaction is not fee-paid by the step account.", 502);
      }
      // Decode the wire transaction itself: fee payer and sole signer must be the step account.
      const info = assertSolanaTransactionOwner(transaction.transaction, account.address);
      if (record.to && !info.programs.includes(record.to)) {
        throw new PlatformError("PAYLOAD_INVALID", "Payload transaction does not invoke its recorded program.", 502);
      }
    }
  }
}

const APPROVE_SELECTOR = "0x095ea7b3";

function payloadInvalid(message: string): PlatformError {
  return new PlatformError("PAYLOAD_INVALID", message, 502);
}

/**
 * Engine-level guard on a custom call payload, independent of the adapter
 * (design §4.6): at most a reset-approve and an exact approve of the step's
 * input token to the pinned spender, then the registered function on the
 * registered target, canonically encoded with the step amount, and a value
 * equal to the bound value and within its cap. Nothing else.
 */
export function assertCallPayload(step: IntentStep, prepared: Pick<ContractPreparedPayload, "transactions" | "input">): void {
  const snapshot = step.call;
  if (!snapshot || snapshot.vm !== "evm" || !snapshot.fragment || !snapshot.bindings || !snapshot.selector) {
    throw new PlatformError("STEP_INVALID", "The call step has no EVM contract snapshot.", 500);
  }
  const transactions = prepared.transactions;
  if (transactions.length < 1 || transactions.length > 3 || transactions.some((transaction) => transaction.vm !== "evm")) {
    throw payloadInvalid("A custom call payload has 1-3 EVM transactions.");
  }
  const call = transactions[transactions.length - 1];
  if (!call || call.vm !== "evm") throw payloadInvalid("The custom call is missing.");
  if (call.to.toLowerCase() !== snapshot.target.toLowerCase()) throw payloadInvalid("The custom call targets another contract.");
  if (call.data.slice(0, 10).toLowerCase() !== snapshot.selector.toLowerCase()) throw payloadInvalid("The custom call is not the registered function.");
  if (!isCanonicalCall(snapshot.fragment, call.data)) throw payloadInvalid("The custom call's calldata is not the canonical encoding of the registered function.");
  const amount = prepared.input ? BigInt(prepared.input.amount) : null;
  if ((step.input === undefined) !== (amount === null)) throw payloadInvalid("The custom call's input does not match the step.");
  const args = decodeContractCall(snapshot.fragment, call.data) ?? [];
  for (const value of boundValues(snapshot.fragment, snapshot.bindings, args, "$amount")) {
    if (value !== amount) throw payloadInvalid("The custom call encodes another amount than the step's.");
  }
  const value = BigInt(call.value);
  const bound = snapshot.value
    ? snapshot.value.bind === "$amount" ? amount : /^\d+$/u.test(snapshot.value.bind) ? BigInt(snapshot.value.bind) : null
    : 0n;
  if (bound === null || value !== bound || (snapshot.value && value > BigInt(snapshot.value.max))) throw payloadInvalid("The custom call sends another value than bound.");
  const approvals = transactions.slice(0, -1);
  if (approvals.length > 0) {
    const token = step.input ? parseAssetId(step.input.asset) : null;
    if (!snapshot.approvalSpender || !token || token.assetNamespace !== "erc20" || amount === null) throw payloadInvalid("This custom call takes no approval.");
    approvals.forEach((approval, index) => {
      if (approval.vm !== "evm" || approval.to.toLowerCase() !== token.reference.toLowerCase() || BigInt(approval.value) !== 0n) {
        throw payloadInvalid("An approval targets another token or sends value.");
      }
      if (approval.data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR || approval.data.length !== 10 + 128) throw payloadInvalid("An approval is not approve(address,uint256).");
      const spender = `0x${approval.data.slice(34, 74)}`.toLowerCase();
      const approved = BigInt(`0x${approval.data.slice(74, 138)}`);
      if (!/^0{24}$/u.test(approval.data.slice(10, 34)) || spender !== (snapshot.approvalSpender as string).toLowerCase()) throw payloadInvalid("An approval names another spender than the pinned one.");
      const last = index === approvals.length - 1;
      if (last ? approved !== amount : approved !== 0n) throw payloadInvalid("Approvals are a reset to 0 and an exact approval of the step amount.");
    });
  }
}

interface PriceFloor {
  readonly input: bigint;
  readonly minimum: bigint;
  /** The guaranteed minimum as shown to users ("149.25 USDC"). */
  readonly label: string;
}

/**
 * The rate every prepare is held to: the planned input and minimum recorded
 * in the step ref, never the previous prepare's (re-prepares must not erode
 * it). Legacy steps without a recorded plan use their current amounts.
 */
function plannedFloor(step: IntentStep): PriceFloor | null {
  if (!step.input || !step.minimumOutput || step.kind === "transfer" || step.kind === "deposit" || step.kind === "withdraw") return null;
  // Call / action adapters hold prepares to the plan themselves (share prices are not swap rates).
  if (step.kind === "call" || step.kind === "action") return null;
  const ref = decodeStepRef(step.quoteRef);
  const planned = ref?.plannedInput && ref.plannedMinimum
    ? { input: ref.plannedInput, minimum: ref.plannedMinimum }
    : { input: step.input.amount, minimum: step.minimumOutput.amount };
  return {
    input: BigInt(planned.input),
    minimum: BigInt(planned.minimum),
    label: `${fromBaseUnits(planned.minimum, step.minimumOutput.decimals)} ${step.minimumOutput.symbol}`,
  };
}

function priceMoved(floor: PriceFloor | null, prepared: Pick<PreparedPayload, "input" | "expectedOutput">): boolean {
  if (!floor) return false;
  return BigInt(prepared.expectedOutput.amount) * floor.input < floor.minimum * BigInt(prepared.input.amount);
}

/**
 * Value paid on top of the input may not appear or grow after planning: each
 * prepared extra cost needs a planned cost in the same asset, and may exceed it
 * by at most the step's slippage. Returns the offending cost's description.
 */
function extraCostMoved(step: IntentStep, prepared: Pick<PreparedPayload, "extraCosts">): string | null {
  const slippageBps = BigInt(decodeStepRef(step.quoteRef)?.slippageBps ?? 0);
  for (const cost of prepared.extraCosts ?? []) {
    if (!isBaseUnitAmount(cost.amount)) return `${cost.symbol} (malformed amount)`;
    const planned = (step.extraCosts ?? [])
      .filter((entry) => sameAsset(entry, cost))
      .reduce((total, entry) => total + BigInt(entry.amount), 0n);
    if (BigInt(cost.amount) * 10_000n > planned * (10_000n + slippageBps)) return `${cost.formatted} ${cost.symbol}`;
  }
  return null;
}

/** Interest a "withdraw all" position may accrue between planning and prepare (bps of the planned size). */
const POSITION_ACCRUAL_BPS = 100n;

/**
 * "Withdraw all" takes the position read at prepare. A position that grew
 * beyond the planned size plus accrual (a later deposit, a supply on the
 * account's behalf) is not what was approved: returns the planned size.
 */
function positionGrown(step: IntentStep, prepared: { readonly input?: PreparedPayload["input"] }): string | null {
  const ref = decodeStepRef(step.quoteRef);
  if (step.kind !== "withdraw" || !ref?.closePosition || !ref.plannedInput || !step.input || !prepared.input) return null;
  const planned = BigInt(ref.plannedInput);
  if (BigInt(prepared.input.amount) * 10_000n <= planned * (10_000n + POSITION_ACCRUAL_BPS)) return null;
  return `${fromBaseUnits(planned, step.input.decimals)} ${step.input.symbol}`;
}

/**
 * A step planned for a recipient name pays the address the name resolved to
 * at planning. The name is resolved again before every prepare; a different
 * address (or an unreadable record) refuses the prepare.
 */
async function assertRecipientNameUnchanged(step: IntentStep): Promise<void> {
  const name = stepRecipientName(step);
  const recipient = step.recipient ? parseAccountId(step.recipient) : null;
  if (!name || !recipient) return;
  const resolution = await resolveRecipientName(name, recipient.chain.key);
  const current = parseAccountId(`${recipient.chain.id}:${resolution.address}`);
  if (!current || !sameAddress(current, recipient)) {
    throw new PlatformError(
      "RECIPIENT_NAME_CHANGED",
      `${name} now resolves to ${resolution.address.slice(0, 64)}, not the planned ${recipient.address}. Create a new intent to pay the new address.`,
      409,
    );
  }
}

interface ContractStepUse {
  readonly registration: RegisteredContract;
  readonly ownerKeyId: string;
  /** Priced notional of the step (null when unpriced). */
  readonly usd: number | null;
}

/**
 * Prepare-time checks of a call / action step against the live registry
 * (design §4.4): the intent's owner key may still use the registration, it is
 * active on the very revision and definition the step was planned on, its
 * targets are not deny-listed, and the amount is within the entry limits and
 * the USD cap. Pins are re-read by the adapter.
 */
async function assertContractStepUsable(graph: IntentGraph, step: IntentStep, amount: string): Promise<ContractStepUse> {
  const directory = contractDirectory();
  if (!contractsEnabled() || !directory) {
    throw new PlatformError("CONTRACTS_DISABLED", "Custom contract and Solana Action steps are disabled on this deployment.", 503);
  }
  const snapshot = step.call;
  if (!snapshot) throw new PlatformError("STEP_INVALID", "The call step has no contract snapshot.", 500);
  const owner = await getIntentStore().ownerOf(graph.id);
  if (!owner || !(await directory.usableBy(snapshot.contract, owner))) {
    throw new PlatformError("CONTRACT_NOT_USABLE", "The API key that created this intent may no longer use its contract registration.", 409);
  }
  const registration = await directory.current(snapshot.contract);
  if (!registration) throw new PlatformError("CONTRACT_NOT_USABLE", "The contract registration of this step no longer exists.", 409);
  if (registration.status === "suspended") {
    throw new PlatformError("CONTRACT_SUSPENDED", `${registration.id} is suspended; the integrator must inspect and reverify it.`, 409);
  }
  if (registration.status === "pending" || registration.activeRevision === null) {
    throw withActivationRetry(new PlatformError("CONTRACT_PENDING", `${registration.id} is waiting for activation.`, 409), registration.activatesAt);
  }
  if (registration.activeRevision !== snapshot.revision || registration.definitionHash !== snapshot.definitionHash) {
    throw new PlatformError(
      "CONTRACT_REVISION_CHANGED",
      `${registration.id} revision ${registration.activeRevision} is active; this step was planned on revision ${snapshot.revision}. Create a new intent.`,
      409,
    );
  }
  const definition = registration.definition;
  const targets = definition.vm === "evm" ? [definition.address, ...(definition.addresses ?? []).map((entry) => entry.address)] : definition.programs;
  for (const target of targets) {
    const denied = directory.denied(step.network, target);
    if (denied) throw new PlatformError("CONTRACT_DENIED", `${target} is ${denied}; Kletia does not call it.`, 422);
  }
  let usd: number | null = null;
  const entry = definition.actions.find((candidate) => candidate.id === snapshot.entry);
  if (!entry) throw new PlatformError("CONTRACT_REVISION_CHANGED", `${registration.id} no longer has the action ${snapshot.entry}. Create a new intent.`, 409);
  if (step.input) {
    usd = await assertContractAmount(entry.limits, assetFromRef(step.input), BigInt(amount), registration.verification.domain.verified, entry.label);
  }
  return { registration, ownerKeyId: owner, usd };
}

/**
 * Simulates the prepared payload and checks it (asset-preview design §5.8,
 * §7.2). Refusals (invariants, PREVIEW_CHANGED, SIMULATION_UNAVAILABLE where
 * simulation is enforced) propagate; an unexpected preview failure on a
 * built-in venue leaves the payload without a preview (adapters already pin
 * their calldata), on an enforced step it refuses.
 */
async function preparedPreview(
  graph: IntentGraph,
  step: IntentStep,
  nextStep: IntentStep,
  adapter: ProtocolAdapter,
  prepared: PreparedPayload | ContractPreparedPayload,
  quoteBinding: string,
  options: PrepareStepOptions,
): Promise<PreparedPreview | null> {
  // The step as the preview sees it: prepared amounts, and the extra costs this payload really pays.
  const view: IntentStep = { ...nextStep, ...(prepared.extraCosts ? { extraCosts: prepared.extraCosts } : {}) };
  try {
    return await previewPreparedStep(graph, view, { transactions: prepared.transactions, quoteBinding }, {
      ...(options.acknowledgedPreview ? { acknowledgedPreview: options.acknowledgedPreview } : {}),
      simulate: ADAPTERS.includes(adapter) || adapter.previewAtPrepare === true,
    });
  } catch (error) {
    if (isPlatformError(error)) throw error;
    console.warn(`[platform] preview of ${graph.id}/${step.id} failed:`, error instanceof Error ? error.message : error);
    if (previewEnforced(graph, step)) {
      throw Object.assign(new PlatformError("SIMULATION_UNAVAILABLE", `Step ${step.id} could not be simulated right now, and it is never prepared unsimulated. Retry shortly.`, 503), {
        retryAfterSeconds: SIMULATION_RETRY_AFTER_SECONDS,
      });
    }
    return null;
  }
}

export async function prepareStep(intentId: string, stepId: string, options: PrepareStepOptions = {}): Promise<PreparedStepResult> {
  try {
    return await withIntentLock(intentId, async () => {
      const graph = await loadIntent(intentId);
      const step = findStep(graph, stepId);
      const now = Date.now();
      assertExecutable(graph, now);
      const waiting = step.dependsOn.filter((dependency) => {
        const parent = graph.steps.find((candidate) => candidate.id === dependency);
        return !parent || !isStepDone(parent);
      });
      if (waiting.length > 0) {
        throw new PlatformError("STEP_NOT_READY", `Step ${step.id} waits for ${waiting.join(", ")} to settle.`, 409);
      }
      if (!["pending", "ready", "awaiting_signature", "failed"].includes(step.status)) {
        throw new PlatformError("STEP_NOT_PREPARABLE", `Step ${step.id} is ${step.status}; it cannot be prepared again.`, 409);
      }
      const funded = graph.edges.some((edge) => edge.to === step.id && edge.kind === "funds");
      const action = actionForStep(graph, step);
      const adapter = adapterForStep(step);
      await assertRecipientNameUnchanged(step);
      // Rule Book (policy design §6): the owner is read only when a gate is installed.
      const gate = policyGate();
      const governed = policyGateActive();
      const ownerKeyId = governed ? (await getIntentStore().ownerOf(graph.id)) ?? null : null;
      const expiresAt = Math.floor(now / 1000) + PAYLOAD_TTL_SECONDS;
      const contractStep = step.kind === "call" || step.kind === "action";
      let usable: ContractStepUse | null = null;
      let prepared: PreparedPayload | ContractPreparedPayload;
      if (contractStep) {
        usable = await assertContractStepUsable(graph, step, action.amount);
        if (!isContractAdapter(adapter) || !action.call) throw new PlatformError("PROTOCOL_UNSUPPORTED", `No contract adapter for protocol ${step.protocol}.`, 500);
        prepared = await adapter.prepareCall({
          graph,
          step,
          action: { ...action, call: { ...action.call, registration: usable.registration } },
          now,
          expiresAt,
        });
      } else {
        prepared = await adapter.prepare({ graph, step, action, now, expiresAt });
      }
      validatePayload(step, prepared);
      if (step.kind === "call") assertCallPayload(step, prepared);
      // Nonce pinning (§6.3): consecutive pending nonces, so re-prepares on one nonce are mutually exclusive.
      if (governed && isEvmNetwork(step.network) && (await gate.executionOptions(ownerKeyId)).pinNonce) {
        prepared = { ...prepared, transactions: await pinNonces(step, prepared.transactions) };
      }
      const movedCost = extraCostMoved(step, prepared);
      if (movedCost) {
        throw new PlatformError(
          "QUOTE_MOVED",
          `The venue now charges ${movedCost} on top of the amount, more than planned. Create a new intent to re-quote.`,
          409,
        );
      }
      const plannedPosition = positionGrown(step, prepared);
      if (plannedPosition && prepared.input) {
        throw new PlatformError(
          "QUOTE_MOVED",
          `The position is now ${prepared.input.formatted} ${prepared.input.symbol}, more than the ${plannedPosition} planned for "withdraw all". Create a new intent to re-quote.`,
          409,
        );
      }
      // Quote-specific warnings are replaced by the fresh quote's; static ones (token verification, rent) persist.
      const quoteSpecific = /^(?:Route:|Price |Fees and price impact|Slippage capped|Simulation was unavailable)/u;
      const warnings = [...(step.warnings ?? []).filter((warning) => !quoteSpecific.test(warning)), ...prepared.warnings];
      const floor = plannedFloor(step);
      if (!contractStep && prepared.input && prepared.expectedOutput && prepared.minimumOutput && priceMoved(floor, prepared as PreparedPayload)) {
        if (!funded) {
          throw new PlatformError(
            "QUOTE_MOVED",
            `The price moved beyond the slippage limit since planning (now ${prepared.expectedOutput.formatted} ${prepared.expectedOutput.symbol}, plan guaranteed ${floor?.label}). Create a new intent to re-quote.`,
            409,
          );
        }
        warnings.push(`Price moved since planning; the fresh quote guarantees ${prepared.minimumOutput.formatted} ${prepared.minimumOutput.symbol}.`);
      }
      const quoteBinding = quoteBindingFor(prepared.transactions);
      const preparedAt = new Date(now).toISOString();
      const status = step.status === "failed" || step.status === "pending"
        ? transition(step, "ready", "awaiting_signature")
        : transition(step, "awaiting_signature");
      const ref = decodeStepRef(step.quoteRef);
      const evidence: StepEvidence = {
        kind: "quote",
        network: step.network,
        reference: quoteBinding,
        observedAt: preparedAt,
        detail: `Prepared ${prepared.transactions.length} transaction(s) with ${adapter.label}${prepared.quoteId ? ` (quote ${prepared.quoteId.slice(0, 18)})` : ""}.`,
      };
      // Every settlement tracking id handed to a wallet stays attributable to this step.
      const tracking: StepEvidence[] = prepared.trackingId
        ? [{ kind: "quote", network: step.network, reference: prepared.trackingId.slice(0, 100), observedAt: preparedAt, detail: "Settlement request prepared." }]
        : [];
      // step.extraCosts keeps the planned values: every prepare is held to them (extraCostMoved).
      const { references: _references, failure: _failure, ...rest } = step;
      const review = "review" in prepared ? prepared.review : undefined;
      const bound = "evidence" in prepared && Array.isArray(prepared.evidence) ? prepared.evidence : [];
      const nextStep: IntentStep = {
        ...rest,
        status,
        ...(prepared.input ? { input: prepared.input } : {}),
        ...(prepared.expectedOutput ? { expectedOutput: prepared.expectedOutput } : {}),
        ...(prepared.minimumOutput ? { minimumOutput: prepared.minimumOutput } : {}),
        ...(step.call && review ? { call: { ...step.call, review } } : {}),
        ...(prepared.feesUsd !== undefined ? { feesUsd: roundUsd(prepared.feesUsd) } : {}),
        ...(step.settlement
          ? { settlement: { ...step.settlement, ...(prepared.trackingId ? { trackingId: prepared.trackingId } : {}) } }
          : {}),
        prepared: { quoteBinding, preparedAt, expiresAt, transactions: prepared.records },
        evidence: appendEvidence(step, [evidence, ...tracking, ...bound]),
        ...(ref
          ? {
              quoteRef: encodeStepRef({
                ...ref,
                ...(prepared.quoteId ? { quote: prepared.quoteId } : {}),
                // Each payload's own guarantee: an earlier payload that lands after this re-prepare still verifies.
                ...(prepared.minimumOutput
                  ? { floors: [...(ref.floors ?? []), { at: Math.floor(now / 1000), min: prepared.minimumOutput.amount }].slice(-MAX_PREPARED_FLOORS) }
                  : {}),
              }),
            }
          : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)].slice(0, 12) } : {}),
      };
      // Asset-change preview of exactly these transactions (design §5.8): invariants and the
      // acknowledged-preview check run before anything is counted, committed or handed out.
      const preview = await preparedPreview(graph, step, nextStep, adapter, prepared, quoteBinding, options);
      const next = withSteps(graph, replaceStep(graph.steps, nextStep), now);
      // Rule Book clearance (§6.4): re-evaluated with fresh amounts, approval checked, exposure reserved
      // before the payload leaves. A rejected approval cancels the intent (nothing was submitted).
      let exposure: ExposureHandle | null = null;
      if (governed) {
        try {
          exposure = await gate.beforePayload({
            graph: next,
            step: nextStep,
            prepared,
            ownerKeyId,
            quoteBinding,
            exposure: payloadExposure({ intentId: graph.id, step, quoteBinding, transactions: prepared.transactions, now }),
            now,
            solanaBlockHeight: () => solanaBlockHeight(step.network),
          });
        } catch (error) {
          if (isPlatformError(error) && error.code === "POLICY_APPROVAL_REJECTED") await cancelAfterRejection(graph, now);
          throw error;
        }
      }
      let intent: IntentGraph;
      try {
        // The key's daily notional is counted once per step (its first prepare), whatever re-prepares follow.
        if (usable && usable.usd !== null && firstPreparedAt(step) === null) {
          await (contractDirectory() as ContractDirectory).recordSpend(usable.ownerKeyId, usable.usd);
        }
        intent = await commit(graph, next);
      } catch (error) {
        // The payload never left: its exposure must not count.
        if (exposure) {
          await exposure.abort().catch((abortError: unknown) => {
            console.warn(`[platform] releasing exposure ${exposure?.exposureId} failed:`, abortError instanceof Error ? abortError.message : abortError);
          });
        }
        throw error;
      }
      if (exposure) {
        await exposure.commit().catch((commitError: unknown) => {
          console.warn(`[platform] committing exposure ${exposure?.exposureId} failed:`, commitError instanceof Error ? commitError.message : commitError);
        });
      }
      return {
        intent,
        payload: {
          vm: CHAINS[step.network].vm,
          transactions: prepared.transactions,
          expiresAt,
          quoteBinding,
          ...(review ? { review } : {}),
          ...(preview ? { preview: preview.step } : {}),
          ...(exposure
            ? {
                policy: {
                  decisionId: exposure.decisionId,
                  exposureId: exposure.exposureId,
                  notionalUsd: exposure.notionalUsd,
                  chainHashes: [...(exposure.chainHashes ?? graph.policy?.chain.map((link) => link.hash) ?? [])],
                },
              }
            : {}),
        },
        ...(preview ? { preview: preview.intent } : {}),
        ...(preview?.ack ? { previewAck: preview.ack } : {}),
      };
    });
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* --------------------------------------------------------------- preview */

/** One quote refresh per intent per 20 s (asset-preview design §8.3); at most 4 ready steps re-quoted. */
const REFRESH_QUOTES_INTERVAL_MS = 20_000;
const REFRESH_QUOTES_MAX_STEPS = 4;
const quoteRefreshes = new Map<string, number>();

export interface RefreshPreviewOptions {
  /** Re-quote ready steps (one provider quote each, rate limited); default false re-simulates cached quote transactions. */
  readonly refreshQuotes?: boolean;
}

/**
 * Recomputes an intent's asset-change preview (stage `refresh`). By default
 * no provider is called: cached plan-time transactions are re-simulated while
 * their quotes are valid, other steps are quoted. With `refreshQuotes`, ready
 * steps are re-quoted first (RATE_LIMITED when asked again within 20 s).
 */
export async function refreshIntentPreview(intentId: string, options: RefreshPreviewOptions = {}): Promise<IntentPreview> {
  try {
    const graph = await getIntent(intentId);
    const sources = new Map<string, PlannedStepPreview>();
    if (options.refreshQuotes) {
      const now = Date.now();
      const last = quoteRefreshes.get(intentId);
      if (last !== undefined && now - last < REFRESH_QUOTES_INTERVAL_MS) {
        const wait = Math.ceil((REFRESH_QUOTES_INTERVAL_MS - (now - last)) / 1000);
        throw Object.assign(new PlatformError("RATE_LIMITED", `Quotes of this intent were refreshed moments ago; retry in ${wait} s.`, 429), { retryAfterSeconds: wait });
      }
      quoteRefreshes.delete(intentId);
      quoteRefreshes.set(intentId, now);
      while (quoteRefreshes.size > 20_000) {
        const oldest = quoteRefreshes.keys().next().value;
        if (oldest === undefined) break;
        quoteRefreshes.delete(oldest);
      }
      const ready = graph.steps
        .filter((step) => (step.status === "ready" || step.status === "awaiting_signature") && step.kind !== "call" && step.kind !== "action" &&
          step.dependsOn.every((dependency) => {
            const parent = graph.steps.find((candidate) => candidate.id === dependency);
            return parent !== undefined && isStepDone(parent);
          }))
        .slice(0, REFRESH_QUOTES_MAX_STEPS);
      await Promise.all(ready.map(async (step) => {
        try {
          const planned = await adapterForStep(step).plan(actionForStep(graph, step));
          if (planned.preview) sources.set(step.id, planned.preview);
        } catch (error) {
          console.warn(`[platform] preview re-quote of ${intentId}/${step.id} failed:`, toPlatformError(error).message);
        }
      }));
      if (sources.size > 0) rememberPlannedPreviews(intentId, new Map([...plannedPreviews(intentId), ...sources]));
    }
    return await previewIntent(graph, { stage: "refresh", ...(sources.size > 0 ? { sources } : {}) });
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* ---------------------------------------------------------------- submit */

function submittedAt(step: IntentStep): number {
  for (let index = step.evidence.length - 1; index >= 0; index -= 1) {
    const entry = step.evidence[index];
    if (entry?.kind === "note" && entry.detail === "References submitted.") return Date.parse(entry.observedAt);
  }
  return step.prepared ? Date.parse(step.prepared.preparedAt) : Date.now();
}

function appendEvidence(step: IntentStep, evidence: readonly StepEvidence[]): StepEvidence[] {
  return [...step.evidence, ...evidence].slice(-50);
}

const LANDED_STATUSES: readonly StepStatus[] = ["confirmed", "settling", "settled"];

/**
 * Rule Book reconciliation (policy design §6.2): steps whose references
 * just verified on-chain turn their exposure landed. Never throws and never
 * refuses: on-chain facts are recorded whatever the rule book says.
 */
async function reconcileVerified(before: IntentGraph, after: IntentGraph): Promise<void> {
  if (!policyGateActive()) return;
  const verified = after.steps.filter((step) => {
    const previous = before.steps.find((candidate) => candidate.id === step.id);
    return LANDED_STATUSES.includes(step.status) && (!previous || !LANDED_STATUSES.includes(previous.status));
  });
  if (verified.length === 0) return;
  try {
    const ownerKeyId = (await getIntentStore().ownerOf(after.id)) ?? null;
    if (!ownerKeyId) return;
    for (const step of verified) {
      const landed = landedPayload(step);
      await policyGate().afterVerification({
        graph: after,
        step,
        ownerKeyId,
        ...(landed ? { landedNonces: landed.nonces } : {}),
        quoteBinding: landed?.quoteBinding ?? (CHAINS[step.network].vm === "svm" ? step.prepared?.quoteBinding ?? null : null),
      });
    }
  } catch (error) {
    console.warn(`[platform] policy reconcile of ${after.id} failed:`, toPlatformError(error).message);
  }
}

/** Moves a step to manual review (never auto-retried) with a note saying why. */
function toIndeterminate(step: IntentStep, now: number, detail: string): IntentStep {
  return {
    ...step,
    status: transition(step, "indeterminate"),
    evidence: appendEvidence(step, [{ kind: "note", network: step.network, observedAt: new Date(now).toISOString(), detail }]),
  };
}

function applyVerification(step: IntentStep, result: VerificationResult, now: number): IntentStep {
  if (result.status === "failed" && result.failure.code === "CONTRACT_CHANGED_DURING_EXECUTION") {
    // The contract's code identity differed at the receipt block: manual review, never a plain failure or retry.
    if (step.status === "indeterminate") return step;
    const moved = toIndeterminate({ ...step, evidence: appendEvidence(step, result.evidence) }, now, `Contract changed during execution: ${result.failure.message}`.slice(0, 300));
    return { ...moved, failure: result.failure };
  }
  if (result.status === "pending") {
    if (!result.stale || step.status === "indeterminate") return step;
    return toIndeterminate(step, now, "Submitted transactions were not observed for over an hour; manual review needed.");
  }
  if (result.status === "failed") {
    return {
      ...step,
      status: transition(step, "failed"),
      evidence: appendEvidence(step, result.evidence),
      failure: result.failure,
    };
  }
  const cross = step.settlement?.kind === "cross-network";
  return {
    ...step,
    status: cross ? transition(step, "settling") : transition(step, "confirmed", "settled"),
    evidence: appendEvidence(step, result.evidence),
    ...(!cross && result.actualOutput ? { actualOutput: result.actualOutput } : {}),
  };
}

function applySettlement(step: IntentStep, result: SettlementResult, now: number): IntentStep {
  if (result.status === "settled") {
    return {
      ...step,
      status: transition(step, "settled"),
      evidence: appendEvidence(step, result.evidence),
      ...(result.actualOutput ? { actualOutput: result.actualOutput } : {}),
    };
  }
  if (result.status === "failed") {
    return { ...step, status: transition(step, "failed"), evidence: appendEvidence(step, result.evidence), failure: result.failure };
  }
  let next = step;
  if (result.trackingId && step.settlement && result.trackingId !== step.settlement.trackingId) {
    next = { ...next, settlement: { ...step.settlement, trackingId: result.trackingId } };
  }
  if (now - submittedAt(step) > SETTLEMENT_TIMEOUT_MS && step.status !== "indeterminate") {
    next = toIndeterminate(next, now, "Settlement has not completed within 3 hours; manual review needed.");
  }
  return next;
}

/**
 * Verification or settlement reads keep failing (chain RPC or provider down,
 * throttled or retired). The deadlines of a successful read still apply, so a
 * step past them goes to manual review instead of staying active forever;
 * before them the error propagates and the refresh is deferred.
 */
function overdueAfterError(step: IntentStep, now: number): IntentStep | null {
  const elapsed = now - submittedAt(step);
  if (step.status === "settling" && elapsed > SETTLEMENT_TIMEOUT_MS) {
    return toIndeterminate(step, now, "Settlement could not be confirmed within 3 hours (status reads failing); manual review needed.");
  }
  if (step.status === "submitted" && elapsed > REFERENCE_STALE_MS) {
    return toIndeterminate(step, now, "Submitted transactions could not be verified for over an hour (reads failing); manual review needed.");
  }
  return null;
}

/**
 * Binds verified references to this step globally. Claims happen only after
 * on-chain verification (sender, chain, binding) so nobody can squat a hash
 * they did not send; a reference already bound elsewhere is rejected.
 */
async function claimVerified(intentId: string, step: IntentStep, result: VerificationResult): Promise<VerificationResult> {
  if (result.status !== "confirmed") return result;
  try {
    await getIntentStore().claimReferences(
      (step.references ?? []).map((reference) => ({ key: referenceKey(step, reference), intentId, stepId: step.id })),
    );
    return result;
  } catch (error) {
    const platformError = toPlatformError(error);
    if (platformError.code !== "REFERENCE_ALREADY_USED") throw platformError;
    return { status: "failed", evidence: [], failure: { code: platformError.code, message: platformError.message } };
  }
}

/**
 * Binds a settled step's destination fill to it globally, like origin
 * references: one fill can settle one step per recipient (a relayer may batch
 * fills for different recipients into one transaction; a fill is only ever
 * accepted for the recipient it credited). A fill already bound elsewhere
 * leaves the step settling (it times out to manual review); it never settles.
 */
async function claimSettlement(intentId: string, step: IntentStep, result: SettlementResult): Promise<SettlementResult> {
  const destination = step.settlement?.destinationNetwork;
  if (result.status !== "settled" || !destination) return result;
  const chain = CHAINS[destination].id;
  const evm = chain.startsWith("eip155:");
  const payee = parseAccountId(step.recipient ?? step.account)?.address ?? step.recipient ?? step.account;
  const recipient = evm ? payee.toLowerCase() : payee;
  const keys = result.evidence
    .filter((entry) => entry.kind === "settlement" && entry.reference)
    .map((entry) => `fill:${chain}:${evm ? (entry.reference as string).toLowerCase() : entry.reference}:${recipient}`);
  if (keys.length === 0) return result;
  try {
    await getIntentStore().claimReferences(keys.map((key) => ({ key, intentId, stepId: step.id })));
    return result;
  } catch (error) {
    const platformError = toPlatformError(error);
    if (platformError.code !== "REFERENCE_ALREADY_USED") throw platformError;
    return { status: "settling", evidence: [] };
  }
}

/** Polls a settling step's venue and claims the fill it reports. */
async function pollSettlement(intentId: string, step: IntentStep, adapter: ProtocolAdapter, now: number): Promise<IntentStep> {
  if (!adapter.poll) return step;
  return applySettlement(step, await claimSettlement(intentId, step, await adapter.poll(step, now)), now);
}

/**
 * A call / action step whose landed outcome does not match (OUTCOME_NOT_PROVEN)
 * or whose code changed during execution suspends its registration; the
 * directory emits contract.suspended. Never blocks verification.
 */
async function reportVerificationAnomaly(step: IntentStep, result: VerificationResult): Promise<void> {
  if (!step.call || result.status !== "failed") return;
  if (result.failure.code === "OUTCOME_NOT_PROVEN") {
    await reportContractAnomaly(step.call.contract, "outcome_mismatch", result.failure.message);
  } else if (result.failure.code === "CONTRACT_CHANGED_DURING_EXECUTION") {
    await reportContractAnomaly(step.call.contract, step.call.vm === "evm" ? "pins_changed" : "program_changed", result.failure.message);
  }
}

/** Verifies a step's current references on-chain and claims them when confirmed. */
async function verifyReferences(intentId: string, step: IntentStep, now: number): Promise<VerificationResult> {
  const references = step.references ?? [];
  const result = await adapterForStep(step).verify({ step, references, submittedAt: submittedAt(step), now });
  await reportVerificationAnomaly(step, result);
  return claimVerified(intentId, step, result);
}

/** True once any current reference produced origin-network evidence (receipt / landed transaction). */
function hasOriginEvidence(step: IntentStep): boolean {
  const references = new Set(step.references ?? []);
  return step.evidence.some(
    (entry) => (entry.kind === "receipt" || entry.kind === "transaction") && entry.reference !== undefined && references.has(entry.reference),
  );
}

/**
 * The references are not this step's transactions: drop them and put the step
 * back to awaiting its prepared payload. Nothing happened on-chain for it.
 */
function rejectReferences(step: IntentStep, failure: StepFailure, now: number): IntentStep {
  const { references: _references, failure: _failure, ...rest } = step;
  return {
    ...rest,
    status: transition(step, "failed", "ready", "awaiting_signature"),
    evidence: appendEvidence(step, [
      {
        kind: "note",
        network: step.network,
        ...(step.references?.length ? { reference: step.references[step.references.length - 1] as string } : {}),
        observedAt: new Date(now).toISOString(),
        detail: `References rejected (${failure.code}): ${failure.message}`.slice(0, 300),
      },
    ]),
  };
}

/** Rejected references are "understood but not executable" (422) per the API contract, including reuse. */
function rejectionError(failure: StepFailure): PlatformError {
  return new PlatformError(failure.code, failure.message, 422, [{ path: "references", message: failure.message }]);
}

/** Fast solvers often fill within seconds: poll a freshly settling step once right away. */
async function settleNow(intentId: string, step: IntentStep, now: number): Promise<IntentStep> {
  const adapter = adapterForStep(step);
  if (step.status !== "settling" || !adapter.poll) return step;
  try {
    return await pollSettlement(intentId, step, adapter, now);
  } catch {
    return step;
  }
}

/** Advances one step by re-reading the chain or the settlement network. */
async function progressStep(intentId: string, step: IntentStep, now: number): Promise<IntentStep> {
  try {
    return await readProgress(intentId, step, now);
  } catch (error) {
    const overdue = overdueAfterError(step, now);
    if (overdue) return overdue;
    throw error;
  }
}

async function readProgress(intentId: string, step: IntentStep, now: number): Promise<IntentStep> {
  const adapter = adapterForStep(step);
  const references = step.references ?? [];
  const settlingLike = step.status === "settling" ||
    (step.status === "indeterminate" && step.settlement?.kind === "cross-network" && hasOriginEvidence(step));
  if (settlingLike) return pollSettlement(intentId, step, adapter, now);
  if ((step.status === "submitted" || step.status === "indeterminate") && references.length > 0) {
    const result = await verifyReferences(intentId, step, now);
    if (isReferenceRejection(result)) return rejectReferences(step, result.failure, now);
    if (step.status === "indeterminate" && result.status === "pending") return step;
    return settleNow(intentId, applyVerification(step, result, now), now);
  }
  return step;
}

function parseReferences(step: IntentStep, input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REFERENCES) {
    throw new PlatformError("REFERENCES_INVALID", `references must be a list of 1-${MAX_REFERENCES} transaction hashes or signatures.`, 400, [
      { path: "references", message: "Invalid list." },
    ]);
  }
  const references = input.map((value, index) => {
    if (typeof value !== "string" || !referenceFormatValid(step, value.trim())) {
      throw new PlatformError(
        "REFERENCE_INVALID",
        step.chain.startsWith("eip155:") ? "Each reference must be a 0x-prefixed 32-byte transaction hash." : "Each reference must be a base58 Solana signature.",
        400,
        [{ path: `references[${index}]`, message: "Invalid format." }],
      );
    }
    return value.trim();
  });
  if (new Set(references.map((reference) => referenceKey(step, reference))).size !== references.length) {
    throw new PlatformError("REFERENCES_INVALID", "references must not repeat.", 400);
  }
  return references;
}

function sameReferences(step: IntentStep, a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((reference, index) => referenceKey(step, reference) === referenceKey(step, b[index] ?? ""));
}

const SUBMITTED_STATUSES: readonly StepStatus[] = ["submitted", "confirmed", "settling", "settled", "indeterminate"];

/**
 * A submitted step whose references never produced on-chain evidence may take
 * new ones: wallets replace transactions (speed-up / cancel changes the hash)
 * and a mistyped hash must not lock the step.
 */
function acceptsReplacementReferences(step: IntentStep): boolean {
  return (step.status === "submitted" || step.status === "indeterminate") && !hasOriginEvidence(step);
}

/**
 * Submits transaction references for a prepared step. They are verified
 * on-chain before anything is stored: references that are not this step's
 * transactions (other sender, other payload, mined before prepare, already
 * bound elsewhere) are refused with 4xx and leave the step unchanged. Not yet
 * visible references are stored as `submitted` and re-verified by refresh and
 * the settlement poller.
 */
export async function submitStep(intentId: string, stepId: string, references: unknown): Promise<IntentGraph> {
  try {
    return await withIntentLock(intentId, async () => {
      const graph = await loadIntent(intentId);
      const step = findStep(graph, stepId);
      const parsed = parseReferences(step, references);
      if (step.references && sameReferences(step, step.references, parsed) && SUBMITTED_STATUSES.includes(step.status)) {
        return graph;
      }
      if (graph.status === "cancelled") throw new PlatformError("INTENT_CANCELLED", "This intent was cancelled.", 409);
      const replacing = acceptsReplacementReferences(step);
      if ((step.status !== "awaiting_signature" && !replacing) || !step.prepared) {
        throw new PlatformError("STEP_NOT_AWAITING_SIGNATURE", `Step ${step.id} is ${step.status}; prepare it before submitting.`, 409);
      }
      if (parsed.length !== step.prepared.transactions.length) {
        throw new PlatformError(
          "REFERENCE_COUNT_MISMATCH",
          `Submit exactly ${step.prepared.transactions.length} reference(s), one per prepared transaction, in order.`,
          400,
          [{ path: "references", message: `Expected ${step.prepared.transactions.length}, got ${parsed.length}.` }],
        );
      }
      const now = Date.now();
      const path: StepStatus[] = step.status === "submitted"
        ? []
        : step.status === "indeterminate"
          ? ["failed", "ready", "awaiting_signature", "submitted"]
          : ["submitted"];
      const { failure: _failure, ...rest } = step;
      const candidate: IntentStep = {
        ...rest,
        status: path.length > 0 ? transition(step, ...path) : step.status,
        references: parsed,
        evidence: appendEvidence(step, [
          { kind: "note", network: step.network, reference: parsed[parsed.length - 1] as string, observedAt: new Date(now).toISOString(), detail: "References submitted." },
        ]),
      };
      let result: VerificationResult;
      try {
        result = await verifyReferences(intentId, candidate, now);
      } catch (error) {
        // Chain or provider reads failed: keep the submission; refresh and the poller re-verify it.
        console.warn("[platform] verification deferred:", toPlatformError(error).message);
        result = { status: "pending", evidence: [], reason: "Verification deferred.", stale: false };
      }
      if (isReferenceRejection(result)) throw rejectionError(result.failure);
      const verified = await settleNow(intentId, applyVerification(candidate, result, now), now);
      const steps = unlockDependents(replaceStep(graph.steps, verified));
      const committed = await commit(graph, withSteps(graph, steps, now));
      await reconcileVerified(graph, committed);
      return committed;
    });
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* --------------------------------------------------------------- refresh */

const REFRESHABLE: readonly StepStatus[] = ["submitted", "confirmed", "settling", "indeterminate"];

async function refreshIntentInternal(id: string, onlySteps?: readonly string[]): Promise<IntentGraph> {
  return withIntentLock(id, async () => {
    const graph = await loadIntent(id);
    if (graph.status === "cancelled") return graph;
    const now = Date.now();
    let steps: IntentStep[] = [...graph.steps];
    let changed = false;
    for (const step of graph.steps) {
      if (!REFRESHABLE.includes(step.status) || (onlySteps && !onlySteps.includes(step.id))) continue;
      try {
        const next = await progressStep(id, step, now);
        if (next !== step) {
          steps = replaceStep(steps, next);
          changed = true;
        }
      } catch (error) {
        console.warn(`[platform] refresh ${id}/${step.id} deferred:`, toPlatformError(error).message);
      }
    }
    const unlocked = unlockDependents(steps);
    if (unlocked.some((step, index) => step !== steps[index])) changed = true;
    const status = deriveStatus(graph, unlocked, now);
    if (!changed && status === graph.status) return graph;
    const committed = await commit(graph, withSteps(graph, unlocked, now));
    await reconcileVerified(graph, committed);
    return committed;
  });
}

/** Re-verifies submitted steps and polls settling steps now. */
export async function refreshIntent(id: string): Promise<IntentGraph> {
  try {
    return await refreshIntentInternal(id);
  } catch (error) {
    if (error instanceof PlatformError && error.code === "INTENT_CONFLICT") return loadIntent(id);
    throw toPlatformError(error);
  }
}

/* ---------------------------------------------------------------- cancel */

function hasStarted(graph: IntentGraph): boolean {
  return graph.steps.some(
    (step) => (step.references?.length ?? 0) > 0 ||
      ["submitted", "confirmed", "settling", "settled", "indeterminate"].includes(step.status),
  );
}

function cancelledGraph(graph: IntentGraph, now: number): IntentGraph {
  const steps = graph.steps.map((step): IntentStep => {
    if (step.status === "skipped") return step;
    const path: StepStatus[] = step.status === "awaiting_signature" || step.status === "failed" ? ["ready", "skipped"] : ["skipped"];
    return { ...step, status: transition(step, ...path) };
  });
  return {
    ...graph,
    steps,
    status: "cancelled",
    updatedAt: nextTimestamp(graph.updatedAt, now),
  };
}

/**
 * An approver rejected the intent's Rule Book hold (policy design §7.1): the
 * intent is cancelled unless a step was already submitted. Runs inside the
 * intent lock; never masks the refusal.
 */
async function cancelAfterRejection(graph: IntentGraph, now: number): Promise<void> {
  if (graph.status === "cancelled" || hasStarted(graph)) return;
  try {
    await commit(graph, cancelledGraph(graph, now));
  } catch (error) {
    console.warn(`[platform] cancelling rejected intent ${graph.id} failed:`, toPlatformError(error).message);
  }
}

export async function cancelIntent(id: string): Promise<IntentGraph> {
  try {
    return await withIntentLock(id, async () => {
      const graph = await loadIntent(id);
      if (graph.status === "cancelled") return graph;
      if (hasStarted(graph)) {
        throw new PlatformError("INTENT_NOT_CANCELLABLE", "A step was already submitted on-chain; the intent can no longer be cancelled.", 409);
      }
      return commit(graph, cancelledGraph(graph, Date.now()));
    });
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* ---------------------------------------------------------------- poller */

export interface SettlementPollerOptions {
  readonly intervalMs?: number;
  readonly concurrency?: number;
  readonly batchSize?: number;
}

/**
 * Periodically refreshes intents with submitted or settling steps. Never
 * throws; returns a stop function.
 */
export function startSettlementPoller(options: SettlementPollerOptions = {}): () => void {
  const intervalMs = Math.max(2_000, options.intervalMs ?? 8_000);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 500));
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    const intents = getIntentStore();
    const polled: string[] = [];
    try {
      const active = await intents.listActive(batchSize);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, active.length) }, async () => {
        while (!stopped && cursor < active.length) {
          const graph = active[cursor];
          cursor += 1;
          if (!graph) continue;
          await refreshIntent(graph.id).catch((error: unknown) => {
            console.warn(`[platform] poll ${graph.id} failed:`, toPlatformError(error).message);
          });
          polled.push(graph.id);
        }
      });
      await Promise.all(workers);
    } catch (error) {
      console.warn("[platform] settlement poller tick failed:", toPlatformError(error).message);
    } finally {
      // A refresh that changes nothing keeps updatedAt; the polled marker moves the intent
      // behind the others so every active intent gets its turn, however many stay unchanged.
      if (polled.length > 0) {
        await intents.markPolled(polled).catch((error: unknown) => {
          console.warn("[platform] settlement poller could not record polled intents:", toPlatformError(error).message);
        });
      }
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
