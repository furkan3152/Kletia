/**
 * @kletia/embed: the framework-agnostic Kletia intent widget.
 *
 * Defines the `<kletia-intent>` custom element and `mountKletiaIntent()`. The
 * element renders Kletia's hosted `/embed` page in a sandboxed iframe,
 * connects to it over a private `MessageChannel` (bridge protocol v1), sizes
 * the frame to its content and re-emits the frame's progress as DOM
 * `CustomEvent`s named `kletia:*`.
 *
 * This file has no imports on purpose: `dist/index.js` and the script-tag
 * build `dist/kletia-embed.min.js` are each a single self-contained file, so
 * one Subresource Integrity hash covers all of the code a host page runs.
 *
 * Events are notifications, not proof of payment. Never fulfil an order from
 * a `kletia:*` event: read the intent on your server with
 * `GET /v1/intents/:id` and check its status, steps and `metadata.hostRef`.
 */

declare const __KLETIA_EMBED_VERSION__: string | undefined;

/** Package version (injected at build time). */
export const EMBED_VERSION: string =
  typeof __KLETIA_EMBED_VERSION__ === "string" ? __KLETIA_EMBED_VERSION__ : "0.0.0-dev";
export const TAG_NAME = "kletia-intent";
export const DEFAULT_KLETIA_ORIGIN = "https://kletiaai.xyz";
export const BRIDGE_PROTOCOL_VERSION = 1;

export const MIN_FRAME_HEIGHT = 320;
export const MAX_FRAME_HEIGHT = 1600;
export const DEFAULT_FRAME_HEIGHT = 600;
export const MAX_TEXT_LENGTH = 500;
export const MAX_EXAMPLES = 6;
export const MAX_EXAMPLE_LENGTH = 120;

/**
 * Sandbox of the frame: scripts, its own origin (wallet storage and API
 * calls), the widget's form and wallet popups. No top navigation, modals,
 * downloads or pointer lock.
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";
/** Permissions Policy of the frame: clipboard writes (copy buttons) and nothing else. */
export const FRAME_ALLOW = "clipboard-write";
/**
 * Referrer policy of the frame. Never `no-referrer`: browsers then hide the
 * host origin from `location.ancestorOrigins` and the frame refuses to connect.
 */
export const FRAME_REFERRER_POLICY = "strict-origin-when-cross-origin";

/**
 * Delays in milliseconds between connect attempts after each frame load. The
 * frame's bridge can start after its `load` event, so the host retries until
 * the frame answers `ready`, then gives up `CONNECT_GIVE_UP_MS` after the last.
 */
export const CONNECT_RETRY_DELAYS: readonly number[] = [250, 500, 1000, 2000, 4000, 8000];
export const CONNECT_GIVE_UP_MS = 4000;

/** Attributes `<kletia-intent>` reads. */
export const OBSERVED_ATTRIBUTES: readonly string[] = ["theme", "text", "examples", "bg", "height", "origin", "reference", "label"];

export type KletiaTheme = "light" | "dark" | "auto";

/** What the widget shows. Everything is optional and validated again by the frame. */
export interface KletiaEmbedOptions {
  /** `light`, `dark` or `auto` (the default: follows the visitor's system). */
  readonly theme?: string | null;
  /** Prefilled intent text, at most 500 characters. The visitor can edit it and always signs in their own wallet. */
  readonly text?: string | null;
  /** Example chips: an array or one comma-separated string. At most 6, 120 characters each. */
  readonly examples?: string | readonly string[] | null;
  /** `transparent` drops the widget's page background so your page shows through. */
  readonly bg?: string | null;
  /**
   * Your reference for intents created in this widget (`^[A-Za-z0-9_.:-]{1,80}$`),
   * stored as `metadata.hostRef` and echoed in `kletia:intent-planned` and `kletia:intent-created`.
   * Anyone holding the intent id can read it: never put personal data in it.
   */
  readonly reference?: string | null;
}

export interface KletiaReadyDetail {
  /** Height of the widget's content in CSS pixels. */
  readonly height: number;
}
export interface KletiaResizeDetail {
  readonly height: number;
}
export interface KletiaIntentPlannedDetail {
  /** Status of the preview (`planned`). Previews are dry runs: nothing is stored and there is no id. */
  readonly status: string;
  /** The `reference` attribute, when one was set. */
  readonly reference?: string;
}
export interface KletiaIntentCreatedDetail {
  /** Id of the stored intent. Verify it server-side before acting on it. */
  readonly intentId: string;
  readonly status: string;
  /** The `reference` attribute, when one was set. */
  readonly reference?: string;
}
export interface KletiaStepUpdatedDetail {
  readonly intentId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly network: string;
  readonly status: string;
}
export interface KletiaCompletedDetail {
  readonly intentId: string;
  /** Final intent status, e.g. `completed`, `partially_completed` or `failed`. */
  readonly status: string;
}
export interface KletiaErrorDetail {
  /** Stable code, e.g. an API error code (see `GET /v1/errors`), `USER_REJECTED` or `BRIDGE_UNAVAILABLE`. */
  readonly code: string;
  readonly message: string;
}

export interface KletiaEventDetailMap {
  "kletia:ready": KletiaReadyDetail;
  "kletia:resize": KletiaResizeDetail;
  "kletia:intent-planned": KletiaIntentPlannedDetail;
  "kletia:intent-created": KletiaIntentCreatedDetail;
  "kletia:step-updated": KletiaStepUpdatedDetail;
  "kletia:completed": KletiaCompletedDetail;
  "kletia:error": KletiaErrorDetail;
}
export type KletiaEventName = keyof KletiaEventDetailMap;
export type KletiaBridgeEvent = {
  [K in KletiaEventName]: { readonly name: K; readonly detail: KletiaEventDetailMap[K] };
}[KletiaEventName];

export interface KletiaIntentElement extends HTMLElement {
  /** True once the frame has answered the connect handshake. */
  readonly bridgeConnected: boolean;
  addEventListener<K extends KletiaEventName>(
    type: K,
    listener: (this: KletiaIntentElement, event: CustomEvent<KletiaEventDetailMap[K]>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: KletiaIntentElement, event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends KletiaEventName>(
    type: K,
    listener: (this: KletiaIntentElement, event: CustomEvent<KletiaEventDetailMap[K]>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: KletiaIntentElement, event: HTMLElementEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "kletia-intent": KletiaIntentElement;
  }
}

// ---------------------------------------------------------------------------
// Attributes and the frame URL (pure, testable without a DOM)
// ---------------------------------------------------------------------------

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/gu;
const REFERENCE = /^[A-Za-z0-9_.:-]{1,80}$/u;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function clean(value: string, max: number): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s{2,}/gu, " ").trim().slice(0, max);
}

export function normalizeTheme(value: unknown): KletiaTheme {
  const theme = typeof value === "string" ? value.trim().toLowerCase() : "";
  return theme === "light" || theme === "dark" ? theme : "auto";
}

/** Example chips, split on commas, cleaned, de-duplicated (case-insensitive) and capped like the frame does. */
export function normalizeExamples(value: unknown): string[] {
  const parts: string[] = [];
  if (typeof value === "string") parts.push(...value.split(","));
  else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") parts.push(...item.split(","));
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const part of parts) {
    const example = clean(part, MAX_EXAMPLE_LENGTH);
    const key = example.toLowerCase();
    if (!example || seen.has(key)) continue;
    seen.add(key);
    examples.push(example);
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}

export function normalizeReference(value: unknown): string | null {
  return typeof value === "string" && REFERENCE.test(value) ? value : null;
}

/**
 * The Kletia origin that serves `/embed`: any https origin, or http on
 * localhost for development. Empty input means `DEFAULT_KLETIA_ORIGIN`;
 * anything else (paths, queries, credentials, other schemes) is `null`.
 */
export function normalizeKletiaOrigin(value?: string | null): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return DEFAULT_KLETIA_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname)) return url.origin;
  return null;
}

/** A page origin that can take part in the bridge: http or https, never the opaque `"null"`. */
export function normalizeHostOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

export function clampFrameHeight(px: number): number {
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(px)));
}

/**
 * `height` attribute: the frame's height in pixels (optionally `px`) until
 * the frame reports its content height, which it then follows. Anything else
 * means `DEFAULT_FRAME_HEIGHT`.
 */
export function parseFrameHeight(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? clampFrameHeight(value) : DEFAULT_FRAME_HEIGHT;
  const match = /^(\d{1,5})(?:px)?$/u.exec((value ?? "").trim().toLowerCase());
  return match ? clampFrameHeight(Number(match[1])) : DEFAULT_FRAME_HEIGHT;
}

/**
 * URL of the frame. `hostOrigin` (your page's `location.origin`) opts the
 * frame into the bridge with `bridge=1&origin=…`; the frame only connects to
 * a parent whose real origin matches it.
 */
export function buildEmbedUrl(kletiaOrigin: string, options: KletiaEmbedOptions = {}, hostOrigin?: string | null): string {
  const origin = normalizeKletiaOrigin(kletiaOrigin);
  if (!origin) throw new TypeError("The Kletia origin must be https (or http on localhost).");
  const query = new URLSearchParams();
  const theme = normalizeTheme(options.theme);
  if (theme !== "auto") query.set("theme", theme);
  const text = typeof options.text === "string" ? clean(options.text, MAX_TEXT_LENGTH) : "";
  if (text) query.set("text", text);
  const examples = normalizeExamples(options.examples);
  if (examples.length > 0) query.set("examples", examples.join(","));
  if (typeof options.bg === "string" && options.bg.trim().toLowerCase() === "transparent") query.set("bg", "transparent");
  const reference = normalizeReference(options.reference);
  if (reference) query.set("ref", reference);
  const host = normalizeHostOrigin(hostOrigin);
  if (host) {
    query.set("bridge", "1");
    query.set("origin", host);
  }
  const search = query.toString();
  return `${origin}/embed${search ? `?${search}` : ""}`;
}

export interface KletiaElementConfig {
  /** `null` when the `origin` attribute is invalid. */
  readonly origin: string | null;
  readonly options: KletiaEmbedOptions;
  /** Height in pixels until the frame reports its content height. */
  readonly height: number;
  /** Accessible name of the frame. */
  readonly label: string;
}

/** Maps `<kletia-intent>` attributes to the frame configuration. */
export function readElementConfig(getAttribute: (name: string) => string | null): KletiaElementConfig {
  const label = clean(getAttribute("label") ?? "", 120);
  return {
    origin: normalizeKletiaOrigin(getAttribute("origin")),
    options: {
      theme: getAttribute("theme"),
      text: getAttribute("text"),
      examples: getAttribute("examples"),
      bg: getAttribute("bg"),
      reference: getAttribute("reference"),
    },
    height: parseFrameHeight(getAttribute("height")),
    label: label || "Kletia intent widget",
  };
}

// ---------------------------------------------------------------------------
// Bridge protocol v1, host side
// ---------------------------------------------------------------------------

const INTENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STATUS = /^[a-z][a-z_]{0,39}$/u;
const STEP_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const NETWORK = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function match(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function heightOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000 ? Math.ceil(value) : null;
}

/**
 * Validates a message from the frame and maps it to a DOM event. Unknown
 * types, malformed fields and any extra fields are dropped.
 */
export function parseBridgeMessage(data: unknown): KletiaBridgeEvent | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.kletia !== "event" || message.v !== BRIDGE_PROTOCOL_VERSION) return null;
  switch (message.type) {
    case "ready":
    case "resize": {
      const height = heightOf(message.height);
      if (height === null) return null;
      return message.type === "ready" ? { name: "kletia:ready", detail: { height } } : { name: "kletia:resize", detail: { height } };
    }
    case "intent.planned": {
      const status = match(message.status, STATUS);
      const reference = normalizeReference(message.reference);
      return status ? { name: "kletia:intent-planned", detail: { status, ...(reference ? { reference } : {}) } } : null;
    }
    case "intent.created": {
      const intentId = match(message.intentId, INTENT_ID);
      const status = match(message.status, STATUS);
      const reference = normalizeReference(message.reference);
      return intentId && status
        ? { name: "kletia:intent-created", detail: { intentId, status, ...(reference ? { reference } : {}) } }
        : null;
    }
    case "intent.step_updated": {
      const intentId = match(message.intentId, INTENT_ID);
      const stepId = match(message.stepId, STEP_ID);
      const network = match(message.network, NETWORK);
      const status = match(message.status, STATUS);
      const stepIndex = message.stepIndex;
      if (!intentId || !stepId || !network || !status) return null;
      if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 999) return null;
      return { name: "kletia:step-updated", detail: { intentId, stepId, stepIndex, network, status } };
    }
    case "intent.completed": {
      const intentId = match(message.intentId, INTENT_ID);
      const status = match(message.status, STATUS);
      return intentId && status ? { name: "kletia:completed", detail: { intentId, status } } : null;
    }
    case "error": {
      const code = match(message.code, CODE);
      if (!code) return null;
      return { name: "kletia:error", detail: { code, message: typeof message.message === "string" ? clean(message.message, 200) : "" } };
    }
    default:
      return null;
  }
}

/** The frame's window, as far as the connector needs it. */
export interface FrameTarget {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
}

export interface ConnectFrameOptions {
  /** Returns the frame's window, e.g. `() => iframe.contentWindow`. Read on every attempt. */
  readonly target: () => FrameTarget | null;
  /** Origin of the Kletia frame. Connect messages are only delivered to a document of this origin. */
  readonly targetOrigin: string;
  readonly onEvent: (event: KletiaBridgeEvent) => void;
  /** Called once when no attempt was answered. */
  readonly onGiveUp?: () => void;
  readonly retryDelays?: readonly number[];
  readonly giveUpAfterMs?: number;
}

export interface FrameConnection {
  readonly connected: boolean;
  close(): void;
}

/**
 * Bridge handshake from the host page. Each attempt transfers a fresh
 * `MessagePort` with `postMessage(…, targetOrigin)`, never `"*"`, so only a
 * Kletia document can receive it. The first port that answers `ready` wins;
 * the others are closed and every later message must arrive on the winner.
 */
export function connectFrame(options: ConnectFrameOptions): FrameConnection {
  const delays = options.retryDelays ?? CONNECT_RETRY_DELAYS;
  const pending: MessagePort[] = [];
  let active: MessagePort | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const closePort = (port: MessagePort) => {
    port.onmessage = null;
    port.close();
  };
  const onPortMessage = (port: MessagePort, data: unknown) => {
    if (closed) return;
    const event = parseBridgeMessage(data);
    if (!event) return;
    if (active === null) {
      if (event.name !== "kletia:ready") return;
      active = port;
      clearTimeout(timer);
      for (const other of pending.splice(0)) if (other !== port) closePort(other);
    } else if (port !== active) {
      return;
    }
    options.onEvent(event);
  };
  const giveUp = () => {
    if (closed || active) return;
    for (const port of pending.splice(0)) closePort(port);
    options.onGiveUp?.();
  };
  const send = () => {
    if (closed || active) return;
    const target = options.target();
    if (target) {
      const channel = new MessageChannel();
      const port = channel.port1;
      port.onmessage = (message: MessageEvent) => onPortMessage(port, message.data);
      pending.push(port);
      try {
        target.postMessage({ kletia: "connect", v: BRIDGE_PROTOCOL_VERSION }, options.targetOrigin, [channel.port2]);
      } catch {
        // The frame is navigating or gone; the next attempt tries again.
      }
    }
    const delay = delays[attempt];
    attempt += 1;
    timer = delay === undefined ? setTimeout(giveUp, options.giveUpAfterMs ?? CONNECT_GIVE_UP_MS) : setTimeout(send, delay);
  };

  send();
  return {
    get connected() {
      return active !== null;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const port of pending.splice(0)) closePort(port);
      if (active) closePort(active);
      active = null;
    },
  };
}

// ---------------------------------------------------------------------------
// <kletia-intent>
// ---------------------------------------------------------------------------

const HOST_STYLE = ":host{display:block;width:100%;max-width:100%}:host([hidden]){display:none}";

function pageOrigin(): string | null {
  return typeof location === "undefined" ? null : normalizeHostOrigin(location.origin);
}

function createElementClass(): CustomElementConstructor {
  return class KletiaIntent extends HTMLElement {
    static get observedAttributes(): string[] {
      return [...OBSERVED_ATTRIBUTES];
    }

    readonly #root: ShadowRoot;
    #frame: HTMLIFrameElement | null = null;
    #connection: FrameConnection | null = null;
    #config: KletiaElementConfig | null = null;
    #src = "";
    #reported: number | null = null;
    #scheduled = false;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
      // Constructable stylesheets are not blocked by a strict style-src CSP; inline styles below cover the rest.
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(HOST_STYLE);
        this.#root.adoptedStyleSheets = [sheet];
      } catch {
        const style = document.createElement("style");
        style.textContent = HOST_STYLE;
        this.#root.append(style);
      }
    }

    get bridgeConnected(): boolean {
      return this.#connection?.connected ?? false;
    }

    connectedCallback(): void {
      this.#render();
    }

    disconnectedCallback(): void {
      this.#teardown();
    }

    attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
      if (previous === next || !this.isConnected) return;
      if (name === "height" || name === "label") {
        this.#config = readElementConfig((attribute) => this.getAttribute(attribute));
        this.#applyFrame();
        return;
      }
      // Batch changes made together (e.g. `mounted.update()`) into one frame reload.
      if (this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        if (this.isConnected) this.#render();
      });
    }

    #render(): void {
      const config = readElementConfig((attribute) => this.getAttribute(attribute));
      this.#config = config;
      if (!config.origin) {
        this.#teardown();
        this.#emitLater("kletia:error", {
          code: "EMBED_ORIGIN_INVALID",
          message: "The origin attribute must be an https origin, or http://localhost for development.",
        });
        return;
      }
      const src = buildEmbedUrl(config.origin, config.options, pageOrigin());
      let frame = this.#frame;
      if (!frame) {
        frame = document.createElement("iframe");
        // The sandbox must be in place before the first navigation.
        frame.setAttribute("sandbox", FRAME_SANDBOX);
        frame.setAttribute("allow", FRAME_ALLOW);
        frame.setAttribute("referrerpolicy", FRAME_REFERRER_POLICY);
        frame.setAttribute("loading", "lazy");
        frame.setAttribute("part", "frame");
        frame.style.display = "block";
        frame.style.width = "100%";
        frame.style.border = "0";
        frame.style.background = "transparent";
        frame.addEventListener("load", this.#onLoad);
        this.#frame = frame;
      }
      this.#applyFrame();
      if (src !== this.#src) {
        this.#src = src;
        this.#connection?.close();
        this.#connection = null;
        frame.src = src;
      }
      if (!frame.isConnected) this.#root.append(frame);
    }

    #applyFrame(): void {
      const frame = this.#frame;
      const config = this.#config;
      if (!frame || !config) return;
      frame.title = config.label;
      // Match the frame document's color scheme, or browsers paint an opaque backdrop behind a transparent frame.
      frame.style.colorScheme = normalizeTheme(config.options.theme) === "dark" ? "dark" : "light";
      frame.style.height = `${this.#reported === null ? config.height : clampFrameHeight(this.#reported)}px`;
    }

    readonly #onLoad = (): void => {
      const frame = this.#frame;
      const origin = this.#config?.origin;
      this.#connection?.close();
      this.#connection = null;
      if (!frame || !origin) return;
      if (!pageOrigin()) {
        this.#emit("kletia:error", {
          code: "BRIDGE_UNAVAILABLE",
          message: "This page has no http(s) origin, so the widget cannot report events to it.",
        });
        return;
      }
      this.#connection = connectFrame({
        target: () => frame.contentWindow,
        targetOrigin: origin,
        onEvent: (event) => {
          // A height of 0 means the frame has not measured itself yet.
          if ((event.name === "kletia:ready" || event.name === "kletia:resize") && event.detail.height > 0) {
            this.#reported = event.detail.height;
            this.#applyFrame();
          }
          this.#emit(event.name, event.detail);
        },
        onGiveUp: () =>
          this.#emit("kletia:error", {
            code: "BRIDGE_UNAVAILABLE",
            message: "The Kletia frame did not answer the connect handshake.",
          }),
      });
    };

    #emit<K extends KletiaEventName>(name: K, detail: KletiaEventDetailMap[K]): void {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }

    #emitLater<K extends KletiaEventName>(name: K, detail: KletiaEventDetailMap[K]): void {
      queueMicrotask(() => this.#emit(name, detail));
    }

    #teardown(): void {
      this.#connection?.close();
      this.#connection = null;
      if (this.#frame) {
        this.#frame.removeEventListener("load", this.#onLoad);
        this.#frame.remove();
        this.#frame = null;
      }
      this.#src = "";
    }
  };
}

/**
 * Defines `<kletia-intent>` once per page and returns its constructor, or
 * `null` outside a browser. Importing this module calls it already.
 */
export function defineKletiaIntent(): CustomElementConstructor | null {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return null;
  const existing = customElements.get(TAG_NAME);
  if (existing) return existing;
  const constructor = createElementClass();
  customElements.define(TAG_NAME, constructor);
  return constructor;
}

// ---------------------------------------------------------------------------
// mountKletiaIntent()
// ---------------------------------------------------------------------------

export interface KletiaFrameOptions extends KletiaEmbedOptions {
  /** Origin that serves `/embed` (default `https://kletiaai.xyz`). */
  readonly origin?: string | null;
  /** Height in pixels until the frame reports its content height (default 600). */
  readonly height?: number | null;
  /** Accessible name of the frame (default "Kletia intent widget"). */
  readonly label?: string | null;
}

export interface MountKletiaIntentOptions extends KletiaFrameOptions {
  readonly onReady?: (detail: KletiaReadyDetail) => void;
  readonly onResize?: (detail: KletiaResizeDetail) => void;
  readonly onIntentPlanned?: (detail: KletiaIntentPlannedDetail) => void;
  readonly onIntentCreated?: (detail: KletiaIntentCreatedDetail) => void;
  readonly onStepUpdated?: (detail: KletiaStepUpdatedDetail) => void;
  readonly onCompleted?: (detail: KletiaCompletedDetail) => void;
  readonly onError?: (detail: KletiaErrorDetail) => void;
}

export interface MountedKletiaIntent {
  readonly element: KletiaIntentElement;
  /** Changes attributes: `undefined` keeps a value, `null` or `""` removes it. */
  update(options: KletiaFrameOptions): void;
  /** Removes the listeners and the element. */
  destroy(): void;
}

const HANDLERS: ReadonlyArray<readonly [keyof MountKletiaIntentOptions, KletiaEventName]> = [
  ["onReady", "kletia:ready"],
  ["onResize", "kletia:resize"],
  ["onIntentPlanned", "kletia:intent-planned"],
  ["onIntentCreated", "kletia:intent-created"],
  ["onStepUpdated", "kletia:step-updated"],
  ["onCompleted", "kletia:completed"],
  ["onError", "kletia:error"],
];

function applyAttributes(element: Element, options: KletiaFrameOptions): void {
  const set = (name: string, value: string | number | readonly string[] | null | undefined) => {
    if (value === undefined) return;
    const text = Array.isArray(value) ? value.join(",") : value === null ? "" : String(value);
    if (text) element.setAttribute(name, text);
    else element.removeAttribute(name);
  };
  set("origin", options.origin);
  set("theme", options.theme);
  set("text", options.text);
  set("examples", options.examples);
  set("bg", options.bg);
  set("reference", options.reference);
  set("height", options.height);
  set("label", options.label);
}

/**
 * Creates a `<kletia-intent>` inside `target` (an element or a selector),
 * wires the `on*` callbacks to its events and returns a handle.
 */
export function mountKletiaIntent(target: Element | string, options: MountKletiaIntentOptions = {}): MountedKletiaIntent {
  if (!defineKletiaIntent()) throw new Error("mountKletiaIntent needs a browser with custom elements.");
  const container = typeof target === "string" ? document.querySelector(target) : target;
  if (!container) throw new Error(`mountKletiaIntent: no element matches ${String(target)}.`);
  const element = document.createElement(TAG_NAME);
  applyAttributes(element, options);
  const listeners: Array<readonly [string, EventListener]> = [];
  for (const [key, name] of HANDLERS) {
    const handler = options[key];
    if (typeof handler !== "function") continue;
    const listener = (event: Event) => (handler as (detail: unknown) => void)((event as CustomEvent).detail);
    element.addEventListener(name, listener);
    listeners.push([name, listener]);
  }
  container.append(element);
  return {
    element,
    update: (next) => applyAttributes(element, next),
    destroy() {
      for (const [name, listener] of listeners) element.removeEventListener(name, listener);
      element.remove();
    },
  };
}

defineKletiaIntent();
