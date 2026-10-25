/**
 * The contract clock and the contract webhook events.
 */
import type {
  ContractEventData,
  ContractEventType,
  KletiaEvent,
} from "@kletia/core";
import { buildEvent } from "../../index.js";
import type { ContractRecord } from "./records.js";

/* ================================================================== clock */

export let clock: () => number = () => Date.now();

/** Replaces the clock of contract activation and caps (tests); `null` restores Date.now. */
export function configureContractClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

export function contractNow(): number {
  return clock();
}

export function iso(time: number): string {
  return new Date(time).toISOString();
}

/** A strictly later timestamp than `previous` (optimistic concurrency token). */
export function nextTimestamp(previous: string, now: number): string {
  const before = Date.parse(previous);
  return iso(Number.isFinite(before) && before >= now ? before + 1 : now);
}

/* ================================================================= events */

export type ContractEvent = KletiaEvent<ContractEventType>;

const listeners = new Set<(event: ContractEvent) => void>();

/** Subscribes to contract lifecycle events (webhook dispatch). Returns an unsubscribe function. */
export function subscribeContractEvents(listener: (event: ContractEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publish(type: ContractEventType, record: ContractRecord, revision: number, reason?: string): void {
  const data: ContractEventData = {
    contractId: record.id,
    ownerKeyId: record.ownerKeyId,
    network: record.network,
    target: record.target,
    revision,
    ...(reason ? { reason } : {}),
  };
  const event = buildEvent(type, data) as ContractEvent;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("[platform] contract event listener failed:", error instanceof Error ? error.message : error);
    }
  }
}
