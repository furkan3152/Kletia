/**
 * Event model shared by the API (SSE + webhooks), the SDK and the web app's
 * cross-feature synchronisation bus.
 */
import type { NetworkKey } from "./chains.js";
import type { AccountId } from "./caip.js";
import type { IntentStatus, IntentSummary, StepEvidence, StepStatus } from "./intent.js";

export interface KletiaEventMap {
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
