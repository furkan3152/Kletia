/**
 * The admin panel's HTTP client. Pure: no React, no wallet code, no
 * build-time env, so `node --test` loads it and the wallet-free gate
 * (AdminPage) can use it before any wallet chunk loads.
 *
 * Every call sends the session cookie (`credentials: "include"`) and the
 * `X-Kletia-Admin: 1` header the API requires on every admin route (it forces
 * a CORS preflight that only the admin origins pass). Error bodies are
 * `AdminErrorBody`; `gateFor` maps the codes that decide what the panel shows.
 */
import type {
  AdminActionVerifyRequest,
  AdminArtifact,
  AdminAuditEntry,
  AdminCatalog,
  AdminConfirmation,
  AdminContractState,
  AdminDeploymentRecord,
  AdminEnvView,
  AdminEvmNetwork,
  AdminExport,
  AdminFeesView,
  AdminNetworkProfile,
  AdminNonceResponse,
  AdminOverview,
  AdminPinnedDeployment,
  AdminRecordRequest,
  AdminRenderDeploy,
  AdminRenderServiceKey,
  AdminSafeProposal,
  AdminServicesView,
  AdminSessionView,
  AdminWalletKind,
} from "../model/types.ts";

export const ADMIN_HEADER = "X-Kletia-Admin";
export const ADMIN_PREFIX = "/api/admin";
/** Admin reads are small; a slow RPC behind a state read still answers within this. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Why the panel shows a gate card instead of its sections. */
export type AdminGate =
  | "disabled"
  | "missing"
  | "origin"
  | "store"
  | "signed-out"
  | "not-allowed"
  | "unreachable";

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(code: string, message: string, status: number, requestId: string | null = null, details: Readonly<Record<string, unknown>> | null = null) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }

  /** The API could not be reached (offline, DNS, CORS refusal, timeout). */
  get unreachable(): boolean {
    return this.status === 0;
  }

  /** Worth a Retry button: the network, a timeout, a rate limit or a 5xx other than "admin is off". */
  get retryable(): boolean {
    if (this.status === 0 || this.status === 429) return true;
    return this.status >= 500 && this.code !== "ADMIN_DISABLED" && this.code !== "ADMIN_STORE_UNAVAILABLE";
  }
}

/** The gate an error puts the panel in, or null when the error belongs to one request only. */
export function gateFor(error: unknown): AdminGate | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case "ADMIN_DISABLED":
      return "disabled";
    case "ADMIN_ROUTE_MISSING":
      return "missing";
    case "ADMIN_ORIGIN_FORBIDDEN":
      return "origin";
    case "ADMIN_STORE_UNAVAILABLE":
      return "store";
    case "ADMIN_SESSION_REQUIRED":
      return "signed-out";
    case "ADMIN_NOT_ALLOWED":
      return "not-allowed";
    default:
      return error.unreachable ? "unreachable" : null;
  }
}

/** Plain-English line for an error, for inline messages (ApiErrorPanel shows code and status beside it). */
export function describeAdminError(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.unreachable) {
      return error.code === "ADMIN_TIMEOUT" ? "The Kletia API did not answer in time." : "The Kletia API is unreachable from this browser right now.";
    }
    return error.message || `The request failed (${error.code}).`;
  }
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function isErrorBody(value: unknown): value is { error: { code: string; message?: string; requestId?: string; details?: Record<string, unknown> } } {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string");
}

/** A nonce request: EVM wallets sign EIP-4361 for one chain id; Solana wallets sign the plain-text equivalent. */
export type AdminNonceRequest =
  | { readonly kind: "evm"; readonly address: string; readonly chainId: number }
  | { readonly kind: "solana"; readonly address: string };

/**
 * A step-up confirmation nonce, signed by the wallet that holds
 * the session and bound to the action and the payload hash.
 */
export interface AdminConfirmNonceRequest {
  readonly walletKind: AdminWalletKind;
  readonly address: string;
  /** EVM sessions only. */
  readonly chainId?: number | null;
  readonly action: string;
  readonly network?: AdminEvmNetwork;
  readonly payloadSha256: string;
}

/** The body `POST auth/nonce` receives (one place, so a wire change touches one function). */
export function nonceBody(request: AdminNonceRequest): Record<string, unknown> {
  return request.kind === "evm"
    ? { walletKind: "evm", address: request.address, chainId: request.chainId, purpose: "login" }
    : { walletKind: "solana", address: request.address, purpose: "login" };
}

/** The body `POST auth/confirm` nonces receive. */
export function confirmNonceBody(request: AdminConfirmNonceRequest): Record<string, unknown> {
  return {
    walletKind: request.walletKind,
    address: request.address,
    ...(request.walletKind === "evm" && typeof request.chainId === "number" ? { chainId: request.chainId } : {}),
    purpose: "confirm",
    action: request.action,
    ...(request.network ? { network: request.network } : {}),
    payloadSha256: request.payloadSha256,
  };
}

/**
 * The body `POST auth/verify` receives: the exact message text and the
 * signature (0x hex from an EVM wallet, base58 of the 64 ed25519 bytes from a
 * Solana wallet). The server reads the wallet family from the message.
 */
export function verifyBody(message: string, signature: string): Record<string, unknown> {
  return { message, signature };
}

export interface AdminClientOptions {
  /** API origin, e.g. https://api.kletiaai.xyz (no trailing slash needed). */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

type Method = "GET" | "POST" | "PUT" | "PATCH";

export interface AdminFileDownload {
  readonly filename: string;
  readonly body: AdminExport;
}

export function createAdminClient({ baseUrl, fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }: AdminClientOptions) {
  const origin = baseUrl.replace(/\/+$/u, "");
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  async function send(method: Method, path: string, body?: unknown): Promise<Response> {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const headers: Record<string, string> = { [ADMIN_HEADER]: "1", Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(`${origin}${ADMIN_PREFIX}${path}`, {
        method,
        credentials: "include",
        cache: "no-store",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new AdminApiError(aborted ? "ADMIN_TIMEOUT" : "ADMIN_UNREACHABLE", aborted ? "The Kletia API did not answer in time." : "The Kletia API is unreachable.", 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fail(response: Response): Promise<never> {
    const parsed: unknown = await response.json().catch(() => null);
    if (isErrorBody(parsed)) {
      const { code, message, requestId, details } = parsed.error;
      throw new AdminApiError(code, message ?? code, response.status, requestId ?? response.headers.get("x-request-id"), details ?? null);
    }
    // An API without the admin router answers 404 with its generic body: the panel says so instead of "not found".
    if (response.status === 404) throw new AdminApiError("ADMIN_ROUTE_MISSING", "This API has no admin panel.", 404, response.headers.get("x-request-id"));
    throw new AdminApiError("ADMIN_HTTP_ERROR", `The API answered HTTP ${response.status}.`, response.status, response.headers.get("x-request-id"));
  }

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
    if (!response.ok) return fail(response);
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new AdminApiError("ADMIN_BAD_RESPONSE", "The API sent a response the panel cannot read.", response.status);
    }
  }

  const enc = encodeURIComponent;

  return {
    request,
    /* auth */
    session: () => request<{ session: AdminSessionView }>("GET", "/auth/session").then((body) => body.session),
    nonce: (input: AdminNonceRequest) => request<AdminNonceResponse>("POST", "/auth/nonce", nonceBody(input)),
    confirmNonce: (input: AdminConfirmNonceRequest) => request<AdminNonceResponse>("POST", "/auth/nonce", confirmNonceBody(input)),
    verify: (message: string, signature: string) =>
      request<{ session: AdminSessionView }>("POST", "/auth/verify", verifyBody(message, signature)).then((body) => body.session),
    logout: () => request<void>("POST", "/auth/logout"),
    logoutAll: () => request<void>("POST", "/auth/logout-all"),
    /* reads */
    overview: () => request<AdminOverview>("GET", "/overview"),
    catalog: () => request<AdminCatalog>("GET", "/catalog"),
    artifact: (artifactId: string) =>
      request<{ artifact: AdminArtifact }>("GET", `/artifacts/${artifactId.split("/").map(enc).join("/")}`).then((body) => body.artifact),
    deployments: (filter: { network?: AdminEvmNetwork; status?: string } = {}) => {
      const query = new URLSearchParams();
      if (filter.network) query.set("network", filter.network);
      if (filter.status) query.set("status", filter.status);
      const text = query.toString();
      const suffix = text ? `?${text}` : "";
      return request<{ records: AdminDeploymentRecord[]; pinned: AdminPinnedDeployment[] }>("GET", `/deployments${suffix}`);
    },
    recordDeployment: (input: AdminRecordRequest & { import?: boolean }) =>
      request<{ record: AdminDeploymentRecord }>("POST", "/deployments", input).then((body) => body.record),
    reverify: (id: string) => request<{ record: AdminDeploymentRecord }>("POST", `/deployments/${enc(id)}/reverify`).then((body) => body.record),
    setRecordStatus: (id: string, input: { status: "archived" | "superseded"; notes?: string; confirmation: AdminConfirmation }) =>
      request<{ record: AdminDeploymentRecord }>("PATCH", `/deployments/${enc(id)}`, input).then((body) => body.record),
    exportDeployments: () => request<AdminExport>("GET", "/deployments/export"),
    profiles: () => request<{ profiles: AdminNetworkProfile[] }>("GET", "/network-profiles").then((body) => body.profiles),
    saveProfile: (
      network: AdminEvmNetwork,
      input: { owner: string | null; guardian: string | null; treasury: string | null; eoaOwnerAcknowledged: boolean; confirmation: AdminConfirmation },
    ) => request<{ profile: AdminNetworkProfile }>("PUT", `/network-profiles/${enc(network)}`, input).then((body) => body.profile),
    contractState: (recordKey: string) => request<AdminContractState>("GET", `/contracts/${enc(recordKey)}/state`),
    verifyAction: (input: AdminActionVerifyRequest) =>
      request<{ decoded: { fn: string; args: Record<string, string> } | null; block: string; auditId: string }>("POST", "/actions/verify", input),
    safeProposals: (filter: { network?: AdminEvmNetwork; status?: string } = {}) => {
      const query = new URLSearchParams();
      if (filter.network) query.set("network", filter.network);
      if (filter.status) query.set("status", filter.status);
      const text = query.toString();
      const suffix = text ? `?${text}` : "";
      return request<{ proposals: AdminSafeProposal[] }>("GET", `/safe-proposals${suffix}`).then((body) => body.proposals);
    },
    proposeSafe: (input: { network: AdminEvmNetwork; safe: string; to: string; value: string; data: string; description: string; actionId?: string | null }) =>
      request<{ proposal: AdminSafeProposal }>("POST", "/safe-proposals", input).then((body) => body.proposal),
    addSafeSignature: (id: string, signature: string) =>
      request<{ proposal: AdminSafeProposal }>("POST", `/safe-proposals/${enc(id)}/signatures`, { signature }).then((body) => body.proposal),
    markSafeExecuted: (id: string, txHash: string) =>
      request<{ proposal: AdminSafeProposal }>("POST", `/safe-proposals/${enc(id)}/executed`, { txHash }).then((body) => body.proposal),
    cancelSafe: (id: string) => request<{ proposal: AdminSafeProposal }>("POST", `/safe-proposals/${enc(id)}/cancel`).then((body) => body.proposal),
    fees: () => request<AdminFeesView>("GET", "/fees"),
    rescanFees: (key: string) => request<{ scannedThroughBlock: string }>("POST", "/fees/rescan", { key }),
    services: () => request<AdminServicesView>("GET", "/services"),
    redeploy: (service: AdminRenderServiceKey, clearCache: boolean) =>
      request<{ deploy: AdminRenderDeploy }>("POST", `/services/${enc(service)}/deploy`, { clearCache }).then((body) => body.deploy),
    env: () => request<AdminEnvView>("GET", "/env"),
    audit: (input: { limit?: number; before?: string | null } = {}) => {
      const query = new URLSearchParams();
      query.set("limit", String(Math.min(Math.max(input.limit ?? 50, 1), 100)));
      if (input.before) query.set("before", input.before);
      return request<{ entries: AdminAuditEntry[]; next: string | null }>("GET", `/audit?${query.toString()}`);
    },
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;

/** `kletia-deployments-YYYY-MM-DD.json`, the name the API's attachment header uses. */
export function exportFileName(exportedAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/u.exec(exportedAt)?.[0] ?? new Date().toISOString().slice(0, 10);
  return `kletia-deployments-${day}.json`;
}
