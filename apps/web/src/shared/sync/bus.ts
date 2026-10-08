import { useEffect, useRef } from "react";
import {
  createEventBus,
  isNetworkKey,
  parseAccountId,
  type AccountId,
  type KletiaEventMap,
  type KletiaEventType,
  type NetworkKey,
} from "@kletia/core";

/**
 * Cross-feature synchronisation bus for the web app.
 *
 * Features never call each other directly: a wallet connecting, a workspace
 * switching, a transaction confirming or a balance going stale is announced
 * here with the same event vocabulary the Platform API uses for SSE and
 * webhooks (`KletiaEventMap` in @kletia/core). Listeners are isolated: one
 * failing listener never stops the others.
 */
export const kletiaBus = createEventBus<KletiaEventMap>((error) => {
  if (import.meta.env.DEV) {
    console.warn("[kletia-bus] listener failed", error);
  }
});

/**
 * Cross-tab relay: a balance that went stale in one tab (Studio, the console,
 * an embed on this origin) is stale in every other open tab of the app too.
 * Only `portfolio.invalidated` crosses tabs; activity is shared through the
 * persisted activity store instead.
 */
const CROSS_TAB_CHANNEL = "kletia-bus";
let relayingRemoteEvent = false;

function installCrossTabRelay(): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CROSS_TAB_CHANNEL);
  } catch {
    return;
  }
  channel.onmessage = (message: MessageEvent<unknown>) => {
    const data = message.data as { type?: unknown; payload?: Record<string, unknown> } | null;
    if (!data || data.type !== "portfolio.invalidated" || !data.payload) return;
    const { account, network, reason } = data.payload;
    const parsed = parseAccountId(account);
    if (!parsed || !isNetworkKey(network) || typeof reason !== "string") return;
    relayingRemoteEvent = true;
    try {
      kletiaBus.emit("portfolio.invalidated", { account: parsed.id, network, reason: reason.slice(0, 200) });
    } finally {
      relayingRemoteEvent = false;
    }
  };
  kletiaBus.on("portfolio.invalidated", (payload) => {
    if (relayingRemoteEvent) return;
    try {
      channel.postMessage({ type: "portfolio.invalidated", payload });
    } catch {
      // A closed or unavailable channel only means other tabs refresh later.
    }
  });
}

installCrossTabRelay();

export function emitWalletConnected(account: AccountId, wallet: string): void {
  kletiaBus.emit("wallet.connected", { account, wallet });
}

export function emitWalletDisconnected(account: AccountId): void {
  kletiaBus.emit("wallet.disconnected", { account });
}

export function emitNetworkSelected(network: NetworkKey): void {
  kletiaBus.emit("network.selected", { network });
}

/** Ask every balance view bound to `account` on `network` to re-read. */
export function emitPortfolioInvalidated(
  account: AccountId,
  network: NetworkKey,
  reason: string,
): void {
  kletiaBus.emit("portfolio.invalidated", { account, network, reason });
}

export function emitActivityRecorded(
  payload: KletiaEventMap["activity.recorded"],
): void {
  kletiaBus.emit("activity.recorded", payload);
}

/**
 * Subscribe a component to one bus event. The subscription is created once
 * per event type; the latest handler is always called, so callers may pass an
 * inline function without re-subscribing on every render.
 */
export function useKletiaEvent<K extends KletiaEventType>(
  type: K,
  handler: (payload: KletiaEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(
    () => kletiaBus.on(type, (payload) => handlerRef.current(payload)),
    [type],
  );
}
