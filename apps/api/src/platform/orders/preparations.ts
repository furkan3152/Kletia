/**
 * Prepared orders between prepare (or cancel) and submit. The id is a
 * random capability; the stored draft is what the signature is checked
 * against, so a client can never change what Kletia relays. Kept in memory
 * on the instance that prepared it, for the draft's short lifetime.
 */
import { createHash, randomBytes } from "node:crypto";
import { PlatformError } from "../errors.js";
import type { OrderSignRequest, PreparedOrderDraft, RelayResult } from "./types.js";

export const PREPARATION_ID_PATTERN = /^ordp_[0-9a-f]{32}$/u;
const MAX_PREPARATIONS = 10_000;

export interface StoredPreparation {
  readonly id: string;
  readonly draft: PreparedOrderDraft;
  readonly expiresAt: number;
  state: "ready" | "relaying" | "done";
  result?: RelayResult;
  /** sha256 of the submission that was relayed. */
  fingerprint?: string;
}

/** What clients see: the steps, never the relay context. */
export interface PreparationView {
  readonly id: string;
  readonly protocol: PreparedOrderDraft["protocol"];
  readonly action: PreparedOrderDraft["action"];
  readonly network: PreparedOrderDraft["network"];
  readonly owner: string;
  readonly orderId: string | null;
  readonly steps: readonly OrderSignRequest[];
  readonly submit: PreparedOrderDraft["submit"];
  readonly expiresAt: string;
  readonly warnings: readonly string[];
}

const store = new Map<string, StoredPreparation>();
let clock: () => number = () => Date.now();

/** Overrides the clock (tests); null restores Date.now. */
export function configurePreparationClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function resetPreparations(): void {
  store.clear();
}

function prune(now: number): void {
  for (const [id, entry] of store) if (entry.expiresAt <= now) store.delete(id);
  while (store.size >= MAX_PREPARATIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function savePreparation(draft: PreparedOrderDraft): StoredPreparation {
  const now = clock();
  prune(now);
  const entry: StoredPreparation = { id: `ordp_${randomBytes(16).toString("hex")}`, draft, expiresAt: now + draft.ttlSeconds * 1000, state: "ready" };
  store.set(entry.id, entry);
  return entry;
}

export function preparationView(entry: StoredPreparation): PreparationView {
  const { draft } = entry;
  return {
    id: entry.id,
    protocol: draft.protocol,
    action: draft.action,
    network: draft.network,
    owner: draft.owner,
    orderId: draft.orderId,
    steps: draft.steps,
    submit: draft.submit,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    warnings: draft.warnings,
  };
}

/** The live preparation `id`, or ORDER_PREPARATION_NOT_FOUND / ORDER_PREPARATION_EXPIRED. */
export function loadPreparation(id: string): StoredPreparation {
  const entry = PREPARATION_ID_PATTERN.test(id) ? store.get(id) : undefined;
  if (!entry) throw new PlatformError("ORDER_PREPARATION_NOT_FOUND", "No prepared order has this id on this instance.", 404);
  if (entry.expiresAt <= clock()) {
    store.delete(id);
    throw new PlatformError("ORDER_PREPARATION_EXPIRED", "The prepared order expired. Prepare it again.", 410);
  }
  return entry;
}

export function submissionFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
