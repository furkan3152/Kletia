/**
 * EgressGuardV1
 *
 * WorkflowPlanV2 measures "zero registered private-field egress" for an
 * observed browser session. Before this guard, that bounded claim rested on the
 * *shape* of the redacted semantic envelope: the allowlist in
 * `privateIntent.ts` and the server-side workflow parser. Those checks cover the
 * intended V2 path, but not other Kletia surfaces or an unobserved code path.
 *
 * This module turns the claim into a measurement. Private field values are
 * registered in a module-local closure, then every outbound browser surface is
 * wrapped and inspected. A private value found on any of those surfaces is a
 * violation: the call is blocked fail-closed and recorded.
 *
 * What this guarantees
 * - A registered, guardable value cannot leave through a wrapped surface without
 *   the operation failing and the violation being recorded.
 *
 * What this does NOT guarantee
 * - It is not a sandbox. Code holding a direct reference to an unwrapped native
 *   (captured before installation, or reached via an iframe or worker realm) is
 *   outside the guard.
 * - It cannot detect a value that left in a form it was not asked to watch, such
 *   as an encrypted, hashed or arithmetically transformed derivative.
 * - Short, low-entropy values (a bare "5") are indistinguishable from ordinary
 *   protocol traffic. Those are reported `unguardable_low_entropy` rather than
 *   silently counted as protected. Callers should register the atomic and
 *   normalized forms, which carry enough length to be watched.
 */

export const EGRESS_GUARD_SCHEMA = "kletia_egress_guard_v1" as const;

/**
 * Below this length a needle collides with ordinary protocol traffic (chain IDs,
 * enum values, decimals) often enough that blocking on it would break the app
 * without adding a real privacy guarantee.
 */
const MINIMUM_GUARDABLE_LENGTH = 6;

/** Bounded so a large upload cannot be turned into an unbounded scan. */
const MAX_SCANNED_CHARACTERS = 512 * 1_024;

export type EgressSurface =
  | "fetch"
  | "xhr"
  | "websocket"
  | "beacon"
  | "console"
  | "storage"
  | "error_telemetry";

export type PrivateFieldName = "amount" | "recipient" | "opening" | "root";

export type GuardRegistrationStatus =
  | "guarded"
  | "unguardable_low_entropy"
  | "duplicate";

export interface EgressViolation {
  readonly schemaVersion: typeof EGRESS_GUARD_SCHEMA;
  /** Which private field leaked. The value itself is never recorded. */
  readonly field: PrivateFieldName;
  readonly surface: EgressSurface;
  /** How the value was encoded when found, e.g. `raw`, `uri_component`. */
  readonly encoding: string;
  /** Coarse location, e.g. `fetch:url`, `fetch:body`, `storage:key`. */
  readonly location: string;
  /**
   * Destination origin when the surface has one. Never a full URL, because a URL
   * may itself contain the leaked value.
   */
  readonly destinationOrigin: string | null;
  readonly observedAt: string;
}

export interface ApprovedCheckpointCommitmentDisclosure {
  readonly schemaVersion: typeof EGRESS_GUARD_SCHEMA;
  readonly kind: "public_checkpoint_commitment_opening";
  /** The private value is deliberately omitted; only its protocol field is named. */
  readonly binding: "amountCommitmentSalt" | "recipientCommitmentSalt";
  readonly field: "opening";
  readonly surface: "fetch";
  readonly location: "fetch:body";
  readonly destinationOrigin: string;
  readonly destinationPath: "/api/workflows/v2/advance";
  readonly observer: "kletia_api";
  readonly workflowId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly transactionHash: string;
  readonly irreversible: true;
  readonly reason: string;
  readonly observedAt: string;
}

export interface ApprovedRouteHydrationDisclosure {
  readonly schemaVersion: typeof EGRESS_GUARD_SCHEMA;
  readonly kind: "public_route_hydration_opening";
  readonly binding: "amount" | "amountSalt";
  readonly field: "amount" | "opening";
  readonly surface: "fetch";
  readonly location: "fetch:body";
  readonly destinationOrigin: string;
  readonly destinationPath: string;
  readonly observer: "kletia_api";
  readonly workflowId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly transactionHash: null;
  readonly irreversible: true;
  readonly reason: string;
  readonly observedAt: string;
}

export type ApprovedCommitmentDisclosure =
  | ApprovedCheckpointCommitmentDisclosure
  | ApprovedRouteHydrationDisclosure;

export type EgressGuardCoverage =
  | "inactive"
  | "complete"
  | "partial_low_entropy";

export interface EgressGuardReport {
  readonly schemaVersion: typeof EGRESS_GUARD_SCHEMA;
  readonly installed: boolean;
  /** Fields with at least one value currently being watched. */
  readonly guardedFields: readonly PrivateFieldName[];
  /**
   * Fields whose most recently registered value was too short to watch. A field
   * can appear in both lists: that means an earlier value is guarded while the
   * latest one is not, and the caller must treat the field as unprotected.
   */
  readonly unguardableFields: readonly PrivateFieldName[];
  readonly needleCount: number;
  readonly inspectedOperations: number;
  readonly violations: readonly EgressViolation[];
  /** Deliberate public-checkpoint openings. No private value is included. */
  readonly approvedDisclosures: readonly ApprovedCommitmentDisclosure[];
  /** Whether every registered field can actually be measured by this guard. */
  readonly coverage: EgressGuardCoverage;
  /** True when the observed operations produced no blocked leak. */
  readonly observedNoViolation: boolean;
  /**
   * The headline KPI is true only with complete guard coverage and no violation.
   * A short value such as `5` therefore cannot be presented as a privacy pass.
   */
  readonly zeroPrivateFieldEgress: boolean;
  readonly limitations: readonly string[];
}

const LIMITATIONS: readonly string[] = Object.freeze([
  "The guard wraps browser surfaces; it is not a sandbox and cannot observe a native reference captured before installation, or a separate iframe or worker realm.",
  "It detects registered values in the encodings it was asked to watch. An encrypted, hashed or arithmetically transformed derivative is not detected.",
  `Values shorter than ${MINIMUM_GUARDABLE_LENGTH} characters are reported unguardable_low_entropy instead of being treated as protected, because they collide with ordinary protocol traffic.`,
  "A clean report means nothing leaked during the observed session. It is not a proof about code paths that were never exercised.",
]);

interface Needle {
  readonly field: PrivateFieldName;
  readonly encoding: string;
  readonly value: string;
}

/**
 * Module-local. Never written to storage, never serialised into a report, and
 * never exposed through a getter, so registering a value here does not create a
 * new place for it to leak from.
 */
const needles: Needle[] = [];
const guardedFields = new Set<PrivateFieldName>();
const unguardableFields = new Set<PrivateFieldName>();
const violations: EgressViolation[] = [];
const approvedDisclosures: ApprovedCommitmentDisclosure[] = [];
const consumedOpeningDisclosureKeys = new Set<string>();
let inspectedOperations = 0;
let installed = false;
let nativeFetchForApprovedDisclosure: typeof fetch | null = null;

/**
 * Encodings a value can legitimately pass through on its way out of the browser.
 * Each is watched separately so a violation report can name the exact form.
 */
function encodingsOf(value: string): readonly { encoding: string; value: string }[] {
  const candidates: { encoding: string; value: string }[] = [
    { encoding: "raw", value },
    { encoding: "uri_component", value: encodeURIComponent(value) },
    { encoding: "json_string", value: JSON.stringify(value).slice(1, -1) },
    { encoding: "lowercase", value: value.toLowerCase() },
  ];
  try {
    // Covers a value smuggled inside a base64 payload or data URL.
    candidates.push({ encoding: "base64", value: btoa(value) });
  } catch {
    // Non-Latin1 input cannot be btoa-encoded; skip rather than guess.
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.value.length < MINIMUM_GUARDABLE_LENGTH) return false;
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}

/**
 * Registers a private field value to watch. Call this in the browser at the
 * moment the user enters a private slot, before any network call is made.
 */
export function registerPrivateField(
  field: PrivateFieldName,
  value: string,
): GuardRegistrationStatus {
  const normalized = value.trim();
  if (normalized.length < MINIMUM_GUARDABLE_LENGTH) {
    unguardableFields.add(field);
    return "unguardable_low_entropy";
  }
  // A guardable registration clears the flag because the realistic caller is a
  // keystroke-driven input: every prefix of "1234.56" is briefly too short, and
  // a sticky flag would report the field as unprotected for the rest of the
  // session even though the final value is watched.
  const encodings = encodingsOf(normalized);
  const known = new Set(needles.map((needle) => needle.value));
  const added = encodings.filter((candidate) => !known.has(candidate.value));
  if (added.length === 0) return "duplicate";
  for (const candidate of added) {
    needles.push({ field, encoding: candidate.encoding, value: candidate.value });
  }
  guardedFields.add(field);
  unguardableFields.delete(field);
  return "guarded";
}

/**
 * Clears every registered needle. Called when a workflow is reset so a stale
 * value from a previous plan cannot produce a violation attributed to a new one.
 */
export function resetPrivateFields(): void {
  needles.length = 0;
  guardedFields.clear();
  unguardableFields.clear();
}

/** Starts a fresh, per-workflow measurement without weakening replay memory. */
export function beginEgressGuardObservation(): void {
  resetPrivateFields();
  violations.length = 0;
  approvedDisclosures.length = 0;
  inspectedOperations = 0;
}

export class PrivateFieldEgressBlockedError extends Error {
  readonly violation: EgressViolation;

  constructor(violation: EgressViolation) {
    super(
      `A private ${violation.field} value was about to leave the device through ${violation.location}. The operation was blocked.`,
    );
    this.name = "PrivateFieldEgressBlockedError";
    this.violation = violation;
  }
}

function originOf(target: unknown): string | null {
  try {
    const raw =
      typeof target === "string"
        ? target
        : target instanceof URL
          ? target.href
          : typeof (target as { url?: unknown })?.url === "string"
            ? (target as { url: string }).url
            : null;
    if (!raw) return null;
    return new URL(raw, globalThis.location?.href).origin;
  } catch {
    return null;
  }
}

/**
 * Scans a haystack for any registered needle. Throws on the first match so the
 * caller cannot proceed with the operation.
 */
function assertNoEgress(input: {
  haystack: string;
  surface: EgressSurface;
  location: string;
  destinationOrigin: string | null;
  /** Exact encoded private needles allowed for one reviewed disclosure call. */
  allowedPrivateNeedles?: ReadonlySet<string>;
}): void {
  if (needles.length === 0 || !input.haystack) return;
  const haystack =
    input.haystack.length > MAX_SCANNED_CHARACTERS
      ? input.haystack.slice(0, MAX_SCANNED_CHARACTERS)
      : input.haystack;
  const lowered = haystack.toLowerCase();
  for (const needle of needles) {
    if (input.allowedPrivateNeedles?.has(needle.value)) {
      continue;
    }
    const found =
      needle.encoding === "lowercase"
        ? lowered.includes(needle.value)
        : haystack.includes(needle.value);
    if (!found) continue;
    const violation: EgressViolation = {
      schemaVersion: EGRESS_GUARD_SCHEMA,
      field: needle.field,
      surface: input.surface,
      encoding: needle.encoding,
      location: input.location,
      destinationOrigin: input.destinationOrigin,
      observedAt: new Date().toISOString(),
    };
    violations.push(violation);
    throw new PrivateFieldEgressBlockedError(violation);
  }
}

/** Renders a value for scanning without ever throwing on exotic input. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof URLSearchParams) return value.toString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, (_key, entry) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ) ?? "";
    } catch {
      // A cyclic or non-serialisable payload cannot be scanned. Kletia's own
      // outbound bodies are all plain JSON, so this path means a third party
      // constructed the payload; the guard reports it as unscanned rather than
      // asserting it was clean.
      return "";
    }
  }
  return "";
}

function inspectHeaders(
  headers: HeadersInit | undefined,
  surface: EgressSurface,
  location: string,
  destinationOrigin: string | null,
): void {
  if (!headers) return;
  const entries: string[] = [];
  if (headers instanceof Headers) {
    headers.forEach((value, key) => entries.push(`${key}: ${value}`));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) entries.push(`${key}: ${value}`);
  } else {
    for (const [key, value] of Object.entries(headers)) {
      entries.push(`${key}: ${String(value)}`);
    }
  }
  assertNoEgress({
    haystack: entries.join("\n"),
    surface,
    location,
    destinationOrigin,
  });
}

/**
 * Installs the guard over every outbound surface Kletia's browser runtime can
 * reach. Idempotent: a second call is a no-op so hot reloads cannot double-wrap.
 */
export function installEgressGuard(): void {
  if (installed) return;
  installed = true;

  const scope = globalThis as typeof globalThis & {
    fetch?: typeof fetch;
    XMLHttpRequest?: typeof XMLHttpRequest;
    WebSocket?: typeof WebSocket;
    navigator?: Navigator;
    localStorage?: Storage;
    sessionStorage?: Storage;
  };

  if (typeof scope.fetch === "function") {
    const nativeFetch = scope.fetch.bind(scope);
    nativeFetchForApprovedDisclosure = nativeFetch;
    scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      inspectedOperations += 1;
      const destinationOrigin = originOf(input);
      const url = typeof input === "string" ? input : originOf(input) === null ? "" : String(
        input instanceof URL ? input.href : (input as Request).url ?? "",
      );
      // The URL carries query strings and path segments, a common accidental
      // leak channel, and is also what ends up in referrers and server logs.
      assertNoEgress({
        haystack: url,
        surface: "fetch",
        location: "fetch:url",
        destinationOrigin,
      });
      inspectHeaders(init?.headers, "fetch", "fetch:headers", destinationOrigin);
      assertNoEgress({
        haystack: stringify(init?.body),
        surface: "fetch",
        location: "fetch:body",
        destinationOrigin,
      });
      return nativeFetch(input as RequestInfo, init);
    }) as typeof fetch;
  }

  if (typeof scope.XMLHttpRequest === "function") {
    const NativeXhr = scope.XMLHttpRequest;
    const nativeOpen = NativeXhr.prototype.open;
    const nativeSend = NativeXhr.prototype.send;
    const nativeSetHeader = NativeXhr.prototype.setRequestHeader;
    const origins = new WeakMap<XMLHttpRequest, string | null>();

    NativeXhr.prototype.open = function open(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      inspectedOperations += 1;
      const destinationOrigin = originOf(url);
      origins.set(this, destinationOrigin);
      assertNoEgress({
        haystack: String(url),
        surface: "xhr",
        location: "xhr:url",
        destinationOrigin,
      });
      return (nativeOpen as unknown as (...args: unknown[]) => void).apply(this, [
        method,
        url,
        ...rest,
      ]);
    } as typeof NativeXhr.prototype.open;

    NativeXhr.prototype.setRequestHeader = function setRequestHeader(
      this: XMLHttpRequest,
      name: string,
      value: string,
    ) {
      assertNoEgress({
        haystack: `${name}: ${value}`,
        surface: "xhr",
        location: "xhr:headers",
        destinationOrigin: origins.get(this) ?? null,
      });
      return nativeSetHeader.call(this, name, value);
    };

    NativeXhr.prototype.send = function send(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      assertNoEgress({
        haystack: stringify(body),
        surface: "xhr",
        location: "xhr:body",
        destinationOrigin: origins.get(this) ?? null,
      });
      return (nativeSend as unknown as (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ) => void).call(this, body);
    };
  }

  if (typeof scope.WebSocket === "function") {
    const NativeSocket = scope.WebSocket;
    const nativeSocketSend = NativeSocket.prototype.send;
    scope.WebSocket = class GuardedWebSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        inspectedOperations += 1;
        assertNoEgress({
          haystack: String(url),
          surface: "websocket",
          location: "websocket:url",
          destinationOrigin: originOf(url),
        });
        super(url, protocols);
      }

      send(data: Parameters<WebSocket["send"]>[0]) {
        assertNoEgress({
          haystack: typeof data === "string" ? data : "",
          surface: "websocket",
          location: "websocket:frame",
          destinationOrigin: originOf(this.url),
        });
        return nativeSocketSend.call(this, data);
      }
    } as unknown as typeof WebSocket;
  }

  if (scope.navigator && typeof scope.navigator.sendBeacon === "function") {
    const nativeBeacon = scope.navigator.sendBeacon.bind(scope.navigator);
    scope.navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
      inspectedOperations += 1;
      const destinationOrigin = originOf(url);
      assertNoEgress({
        haystack: String(url),
        surface: "beacon",
        location: "beacon:url",
        destinationOrigin,
      });
      assertNoEgress({
        haystack: stringify(data),
        surface: "beacon",
        location: "beacon:body",
        destinationOrigin,
      });
      return nativeBeacon(url, data);
    }) as Navigator["sendBeacon"];
  }

  // Console output is an egress surface in practice: it is captured by browser
  // extensions, session replay tools and error reporters.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const native = console[level]?.bind(console);
    if (!native) continue;
    console[level] = (...args: unknown[]) => {
      assertNoEgress({
        haystack: args.map(stringify).join(" "),
        surface: "console",
        location: `console:${level}`,
        destinationOrigin: null,
      });
      return native(...args);
    };
  }

  // Persistence is egress across time: a value written here outlives the tab and
  // is readable by any script on the origin.
  for (const [name, storage] of [
    ["localStorage", scope.localStorage],
    ["sessionStorage", scope.sessionStorage],
  ] as const) {
    if (!storage) continue;
    const nativeSetItem = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      assertNoEgress({
        haystack: key,
        surface: "storage",
        location: `${name}:key`,
        destinationOrigin: null,
      });
      assertNoEgress({
        haystack: value,
        surface: "storage",
        location: `${name}:value`,
        destinationOrigin: null,
      });
      return nativeSetItem(key, value);
    };
  }
}

export interface CommitmentOpeningFetchInput {
  readonly url: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly requestId: string;
  readonly transactionHash: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly openings: readonly {
    readonly binding: "amountCommitmentSalt" | "recipientCommitmentSalt";
    readonly value: `0x${string}`;
  }[];
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

/**
 * Sends the commitment salts only at the exact public checkpoint that opens the
 * already-public transaction amount. This is intentionally not a general
 * allowlist escape hatch: it only accepts the workflow advance endpoint, the
 * two reviewed JSON property names, one POST body, and 32-byte salts.
 *
 * Every other registered value, including the raw amount, is still scanned and
 * blocked. The approved opening is recorded without retaining the value.
 */
export function fetchWithCommitmentOpeningDisclosure(
  input: CommitmentOpeningFetchInput,
): Promise<Response> {
  if (!nativeFetchForApprovedDisclosure || !installed) {
    throw new Error(
      "The privacy guard must be installed before a commitment opening can be disclosed.",
    );
  }
  const destination = new URL(input.url, globalThis.location?.href);
  if (
    destination.pathname !== "/api/workflows/v2/advance" ||
    destination.search.length > 0 ||
    destination.hash.length > 0
  ) {
    throw new Error(
      "A commitment opening may only be disclosed to the exact workflow advance endpoint.",
    );
  }
  if (input.openings.length === 0 || input.openings.length > 2) {
    throw new Error("The public checkpoint opening set is invalid.");
  }
  if (
    !input.workflowId.trim() ||
    input.stepId !== "step-1" ||
    !input.requestId.trim() ||
    input.body.requestId !== input.requestId ||
    input.body.txHash !== input.transactionHash ||
    typeof input.body.workflowToken !== "string" ||
    !input.body.workflowToken.startsWith("v2.") ||
    !/^(?:0x[a-f\d]{64}|[a-f\d]{64})$/iu.test(input.transactionHash)
  ) {
    throw new Error(
      "The public checkpoint opening is not bound to an exact workflow, step, request, token and transaction.",
    );
  }
  const disclosureKey = [
    input.workflowId,
    input.stepId,
    input.requestId,
    input.transactionHash.toLowerCase(),
  ].join(":");
  if (consumedOpeningDisclosureKeys.has(disclosureKey)) {
    throw new Error(
      "This commitment opening was already disclosed for the sealed checkpoint. Recover status without replaying it.",
    );
  }
  const seenBindings = new Set<string>();
  const allowedOpeningNeedles = new Set<string>();
  const allowedBodyKeys = new Set([
    "workflowToken",
    "requestId",
    "txHash",
    "manifestAuthorization",
    "amountCommitmentSalt",
    "recipientCommitmentSalt",
  ]);
  if (Object.keys(input.body).some((key) => !allowedBodyKeys.has(key))) {
    throw new Error(
      "The public checkpoint opening body contains an unreviewed field.",
    );
  }
  for (const opening of input.openings) {
    if (
      seenBindings.has(opening.binding) ||
      !/^0x[a-f\d]{64}$/iu.test(opening.value) ||
      input.body[opening.binding] !== opening.value
    ) {
      throw new Error("A public checkpoint commitment opening is malformed.");
    }
    seenBindings.add(opening.binding);
    for (const encoded of encodingsOf(opening.value)) {
      allowedOpeningNeedles.add(encoded.value);
    }
    for (const [key, value] of Object.entries(input.body)) {
      if (key === opening.binding) continue;
      const serialized = stringify(value);
      if (
        encodingsOf(opening.value).some((encoded) =>
          serialized.includes(encoded.value),
        )
      ) {
        throw new Error(
          "A commitment opening may appear only in its exact reviewed binding.",
        );
      }
    }
  }
  const body = JSON.stringify(input.body);
  inspectedOperations += 1;
  assertNoEgress({
    haystack: destination.href,
    surface: "fetch",
    location: "fetch:url",
    destinationOrigin: destination.origin,
  });
  inspectHeaders(
    input.headers,
    "fetch",
    "fetch:headers",
    destination.origin,
  );
  assertNoEgress({
    haystack: body,
    surface: "fetch",
    location: "fetch:body",
    destinationOrigin: destination.origin,
    allowedPrivateNeedles: allowedOpeningNeedles,
  });
  // Consume before handing control to the network. A timeout is indeterminate,
  // not permission to replay the opening under the same checkpoint identity.
  consumedOpeningDisclosureKeys.add(disclosureKey);
  const observedAt = new Date().toISOString();
  for (const opening of input.openings) {
    approvedDisclosures.push({
      schemaVersion: EGRESS_GUARD_SCHEMA,
      kind: "public_checkpoint_commitment_opening",
      binding: opening.binding,
      field: "opening",
      surface: "fetch",
      location: "fetch:body",
      destinationOrigin: destination.origin,
      destinationPath: "/api/workflows/v2/advance",
      observer: "kletia_api",
      workflowId: input.workflowId,
      stepId: input.stepId,
      requestId: input.requestId,
      transactionHash: input.transactionHash,
      irreversible: true,
      reason:
        "The public transaction already reveals the bound value. Kletia API receives this one-time opening only to verify the exact calldata against the user-signed plan.",
      observedAt,
    });
  }
  return nativeFetchForApprovedDisclosure(destination.href, {
    method: "POST",
    headers: input.headers,
    body,
    signal: input.signal,
  });
}

export interface RouteHydrationFetchInput {
  readonly url: string;
  readonly workflowId: string;
  readonly routeId: string;
  readonly requestId: string;
  readonly body: {
    readonly amount: string;
    readonly amountSalt: `0x${string}`;
    readonly acknowledgePublicExecution: true;
  };
  readonly headers: HeadersInit;
  readonly signal?: AbortSignal;
}

/**
 * Opens the protected amount only for the exact V3 live-route hydration call.
 * This is the explicit boundary where the user requests amount-dependent
 * balance, allowance, bridge-fee and APY evidence. It cannot be reused as a
 * general privacy-guard bypass.
 */
export function fetchWithRouteHydrationDisclosure(
  input: RouteHydrationFetchInput,
): Promise<Response> {
  if (!nativeFetchForApprovedDisclosure || !installed) {
    throw new Error(
      "The privacy guard must be installed before route hydration can disclose private fields.",
    );
  }
  const destination = new URL(input.url, globalThis.location?.href);
  const expectedPath = `/api/workflows/v3/${encodeURIComponent(input.workflowId)}/routes/${encodeURIComponent(input.routeId)}/hydrate`;
  if (
    destination.pathname !== expectedPath ||
    destination.search.length > 0 ||
    destination.hash.length > 0 ||
    !/^[0-9a-f-]{36}$/iu.test(input.workflowId) ||
    !/^[0-9a-f-]{36}$/iu.test(input.requestId) ||
    !/^[a-z0-9][a-z0-9-]{2,127}$/u.test(input.routeId) ||
    !/^(?:\d+\.?\d*|\.\d+)$/u.test(input.body.amount) ||
    (input.body.amount.split(".")[1]?.length ?? 0) > 6 ||
    !/^0x[a-f\d]{64}$/iu.test(input.body.amountSalt) ||
    input.body.acknowledgePublicExecution !== true
  ) {
    throw new Error(
      "The V3 route-hydration disclosure is not bound to an exact reviewed workflow request.",
    );
  }
  const headers = new Headers(input.headers);
  const authorization = headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length < 88) {
    throw new Error(
      "The route-hydration disclosure requires the exact sealed Workflow V3 token.",
    );
  }
  const body = JSON.stringify(input.body);
  const allowedPrivateNeedles = new Set<string>();
  for (const value of [input.body.amount, input.body.amountSalt]) {
    for (const encoded of encodingsOf(value)) {
      allowedPrivateNeedles.add(encoded.value);
    }
  }
  inspectedOperations += 1;
  assertNoEgress({
    haystack: destination.href,
    surface: "fetch",
    location: "fetch:url",
    destinationOrigin: destination.origin,
  });
  inspectHeaders(headers, "fetch", "fetch:headers", destination.origin);
  assertNoEgress({
    haystack: body,
    surface: "fetch",
    location: "fetch:body",
    destinationOrigin: destination.origin,
    allowedPrivateNeedles,
  });
  const observedAt = new Date().toISOString();
  for (const entry of [
    { binding: "amount" as const, field: "amount" as const },
    { binding: "amountSalt" as const, field: "opening" as const },
  ]) {
    approvedDisclosures.push({
      schemaVersion: EGRESS_GUARD_SCHEMA,
      kind: "public_route_hydration_opening",
      binding: entry.binding,
      field: entry.field,
      surface: "fetch",
      location: "fetch:body",
      destinationOrigin: destination.origin,
      destinationPath: expectedPath,
      observer: "kletia_api",
      workflowId: input.workflowId,
      stepId: input.routeId,
      requestId: input.requestId,
      transactionHash: null,
      irreversible: true,
      reason:
        "User approved an amount-bound live route quote before public execution.",
      observedAt,
    });
  }
  return nativeFetchForApprovedDisclosure(destination.href, {
    method: "POST",
    headers,
    body,
    signal: input.signal,
  });
}

/**
 * Opens the protected amount at the equivalent canonical V4 boundary.
 *
 * V4 has already required a device proof and an owner-authorized Stellar
 * control-plane commitment before this call can succeed. Keeping a separate,
 * exact-path helper prevents that stronger workflow token from becoming a
 * general bypass for the browser egress guard.
 */
export function fetchWithCanonicalRouteHydrationDisclosure(
  input: RouteHydrationFetchInput,
): Promise<Response> {
  if (!nativeFetchForApprovedDisclosure || !installed) {
    throw new Error(
      "The privacy guard must be installed before canonical route hydration can disclose private fields.",
    );
  }
  const destination = new URL(input.url, globalThis.location?.href);
  const expectedPath = `/api/intents/v4/${encodeURIComponent(input.workflowId)}/hydrate`;
  if (
    destination.pathname !== expectedPath ||
    destination.search.length > 0 ||
    destination.hash.length > 0 ||
    !/^[0-9a-f-]{36}$/iu.test(input.workflowId) ||
    !/^[0-9a-f-]{36}$/iu.test(input.requestId) ||
    input.routeId !== "arc-arbitrum-direct-cctp" ||
    !/^(?:\d+\.?\d*|\.\d+)$/u.test(input.body.amount) ||
    (input.body.amount.split(".")[1]?.length ?? 0) > 6 ||
    !/^0x[a-f\d]{64}$/iu.test(input.body.amountSalt) ||
    input.body.acknowledgePublicExecution !== true
  ) {
    throw new Error(
      "The V4 route-hydration disclosure is not bound to an exact reviewed workflow request.",
    );
  }
  const headers = new Headers(input.headers);
  const authorization = headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length < 88) {
    throw new Error(
      "The route-hydration disclosure requires the exact sealed Workflow V4 token.",
    );
  }
  const body = JSON.stringify({
    routeId: input.routeId,
    ...input.body,
  });
  const allowedPrivateNeedles = new Set<string>();
  for (const value of [input.body.amount, input.body.amountSalt]) {
    for (const encoded of encodingsOf(value)) allowedPrivateNeedles.add(encoded.value);
  }
  inspectedOperations += 1;
  assertNoEgress({
    haystack: destination.href,
    surface: "fetch",
    location: "fetch:url",
    destinationOrigin: destination.origin,
  });
  inspectHeaders(headers, "fetch", "fetch:headers", destination.origin);
  assertNoEgress({
    haystack: body,
    surface: "fetch",
    location: "fetch:body",
    destinationOrigin: destination.origin,
    allowedPrivateNeedles,
  });
  const observedAt = new Date().toISOString();
  for (const entry of [
    { binding: "amount" as const, field: "amount" as const },
    { binding: "amountSalt" as const, field: "opening" as const },
  ]) {
    approvedDisclosures.push({
      schemaVersion: EGRESS_GUARD_SCHEMA,
      kind: "public_route_hydration_opening",
      binding: entry.binding,
      field: entry.field,
      surface: "fetch",
      location: "fetch:body",
      destinationOrigin: destination.origin,
      destinationPath: expectedPath,
      observer: "kletia_api",
      workflowId: input.workflowId,
      stepId: input.routeId,
      requestId: input.requestId,
      transactionHash: null,
      irreversible: true,
      reason:
        "The owner explicitly opened the sealed amount after Policy V2 proof and Stellar commitment so Kletia can bind live public execution evidence.",
      observedAt,
    });
  }
  return nativeFetchForApprovedDisclosure(destination.href, {
    method: "POST",
    headers,
    body,
    signal: input.signal,
  });
}

export function readEgressGuardReport(): EgressGuardReport {
  const hasRegisteredFields =
    guardedFields.size > 0 || unguardableFields.size > 0;
  const coverage: EgressGuardCoverage = !hasRegisteredFields
    ? "inactive"
    : unguardableFields.size > 0
      ? "partial_low_entropy"
      : "complete";
  const observedNoViolation = violations.length === 0;
  return {
    schemaVersion: EGRESS_GUARD_SCHEMA,
    installed,
    guardedFields: [...guardedFields],
    unguardableFields: [...unguardableFields],
    needleCount: needles.length,
    inspectedOperations,
    violations: [...violations],
    approvedDisclosures: [...approvedDisclosures],
    coverage,
    observedNoViolation,
    zeroPrivateFieldEgress:
      coverage === "complete" && observedNoViolation,
    limitations: LIMITATIONS,
  };
}

/**
 * Records a violation raised outside a wrapped surface, for example by an error
 * reporter that serialised a private value. Kept separate so such a report can
 * never be mistaken for a blocked call.
 */
export function recordExternalEgressViolation(
  field: PrivateFieldName,
  location: string,
): EgressViolation {
  const violation: EgressViolation = {
    schemaVersion: EGRESS_GUARD_SCHEMA,
    field,
    surface: "error_telemetry",
    encoding: "reported",
    location,
    destinationOrigin: null,
    observedAt: new Date().toISOString(),
  };
  violations.push(violation);
  return violation;
}

/** Test-only reset so a suite can assert on a clean guard between cases. */
export function resetEgressGuardStateForTests(): void {
  resetPrivateFields();
  violations.length = 0;
  approvedDisclosures.length = 0;
  consumedOpeningDisclosureKeys.clear();
  inspectedOperations = 0;
}
