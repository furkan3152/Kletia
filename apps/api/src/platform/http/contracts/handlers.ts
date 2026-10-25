/**
 * The /v1/contracts handlers: views, registration, listing, updates,
 * revisions, deletion, re-verification, operator suspension and tests.
 */
import {
  CONTRACT_LIMITS,
  canonicalJson,
  contractTarget,
  functionSelector,
  isSecurityRelevantChange,
  parseAccountId,
  resolveChain,
  type ContractActionView,
  type ContractDefinition,
  type ContractStatus,
  type ContractTestRequest,
  type ContractTestResult,
  type ContractView,
  type ContractVm,
  type NetworkKey,
  type SolanaActionMetadata,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { RegisteredContract } from "../../index.js";
import {
  activationDelaySeconds,
  comparePins,
  contractChecks,
  contractEngine,
} from "../contractChecks.js";
import {
  HttpError,
  invalidRequest,
  isRecord,
  type AuthContext,
} from "../context.js";
import { randomHex } from "../secrets.js";
import { clock, iso, nextTimestamp, publish } from "./events.js";
import {
  assertContractsEnabled,
  ConcurrentChange,
  type ContractEntry,
  contractExists,
  contractLimitReached,
  contractNotFound,
  type ContractRecord,
  type ContractRevision,
  definitionHashOf,
  isOperatorSuspension,
  latestRevision,
  OPERATOR_PREFIX,
  type RevisionSummary,
  usedRevision,
} from "./records.js";
import {
  activated,
  type Caller,
  contractStore,
  mutate,
  reader,
  settle,
  visibleTo,
  writer,
} from "./lifecycle.js";
import {
  assertPhrasesFree,
  pin,
  type Pinned,
  validateDefinition,
} from "./validation.js";

/* ================================================================== views */

export interface ContractViewOptions {
  /** Owner views carry the ABI, addresses, programs and payees. */
  readonly owner: boolean;
  readonly history?: readonly RevisionSummary[];
}

export type ContractViewWithHistory = ContractView & { readonly revisions?: readonly RevisionSummary[] };

function actionViews(definition: ContractDefinition, metadata: Readonly<Record<string, SolanaActionMetadata>>): ContractActionView[] {
  if (definition.vm === "evm") return definition.actions.map((action) => ({ ...action, selector: functionSelector(action.function) }));
  return definition.actions.map((action) => ({ ...action, metadata: metadata[action.id] ?? null }));
}

/** API view of a registration. The fields describe the latest revision (`revision`); intents use `activeRevision`. */
export function contractView(entry: ContractEntry, options: ContractViewOptions): ContractViewWithHistory {
  const { record } = entry;
  const latest = latestRevision(entry);
  const definition = latest.definition;
  return {
    id: record.id,
    vm: record.vm,
    network: record.network,
    ...(definition.vm === "evm" ? { address: definition.address } : { origin: definition.origin }),
    integrator: { ...definition.integrator, domainVerified: record.verification.domain.verified },
    visibility: record.visibility,
    status: record.status === "deleted" ? "suspended" : record.status,
    revision: latest.revision,
    activeRevision: record.activeRevision,
    pendingRevision: record.pendingRevision,
    activatesAt: record.activatesAt,
    definitionHash: latest.definitionHash,
    pins: latest.pins,
    verification: record.verification,
    actions: actionViews(definition, record.metadata),
    ...(options.owner && definition.vm === "evm"
      ? { abi: definition.abi, ...(definition.addresses ? { addresses: definition.addresses } : {}) }
      : {}),
    ...(options.owner && definition.vm === "svm"
      ? { programs: definition.programs, ...(definition.payees ? { payees: definition.payees } : {}) }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    suspendedReason: record.suspendedReason,
    ...(options.history ? { revisions: options.history } : {}),
  };
}

/** The engine's view of a registration: the revision intents use (active, else the first pending one). */
export function registeredContract(entry: ContractEntry, revision: ContractRevision = usedRevision(entry)): RegisteredContract {
  const { record } = entry;
  return {
    id: record.id,
    ownerKeyId: record.ownerKeyId,
    projectId: record.projectId,
    status: record.status === "deleted" ? "suspended" : record.status,
    activeRevision: record.activeRevision,
    activatesAt: record.activatesAt,
    definition: revision.definition,
    definitionHash: revision.definitionHash,
    pins: revision.pins,
    verification: record.verification,
    createdAt: record.createdAt,
  };
}

/* =============================================================== handlers */

const DOMAIN_UNCHECKED = { verified: false, checkedAt: null } as const;

/** POST /v1/contracts. */
export async function registerContract(auth: AuthContext, body: unknown): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  const definition = validateDefinition(body);
  const network = definition.network;
  const target = contractTarget(definition);
  // Cheap refusals before any network work (the store re-checks both atomically).
  const visible = await contractStore().listVisible(caller.keyId, caller.projectId);
  const owned = visible.filter((entry) => entry.record.ownerKeyId === caller.keyId);
  if (owned.some((entry) => entry.record.network === network && entry.record.target === target)) throw contractExists();
  if (owned.length >= CONTRACT_LIMITS.registrationsPerKey) throw contractLimitReached(CONTRACT_LIMITS.registrationsPerKey);
  await assertPhrasesFree(caller, definition, null);

  const pinned = await pin(definition);
  const now = clock();
  const id = `ct_${randomHex(12)}`;
  const createdAt = iso(now);
  const revision: ContractRevision = {
    contractId: id,
    revision: 1,
    definition,
    definitionHash: definitionHashOf(definition),
    pins: pinned.pins,
    createdAt,
  };
  const pendingRecord: ContractRecord = {
    id,
    ownerKeyId: caller.keyId,
    projectId: caller.projectId,
    vm: definition.vm,
    network,
    target,
    status: "pending",
    visibility: definition.visibility ?? "private",
    revision: 1,
    activeRevision: null,
    pendingRevision: 1,
    activatesAt: iso(now + activationDelaySeconds(network) * 1000),
    suspendedReason: null,
    verification: { ...pinned.verification, domain: DOMAIN_UNCHECKED },
    metadata: pinned.metadata,
    pinsCheckedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  const pendingEntry: ContractEntry = { record: pendingRecord, active: null, pending: revision };
  // Testnets (no delay) activate at once, unless a reserved brand name still needs its domain verified.
  const immediate = activated(pendingEntry, now);
  const record = immediate ?? pendingRecord;
  await contractStore().create(record, revision, CONTRACT_LIMITS.registrationsPerKey);
  publish("contract.registered", record, 1);
  if (record.status === "active") publish("contract.activated", record, 1);
  return contractView(immediate ? { record, active: revision, pending: null } : pendingEntry, { owner: true });
}

async function visibleEntry(caller: Caller, id: string): Promise<ContractEntry> {
  const entry = await contractStore().get(id);
  if (!entry || !visibleTo(entry.record, caller)) throw contractNotFound();
  return settle(entry);
}

async function ownedEntry(caller: Caller, id: string): Promise<ContractEntry> {
  const entry = await contractStore().get(id);
  if (!entry || entry.record.status === "deleted" || entry.record.ownerKeyId !== caller.keyId) throw contractNotFound();
  return settle(entry);
}

export interface ContractListFilter {
  readonly network?: NetworkKey;
  readonly vm?: ContractVm;
  readonly status?: ContractStatus;
}

export function parseContractListFilter(query: { network?: string; vm?: string; status?: string }): ContractListFilter {
  const filter: { network?: NetworkKey; vm?: ContractVm; status?: ContractStatus } = {};
  if (query.network) {
    const chain = resolveChain(query.network);
    if (!chain) throw invalidRequest(`Unknown network "${query.network.slice(0, 40)}".`, [{ path: "network", message: "Unknown network." }]);
    filter.network = chain.key;
  }
  if (query.vm) {
    if (query.vm !== "evm" && query.vm !== "svm") throw invalidRequest("vm must be evm or svm.", [{ path: "vm", message: "Expected evm or svm." }]);
    filter.vm = query.vm;
  }
  if (query.status) {
    if (query.status !== "pending" && query.status !== "active" && query.status !== "suspended") {
      throw invalidRequest("status must be pending, active or suspended.", [{ path: "status", message: "Expected pending, active or suspended." }]);
    }
    filter.status = query.status;
  }
  return filter;
}

/** GET /v1/contracts: the caller's registrations and the project-visible ones of its project. */
export async function listContracts(auth: AuthContext, filter: ContractListFilter = {}): Promise<ContractViewWithHistory[]> {
  const caller = reader(auth);
  const out: ContractViewWithHistory[] = [];
  for (const raw of await contractStore().listVisible(caller.keyId, caller.projectId)) {
    const entry = await settle(raw);
    const { record } = entry;
    if (filter.network && record.network !== filter.network) continue;
    if (filter.vm && record.vm !== filter.vm) continue;
    if (filter.status && record.status !== filter.status) continue;
    out.push(contractView(entry, { owner: record.ownerKeyId === caller.keyId }));
  }
  return out;
}

/** GET /v1/contracts/{id}: owners also get the ABI and the revision history. */
export async function getContract(auth: AuthContext, id: string): Promise<ContractViewWithHistory> {
  const caller = reader(auth);
  const entry = await visibleEntry(caller, id);
  const owner = entry.record.ownerKeyId === caller.keyId;
  return contractView(entry, { owner, ...(owner ? { history: await contractStore().history(id, 20) } : {}) });
}

const IMMUTABLE_FIELDS = ["vm", "network", "address", "origin"] as const;

/** PATCH /v1/contracts/{id}: a partial definition merged onto the latest revision (`null` removes an optional field). */
export async function updateContract(auth: AuthContext, id: string, body: unknown): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  if (!isRecord(body) || Object.keys(body).length === 0) {
    throw invalidRequest("Body must be a non-empty partial contract definition, e.g. { \"actions\": [...] }.", [{ path: "", message: "Expected an object with fields to change." }]);
  }
  const entry = await ownedEntry(caller, id);
  const latest = latestRevision(entry);
  const current = latest.definition as unknown as Record<string, unknown>;
  for (const field of IMMUTABLE_FIELDS) {
    if (field in body && canonicalJson(body[field]) !== canonicalJson(current[field])) {
      throw new PlatformError("CONTRACT_DEFINITION_INVALID", `${field} cannot change; register a new contract instead.`, 400, [{ path: field, message: "Immutable." }]);
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const next = validateDefinition(merged);
  await assertPhrasesFree(caller, next, id);

  if (!isSecurityRelevantChange(latest.definition, next)) {
    // Labels and phrases change in place: same revision, same hash, no activation delay.
    const replaced: ContractRevision = { ...latest, definition: next };
    if (definitionHashOf(next) !== latest.definitionHash) throw new Error("Non-security change altered the definition hash.");
    const result = await mutate(id, async (fresh) => {
      if (latestRevision(fresh).revision !== latest.revision) throw new ConcurrentChange();
      return { record: { ...fresh.record, updatedAt: nextTimestamp(fresh.record.updatedAt, clock()) }, replace: replaced };
    });
    if (!result) throw contractNotFound();
    return contractView(result.after, { owner: true });
  }

  const pinned = await pin(next);
  const websiteChanged = (next.integrator.website ?? null) !== (latest.definition.integrator.website ?? null);
  const result = await mutate(id, async (fresh) => {
    if (fresh.record.ownerKeyId !== caller.keyId || fresh.record.status === "deleted") throw contractNotFound();
    return newRevision(fresh, next, pinned, websiteChanged);
  });
  if (!result) throw contractNotFound();
  return announceRevision(result.before, result.after);
}

/** A new revision N+1 (pending on mainnet; on testnets it activates at once). */
function newRevision(
  entry: ContractEntry,
  definition: ContractDefinition,
  pinned: Pinned,
  resetDomain: boolean,
  suspend?: string,
): { record: ContractRecord; insert: ContractRevision } {
  const now = clock();
  const number = entry.record.revision + 1;
  const revision: ContractRevision = {
    contractId: entry.record.id,
    revision: number,
    definition,
    definitionHash: definitionHashOf(definition),
    pins: pinned.pins,
    createdAt: iso(now),
  };
  const base = entry.record;
  const pendingRecord: ContractRecord = {
    ...base,
    status: suspend && base.status === "active" ? "suspended" : base.status,
    suspendedReason: suspend && base.status === "active" ? suspend : base.suspendedReason,
    revision: number,
    pendingRevision: number,
    // A pending first revision stays first: its replacement waits the full delay again.
    activatesAt: iso(now + activationDelaySeconds(base.network) * 1000),
    verification: {
      ...base.verification,
      ...pinned.verification,
      domain: resetDomain ? DOMAIN_UNCHECKED : base.verification.domain,
    },
    metadata: Object.keys(pinned.metadata).length > 0 ? pinned.metadata : base.metadata,
    pinsCheckedAt: iso(now),
    updatedAt: nextTimestamp(base.updatedAt, now),
  };
  const immediate = activated({ record: pendingRecord, active: entry.active, pending: revision }, now);
  return { record: immediate ?? pendingRecord, insert: revision };
}

/** Webhooks for a new revision: `contract.registered`, then activation (and reactivation) when immediate. */
function announceRevision(before: ContractEntry, after: ContractEntry): ContractViewWithHistory {
  const { record } = after;
  if (before.record.status !== "suspended" && record.status === "suspended") {
    publish("contract.suspended", record, before.record.activeRevision ?? before.record.revision, record.suspendedReason ?? undefined);
  }
  publish("contract.registered", record, record.revision);
  if (record.activeRevision === record.revision) {
    if (record.status === "active") publish("contract.activated", record, record.revision);
    if (before.record.status === "suspended" && record.status === "active") publish("contract.reactivated", record, record.revision);
  }
  return contractView(after, { owner: true });
}

/** DELETE /v1/contracts/{id}: soft delete (idempotent for the owner). */
export async function deleteContract(auth: AuthContext, id: string): Promise<void> {
  const caller = writer(auth);
  const existing = await contractStore().get(id);
  if (!existing || existing.record.ownerKeyId !== caller.keyId) throw contractNotFound();
  if (existing.record.status === "deleted") return;
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted") return null;
    return { record: { ...entry.record, status: "deleted", updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) throw contractNotFound();
}

/** POST /v1/contracts/{id}/reverify: fresh pins and checks; a new revision when pins changed or to lift a suspension. */
export async function reverifyContract(auth: AuthContext, id: string): Promise<ContractViewWithHistory> {
  assertContractsEnabled();
  const caller = writer(auth);
  const entry = await ownedEntry(caller, id);
  if (isOperatorSuspension(entry.record)) {
    throw new PlatformError("CONTRACT_SUSPENDED", "This registration was suspended by the operator and cannot be re-verified by the integrator.", 409);
  }
  const latest = latestRevision(entry);
  const pinned = await pin(latest.definition);
  const website = latest.definition.integrator.website;
  const domainVerified = await contractChecks().domain(website, id);
  const domain = { verified: domainVerified, checkedAt: iso(clock()) };
  const changed = comparePins(latest.pins, pinned.pins);
  const suspendedForPins = entry.record.status === "suspended" && entry.record.suspendedReason !== "domain_unverified";
  const result = await mutate(id, async (fresh) => {
    if (fresh.record.status === "deleted") throw contractNotFound();
    if (isOperatorSuspension(fresh.record)) {
      throw new PlatformError("CONTRACT_SUSPENDED", "This registration was suspended by the operator and cannot be re-verified by the integrator.", 409);
    }
    const withDomain: ContractEntry = { ...fresh, record: { ...fresh.record, verification: { ...fresh.record.verification, domain } } };
    if (changed !== null || suspendedForPins) {
      const reason = fresh.record.vm === "evm" ? "pins_changed" : "program_changed";
      return newRevision(withDomain, latestRevision(fresh).definition, pinned, false, changed !== null ? reason : undefined);
    }
    // Same code: refresh verification; a domain-only suspension lifts once the domain verifies again.
    const lift = fresh.record.status === "suspended" && fresh.record.suspendedReason === "domain_unverified" && domain.verified;
    return {
      record: {
        ...withDomain.record,
        verification: { ...withDomain.record.verification, ...pinned.verification, domain },
        ...(lift ? { status: "active" as const, suspendedReason: null } : {}),
        pinsCheckedAt: iso(clock()),
        updatedAt: nextTimestamp(fresh.record.updatedAt, clock()),
      },
    };
  });
  if (!result) throw contractNotFound();
  if (result.after.record.revision !== result.before.record.revision) return announceRevision(result.before, result.after);
  if (result.before.record.status === "suspended" && result.after.record.status === "active") {
    publish("contract.reactivated", result.after.record, result.after.record.activeRevision ?? result.after.record.revision);
  }
  // A verified domain may let a pending revision activate now.
  return contractView(await settle(result.after), { owner: true });
}

/** POST /v1/contracts/{id}/suspend (operator): suspends any registration. */
export async function operatorSuspend(auth: AuthContext, id: string, body: unknown): Promise<ContractViewWithHistory> {
  if (auth.tier !== "operator") throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an operator API key.");
  const raw = isRecord(body) && typeof body.reason === "string" ? body.reason.replace(/\s+/gu, " ").trim() : "";
  if (!raw || raw.length > 200 || /[\p{Cc}\p{Cf}]/u.test(raw)) {
    throw invalidRequest("Body must be { \"reason\": \"…\" } with 1-200 printable characters.", [{ path: "reason", message: "Required, 1-200 printable characters." }]);
  }
  const existing = await contractStore().get(id);
  if (!existing || existing.record.status === "deleted") throw contractNotFound();
  const reason = `${OPERATOR_PREFIX}${raw}`;
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted") throw contractNotFound();
    if (isOperatorSuspension(entry.record)) return null;
    return { record: { ...entry.record, status: "suspended", suspendedReason: reason, updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) throw contractNotFound();
  if (!isOperatorSuspension(result.before.record) && isOperatorSuspension(result.after.record)) {
    publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, reason);
  }
  return contractView(result.after, { owner: false });
}

/** POST /v1/contracts/{id}/test: the plan + prepare pipeline as a dry run (never stored). */
export async function testContract(auth: AuthContext, id: string, request: ContractTestRequest): Promise<ContractTestResult> {
  assertContractsEnabled();
  const caller = reader(auth);
  const entry = await visibleEntry(caller, id);
  // The owner tests the latest revision (also while it is pending); other keys the one intents use.
  const revision = entry.record.ownerKeyId === caller.keyId ? latestRevision(entry) : usedRevision(entry);
  if (!revision.definition.actions.some((action) => action.id === request.entry)) {
    throw new PlatformError("CONTRACT_ACTION_UNKNOWN", `No action "${request.entry}" in this registration.`, 422, [{ path: "entry", message: "Unknown action id." }]);
  }
  const account = parseAccountId(request.account);
  if (!account || account.chain.key !== entry.record.network) {
    throw invalidRequest(`account must be a CAIP-10 account on ${entry.record.network}.`, [{ path: "account", message: "Wrong network." }]);
  }
  return contractEngine().testContractAction(registeredContract(entry, revision), request);
}
