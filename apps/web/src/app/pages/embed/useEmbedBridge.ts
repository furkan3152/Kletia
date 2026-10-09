import { useEffect, useSyncExternalStore } from "react";

import {
  type BridgeSnapshot,
  createEmbedBridge,
  type EmbedBridge,
  readBridgeParams,
  toConnectEvent,
  windowBridgeEnv,
} from "./embedBridge";
import { takeEarlyConnects } from "./embedParams";

function isFramed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/**
 * One bridge per document. It takes over from the entry's early listener
 * (connects sent on the frame's `load`, before this chunk ran) and survives
 * remounts, so a second connect stays ignored for the life of the page.
 */
const documentBridge: EmbedBridge | null = (() => {
  if (typeof window === "undefined") return null;
  // Synchronous hand-over: no message can arrive between these statements.
  const early = takeEarlyConnects();
  const params = readBridgeParams(window.location.search);
  if (!isFramed() || !params.enabled) return null;
  const bridge = createEmbedBridge(windowBridgeEnv(window, params.hostOrigin, params.reference));
  bridge.start();
  for (const event of early) bridge.offer(toConnectEvent(event));
  return bridge;
})();

const WAITING: BridgeSnapshot = { status: "waiting", origin: null };
const subscribeNowhere = () => () => undefined;
const readWaiting = () => WAITING;

/** The page's bridge (`null` without `bridge=1&origin=…` or outside a frame) and its connection state. */
export function useEmbedBridge(): { bridge: EmbedBridge | null; snapshot: BridgeSnapshot } {
  const snapshot = useSyncExternalStore(
    documentBridge ? documentBridge.subscribe : subscribeNowhere,
    documentBridge ? documentBridge.getSnapshot : readWaiting,
  );
  return { bridge: documentBridge, snapshot };
}

/**
 * Reports the content height to the host. `html.kletia-embed` keeps the
 * document at its content height, so the root's box is the measure.
 */
export function useEmbedResize(bridge: EmbedBridge | null): void {
  useEffect(() => {
    if (!bridge) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const measure = () => {
      frame = 0;
      bridge.resize(root.getBoundingClientRect().height);
    };
    // The first measurement also releases the bridge's `ready` message.
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [bridge]);
}
