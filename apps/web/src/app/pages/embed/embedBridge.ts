/**
 * Frame side of the embed bridge (protocol v1), used by `/embed` when the
 * host page opted in with `?bridge=1&origin=<host origin>`.
 *
 * - The host must send an explicit connect message, `{ kletia: "connect", v: 1 }`,
 *   with exactly one transferred `MessagePort`. Before that, nothing is posted.
 * - The connect is accepted once, and only from `window.parent`, from a real
 *   http(s) origin (never `"null"`) that equals the `origin` query parameter
 *   and, where the browser has `location.ancestorOrigins`, its first entry.
 * - Every message goes over that port: nothing is ever posted to `"*"` or to
 *   `window.parent`. The host cannot send commands back.
 * - Messages carry the minimum: heights, statuses, step ids, network keys and
 *   error codes. An intent id (a read capability for the intent) is only sent
 *   for stored intents, after the visitor has been shown that the host site
 *   receives progress updates. Never addresses, amounts or transaction hashes.
 *
 * No runtime imports, so `node --test` can load this file directly.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

export interface BridgeParams {
  /** `bridge=1` with a valid `origin`: the host page asked for progress events. */
  readonly enabled: boolean;
  /** The host page origin the connect must come from (`origin=`), or `null`. */
  readonly hostOrigin: string | null;
  /** The host's reference (`ref=`, `^[A-Za-z0-9_.:-]{1,80}$`), stored as `metadata.hostRef`, or `null`. */
  readonly reference: string | null;
}

const HOST_REFERENCE = /^[A-Za-z0-9_.:-]{1,80}$/u;

/** Reads `bridge`, `origin` and `ref` from the `/embed` query string. */
export function readBridgeParams(search: string): BridgeParams {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  const origin = query.get("origin");
  const hostOrigin = isHttpOrigin(origin) ? origin : null;
  const reference = query.get("ref");
  return {
    enabled: query.get("bridge") === "1" && hostOrigin !== null,
    hostOrigin,
    reference: reference !== null && HOST_REFERENCE.test(reference) ? reference : null,
  };
}

/** The port the host transferred with its connect message. */
export interface BridgePort {
  postMessage(message: unknown): void;
}

/** The parts of a `MessageEvent` the connect check reads. */
export interface ConnectEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
  readonly ports: readonly BridgePort[];
}

export interface ConnectContext {
  /** `window.parent` (equal to `self` when the page is not framed). */
  readonly parent: unknown;
  readonly self: unknown;
  /** `location.ancestorOrigins` as an array, or `null` where the browser lacks the API. */
  readonly ancestorOrigins: readonly string[] | null;
  /** The host origin claimed by the `origin` query parameter, or `null`. */
  readonly expectedOrigin: string | null;
  /** True once a connect was accepted: every later connect is ignored. */
  readonly connected: boolean;
}

export type ConnectRejection =
  | "not_connect"
  | "already_connected"
  | "not_framed"
  | "source_not_parent"
  | "origin_invalid"
  | "origin_param_missing"
  | "origin_param_mismatch"
  | "ancestor_mismatch"
  | "port_missing";

export type ConnectDecision =
  | { readonly ok: true; readonly origin: string; readonly port: BridgePort }
  | { readonly ok: false; readonly reason: ConnectRejection };

/** True for an http(s) origin in canonical form; false for `"null"` and anything else. */
export function isHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

export function isConnectMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kletia?: unknown }).kletia === "connect" &&
    (data as { v?: unknown }).v === BRIDGE_PROTOCOL_VERSION
  );
}

/** The connect acceptance rules, in order. Pure: the caller supplies the window facts. */
export function acceptConnect(event: ConnectEvent, context: ConnectContext): ConnectDecision {
  if (!isConnectMessage(event.data)) return { ok: false, reason: "not_connect" };
  if (context.connected) return { ok: false, reason: "already_connected" };
  if (context.parent === null || context.parent === undefined || context.parent === context.self) {
    return { ok: false, reason: "not_framed" };
  }
  if (event.source !== context.parent) return { ok: false, reason: "source_not_parent" };
  if (!isHttpOrigin(event.origin)) return { ok: false, reason: "origin_invalid" };
  if (context.expectedOrigin === null) return { ok: false, reason: "origin_param_missing" };
  if (event.origin !== context.expectedOrigin) return { ok: false, reason: "origin_param_mismatch" };
  // Firefox before 148 has no ancestorOrigins: the parent check and the origin parameter carry the proof there.
  if (context.ancestorOrigins !== null && context.ancestorOrigins[0] !== event.origin) {
    return { ok: false, reason: "ancestor_mismatch" };
  }
  const port = event.ports.length === 1 ? event.ports[0] : undefined;
  if (!port) return { ok: false, reason: "port_missing" };
  return { ok: true, origin: event.origin, port };
}

/** What the bridge reads from an intent: ids and statuses only. */
export interface BridgeIntent {
  readonly id: string;
  readonly status: string;
  readonly steps: readonly { readonly id: string; readonly index: number; readonly network: string; readonly status: string }[];
}

export interface BridgeSnapshot {
  readonly status: "waiting" | "connected";
  /** The proven host origin once connected. */
  readonly origin: string | null;
}

export interface EmbedBridgeEnv {
  /** Subscribes to the window's `message` events; returns an unsubscribe function. */
  readonly listen: (listener: (event: ConnectEvent) => void) => () => void;
  /** Window facts, read when a connect arrives. */
  readonly context: () => Omit<ConnectContext, "connected">;
  /** The host's `ref` parameter, echoed in `intent.planned` and `intent.created`. */
  readonly reference?: string | null;
  /** Diagnostics for ignored connects (the reason only, never message data). */
  readonly warn?: (message: string) => void;
}

export interface EmbedBridge {
  /** Starts listening for the host's connect message. Returns a stop function. */
  start(): () => void;
  /** Judges a connect message that arrived before `start()` (see `takeEarlyConnects`). */
  offer(event: ConnectEvent): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): BridgeSnapshot;
  /** The page calls this once the "this site is notified" notice is on screen. */
  setNoticeVisible(visible: boolean): void;
  resize(height: number): void;
  intentCreated(intent: BridgeIntent, persisted: boolean): void;
  intentUpdated(intent: BridgeIntent): void;
  intentCompleted(intent: BridgeIntent): void;
  error(error: unknown): void;
}

const MAX_HEIGHT = 20_000;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function errorCode(error: unknown, depth = 0): string | null {
  if (typeof error !== "object" || error === null || depth > 3) return null;
  const { code, name, cause } = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (code === 4001 || code === "ACTION_REJECTED" || name === "UserRejectedRequestError") return "USER_REJECTED";
  if (typeof code === "string" && ERROR_CODE.test(code)) return code;
  return errorCode(cause, depth + 1);
}

/** A stable code and a fixed message for the host; the visitor's error text never leaves the frame. */
export function describeBridgeError(error: unknown): { code: string; message: string } {
  const code = errorCode(error) ?? "EMBED_ERROR";
  const message =
    code === "USER_REJECTED"
      ? "The visitor declined the wallet request."
      : "The widget could not finish the request. GET /v1/errors describes the code.";
  return { code, message };
}

export function createEmbedBridge(env: EmbedBridgeEnv): EmbedBridge {
  const listeners = new Set<() => void>();
  let snapshot: BridgeSnapshot = { status: "waiting", origin: null };
  let port: BridgePort | null = null;
  // `ready` waits for the first height measurement; nothing else is posted before it.
  let readySent = false;
  let noticeVisible = false;
  let height: number | null = null;
  let sentHeight: number | null = null;
  // Last step statuses sent for the stored intent being tracked.
  let tracked: { id: string; steps: Map<string, string> } | null = null;
  let unlisten: (() => void) | null = null;

  const post = (message: Record<string, unknown>) => {
    if (!port) return;
    try {
      port.postMessage({ kletia: "event", v: BRIDGE_PROTOCOL_VERSION, ...message });
    } catch {
      // The host closed its end; the frame keeps working without it.
    }
  };
  const canShareIds = () => readySent && noticeVisible;
  const sendReady = () => {
    readySent = true;
    sentHeight = height;
    post({ type: "ready", height });
  };

  const onMessage = (event: ConnectEvent) => {
    if (!isConnectMessage(event.data)) return;
    const decision = acceptConnect(event, { ...env.context(), connected: port !== null });
    if (!decision.ok) {
      // Extra connects from a host that retried before `ready` reached it are expected; stay quiet about those.
      if (decision.reason !== "already_connected") env.warn?.(`Kletia embed: connect ignored (${decision.reason}).`);
      return;
    }
    port = decision.port;
    snapshot = { status: "connected", origin: decision.origin };
    unlisten?.();
    unlisten = null;
    if (height !== null) sendReady();
    for (const listener of listeners) listener();
  };

  const sendStepChanges = (intent: BridgeIntent) => {
    if (!tracked || tracked.id !== intent.id || !canShareIds()) return;
    for (const step of intent.steps) {
      if (tracked.steps.get(step.id) === step.status) continue;
      tracked.steps.set(step.id, step.status);
      post({
        type: "intent.step_updated",
        intentId: intent.id,
        stepId: step.id,
        stepIndex: step.index,
        network: step.network,
        status: step.status,
      });
    }
  };

  return {
    start() {
      if (port === null && unlisten === null) unlisten = env.listen(onMessage);
      return () => {
        unlisten?.();
        unlisten = null;
      };
    },
    offer: onMessage,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    setNoticeVisible(visible) {
      noticeVisible = visible;
    },
    resize(next) {
      if (!Number.isFinite(next)) return;
      height = Math.min(MAX_HEIGHT, Math.max(0, Math.ceil(next)));
      if (!port) return;
      if (!readySent) {
        sendReady();
      } else if (height !== sentHeight) {
        sentHeight = height;
        post({ type: "resize", height });
      }
    },
    intentCreated(intent, persisted) {
      if (!readySent) return;
      const reference = env.reference ? { reference: env.reference } : {};
      tracked = null;
      if (!persisted) {
        // A preview (dry run): nothing is stored, so there is no id to share.
        post({ type: "intent.planned", status: intent.status, ...reference });
        return;
      }
      if (!canShareIds()) return;
      tracked = { id: intent.id, steps: new Map(intent.steps.map((step) => [step.id, step.status])) };
      post({ type: "intent.created", intentId: intent.id, status: intent.status, ...reference });
    },
    intentUpdated(intent) {
      sendStepChanges(intent);
    },
    intentCompleted(intent) {
      if (!tracked || tracked.id !== intent.id || !canShareIds()) return;
      sendStepChanges(intent);
      post({ type: "intent.completed", intentId: intent.id, status: intent.status });
    },
    error(error) {
      if (!readySent) return;
      post({ type: "error", ...describeBridgeError(error) });
    },
  };
}

/** `location.ancestorOrigins` as an array, or `null` where the browser does not provide it. */
export function readAncestorOrigins(location: Location): readonly string[] | null {
  // Typed as always present, but missing in Firefox before 148.
  const list = location.ancestorOrigins as DOMStringList | undefined;
  if (!list || typeof list.length !== "number") return null;
  return Array.from({ length: list.length }, (_, index) => list.item(index) ?? "");
}

export function toConnectEvent(event: MessageEvent): ConnectEvent {
  return { data: event.data, origin: event.origin, source: event.source, ports: event.ports };
}

/** The browser environment for `createEmbedBridge`. */
export function windowBridgeEnv(win: Window, expectedOrigin: string | null, reference: string | null): EmbedBridgeEnv {
  return {
    listen(listener) {
      const handler = (event: MessageEvent) => listener(toConnectEvent(event));
      win.addEventListener("message", handler);
      return () => win.removeEventListener("message", handler);
    },
    context: () => ({
      parent: win.parent,
      self: win,
      ancestorOrigins: readAncestorOrigins(win.location),
      expectedOrigin,
    }),
    reference,
    warn: (message) => console.warn(message),
  };
}
