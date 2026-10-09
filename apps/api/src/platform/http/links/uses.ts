/**
 * Uses of a link (links design §3.9): reserved at the first prepare of a
 * link intent, consumed at its first submit, released when the intent ends
 * without a submit. Prepare of a link intent is forced to strict simulation
 * by the engine (`metadata.linkId`), so a visitor who cannot fund a step
 * never reaches a payload and never holds a use; a reservation made by a
 * prepare that then fails is released in the same handler.
 *
 * - `suspended` refuses every prepare; `paused`, `expired`, `pending` and
 *   withdrawn links refuse only intents without a consumed use (a visitor
 *   whose bridge already landed can always finish);
 * - the intent status listener releases uses of intents that expired or were
 *   cancelled (and counts completed / failed / expired / cancelled, with the
 *   priced root input as volume); a sweeper every 10 minutes releases
 *   reservations whose intent ended or vanished.
 */
import { parseAccountId, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { getIntent, notionalUsdMicros, policyPrice, subscribeIntentEvents, MAX_INTENT_TTL_MS } from "../../index.js";
import { accountHash, effectiveLinkStatus, linkClock, linkStatusError } from "./service.js";
import { countLink } from "./stats.js";
import { linkStore, type LinkRecord } from "./store.js";

export interface LinkPrepareHold {
  readonly linkId: string;
  /** Called when the prepare failed after this hook reserved the use. */
  failed(): Promise<void>;
  /** Called when the prepare succeeded. */
  succeeded(): void;
}

/** The root step: the one spending the visitor's funds (no incoming `funds` edge). */
function rootStep(intent: IntentGraph) {
  const funded = new Set(intent.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  return intent.steps.find((step) => !funded.has(step.id) && step.input !== undefined) ?? intent.steps[0];
}

export function linkSource(intent: IntentGraph): string {
  const root = rootStep(intent);
  return root?.input ? `${root.network}:${root.input.symbol}` : "";
}

function linkIdOf(intent: IntentGraph): string | null {
  const id = intent.metadata?.linkId;
  return typeof id === "string" ? id : null;
}

/**
 * Before `prepareStep` of any intent: nothing for ordinary intents; for link
 * intents the status rules and, at the first prepare, the atomic use
 * reservation (LINK_EXHAUSTED / LINK_ACCOUNT_LIMIT).
 */
export async function beforeLinkPrepare(intentId: string): Promise<LinkPrepareHold | null> {
  const intent = await getIntent(intentId);
  const linkId = linkIdOf(intent);
  if (!linkId) return null;
  const now = linkClock();
  const record = await linkStore().get(linkId);
  // A link intent whose link vanished is not prepared (fail closed).
  if (!record) throw new PlatformError("LINK_NOT_FOUND", "The link this intent was created from no longer exists.", 404);
  const status = effectiveLinkStatus(record, now);
  if (status === "suspended") throw linkStatusError(record, status, now) as PlatformError;
  const use = await linkStore().use(linkId, intentId);
  if (use?.state === "consumed" || use?.state === "reserved") {
    return { linkId, failed: async () => undefined, succeeded: () => undefined };
  }
  const refusal = status === "exhausted" ? null : linkStatusError(record, status, now);
  if (refusal) throw refusal;
  const root = rootStep(intent);
  const perAccount = record.definition.perAccount?.maxUses ?? null;
  const outcome = await linkStore().reserve({
    linkId,
    intentId,
    accountHash: perAccount !== null && root ? accountHash(linkId, root.account) : null,
    source: linkSource(intent),
    perAccountMax: perAccount,
    now,
  });
  if (!outcome.ok) {
    if (outcome.reason === "account_limit") throw new PlatformError("LINK_ACCOUNT_LIMIT", "This account reached the link's per-account limit.", 409);
    const fresh = (await linkStore().get(linkId)) ?? record;
    const freshStatus = effectiveLinkStatus(fresh, now);
    throw linkStatusError(fresh, outcome.reason === "exhausted" || freshStatus === "active" ? "exhausted" : freshStatus, now) as PlatformError;
  }
  if (outcome.replayed) return { linkId, failed: async () => undefined, succeeded: () => undefined };
  return {
    linkId,
    failed: async () => {
      await linkStore().release(linkId, intentId, linkClock()).catch((error: unknown) => {
        console.warn(`[platform] releasing use of ${linkId} failed:`, error instanceof Error ? error.message : error);
      });
    },
    succeeded: () => countLink(linkId, "prepared", { dimension: outcome.use.source }),
  };
}

/** After a successful submit of a link intent's step: the use is consumed (once). */
export async function afterLinkSubmit(intent: IntentGraph): Promise<void> {
  const linkId = linkIdOf(intent);
  if (!linkId) return;
  try {
    const result = await linkStore().consume(linkId, intent.id, linkClock());
    if (result.changed) countLink(linkId, "submitted", { dimension: linkSource(intent) });
    if (result.overflow) countLink(linkId, "overflow");
  } catch (error) {
    console.warn(`[platform] consuming use of ${linkId} failed:`, error instanceof Error ? error.message : error);
  }
}

/** Priced root input of a completed link intent (conservative oracle); null when unpriced. */
async function volumeOf(intent: IntentGraph): Promise<number | null> {
  const root = rootStep(intent);
  if (!root?.input) return null;
  const quote = await policyPrice({ asset: root.input.asset, symbol: root.input.symbol, decimals: root.input.decimals, network: root.network }).catch(() => null);
  if (!quote) return null;
  return Number(notionalUsdMicros(BigInt(root.input.amount), root.input.decimals, quote));
}

async function onTerminal(intentId: string, status: "completed" | "failed" | "expired" | "cancelled"): Promise<void> {
  const intent = await getIntent(intentId).catch(() => null);
  const linkId = intent ? linkIdOf(intent) : null;
  if (!intent || !linkId) return;
  const source = linkSource(intent);
  countLink(linkId, status, { dimension: source });
  if (status === "expired" || status === "cancelled") {
    await linkStore().release(linkId, intentId, linkClock());
  }
  if (status === "completed") {
    const volume = await volumeOf(intent);
    if (volume === null) countLink(linkId, "unpriced", { dimension: source });
    else countLink(linkId, "volumeUsdMicros", { dimension: source, count: 0, usdMicros: volume });
  }
}

const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

/** Listens to intent status changes (release and counters); returns an unsubscribe function. */
export function startLinkUseListener(): () => void {
  return subscribeIntentEvents((event) => {
    if (event.type !== "intent.status_changed" || !TERMINAL.has(event.data.status)) return;
    void onTerminal(event.data.intentId, event.data.status as "completed" | "failed" | "expired" | "cancelled").catch((error: unknown) => {
      console.warn("[platform] link use listener failed:", error instanceof Error ? error.message : error);
    });
  });
}

/** Releases reservations whose intent ended without a submit (or vanished); returns how many. */
export async function sweepLinkUses(now = linkClock(), limit = 200): Promise<number> {
  const stale = await linkStore().staleReservations(new Date(now - Math.min(MAX_INTENT_TTL_MS, 24 * 3_600_000)).toISOString(), limit);
  let released = 0;
  for (const use of stale) {
    const intent = await getIntent(use.intentId).catch(() => null);
    if (intent && !TERMINAL.has(intent.status)) continue;
    if (await linkStore().release(use.linkId, use.intentId, now)) released += 1;
  }
  return released;
}

/** The visitor's source account of a link intent (blinks: the Solana account). */
export function visitorAccount(intent: IntentGraph, vm: "evm" | "svm"): string | null {
  return intent.request.accounts.find((account) => parseAccountId(account)?.chain.vm === vm) ?? null;
}

/** For tests and the watcher: a link's live reservation count. */
export function usedOf(record: LinkRecord): number {
  return record.used;
}
