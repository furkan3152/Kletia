/**
 * `@kletia/sdk/receipts`: open shared receipts and re-verify receipts
 * against public RPCs, trusting neither Kletia nor a single node
 * (receipts design §6.2). Browser-safe: fetch and Web Crypto only (EAS
 * envelopes additionally need the optional `viem` package).
 *
 * Everything here is read-only: `eth_getTransactionByHash`,
 * `eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_call`,
 * `eth_getCode`, `getTransaction`, `getBlock`. Nothing is ever signed or sent.
 */
import {
  CHAINS,
  KLETIA_RECEIPT_KEY_PINS,
  RECEIPT_ID_PATTERN,
  RECEIPT_SHARE_AAD_PREFIX,
  RECEIPT_SHARE_ID_PATTERN,
  base64UrlDecode,
  compareAnchors,
  evmQuoteBinding,
  hexToBytes,
  isAnchorUnavailable,
  keccak256Hex,
  readEvmAnchor,
  readEvmBindingView,
  readSvmAnchor,
  receiptKeyId,
  receiptLogBatchDigest,
  sha256Hex,
  verifyReceipt,
  type CaipChainId,
  type EvidenceGroup,
  type EvmBindingView,
  type NetworkKey,
  type ReceiptAnchor,
  type ReceiptDisclosure,
  type ReceiptDocument,
  type ReceiptKey,
  type ReceiptVerification,
  type ReceiptWarning,
  type RpcTransport,
  type VerifyReceiptOptions,
} from "@kletia/core";
import { DEFAULT_BASE_URL, DEFAULT_WEB_ORIGIN, KletiaClient } from "./client.js";
import { KletiaApiError } from "./errors.js";

export {
  KLETIA_RECEIPT_KEY_PINS,
  RECEIPT_PROFILES,
  intentRef,
  receiptDigest,
  verifyReceipt,
  verifyReceiptLogBatch,
} from "@kletia/core";
export type {
  ReceiptAnchor,
  ReceiptDisclosure,
  ReceiptDocument,
  ReceiptKey,
  ReceiptPayload,
  ReceiptProblem,
  ReceiptProblemCode,
  ReceiptProfile,
  ReceiptVerification,
  ReceiptWarning,
  ReceiptWarningCode,
  VerifyReceiptOptions,
} from "@kletia/core";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Public endpoints per network, in order (receipts design §6.2.2, chosen
 * from the 2026-10-09 history probe; every one answers browser CORS).
 * `cloudflare-eth.com` (null for every transaction, no `finalized` tag) and
 * `solana.drpc.org` (not on the free plan) are deliberately absent. Pass
 * your own (`rpcs`) for audits: a public "not found" is never evidence.
 */
export const DEFAULT_REVERIFY_RPCS: Readonly<Partial<Record<NetworkKey, readonly string[]>>> = Object.freeze({
  ethereum: Object.freeze(["https://eth.drpc.org", "https://ethereum-rpc.publicnode.com"]),
  base: Object.freeze(["https://mainnet.base.org", "https://base.drpc.org"]),
  arbitrum: Object.freeze(["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"]),
  optimism: Object.freeze(["https://mainnet.optimism.io", "https://optimism.drpc.org"]),
  polygon: Object.freeze(["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"]),
  arc: Object.freeze(["https://rpc.drpc.testnet.arc.network", "https://rpc.testnet.arc.network"]),
  "arbitrum-sepolia": Object.freeze(["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"]),
  solana: Object.freeze(["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]),
  "solana-devnet": Object.freeze(["https://api.devnet.solana.com"]),
});

/** Where the web app mirrors the API's receipt key set (a second origin served by a second service). */
export const RECEIPT_KEYS_WELL_KNOWN_PATH = "/.well-known/kletia-receipt-keys.json";

/** The EAS predeploy on Base, which timestamps transparency-log batches. */
export const EAS_BASE_ADDRESS = "0x4200000000000000000000000000000000000021";
/** `getTimestamp(bytes32)`. */
const EAS_GET_TIMESTAMP = "0xd45c4435";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PER_HOST_CONCURRENCY = 4;

/* ================================================================ transport */

/** An RPC error that keeps the JSON-RPC `code` (e.g. -32015) or the HTTP status. */
export class RpcCallError extends Error {
  readonly code: number | null;
  readonly status: number | null;

  constructor(message: string, code: number | null, status: number | null) {
    super(message);
    this.name = "RpcCallError";
    this.code = code;
    this.status = status;
  }
}

/** Origin and short path of an RPC URL: query strings and long path segments (API keys) never reach a report. */
export function displayRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split("/")
      .map((segment) => (segment.length >= 16 || (/\d/u.test(segment) && /[a-z]/iu.test(segment) && segment.length >= 10) ? "…" : segment))
      .join("/")
      .replace(/\/+$/u, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "(invalid url)";
  }
}

function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function readLimited(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new RpcCallError("The response is too large.", null, response.status);
  return text;
}

/** JSON-RPC 2.0 over HTTPS POST (one call per request, bounded by `timeoutMs`). */
export function jsonRpcTransport(url: string, options: { readonly fetch?: FetchLike; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): RpcTransport {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined)?.bind(globalThis);
  if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let id = 0;
  return async (method, params) => {
    id += 1;
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: anySignal([AbortSignal.timeout(timeoutMs), options.signal]) as AbortSignal,
        redirect: "error",
      });
      text = await readLimited(response);
    } catch (error) {
      if (error instanceof RpcCallError) throw error;
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new RpcCallError(timedOut ? "timed out" : "unreachable", null, null);
    }
    if (response.status >= 400) throw new RpcCallError(`HTTP ${response.status}`, null, response.status);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcCallError("not a JSON-RPC response", null, response.status);
    }
    if (typeof body !== "object" || body === null) throw new RpcCallError("not a JSON-RPC response", null, response.status);
    const record = body as { error?: { code?: unknown; message?: unknown }; result?: unknown };
    if (record.error) {
      const message = typeof record.error.message === "string" ? record.error.message.slice(0, 200) : "RPC error";
      throw new RpcCallError(message, typeof record.error.code === "number" ? record.error.code : null, response.status);
    }
    return "result" in record ? record.result : null;
  };
}

/** Caches identical calls and bounds concurrency per host, for one re-verification run. */
function runTransport(base: RpcTransport, host: string, gates: Map<string, Gate>): RpcTransport {
  const cache = new Map<string, Promise<unknown>>();
  return (method, params) => {
    const key = `${method}:${JSON.stringify(params)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const gate = gates.get(host) ?? new Gate(PER_HOST_CONCURRENCY);
    gates.set(host, gate);
    const pending = gate.run(() => base(method, params));
    cache.set(key, pending);
    return pending;
  };
}

class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/* ===================================================================== keys */

const KEY_STATUS_RANK: Readonly<Record<ReceiptKey["status"], number>> = { active: 0, next: 0, development: 1, retired: 2, revoked: 3 };

function isReceiptKeyLike(value: unknown): value is ReceiptKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "OKP" &&
    key.crv === "Ed25519" &&
    typeof key.x === "string" &&
    typeof key.kid === "string" &&
    typeof key.notBefore === "string" &&
    typeof key.status === "string" &&
    key.status in KEY_STATUS_RANK &&
    receiptKeyId(key.x) === key.kid
  );
}

function keyList(body: unknown): ReceiptKey[] {
  const keys = typeof body === "object" && body !== null && Array.isArray((body as { keys?: unknown }).keys) ? (body as { keys: unknown[] }).keys : [];
  return keys.filter(isReceiptKeyLike);
}

export interface ReceiptKeysResult {
  /** Keys both origins list with the same public key and `notBefore` (the stricter status and revocation day win). */
  readonly keys: readonly ReceiptKey[];
  /** Key ids only one origin lists, or listed differently. */
  readonly dropped: readonly string[];
  /** Why an origin could not be read (empty when both were). */
  readonly errors: readonly string[];
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: anySignal([AbortSignal.timeout(timeoutMs), signal]) as AbortSignal });
  const text = await readLimited(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(text) as unknown;
}

/**
 * Receipt keys to trust (receipts design §6.1): `GET /v1/receipts/keys` on
 * the API and the web origin's `/.well-known/kletia-receipt-keys.json` (two
 * origins served by two services), keeping only keys both list identically.
 * A key only one origin shows is never trusted. Pinned keys in
 * `@kletia/core` (`KLETIA_RECEIPT_KEY_PINS`) need none of this.
 */
export async function fetchReceiptKeys(
  options: { readonly baseUrl?: string; readonly webOrigin?: string; readonly fetch?: FetchLike; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ReceiptKeysResult> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined)?.bind(globalThis);
  if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
  const api = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/receipts/keys`;
  const web = `${new URL(options.webOrigin ?? DEFAULT_WEB_ORIGIN).origin}${RECEIPT_KEYS_WELL_KNOWN_PATH}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: string[] = [];
  const read = async (url: string, label: string): Promise<ReceiptKey[]> => {
    try {
      return keyList(await getJson(fetchImpl, url, timeoutMs, options.signal));
    } catch (error) {
      errors.push(`${label} (${displayRpcUrl(url)}): ${error instanceof Error ? error.message.slice(0, 120) : "unreadable"}`);
      return [];
    }
  };
  const [fromApi, fromWeb] = await Promise.all([read(api, "API key set"), read(web, "web mirror")]);
  const webById = new Map(fromWeb.map((key) => [key.kid, key]));
  const keys: ReceiptKey[] = [];
  const dropped = new Set<string>();
  for (const key of fromApi) {
    const mirror = webById.get(key.kid);
    if (!mirror || mirror.x !== key.x || mirror.notBefore !== key.notBefore) {
      dropped.add(key.kid);
      continue;
    }
    const status = KEY_STATUS_RANK[mirror.status] > KEY_STATUS_RANK[key.status] ? mirror.status : key.status;
    const revokedOn = [key.revokedOn, mirror.revokedOn].filter((day): day is string => typeof day === "string").sort()[0];
    keys.push({ kty: "OKP", crv: "Ed25519", x: key.x, kid: key.kid, alg: "Ed25519", use: "sig", status, notBefore: key.notBefore, ...(revokedOn ? { revokedOn } : {}) });
  }
  for (const key of fromWeb) if (!keys.some((kept) => kept.kid === key.kid)) dropped.add(key.kid);
  return { keys, dropped: [...dropped], errors };
}

/** Keys for verification: supplied ones, else the two-origin set; how they were obtained. */
async function resolveKeys(options: ReceiptTrustOptions): Promise<{ readonly keys: readonly ReceiptKey[]; readonly source: KeySource; readonly notes: readonly string[] }> {
  if (options.keys) return { keys: options.keys, source: "supplied", notes: [] };
  if (options.fetchKeys === false) return { keys: [], source: "pinned", notes: [] };
  const fetched = await fetchReceiptKeys({
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.webOrigin ? { webOrigin: options.webOrigin } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const notes = [...fetched.errors, ...(fetched.dropped.length > 0 ? [`Not confirmed by both origins, so not trusted: ${fetched.dropped.join(", ")}.`] : [])];
  return { keys: fetched.keys, source: "api+web", notes };
}

/** How the verification keys were obtained: given by the caller, confirmed by API and web origin, or only the pins. */
export type KeySource = "supplied" | "api+web" | "pinned";

/** Key and network options shared by `openShareUrl` and `reverifyReceipt`. */
export interface ReceiptTrustOptions {
  /** Keys you trust (e.g. read from a file you control). Default: fetched from the API and the web mirror and cross-checked. */
  readonly keys?: readonly ReceiptKey[];
  /** `false`: use only `KLETIA_RECEIPT_KEY_PINS` (and `keys`); no key request is made. */
  readonly fetchKeys?: boolean;
  /** Replaces KLETIA_RECEIPT_KEY_PINS (private deployments, tests). */
  readonly pins?: readonly ReceiptKey[];
  /** API origin (default https://api.kletiaai.xyz). */
  readonly baseUrl?: string;
  /** Web origin of the key mirror (default https://kletiaai.xyz). */
  readonly webOrigin?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function verifyOptions(options: ReceiptTrustOptions & { readonly intentId?: string; readonly requireGroups?: readonly string[] }, keys: readonly ReceiptKey[]): VerifyReceiptOptions {
  return {
    keys,
    ...(options.pins ? { pins: options.pins } : {}),
    ...(options.intentId ? { intentId: options.intentId } : {}),
    ...(options.requireGroups ? { requireGroups: options.requireGroups } : {}),
  };
}

/* =================================================================== shares */

export interface ShareLink {
  readonly receiptId: string;
  readonly shareId: string;
  /** base64url AES-256 key from the fragment (never sent to any server). */
  readonly key: string;
}

/**
 * Parses `https://<web>/r/<receiptId>#s=<shareId>&k=<key>` (any host; only
 * the path and the fragment matter). A query string is refused: keys belong
 * in the fragment, which browsers never send.
 */
export function parseShareUrl(value: string): ShareLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.search || url.username || url.password) return null;
  const match = /^\/r\/(rcpt_[0-9a-f]{32})\/?$/u.exec(url.pathname);
  if (!match) return null;
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const shareId = fragment.get("s") ?? "";
  const key = fragment.get("k") ?? "";
  const receiptId = match[1] as string;
  if (!RECEIPT_ID_PATTERN.test(receiptId) || !RECEIPT_SHARE_ID_PATTERN.test(shareId) || !/^[A-Za-z0-9_-]{43}$/u.test(key)) return null;
  return { receiptId, shareId, key };
}

function webCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is not available in this runtime.");
  return subtle;
}

/**
 * Decrypts a share's ciphertext (`base64url(iv ‖ ciphertext ‖ tag)`,
 * AES-256-GCM, AAD `kletia.receipt-share.v1:<receiptId>:<shareId>`). Null
 * when the key, the ids or the ciphertext do not match.
 */
export async function decryptShareDisclosures(receiptId: string, shareId: string, ciphertext: string, key: string): Promise<Record<string, ReceiptDisclosure> | null> {
  try {
    const raw = base64UrlDecode(ciphertext);
    const secret = base64UrlDecode(key);
    if (!raw || !secret || raw.length < 12 + 16 || secret.length !== 32) return null;
    const subtle = webCrypto();
    const cryptoKey = await subtle.importKey("raw", new Uint8Array(secret), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(raw.slice(0, 12)), additionalData: new TextEncoder().encode(`${RECEIPT_SHARE_AAD_PREFIX}${receiptId}:${shareId}`), tagLength: 128 },
      cryptoKey,
      new Uint8Array(raw.slice(12)),
    );
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { receiptId?: unknown; shareId?: unknown; disclosures?: unknown };
    if (record.receiptId !== receiptId || record.shareId !== shareId) return null;
    if (typeof record.disclosures !== "object" || record.disclosures === null || Array.isArray(record.disclosures)) return null;
    return record.disclosures as Record<string, ReceiptDisclosure>;
  } catch {
    return null;
  }
}

export interface OpenedShare {
  /** Payload, digest, signature (and inclusion) from the API, with the decrypted disclosures. */
  readonly receipt: ReceiptDocument;
  /** `verifyReceipt` of the assembled document (`SHARE_DECRYPT_FAILED` when the link does not open). */
  readonly verification: ReceiptVerification;
  readonly share: { readonly receiptId: string; readonly shareId: string; readonly groups: readonly string[]; readonly expiresAt: string | null };
  readonly keySource: KeySource;
  /** Notes about key discovery (an origin that could not be read, keys only one origin lists). */
  readonly notes: readonly string[];
}

/**
 * Opens a share link: fetches the public payload and the ciphertext, decrypts
 * the disclosures with the key from the fragment (locally; the key never
 * leaves this process) and verifies the result. Never returns the intent id
 * (a share does not carry it). HTTP failures (unknown, revoked or expired
 * shares) reject with `KletiaApiError`.
 */
export async function openShareUrl(url: string, options: ReceiptTrustOptions & { readonly client?: KletiaClient; readonly requireGroups?: readonly string[] } = {}): Promise<OpenedShare> {
  const link = parseShareUrl(url);
  if (!link) throw new TypeError("Not a receipt share link (https://…/r/rcpt_…#s=rsh_…&k=…).");
  const client =
    options.client ??
    new KletiaClient({ ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const request = options.signal ? { signal: options.signal } : {};
  const [shared, sealed] = await Promise.all([client.receipts.shared(link.receiptId, request), client.receipts.shareCiphertext(link.receiptId, link.shareId, request)]);
  const share = { receiptId: link.receiptId, shareId: link.shareId, groups: sealed.groups, expiresAt: sealed.expiresAt };
  const { keys, source, notes } = await resolveKeys({ ...options, baseUrl: options.baseUrl ?? client.baseUrl });
  const disclosures = sealed.alg === "A256GCM" ? await decryptShareDisclosures(link.receiptId, link.shareId, sealed.ciphertext, link.key) : null;
  const base = { payload: shared.payload, digest: shared.digest, signature: shared.signature, ...(shared.inclusion ? { inclusion: shared.inclusion } : {}), ...(shared.attestations ? { attestations: shared.attestations } : {}) } as ReceiptDocument;
  if (!disclosures) {
    const offline = await verifyReceipt(base, verifyOptions(options, keys));
    return {
      receipt: base,
      verification: { ...offline, valid: false, problems: [{ code: "SHARE_DECRYPT_FAILED", message: "The share link does not decrypt: its key, ids or ciphertext do not match." }, ...offline.problems] },
      share,
      keySource: source,
      notes,
    };
  }
  const receipt = { ...base, disclosures } as ReceiptDocument;
  return { receipt, verification: await verifyReceipt(receipt, verifyOptions(options, keys)), share, keySource: source, notes };
}

/* ================================================================= reverify */

export interface ReverifyOptions extends ReceiptTrustOptions {
  /** Endpoints per network (default DEFAULT_REVERIFY_RPCS); listed networks replace the defaults. */
  readonly rpcs?: Partial<Record<NetworkKey, readonly string[]>>;
  /** Distinct endpoints that must agree (default 2; 1 when only one is configured, with a SINGLE_SOURCE warning). */
  readonly quorum?: number;
  /** Check finality on the matching sources (default true). */
  readonly checkFinality?: boolean;
  /** Read `EAS.getTimestamp(batchDigest)` on Base for receipts with an inclusion proof (default true). */
  readonly checkAnchoring?: boolean;
  /** Also query the bridge providers' public status APIs (default false; informational). */
  readonly providers?: boolean;
  /** Archive endpoints per network: enables code-hash checks of custom-contract pins at the receipt's block. */
  readonly archiveRpcs?: Partial<Record<NetworkKey, string>>;
  /** Checks `intent.ref` against this intent id. */
  readonly intentId?: string;
}

export type SourceResult = "match" | "mismatch" | "unavailable";

export interface AnchorCheck {
  readonly step: string;
  /** Transaction hash (EVM) or signature (Solana). */
  readonly ref: string;
  readonly chain: CaipChainId;
  readonly role: "origin" | "fill";
  readonly result: "match" | "mismatch" | "conflict" | "unavailable" | "not_finalized";
  /** Fields that differ on the sources that disagree. */
  readonly mismatched: readonly string[];
  readonly sources: readonly { readonly url: string; readonly result: SourceResult; readonly detail?: string }[];
  /** Finality on a matching source (`null` when not checked or not reached). */
  readonly finalized: boolean | null;
}

export interface ReverifyReport {
  /** `verified`: valid offline and every anchor and binding matches; `mismatch`: invalid offline or a source proved a difference; `inconclusive` otherwise. */
  readonly verdict: "verified" | "mismatch" | "inconclusive";
  readonly offline: ReceiptVerification;
  readonly keySource: KeySource;
  readonly anchors: readonly AnchorCheck[];
  readonly bindings: readonly { readonly step: string; readonly result: "match" | "mismatch" | "unavailable" | "not_applicable"; readonly detail?: string }[];
  readonly anchoring: {
    readonly batchDigest: string;
    readonly timestamp: number | null;
    readonly result: "anchored" | "not_anchored" | "unavailable";
    /** The (unsigned) anchor the receipt's inclusion claims, if any. */
    readonly claimed: number | null;
  } | null;
  /** Steps whose evidence group is sealed: their anchors cannot be checked. */
  readonly sealedSteps: readonly string[];
  /** Custom-contract code pins at the receipt's block (only with `archiveRpcs`). */
  readonly codePins: readonly { readonly step: string; readonly address: string; readonly role: string; readonly result: SourceResult; readonly detail?: string }[];
  /** Provider status lookups (only with `providers: true`; never part of the verdict). */
  readonly providers: readonly { readonly step: string; readonly name: string; readonly trackingId: string; readonly result: "found" | "not_found" | "unavailable"; readonly status: string | null }[];
  /** At least one network had a single usable source. */
  readonly singleSource: boolean;
  readonly warnings: readonly ReceiptWarning[];
  readonly notes: readonly string[];
}

function chainNetwork(chain: string): NetworkKey | null {
  for (const descriptor of Object.values(CHAINS)) if (descriptor.id === chain) return descriptor.key;
  return null;
}

function anchorRef(anchor: ReceiptAnchor): string {
  return anchor.vm === "evm" ? anchor.tx : anchor.signature;
}

function failureDetail(error: unknown): string {
  if (isAnchorUnavailable(error)) return `${error.reason}: ${error.message}`.slice(0, 200);
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unavailable";
}

interface Source {
  readonly url: string;
  readonly display: string;
  readonly rpc: RpcTransport;
}

/** Decides one anchor from per-source results (receipts design §6.2.1 step 3). */
function decide(results: readonly SourceResult[], quorum: number): AnchorCheck["result"] {
  const matches = results.filter((result) => result === "match").length;
  const mismatches = results.filter((result) => result === "mismatch").length;
  if (matches > 0 && mismatches > 0) return "conflict";
  if (matches >= quorum) return "match";
  if (mismatches >= quorum) return "mismatch";
  return "unavailable";
}

const EVIDENCE_PATH = (step: string) => `steps.${step}.evidence`;

function evidenceOf(document: ReceiptDocument, step: string): EvidenceGroup | null {
  const disclosure = document.disclosures?.[EVIDENCE_PATH(step)];
  return disclosure ? (disclosure.value as EvidenceGroup) : null;
}

function readDocument(value: unknown): ReceiptDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { receipt?: unknown; payload?: unknown };
  const root = record.payload === undefined && typeof record.receipt === "object" && record.receipt !== null ? record.receipt : value;
  return typeof (root as { payload?: unknown }).payload === "object" ? (root as ReceiptDocument) : null;
}

async function finalizedHead(source: Source): Promise<bigint | null> {
  try {
    const block = await source.rpc("eth_getBlockByNumber", ["finalized", false]);
    const number = typeof block === "object" && block !== null ? (block as { number?: unknown }).number : undefined;
    return typeof number === "string" && /^0x[0-9a-f]+$/iu.test(number) ? BigInt(number) : null;
  } catch {
    return null;
  }
}

/**
 * Trustless re-verification (receipts design §6.2): runs `verifyReceipt`,
 * then re-reads every anchor of every disclosed evidence group from public
 * RPCs (`quorum` distinct sources must agree), checks finality, rebuilds the
 * EVM quote binding from the landed transactions and reads the log anchor on
 * Base. Read-only throughout.
 */
export async function reverifyReceipt(receipt: unknown, options: ReverifyOptions = {}): Promise<ReverifyReport> {
  const document = readDocument(receipt);
  const { keys, source: keySource, notes: keyNotes } = await resolveKeys(options);
  const offline = await verifyReceipt(document ?? receipt, verifyOptions(options, keys));
  const notes: string[] = [...keyNotes];
  const empty = { anchors: [], bindings: [], anchoring: null, sealedSteps: [], codePins: [], providers: [], singleSource: false } as const;
  if (!offline.valid || !document) {
    return { verdict: "mismatch", offline, keySource, ...empty, warnings: [...offline.warnings], notes };
  }
  const quorumWanted = options.quorum ?? 2;
  if (!Number.isInteger(quorumWanted) || quorumWanted < 1 || quorumWanted > 8) throw new RangeError("quorum must be an integer between 1 and 8.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gates = new Map<string, Gate>();
  const sourcesByNetwork = new Map<NetworkKey, Source[]>();
  const sourcesFor = (network: NetworkKey): Source[] => {
    const known = sourcesByNetwork.get(network);
    if (known) return known;
    const urls = [...new Set(options.rpcs?.[network] ?? DEFAULT_REVERIFY_RPCS[network] ?? [])];
    const list = urls.map((url) => {
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();
      const base = jsonRpcTransport(url, { timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      return { url, display: displayRpcUrl(url), rpc: runTransport(base, host, gates) };
    });
    sourcesByNetwork.set(network, list);
    return list;
  };

  const payload = document.payload;
  const sealedSteps = payload.steps.filter((step) => step.evidenceClass !== "none" && !evidenceOf(document, step.id)).map((step) => step.id);
  let singleSource = false;
  const anchors: AnchorCheck[] = [];
  const bindings: ReverifyReport["bindings"][number][] = [];
  const codePins: ReverifyReport["codePins"][number][] = [];
  /** The sources that matched each anchor, for bindings and code pins. */
  const matched = new Map<string, Source[]>();

  const checkAnchor = async (step: string, anchor: ReceiptAnchor): Promise<AnchorCheck> => {
    const network = chainNetwork(anchor.chain);
    const base = { step, ref: anchorRef(anchor), chain: anchor.chain, role: anchor.role };
    if (!network) return { ...base, result: "unavailable", mismatched: [], sources: [], finalized: null };
    const sources = sourcesFor(network);
    if (sources.length === 0) {
      notes.push(`No RPC endpoint is configured for ${network}; pass one with rpcs.${network}.`);
      return { ...base, result: "unavailable", mismatched: [], sources: [], finalized: null };
    }
    const quorum = Math.min(quorumWanted, sources.length);
    if (sources.length === 1) singleSource = true;
    const outcomes = await Promise.all(
      sources.map(async (source) => {
        try {
          const observed =
            anchor.vm === "evm"
              ? await readEvmAnchor(source.rpc, { chain: anchor.chain, tx: anchor.tx, role: anchor.role, watch: anchor.watch })
              : await readSvmAnchor(source.rpc, { chain: anchor.chain, signature: anchor.signature, role: anchor.role, watch: anchor.watch });
          const differs = compareAnchors(anchor, observed);
          return { source, result: (differs.length === 0 ? "match" : "mismatch") as SourceResult, differs, detail: differs.length > 0 ? `differs: ${differs.join(", ")}` : undefined };
        } catch (error) {
          return { source, result: "unavailable" as SourceResult, differs: [] as readonly string[], detail: failureDetail(error) };
        }
      }),
    );
    const usable = outcomes.filter((outcome) => outcome.result !== "unavailable").length;
    if (usable === 1) singleSource = true;
    let result = decide(outcomes.map((outcome) => outcome.result), quorum);
    const matching = outcomes.filter((outcome) => outcome.result === "match").map((outcome) => outcome.source);
    let finalized: boolean | null = null;
    if (result === "match") {
      matched.set(`${step}:${base.ref}`, matching);
      if (options.checkFinality !== false) {
        if (anchor.vm === "svm") finalized = true; // getTransaction was read at `finalized` commitment.
        else {
          const heads = await Promise.all(matching.map((source) => finalizedHead(source)));
          const block = BigInt(anchor.blockNumber);
          if (heads.some((head) => head !== null && head >= block)) finalized = true;
          else if (heads.every((head) => head !== null)) {
            finalized = false;
            result = "not_finalized";
          } else {
            result = "unavailable";
            notes.push(`${base.ref.slice(0, 12)}…: no matching source reported a finalized head.`);
          }
        }
      }
    }
    const mismatched = [...new Set(outcomes.flatMap((outcome) => outcome.differs))];
    return {
      ...base,
      result,
      mismatched,
      finalized,
      sources: outcomes.map((outcome) => ({ url: outcome.source.display, result: outcome.result, ...(outcome.detail ? { detail: outcome.detail } : {}) })),
    };
  };

  const steps = payload.steps.filter((step) => !sealedSteps.includes(step.id));
  await Promise.all(
    steps.map(async (step) => {
      const evidence = evidenceOf(document, step.id);
      if (!evidence) return;
      const checks = await Promise.all(evidence.anchors.map((anchor) => checkAnchor(step.id, anchor)));
      anchors.push(...checks);
      // Binding (§5.5.3): the landed EVM transactions must reproduce a binding Kletia prepared.
      const origins = evidence.anchors.filter((anchor) => anchor.role === "origin");
      if (evidence.landedBinding === null || origins.length === 0 || origins.some((anchor) => anchor.vm !== "evm")) {
        bindings.push({ step: step.id, result: "not_applicable" });
      } else if (!evidence.quotes.some((quote) => quote.binding === evidence.landedBinding)) {
        bindings.push({ step: step.id, result: "mismatch", detail: "landedBinding is not one of the prepared quotes" });
      } else if (origins.some((anchor) => checks.find((check) => check.ref === anchorRef(anchor))?.result !== "match")) {
        bindings.push({ step: step.id, result: "unavailable", detail: "the origin transactions were not confirmed by the quorum" });
      } else {
        try {
          const views: EvmBindingView[] = [];
          for (const anchor of origins) {
            if (anchor.vm !== "evm") throw new Error("not an EVM anchor");
            const source = matched.get(`${step.id}:${anchor.tx}`)?.[0];
            if (!source) throw new Error("no matching source");
            const view = await readEvmBindingView(source.rpc, { chain: anchor.chain, tx: anchor.tx });
            const data = hexToBytes(view.data);
            if (!data || sha256Hex(data) !== anchor.inputDigest) throw new Error("calldata does not match the anchor's inputDigest");
            views.push(view);
          }
          const binding = await evmQuoteBinding(views);
          bindings.push(binding === evidence.landedBinding ? { step: step.id, result: "match" } : { step: step.id, result: "mismatch", detail: "the landed transactions bind to another payload" });
        } catch (error) {
          bindings.push({ step: step.id, result: "unavailable", detail: failureDetail(error) });
        }
      }
      // Code pins at the receipt's block (archive endpoints only).
      const pins = evidence.contract?.pins as { codeHash?: unknown; proxy?: { implementation?: unknown; implementationCodeHash?: unknown } | null } | undefined;
      const network = chainNetwork(step.chain);
      const archive = network ? options.archiveRpcs?.[network] : undefined;
      const last = origins[origins.length - 1];
      if (archive && pins && typeof pins.codeHash === "string" && step.contract && last?.vm === "evm") {
        const rpc = jsonRpcTransport(archive, { timeoutMs, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        const block = `0x${BigInt(last.blockNumber).toString(16)}`;
        const targets: { address: string; role: string; hash: string }[] = [{ address: step.contract.target, role: "target", hash: pins.codeHash }];
        if (pins.proxy && typeof pins.proxy.implementation === "string" && typeof pins.proxy.implementationCodeHash === "string") {
          targets.push({ address: pins.proxy.implementation, role: "implementation", hash: pins.proxy.implementationCodeHash });
        }
        for (const target of targets) {
          try {
            const code = await rpc("eth_getCode", [target.address, block]);
            const bytes = typeof code === "string" ? hexToBytes(code) : null;
            if (!bytes || bytes.length === 0) throw new Error("no code at this block on the archive endpoint");
            const result: SourceResult = keccak256Hex(bytes).toLowerCase() === target.hash.toLowerCase() ? "match" : "mismatch";
            codePins.push({ step: step.id, address: target.address.toLowerCase(), role: target.role, result });
          } catch (error) {
            codePins.push({ step: step.id, address: target.address.toLowerCase(), role: target.role, result: "unavailable", detail: failureDetail(error) });
          }
        }
      }
    }),
  );
  anchors.sort((a, b) => (a.step === b.step ? 0 : a.step < b.step ? -1 : 1));
  bindings.sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));

  // Anchoring (§6.2.1 step 6): anyone can read EAS.getTimestamp(batchDigest) on Base.
  let anchoring: ReverifyReport["anchoring"] = null;
  if (document.inclusion && options.checkAnchoring !== false) {
    const batchDigest = receiptLogBatchDigest(document.inclusion.batch);
    const claimed = document.inclusion.anchor?.timestamp ?? null;
    const sources = sourcesFor("base");
    const answers = await Promise.all(
      sources.map(async (source) => {
        try {
          const raw = await source.rpc("eth_call", [{ to: EAS_BASE_ADDRESS, data: `${EAS_GET_TIMESTAMP}${batchDigest}` }, "latest"]);
          return typeof raw === "string" && /^0x[0-9a-f]{1,64}$/iu.test(raw) ? Number(BigInt(raw)) : null;
        } catch {
          return null;
        }
      }),
    );
    const values = [...new Set(answers.filter((value): value is number => value !== null))];
    const answered = answers.filter((value) => value !== null).length;
    const quorum = Math.min(quorumWanted, Math.max(1, sources.length));
    const timestamp = values.length === 1 && answered >= quorum ? (values[0] as number) : null;
    anchoring = {
      batchDigest,
      timestamp,
      result: timestamp === null ? "unavailable" : timestamp > 0 ? "anchored" : "not_anchored",
      claimed,
    };
    if (claimed !== null && timestamp !== null && timestamp !== claimed) notes.push(`The receipt's inclusion claims an anchor at ${claimed}; Base reports ${timestamp}.`);
  }

  const providers = options.providers ? await providerChecks(document, options, timeoutMs) : [];
  const warnings: ReceiptWarning[] = [...offline.warnings];
  if (singleSource) warnings.push({ code: "SINGLE_SOURCE", message: "Only one usable source answered for at least one network; pass more endpoints (rpcs) for an independent check." });
  const results = [...anchors.map((check) => check.result), ...bindings.map((check) => check.result), ...codePins.map((check) => check.result)];
  const verdict: ReverifyReport["verdict"] = results.includes("mismatch")
    ? "mismatch"
    : sealedSteps.length === 0 && anchors.every((check) => check.result === "match") && bindings.every((check) => check.result === "match" || check.result === "not_applicable") && codePins.every((check) => check.result === "match")
      ? "verified"
      : "inconclusive";
  if (sealedSteps.length > 0) notes.push(`Evidence is sealed for ${sealedSteps.join(", ")}: share the proof or full profile to re-check those steps.`);
  return { verdict, offline, keySource, anchors, bindings, anchoring, sealedSteps, codePins, providers, singleSource, warnings, notes };
}

/* ================================================================ providers */

const PROVIDER_STATUS: Readonly<Record<string, (trackingId: string, originTx: string | null) => string | null>> = {
  relay: (id) => (/^0x[0-9a-f]{64}$/iu.test(id) ? `https://api.relay.link/intents/status/v3?requestId=${id}` : null),
  lifi: (_id, originTx) => (originTx ? `https://li.quest/v1/status?txHash=${encodeURIComponent(originTx)}` : null),
  debridge: (id) => (/^0x[0-9a-f]{64}$/iu.test(id) ? `https://dln-api.debridge.finance/api/Orders/${id}` : null),
};

async function providerChecks(document: ReceiptDocument, options: ReverifyOptions, timeoutMs: number): Promise<ReverifyReport["providers"][number][]> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined)?.bind(globalThis);
  if (!fetchImpl) return [];
  const out: ReverifyReport["providers"][number][] = [];
  for (const step of document.payload.steps) {
    const evidence = evidenceOf(document, step.id);
    const provider = evidence?.provider;
    if (!evidence || !provider) continue;
    const origin = evidence.anchors.find((anchor) => anchor.role === "origin");
    const url = PROVIDER_STATUS[provider.name]?.(provider.trackingId, origin ? anchorRef(origin) : null) ?? null;
    if (!url) {
      out.push({ step: step.id, name: provider.name, trackingId: provider.trackingId, result: "unavailable", status: null });
      continue;
    }
    try {
      const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: anySignal([AbortSignal.timeout(timeoutMs), options.signal]) as AbortSignal });
      const text = await readLimited(response);
      if (response.status === 404) {
        out.push({ step: step.id, name: provider.name, trackingId: provider.trackingId, result: "not_found", status: null });
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = JSON.parse(text) as Record<string, unknown>;
      const status = [body.status, body.state, (body.orderStruct as Record<string, unknown> | undefined)?.status].find((value) => typeof value === "string") as string | undefined;
      const unknown = typeof status === "string" && /^(unknown|not_found)$/iu.test(status);
      out.push({ step: step.id, name: provider.name, trackingId: provider.trackingId, result: unknown ? "not_found" : "found", status: status ? status.slice(0, 40) : null });
    } catch {
      out.push({ step: step.id, name: provider.name, trackingId: provider.trackingId, result: "unavailable", status: null });
    }
  }
  return out;
}

/* ===================================================================== EAS */

/** Fields of the EAS offchain envelope (receipts design §7.3), as stored on receipts. */
interface EasEnvelopeLike {
  readonly signer: string;
  readonly sig: {
    readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
    readonly primaryType: string;
    readonly types: { readonly Attest: readonly { readonly name: string; readonly type: string }[] };
    readonly message: {
      readonly version: number;
      readonly schema: string;
      readonly recipient: string;
      readonly time: string;
      readonly expirationTime: string;
      readonly revocable: boolean;
      readonly refUID: string;
      readonly data: string;
      readonly salt: string;
    };
    readonly uid: string;
    readonly signature: { readonly r: string; readonly s: string; readonly v: number };
  };
}

export const EAS_RECEIPT_SCHEMA = "bytes32 receiptDigest,string spec,uint32 sequence";
const ATTEST_FIELDS: readonly (readonly [string, string])[] = [
  ["version", "uint16"],
  ["schema", "bytes32"],
  ["recipient", "address"],
  ["time", "uint64"],
  ["expirationTime", "uint64"],
  ["revocable", "bool"],
  ["refUID", "bytes32"],
  ["data", "bytes"],
  ["salt", "bytes32"],
];

/** The subset of viem the envelope check uses (optional peer, loaded on demand). */
interface Viem {
  keccak256(value: `0x${string}`): `0x${string}`;
  encodePacked(types: readonly string[], values: readonly unknown[]): `0x${string}`;
  stringToBytes(value: string): Uint8Array;
  toHex(value: Uint8Array): `0x${string}`;
  decodeAbiParameters(params: unknown, data: `0x${string}`): readonly unknown[];
  parseAbiParameters(params: string): unknown;
  verifyTypedData(input: Record<string, unknown>): Promise<boolean>;
}

async function loadViem(): Promise<Viem> {
  const specifier = "viem";
  try {
    return (await import(specifier)) as Viem;
  } catch {
    throw new Error("verifyEasEnvelope needs the optional dependency viem (>= 2.0): npm install viem");
  }
}

export interface EasVerification {
  readonly valid: boolean;
  readonly signer: string | null;
  readonly uid: string | null;
  /** The zero address unless the owner opted in to name their account. */
  readonly recipient: string | null;
  /** `getRevokeOffchain(signer, uid)` on Base when `checkRevocation` (null: not checked or unreadable). */
  readonly revoked: boolean | null;
  readonly problems: readonly string[];
}

/**
 * Verifies a receipt's optional EAS offchain attestation (receipts design
 * §7.3) fully offline: the domain (`EAS Attestation`, 1.0.1, Base, the EAS
 * predeploy), the Kletia schema UID, the attested digest, spec and sequence,
 * the offchain UID and the EIP-712 signature by `signer`. Needs `viem`.
 * `checkRevocation` adds one read-only `eth_call` on Base.
 */
export async function verifyEasEnvelope(
  receipt: unknown,
  options: { readonly checkRevocation?: boolean; readonly rpcs?: readonly string[]; readonly fetch?: FetchLike; readonly timeoutMs?: number } = {},
): Promise<EasVerification> {
  const document = readDocument(receipt);
  const envelope = (document?.attestations as { eas?: unknown } | undefined)?.eas as EasEnvelopeLike | undefined;
  const none = { valid: false, signer: null, uid: null, recipient: null, revoked: null } as const;
  if (!document || !envelope || typeof envelope !== "object") return { ...none, problems: ["The receipt carries no EAS envelope."] };
  const viem = await loadViem();
  const problems: string[] = [];
  try {
    const { sig } = envelope;
    const zero = "0x0000000000000000000000000000000000000000";
    const schemaUid = viem.keccak256(viem.encodePacked(["string", "address", "bool"], [EAS_RECEIPT_SCHEMA, zero, true]));
    if (sig.domain.name !== "EAS Attestation" || sig.domain.version !== "1.0.1" || sig.domain.chainId !== 8453 || sig.domain.verifyingContract.toLowerCase() !== EAS_BASE_ADDRESS) {
      problems.push("The envelope's EIP-712 domain is not EAS Attestation 1.0.1 on Base.");
    }
    if (sig.primaryType !== "Attest" || JSON.stringify(sig.types.Attest.map((field) => [field.name, field.type])) !== JSON.stringify(ATTEST_FIELDS)) problems.push("The envelope does not use the EAS Version 2 Attest type.");
    const message = sig.message;
    if (message.version !== 2 || message.schema.toLowerCase() !== schemaUid) problems.push("The envelope does not attest the Kletia receipt schema.");
    if (message.revocable !== true || message.expirationTime !== "0") problems.push("The envelope must be revocable and never expire.");
    if (!/^0x[0-9a-fA-F]{40}$/u.test(message.recipient)) problems.push("The envelope's recipient is not an address.");
    const [digest, spec, sequence] = viem.decodeAbiParameters(viem.parseAbiParameters("bytes32, string, uint32"), message.data as `0x${string}`);
    if (String(digest).toLowerCase() !== `0x${document.digest}` || spec !== document.payload.spec || Number(sequence) !== document.payload.sequence) {
      problems.push("The envelope attests another receipt (digest, spec or sequence differ).");
    }
    const time = BigInt(message.time);
    const uid = viem.keccak256(
      viem.encodePacked(
        ["uint16", "bytes", "address", "address", "uint64", "uint64", "bool", "bytes32", "bytes", "bytes32", "uint32"],
        [2, viem.toHex(viem.stringToBytes(message.schema)), message.recipient, zero, time, 0n, true, message.refUID, message.data, message.salt, 0],
      ),
    );
    if (uid !== sig.uid.toLowerCase()) problems.push("The envelope's UID does not match its message.");
    const signature = `${sig.signature.r}${sig.signature.s.slice(2)}${sig.signature.v.toString(16).padStart(2, "0")}` as `0x${string}`;
    const valid = await viem.verifyTypedData({
      address: envelope.signer,
      domain: { name: "EAS Attestation", version: "1.0.1", chainId: 8453, verifyingContract: EAS_BASE_ADDRESS },
      types: { Attest: ATTEST_FIELDS.map(([name, type]) => ({ name, type })) },
      primaryType: "Attest",
      message: { ...message, time, expirationTime: 0n },
      signature,
    });
    if (!valid) problems.push("The EIP-712 signature is not by the envelope's signer.");
    let revoked: boolean | null = null;
    if (options.checkRevocation) {
      const selector = keccak256Hex("getRevokeOffchain(address,bytes32)").slice(0, 10);
      const data = `${selector}${envelope.signer.slice(2).toLowerCase().padStart(64, "0")}${sig.uid.slice(2).toLowerCase()}`;
      for (const url of options.rpcs ?? DEFAULT_REVERIFY_RPCS.base ?? []) {
        try {
          const raw = await jsonRpcTransport(url, { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })("eth_call", [{ to: EAS_BASE_ADDRESS, data }, "latest"]);
          if (typeof raw === "string" && /^0x[0-9a-f]*$/iu.test(raw)) {
            revoked = raw !== "0x" && BigInt(raw) !== 0n;
            break;
          }
        } catch {
          // Try the next endpoint.
        }
      }
      if (revoked) problems.push("The attester revoked this envelope (getRevokeOffchain is non-zero).");
    }
    return { valid: problems.length === 0, signer: envelope.signer.toLowerCase(), uid: sig.uid.toLowerCase(), recipient: message.recipient.toLowerCase(), revoked, problems };
  } catch (error) {
    if (error instanceof KletiaApiError) throw error;
    return { ...none, problems: [...problems, `The envelope is malformed (${error instanceof Error ? error.message.slice(0, 120) : "unreadable"}).`] };
  }
}
