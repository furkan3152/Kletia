/**
 * ConfidentialSurfaceGateV1 — browser capability gate for confidential proving.
 *
 * The release doctrine states: "if the worker, COOP/COEP and SharedArrayBuffer
 * conditions required for browser proving are not met in the real deployment,
 * the confidential transaction surface stays closed." Until now that was a
 * written commitment with no code behind it, so a deployment that silently lost
 * cross-origin isolation would have kept the claim while losing the capability.
 *
 * This module measures the four capabilities that client-side proof generation
 * actually needs and returns a single fail-closed verdict. It never guesses: an
 * environment it cannot measure is reported as closed, not as ready.
 *
 * What this gate does NOT claim:
 *  - It does not prove any particular confidential runtime is safe. Kletia's
 *    separate XLM privacy-pool integration has its own exact contract, SDK,
 *    browser and archive gates; this legacy capability report cannot open it.
 *  - Cross-origin isolation prevents cross-origin leakage into this realm; it is
 *    not a guarantee that same-origin code is trustworthy.
 *  - A capable browser does not make an unaudited confidential token safe.
 */

export type ConfidentialCapabilityStatus = "available" | "unavailable" | "unmeasurable";

export interface ConfidentialCapabilityObservation {
  readonly capability:
    | "cross_origin_isolated"
    | "shared_array_buffer"
    | "dedicated_worker"
    | "web_crypto_subtle";
  readonly status: ConfidentialCapabilityStatus;
  readonly requirement: string;
  readonly detail: string;
}

export interface ConfidentialSurfaceReportV1 {
  readonly schemaVersion: "kletia_confidential_surface_gate_v1";
  /** The only field callers should branch on. False means fail closed. */
  readonly surfaceOpen: boolean;
  readonly observedAt: string;
  readonly capabilities: readonly ConfidentialCapabilityObservation[];
  readonly blockingCapabilities: readonly string[];
  readonly reason: string;
  readonly limitations: readonly string[];
}

const LIMITATIONS: readonly string[] = [
  "An open surface proves browser capability only; it does not attest the separate pinned XLM privacy-pool deployment, SDK, archive or user-signed lifecycle.",
  "Cross-origin isolation constrains cross-origin leakage into this realm; it does not make same-origin code trustworthy.",
  "A capable browser does not make an unaudited confidential token deployment safe to hold value in.",
];

function observeCrossOriginIsolation(): ConfidentialCapabilityObservation {
  const requirement =
    "The document must be cross-origin isolated via Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.";
  if (typeof globalThis === "undefined" || !("crossOriginIsolated" in globalThis)) {
    return {
      capability: "cross_origin_isolated",
      status: "unmeasurable",
      requirement,
      detail:
        "This runtime does not expose crossOriginIsolated, so isolation cannot be confirmed and is treated as absent.",
    };
  }
  const isolated = (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
  return {
    capability: "cross_origin_isolated",
    status: isolated ? "available" : "unavailable",
    requirement,
    detail: isolated
      ? "crossOriginIsolated is true, so the required COOP/COEP response headers are being served."
      : "crossOriginIsolated is false. The deployment is not serving the COOP/COEP headers that client-side proving requires.",
  };
}

function observeSharedArrayBuffer(): ConfidentialCapabilityObservation {
  const requirement =
    "SharedArrayBuffer must be constructible so proving work can share memory with a worker without copying witness data.";
  if (typeof SharedArrayBuffer === "undefined") {
    return {
      capability: "shared_array_buffer",
      status: "unavailable",
      requirement,
      detail: "SharedArrayBuffer is not defined, which is the expected result without cross-origin isolation.",
    };
  }
  try {
    // Presence of the constructor is not sufficient: some engines expose it but
    // refuse construction when the realm is not isolated.
    const probe = new SharedArrayBuffer(8);
    return {
      capability: "shared_array_buffer",
      status: probe.byteLength === 8 ? "available" : "unavailable",
      requirement,
      detail:
        probe.byteLength === 8
          ? "SharedArrayBuffer was constructed successfully."
          : "SharedArrayBuffer was constructed with an unexpected byte length.",
    };
  } catch (error) {
    return {
      capability: "shared_array_buffer",
      status: "unavailable",
      requirement,
      detail: `SharedArrayBuffer exists but could not be constructed: ${
        error instanceof Error ? error.name : "unknown error"
      }.`,
    };
  }
}

function observeDedicatedWorker(): ConfidentialCapabilityObservation {
  const requirement =
    "A dedicated Worker must be available so proof generation never blocks the signing interface.";
  const available = typeof Worker === "function";
  return {
    capability: "dedicated_worker",
    status: available ? "available" : "unavailable",
    requirement,
    detail: available
      ? "The Worker constructor is available."
      : "The Worker constructor is missing, so proving could only run on the main thread.",
  };
}

function observeWebCrypto(): ConfidentialCapabilityObservation {
  const requirement =
    "crypto.getRandomValues and crypto.subtle must exist so salts, openings and blinding factors are generated from a vetted CSPRNG.";
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  const available =
    !!cryptoRef &&
    typeof cryptoRef.getRandomValues === "function" &&
    typeof cryptoRef.subtle?.digest === "function";
  return {
    capability: "web_crypto_subtle",
    status: available ? "available" : "unavailable",
    requirement,
    detail: available
      ? "Both crypto.getRandomValues and crypto.subtle.digest are available."
      : "The Web Crypto API is incomplete, so private-field commitments cannot be produced safely.",
  };
}

/**
 * Measures every capability and returns a fail-closed verdict.
 *
 * `surfaceOpen` is true only when all four capabilities are `available`. Both
 * `unavailable` and `unmeasurable` block the surface, because an environment we
 * cannot measure must never be presented as verified.
 */
export function readConfidentialSurfaceReport(): ConfidentialSurfaceReportV1 {
  const capabilities: readonly ConfidentialCapabilityObservation[] = [
    observeCrossOriginIsolation(),
    observeSharedArrayBuffer(),
    observeDedicatedWorker(),
    observeWebCrypto(),
  ];
  const blocking = capabilities.filter((entry) => entry.status !== "available");
  const surfaceOpen = blocking.length === 0;
  return {
    schemaVersion: "kletia_confidential_surface_gate_v1",
    surfaceOpen,
    observedAt: new Date().toISOString(),
    capabilities,
    blockingCapabilities: blocking.map((entry) => entry.capability),
    reason: surfaceOpen
      ? "Every capability required for client-side confidential proving was observed in this browser realm."
      : `The confidential surface is closed because these capabilities are not confirmed: ${blocking
          .map((entry) => entry.capability)
          .join(", ")}.`,
    limitations: LIMITATIONS,
  };
}

export class ConfidentialSurfaceClosedError extends Error {
  readonly code = "CONFIDENTIAL_SURFACE_CLOSED";
  readonly report: ConfidentialSurfaceReportV1;

  constructor(report: ConfidentialSurfaceReportV1) {
    super(report.reason);
    this.name = "ConfidentialSurfaceClosedError";
    this.report = report;
  }
}

/**
 * Fail-closed guard. Call this before preparing any confidential invocation so a
 * proof is never attempted, and no confidential claim is ever surfaced, in a
 * browser realm that cannot support it.
 */
export function assertConfidentialSurfaceOpen(): ConfidentialSurfaceReportV1 {
  const report = readConfidentialSurfaceReport();
  if (!report.surfaceOpen) throw new ConfidentialSurfaceClosedError(report);
  return report;
}
