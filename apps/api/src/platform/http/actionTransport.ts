/**
 * SSRF-guarded HTTPS client for the integrator URLs Kletia fetches itself:
 * Solana Action endpoints (the engine's `ActionTransport`) and the domain
 * verification file `https://<website>/.well-known/kletia.json`.
 *
 * Same outbound policy as webhooks (netguard.ts): HTTPS only, no credentials,
 * public DNS names, and every socket lookup re-checks that the host resolves
 * only to public addresses (DNS rebinding is refused at connect time).
 * Additionally: redirects are never followed (a 3xx is returned as-is and
 * the engine treats it as unavailable), no cookies are sent or kept, the
 * response body is capped (64 KB for actions, 16 KB for the domain file) and
 * every request has a hard timeout (8 s).
 */
import https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { isIP } from "node:net";
import { CHAINS, CONTRACT_LIMITS, KLETIA_WELL_KNOWN_PATH, domainFileListsContract, normalizeWebOrigin } from "@kletia/core";
import { PlatformError } from "../errors.js";
import type { ActionTransport } from "../index.js";
import { guardedLookup, isPublicAddress, parseWebhookUrl } from "./netguard.js";

export const ACTION_USER_AGENT = "Kletia-Actions/1.0 (+https://kletiaai.xyz)";
/** Solana Actions spec version Kletia speaks. */
export const ACTION_ACCEPT_VERSION = "2.4";

export interface GuardedResponse {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Record<string, string>;
  /** Parsed JSON body; `undefined` when the body is empty or not JSON. */
  readonly json: unknown;
}

export interface GuardedRequest {
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/**
 * Opens one request. Production: `https.request` with the guarded lookup and
 * no agent (no connection reuse, no cookies). Tests substitute a connector
 * that talks to a local server.
 */
export type Connector = (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

const httpsConnector: Connector = (url, options, onResponse) =>
  https.request(url, { ...options, lookup: guardedLookup, agent: false }, onResponse);

let connector: Connector = httpsConnector;

/** Replaces the connector (tests); `null` restores HTTPS with the guarded lookup. */
export function configureActionConnector(custom: Connector | null): void {
  connector = custom ?? httpsConnector;
}

function unavailable(message: string): PlatformError {
  return new PlatformError("ACTION_ENDPOINT_UNAVAILABLE", message, 502);
}

function forbiddenAddress(): PlatformError {
  return new PlatformError("ACTION_URL_FORBIDDEN", "The action host resolves to a private, loopback, link-local or otherwise non-public address.", 422);
}

function headerRecord(response: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || name === "set-cookie") continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One guarded request. Throws ACTION_URL_FORBIDDEN (422) for URLs or hosts
 * the policy refuses and ACTION_ENDPOINT_UNAVAILABLE (502) for timeouts,
 * connection failures and oversized bodies; any HTTP status is returned.
 */
export async function guardedJsonRequest(rawUrl: string, request: GuardedRequest): Promise<GuardedResponse> {
  const url = parseWebhookUrl(rawUrl, { kind: "action" });
  const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
  if (isIP(host) && !isPublicAddress(host)) throw forbiddenAddress();
  const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": ACTION_USER_AGENT,
    ...(request.headers ?? {}),
    ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
  };
  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error: PlatformError | null, value?: GuardedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    let outgoing: ClientRequest;
    try {
      outgoing = connector(url, { method: request.method, headers, timeout: request.timeoutMs }, (response) => {
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > request.maxBytes) {
          response.destroy();
          finish(unavailable(`The endpoint sent more than ${request.maxBytes} bytes.`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > request.maxBytes) {
            response.destroy();
            outgoing.destroy();
            finish(unavailable(`The endpoint sent more than ${request.maxBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          finish(null, {
            status: response.statusCode ?? 0,
            headers: headerRecord(response),
            json: parseJson(Buffer.concat(chunks).toString("utf8")),
          });
        });
        response.on("error", () => finish(unavailable("The endpoint's response was interrupted.")));
      });
    } catch {
      finish(unavailable("The endpoint could not be reached."));
      return;
    }
    timer = setTimeout(() => {
      outgoing.destroy();
      finish(unavailable(`The endpoint did not answer within ${Math.round(request.timeoutMs / 1000)} s.`));
    }, request.timeoutMs);
    outgoing.on("timeout", () => {
      outgoing.destroy();
      finish(unavailable(`The endpoint did not answer within ${Math.round(request.timeoutMs / 1000)} s.`));
    });
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "EWEBHOOKFORBIDDEN" ? forbiddenAddress() : unavailable("The endpoint could not be reached."));
    });
    outgoing.end(payload);
  });
}

/** CAIP-2 ids of the Solana networks, sent as X-Accept-Blockchain-Ids. */
const SOLANA_CHAIN_IDS = [CHAINS.solana.id, CHAINS["solana-devnet"].id].join(",");

const ACTION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-accept-action-version": ACTION_ACCEPT_VERSION,
  "x-accept-blockchain-ids": SOLANA_CHAIN_IDS,
});

/** The engine's `ActionTransport`: 8 s, 64 KB, no redirects, no cookies, public hosts only. */
export function createActionTransport(): ActionTransport {
  const options = { maxBytes: CONTRACT_LIMITS.actionResponseBytes, timeoutMs: CONTRACT_LIMITS.actionTimeoutMs, headers: ACTION_HEADERS };
  return {
    get: (url) => guardedJsonRequest(url, { method: "GET", ...options }),
    post: (url, body) => guardedJsonRequest(url, { method: "POST", body, ...options }),
  };
}

/**
 * Domain verification: true when `https://<website host>/.well-known/kletia.json`
 * (16 KB cap, no redirects, public hosts only) lists `contractId` in
 * `{ "contracts": [...] }`. Never throws: anything else is "not verified".
 */
export async function domainListsContract(website: string | undefined, contractId: string): Promise<boolean> {
  const origin = website ? normalizeWebOrigin(website, { allowPort: true }) : null;
  if (!origin) return false;
  try {
    const response = await guardedJsonRequest(`${origin}${KLETIA_WELL_KNOWN_PATH}`, {
      method: "GET",
      maxBytes: CONTRACT_LIMITS.domainFileBytes,
      timeoutMs: CONTRACT_LIMITS.actionTimeoutMs,
    });
    return response.status === 200 && domainFileListsContract(response.json, contractId);
  } catch {
    return false;
  }
}
