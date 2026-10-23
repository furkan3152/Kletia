/**
 * Automation operations behind /v1/automations. The owner is the API key
 * (project or agent) or, without a key, the wallet of a Kletia account
 * session (the desk). A wallet's automations spend from and watch that
 * wallet's own address only; a key's are bounded by its rule book, which
 * the engine applies to every run's plan.
 *
 * Owners only ever see their own automations: another owner's id answers
 * 404 AUTOMATION_NOT_FOUND.
 */
import {
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LIMITS,
  formatAccountId,
  sameAddressAccount,
  validateAutomationDraft,
  validateAutomationPatch,
  type AccountId,
  type AutomationOwner,
  type AutomationRunView,
  type AutomationView,
  type IntentStatus,
  type ValidatedAutomationDraft,
} from "@kletia/core";
import { getIntent, PlatformError } from "../index.js";
import { randomHex } from "../http/secrets.js";
import { KeyWindowLimiter } from "../http/limits.js";
import { publishAutomationEvent } from "./events.js";
import { automationStore, ownerRefOf, type AutomationRecord } from "./store.js";
import { toAutomationView, toRunView } from "./views.js";

export const automationCreations = new KeyWindowLimiter(AUTOMATION_LIMITS.creationsPerHour, 60 * 60_000, "automations created per hour", 20_000, " per owner");

const LIST_LIMIT = 100;
/** Intent statuses that still wait for the owner's wallet. */
const SIGNABLE: ReadonlySet<IntentStatus> = new Set(["planned", "executing"]);

function notFound(): PlatformError {
  return new PlatformError("AUTOMATION_NOT_FOUND", "No automation with this id belongs to you.", 404);
}

/** A wallet owner's address as an account on any network of its VM (compared with sameAddressAccount). */
function walletAccount(owner: Extract<AutomationOwner, { kind: "wallet" }>): AccountId {
  return formatAccountId(owner.walletKind === "evm" ? "ethereum" : "solana", owner.address);
}

/** Every account the draft spends from or watches must be the wallet's own (wallet owners only). */
function assertWalletAccounts(owner: AutomationOwner, draft: ValidatedAutomationDraft): void {
  if (owner.kind !== "wallet") return;
  const own = walletAccount(owner);
  const watched = draft.trigger.kind === "balance" || draft.trigger.kind === "event" ? [draft.trigger.account] : [];
  const foreign = [...draft.action.accounts, ...watched].find((account) => !sameAddressAccount(account, own));
  if (foreign) {
    throw new PlatformError("AUTOMATION_ACCOUNT_FORBIDDEN", `${foreign} is not the signed-in wallet. A wallet's automations use its own address only.`, 403);
  }
}

async function owned(owner: AutomationOwner, id: string): Promise<AutomationRecord> {
  if (!AUTOMATION_ID_PATTERN.test(id)) throw notFound();
  const record = await automationStore().get(id);
  if (!record || record.ownerRef !== ownerRefOf(owner)) throw notFound();
  return record;
}

/** Writes an owner change (optimistic); a concurrent change answers 409 so the client re-reads. */
async function write(current: AutomationRecord, next: AutomationRecord): Promise<AutomationView> {
  if (!(await automationStore().update(next, current.updatedAt))) {
    throw new PlatformError("AUTOMATION_CONFLICT", "The automation changed meanwhile. Read it again and retry.", 409);
  }
  publishAutomationEvent("automation.updated", next.owner, { automationId: next.id, status: next.status });
  return toAutomationView(next);
}

function touched(current: AutomationRecord, now: number): string {
  // Strictly increasing, so the optimistic check never sees two writes with one stamp.
  return new Date(Math.max(now, Date.parse(current.updatedAt) + 1)).toISOString();
}

export async function createAutomation(owner: AutomationOwner, body: unknown, now = Date.now()): Promise<AutomationView> {
  const parsed = validateAutomationDraft(body, now);
  if (!parsed.ok) throw new PlatformError("AUTOMATION_DRAFT_INVALID", "The automation is invalid.", 400, parsed.issues);
  const draft = parsed.value;
  assertWalletAccounts(owner, draft);
  const ownerRef = ownerRefOf(owner);
  automationCreations.take(ownerRef, now);
  const at = new Date(now).toISOString();
  const record: AutomationRecord = {
    id: `au_${randomHex(12)}`,
    ownerRef,
    owner,
    label: draft.label ?? null,
    trigger: draft.trigger,
    action: draft.action,
    limits: draft.limits,
    status: "active",
    statusReason: null,
    state: { epoch: 0 },
    runs: 0,
    spentUsdMicros: "0",
    lastRunAt: null,
    checkedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  if (!(await automationStore().create(record, AUTOMATION_LIMITS.perOwner))) {
    throw new PlatformError("AUTOMATION_LIMIT_REACHED", `An owner holds at most ${AUTOMATION_LIMITS.perOwner} live automations. Delete some first.`, 409);
  }
  publishAutomationEvent("automation.created", owner, { automationId: record.id, status: "active" });
  return toAutomationView(record, now);
}

export async function listAutomations(owner: AutomationOwner): Promise<AutomationView[]> {
  const now = Date.now();
  return (await automationStore().listByOwner(ownerRefOf(owner), LIST_LIMIT)).map((record) => toAutomationView(record, now));
}

export async function getAutomation(owner: AutomationOwner, id: string): Promise<AutomationView> {
  return toAutomationView(await owned(owner, id));
}

export async function patchAutomation(owner: AutomationOwner, id: string, body: unknown, now = Date.now()): Promise<AutomationView> {
  const current = await owned(owner, id);
  const parsed = validateAutomationPatch(body, now);
  if (!parsed.ok) throw new PlatformError("AUTOMATION_DRAFT_INVALID", "The change is invalid.", 400, parsed.issues);
  const { label, limits } = parsed.value;
  return write(current, {
    ...current,
    ...(label !== undefined ? { label } : {}),
    ...(limits ? { limits } : {}),
    updatedAt: touched(current, now),
  });
}

export async function setAutomationPaused(owner: AutomationOwner, id: string, paused: boolean, now = Date.now()): Promise<AutomationView> {
  const current = await owned(owner, id);
  if (current.status === "completed" || current.status === "expired" || (!paused && Date.parse(current.limits.expiresAt) <= now)) {
    throw new PlatformError("AUTOMATION_ENDED", "This automation has ended. Create a new one.", 409);
  }
  const status = paused ? "paused" : "active";
  if (current.status === status) return toAutomationView(current, now);
  return write(current, { ...current, status, statusReason: paused ? "owner" : null, updatedAt: touched(current, now) });
}

export async function deleteAutomation(owner: AutomationOwner, id: string): Promise<void> {
  const current = await owned(owner, id);
  if (await automationStore().delete(current.id)) publishAutomationEvent("automation.deleted", owner, { automationId: current.id });
}

export async function listAutomationRuns(owner: AutomationOwner, id: string, limit: number): Promise<AutomationRunView[]> {
  const current = await owned(owner, id);
  return (await automationStore().listRuns(current.id, limit)).map(toRunView);
}

export interface InboxEntry extends AutomationRunView {
  readonly automationLabel: string | null;
  readonly intentStatus: IntentStatus;
  readonly intentExpiresAt: string;
}

/**
 * Runs of the last 7 days still waiting for the owner's signature: their
 * intent is planned or part-signed and not expired. An intent that cannot be
 * read is left out (never shown as signable on a guess).
 */
export async function automationInbox(owner: AutomationOwner): Promise<InboxEntry[]> {
  const ownerRef = ownerRefOf(owner);
  const since = new Date(Date.now() - AUTOMATION_LIMITS.inboxDays * 86_400_000).toISOString();
  const runs = await automationStore().listOwnerRuns(ownerRef, ["needs_signature"], since, 50);
  const labels = new Map((await automationStore().listByOwner(ownerRef, LIST_LIMIT)).map((record) => [record.id, record.label]));
  const entries = await Promise.all(
    runs.map(async (run): Promise<InboxEntry | null> => {
      if (!run.intentId) return null;
      const intent = await getIntent(run.intentId).catch(() => null);
      if (!intent || !SIGNABLE.has(intent.status)) return null;
      return { ...toRunView(run), automationLabel: labels.get(run.automationId) ?? null, intentStatus: intent.status, intentExpiresAt: intent.expiresAt };
    }),
  );
  return entries.filter((entry): entry is InboxEntry => entry !== null);
}
