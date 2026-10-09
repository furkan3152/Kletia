/**
 * Event model shared by the API (SSE + webhooks), the SDK and the web app's
 * cross-feature synchronisation bus.
 */
import type { NetworkKey } from "./chains.js";
import type { AccountId } from "./caip.js";
import type { IntentStatus, IntentSummary, StepEvidence, StepStatus } from "./intent.js";
import type { ReceiptIntentStatus } from "./receipts.js";

/**
 * Payload of the contract registration events (webhooks route them by
 * `ownerKeyId`, never to other keys).
 */
export interface ContractEventData {
  readonly contractId: string;
  readonly ownerKeyId: string;
  readonly network: NetworkKey;
  /** Lower-case contract address (EVM) or the Solana Actions origin. */
  readonly target: string;
  readonly revision: number;
  /** Suspensions: `pins_changed`, `outcome_mismatch`, `program_changed` or an operator reason. */
  readonly reason?: string;
}

/** `intent.receipt_issued`: ids and digest only (never disclosures). */
export interface ReceiptIssuedEventData {
  readonly intentId: string;
  readonly receiptId: string;
  readonly sequence: number;
  readonly status: ReceiptIntentStatus;
  readonly terminal: boolean;
  readonly digest: string;
  readonly kid: string;
  /** Digest of the receipt this one replaces. */
  readonly supersedes: string | null;
}

/** Payload of the intent link events (routed by `ownerKeyId`, like contract events). */
export interface LinkEventData {
  readonly linkId: string;
  readonly ownerKeyId: string;
  readonly revision: number;
  /** `recipient_changed`, `contract_changed`, `domain_unverified`, `operator`, … */
  readonly reason?: string;
}

/** Common fields of every Rule Book event: the project, the subject key and the decision or approval. */
export interface PolicyEventBase {
  readonly projectId: string;
  /** Subject key (null for the project rule book). */
  readonly keyId: string | null;
}

export interface PolicyEventMap {
  /** A plan or prepare was refused, or an observed breach (nonce override, uncleared payload) was recorded. */
  "policy.violation": PolicyEventBase & {
    readonly decisionId: string;
    readonly stage: string;
    readonly intentId?: string;
    /** Violated rule ids. */
    readonly rules: readonly string[];
  };
  "policy.approval_requested": PolicyEventBase & {
    readonly approvalId: string;
    readonly intentId: string;
    readonly decisionId: string;
    readonly notionalUsd: string;
    readonly ceilingUsd: string;
    readonly url: string;
    readonly expiresAt: string;
    readonly triggers: readonly string[];
  };
  "policy.approval_decided": PolicyEventBase & {
    readonly approvalId: string;
    readonly intentId: string;
    readonly decision: "approved" | "rejected" | "expired";
    readonly decidedBy: { readonly kind: "key"; readonly keyId: string } | { readonly kind: "wallet"; readonly account: AccountId } | null;
  };
  "policy.amendment_pending": PolicyEventBase & {
    readonly scope: "project" | "key";
    readonly version: number;
    readonly activatesAt: string;
    /** Loosened field paths. */
    readonly loosened: readonly string[];
    readonly decisionId: string;
  };
  "policy.amended": PolicyEventBase & {
    readonly scope: "project" | "key";
    readonly version: number;
    readonly hash: string;
    readonly decisionId: string;
  };
  "policy.spend_threshold": PolicyEventBase & {
    /** Scope whose window crossed the threshold (key id or prj_…). */
    readonly scope: string;
    readonly window: "24h" | "7d";
    readonly thresholdPct: 80 | 95;
    readonly usedUsd: string;
    readonly capUsd: string;
    readonly decisionId: string;
  };
  "key.created": PolicyEventBase & {
    readonly kind: "project" | "agent";
    readonly parentId: string | null;
    readonly expiresAt: string | null;
  };
  "key.revoked": PolicyEventBase & {
    /** Every key revoked with it (its subtree), the subject included. */
    readonly cascade: readonly string[];
  };
}

export interface KletiaEventMap extends PolicyEventMap {
  "intent.created": {
    readonly intentId: string;
    readonly summary: IntentSummary;
    readonly metadata?: Readonly<Record<string, string>>;
  };
  "intent.status_changed": {
    readonly intentId: string;
    readonly status: IntentStatus;
    readonly previous: IntentStatus;
  };
  "intent.step_updated": {
    readonly intentId: string;
    readonly stepId: string;
    readonly network: NetworkKey;
    readonly status: StepStatus;
    readonly evidence?: StepEvidence;
  };
  /** A registration was created (mainnet: still pending activation). */
  "contract.registered": ContractEventData;
  /** A registration or a new revision became active. */
  "contract.activated": ContractEventData;
  /** A registration was suspended (pin change, outcome mismatch, program change, operator). */
  "contract.suspended": ContractEventData;
  /** A suspended registration became usable again (reverify or operator). */
  "contract.reactivated": ContractEventData;
  /** A finalized, signed receipt was issued for the intent (receipts arrive after the terminal status, behind finality). */
  "intent.receipt_issued": ReceiptIssuedEventData;
  /** A link was created (production links paying a third party or calling a contract are pending activation). */
  "link.created": LinkEventData;
  "link.activated": LinkEventData;
  "link.updated": LinkEventData;
  "link.paused": LinkEventData;
  "link.suspended": LinkEventData;
  "link.exhausted": LinkEventData;
  "link.expired": LinkEventData;
  "link.deleted": LinkEventData;
  /** Sent by POST /v1/webhooks/{id}/test to check an endpoint; never emitted for intents. */
  "webhook.test": { readonly webhookId: string };
  "wallet.connected": { readonly account: AccountId; readonly wallet: string };
  "wallet.disconnected": { readonly account: AccountId };
  "network.selected": { readonly network: NetworkKey };
  /** A balance on `network` for `account` is stale and should be re-read. */
  "portfolio.invalidated": { readonly account: AccountId; readonly network: NetworkKey; readonly reason: string };
  "activity.recorded": {
    readonly id: string;
    readonly network: NetworkKey;
    readonly title: string;
    readonly reference?: string;
    readonly url?: string;
  };
}

export type KletiaEventType = keyof KletiaEventMap;

export type ContractEventType = Extract<KletiaEventType, `contract.${string}`>;

/** Contract registration event types, in lifecycle order. */
export const CONTRACT_EVENT_TYPES: readonly ContractEventType[] = Object.freeze([
  "contract.registered",
  "contract.activated",
  "contract.suspended",
  "contract.reactivated",
]);

export type LinkEventType = Extract<KletiaEventType, `link.${string}`>;

/** Intent link event types, in lifecycle order. */
export const LINK_EVENT_TYPES: readonly LinkEventType[] = Object.freeze([
  "link.created",
  "link.activated",
  "link.updated",
  "link.paused",
  "link.suspended",
  "link.exhausted",
  "link.expired",
  "link.deleted",
]);

export type PolicyEventType = Extract<KletiaEventType, `policy.${string}`>;

/** Rule Book event types. */
export const POLICY_EVENT_TYPES: readonly PolicyEventType[] = Object.freeze([
  "policy.violation",
  "policy.approval_requested",
  "policy.approval_decided",
  "policy.amendment_pending",
  "policy.amended",
  "policy.spend_threshold",
]);

export type KeyEventType = Extract<KletiaEventType, `key.${string}`>;

/** API key lifecycle event types (agent keys and cascades). */
export const KEY_EVENT_TYPES: readonly KeyEventType[] = Object.freeze(["key.created", "key.revoked"]);

/** The receipt event (an intent event: routed by the intent's owner, replayed by the SSE buffer). */
export const RECEIPT_EVENT_TYPE = "intent.receipt_issued" as const satisfies KletiaEventType;

export interface KletiaEvent<T extends KletiaEventType = KletiaEventType> {
  readonly id: string;
  readonly type: T;
  readonly at: string;
  readonly data: KletiaEventMap[T];
}

export type AnyKletiaEvent = { [K in KletiaEventType]: KletiaEvent<K> }[KletiaEventType];

type Listener<T> = (payload: T) => void;

export interface EventBus<M extends object> {
  on<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void;
  once<K extends keyof M>(type: K, listener: Listener<M[K]>): () => void;
  off<K extends keyof M>(type: K, listener: Listener<M[K]>): void;
  emit<K extends keyof M>(type: K, payload: M[K]): void;
  /** Subscribe to every event; receives the type alongside the payload. */
  onAny(listener: <K extends keyof M>(type: K, payload: M[K]) => void): () => void;
  clear(): void;
}

/** Tiny synchronous typed pub/sub. Listener errors are isolated. */
export function createEventBus<M extends object>(
  onListenerError: (error: unknown) => void = () => undefined,
): EventBus<M> {
  const listeners = new Map<keyof M, Set<Listener<unknown>>>();
  const wildcard = new Set<(type: keyof M, payload: unknown) => void>();
  const bus: EventBus<M> = {
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener as Listener<unknown>);
      listeners.set(type, set);
      return () => bus.off(type, listener);
    },
    once(type, listener) {
      const unsubscribe = bus.on(type, (payload) => {
        unsubscribe();
        listener(payload);
      });
      return unsubscribe;
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener as Listener<unknown>);
    },
    emit(type, payload) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        try {
          listener(payload);
        } catch (error) {
          onListenerError(error);
        }
      }
      for (const listener of [...wildcard]) {
        try {
          listener(type, payload);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    onAny(listener) {
      const wrapped = listener as (type: keyof M, payload: unknown) => void;
      wildcard.add(wrapped);
      return () => {
        wildcard.delete(wrapped);
      };
    },
    clear() {
      listeners.clear();
      wildcard.clear();
    },
  };
  return bus;
}
