/**
 * `createKletiaProxy`: the one supported way for a browser to reach Kletia
 * through your server (integrator design 4.6). Your page points the SDK or
 * widget at `baseUrl: "/api/kletia"`; the proxy adds your API key and
 * forwards only what a visitor's browser needs.
 *
 * - Allowlist (`allow: "browser"`, the default): registry and quote reads,
 *   `POST /v1/intents` (dry runs and previews too), intent reads, events
 *   (Server-Sent Events, streamed through), journey, stop, preview,
 *   prepare/submit/refresh/cancel, receipt reads and shares, public session
 *   and link routes. Everything else (keys, webhooks, contracts, rule books,
 *   projects, usage, listing intents, Kletia-held threads) answers
 *   `403 PROXY_ROUTE_FORBIDDEN` here, without reaching Kletia.
 * - The browser's `Authorization`, `X-Kletia-Key`, `Cookie` and `Origin`
 *   (and every other header outside a short allowlist) are dropped; the key
 *   is added server-side. `X-Request-Id` passes through.
 * - Bodies are capped (`maxBodyBytes`, default 64 KB: 413); redirects are
 *   never followed (502).
 *
 * Fetch API only (no `node:` imports): it runs on Node 20+, Bun, Deno, edge
 * runtimes and Workers. `expressKletiaProxy` adapts it to Express and plain
 * `node:http`.
 */

/** One allowed route: a method and a `/v1`-relative path pattern with `:param` segments (`/intents/:id`). */
export interface ProxyRule {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
}

export interface KletiaProxyOptions {
  /** Your server key (`kl_dev_…` or `kl_agt_…`). Never sent to the browser. */
  readonly apiKey: string;
  /** Kletia API origin (default https://api.kletiaai.xyz). */
  readonly baseUrl?: string;
  /** Path prefix the proxy is mounted at, e.g. `/api/kletia` (browser `baseUrl`). */
  readonly mount: string;
  /** `browser` (default) or your own rules; a rule list replaces the browser list. */
  readonly allow?: "browser" | readonly ProxyRule[];
  /** Largest request body forwarded (default 65,536 bytes). */
  readonly maxBodyBytes?: number;
  /** Custom fetch (tests, runtimes without a global fetch). */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export const DEFAULT_PROXY_MAX_BODY_BYTES = 65_536;
const DEFAULT_API_ORIGIN = "https://api.kletiaai.xyz";

/** What a visitor's browser needs (and nothing that manages your account). */
export const BROWSER_PROXY_RULES: readonly ProxyRule[] = Object.freeze([
  { method: "GET", path: "/health" },
  { method: "GET", path: "/networks" },
  { method: "GET", path: "/protocols" },
  { method: "GET", path: "/assets" },
  { method: "GET", path: "/venues" },
  { method: "GET", path: "/errors" },
  { method: "GET", path: "/portfolio" },
  { method: "GET", path: "/portfolio/:account" },
  { method: "POST", path: "/quotes" },
  { method: "POST", path: "/intents" },
  { method: "GET", path: "/intents/:id" },
  { method: "GET", path: "/intents/:id/events" },
  { method: "GET", path: "/intents/:id/journey" },
  { method: "POST", path: "/intents/:id/stop" },
  { method: "GET", path: "/intents/:id/preview" },
  { method: "POST", path: "/intents/:id/preview" },
  { method: "POST", path: "/intents/:id/steps/:step/prepare" },
  { method: "POST", path: "/intents/:id/steps/:step/submit" },
  { method: "POST", path: "/intents/:id/refresh" },
  { method: "POST", path: "/intents/:id/cancel" },
  { method: "GET", path: "/intents/:id/receipt" },
  { method: "GET", path: "/intents/:id/receipts" },
  { method: "GET", path: "/intents/:id/receipt/shares" },
  { method: "POST", path: "/intents/:id/receipt/shares" },
  { method: "GET", path: "/receipts/keys" },
  { method: "GET", path: "/receipts/:receipt" },
  { method: "GET", path: "/receipts/:receipt/status" },
  { method: "GET", path: "/receipts/:receipt/shares/:share" },
  { method: "GET", path: "/sessions/:id" },
  { method: "POST", path: "/sessions/:id/intents" },
  { method: "GET", path: "/links/:id" },
  { method: "POST", path: "/links/:id/quote" },
  { method: "POST", path: "/links/:id/intents" },
  { method: "GET", path: "/links/:id/card.png" },
] as const);

/** Request headers forwarded from the browser; everything else (Authorization, Cookie, Origin, …) is dropped. */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "last-event-id", "x-request-id", "x-kletia-sdk", "x-kletia-client"] as const;
/** Response headers passed back (never Set-Cookie or Location). */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "x-request-id",
  "retry-after",
  "ratelimit",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit-policy",
  "idempotent-replayed",
  "deprecation",
  "sunset",
] as const;

/** A path segment the rules may match: no dot segments, no encoded separators. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/u;

interface CompiledRule {
  readonly method: string;
  readonly pattern: RegExp;
}

function compileRules(allow: KletiaProxyOptions["allow"]): readonly CompiledRule[] {
  const rules = allow === undefined || allow === "browser" ? BROWSER_PROXY_RULES : allow;
  if (!Array.isArray(rules)) throw new TypeError('allow must be "browser" or a list of { method, path } rules.');
  return rules.map((rule) => {
    if (!rule || typeof rule.path !== "string" || !rule.path.startsWith("/") || typeof rule.method !== "string") {
      throw new TypeError("Each proxy rule is { method, path } with a path such as /intents/:id.");
    }
    const source = rule.path
      .replace(/\/+$/u, "")
      .split("/")
      .map((segment: string) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
      .join("/");
    return { method: rule.method.toUpperCase(), pattern: new RegExp(`^${source}$`, "u") };
  });
}

function normalizeMount(mount: string): string {
  if (typeof mount !== "string" || !mount.startsWith("/")) throw new TypeError("mount must be a path such as /api/kletia.");
  return mount.replace(/\/+$/u, "");
}

function normalizeOrigin(value: string | undefined): string {
  const url = new URL(value ?? DEFAULT_API_ORIGIN);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TypeError("baseUrl must use HTTPS (HTTP only for localhost).");
  return url.origin + url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function errorResponse(status: number, code: string, message: string, requestId: string | null): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(requestId ? { "x-request-id": requestId } : {}) },
  });
}

/**
 * The `/v1`-relative path of a request under `mount`, or null when it is not
 * a clean Kletia path (outside the mount, dot segments, encoded slashes).
 */
function upstreamPath(pathname: string, mount: string): string | null {
  if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return null;
  const rest = pathname.slice(mount.length);
  if (!rest.startsWith("/v1/")) return null;
  const path = rest.slice(3);
  const segments = path.split("/").slice(1);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment) || /%(?:2f|5c|2e)/iu.test(segment)) return null;
  }
  return path;
}

async function readCapped(request: Request, limit: number): Promise<Uint8Array | "too-large"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return "too-large";
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Clarify turns that would keep a thread under your key (`remember`,
 * `threadId`) are server-side only: visitors would otherwise share one
 * key's thread store.
 */
function heldThreadTurn(method: string, path: string, body: Uint8Array): boolean {
  if (method !== "POST" || path !== "/intents" || body.byteLength === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const turn = parsed as { remember?: unknown; threadId?: unknown };
  return turn.remember !== undefined || turn.threadId !== undefined;
}

/** A fetch handler: `(request) => response`, for Next.js route handlers, Hono, Workers, Bun and Deno. */
export function createKletiaProxy(options: KletiaProxyOptions): (request: Request) => Promise<Response> {
  if (typeof options?.apiKey !== "string" || !/^kl_(?:dev|agt|op)_/u.test(options.apiKey)) {
    throw new TypeError("createKletiaProxy needs your server key (kl_dev_… or kl_agt_…) in apiKey.");
  }
  const mount = normalizeMount(options.mount);
  const origin = normalizeOrigin(options.baseUrl);
  const rules = compileRules(options.allow);
  const limit = options.maxBodyBytes ?? DEFAULT_PROXY_MAX_BODY_BYTES;
  if (!Number.isInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024) throw new RangeError("maxBodyBytes must be an integer between 0 and 16 MB.");
  const fallback = (globalThis as { fetch?: KletiaProxyOptions["fetch"] }).fetch;
  const fetchImpl = options.fetch ?? (fallback ? fallback.bind(globalThis) : undefined);
  if (!fetchImpl) throw new Error("No fetch implementation available; pass options.fetch.");
  const apiKey = options.apiKey;

  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id");
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = upstreamPath(url.pathname, mount);
    if (path === null || !rules.some((rule) => rule.method === method && rule.pattern.test(path))) {
      return errorResponse(403, "PROXY_ROUTE_FORBIDDEN", `${method} ${path ? `/v1${path}` : url.pathname} is not forwarded by this proxy: call it from your server.`, requestId);
    }
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "DELETE") {
      const read = await readCapped(request, limit);
      if (read === "too-large") return errorResponse(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${limit} bytes here.`, requestId);
      body = read;
      if (heldThreadTurn(method, path, read)) {
        return errorResponse(403, "PROXY_ROUTE_FORBIDDEN", "Kletia-held threads (remember, threadId) are kept for your server key only: hold the thread in the browser instead.", requestId);
      }
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    headers.authorization = `Bearer ${apiKey}`;
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${origin}/v1${path}${url.search}`, {
        method,
        headers,
        redirect: "manual",
        signal: request.signal,
        ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
      });
    } catch {
      return errorResponse(502, "PROVIDER_UNAVAILABLE", "Kletia could not be reached from this server.", requestId);
    }
    // Never follow (or hand the browser) a redirect.
    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      await upstream.body?.cancel().catch(() => undefined);
      return errorResponse(502, "PROVIDER_UNAVAILABLE", "Kletia answered with a redirect; the proxy does not follow redirects.", requestId);
    }
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if ((upstream.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
      // Streamed through as it arrives (proxies in front of this one should not buffer it).
      out.set("cache-control", "no-cache");
      out.set("x-accel-buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

/* ----------------------------------------------------------- Express / node:http */

/** The parts of a Node / Express request the proxy reads. */
export interface NodeProxyRequest {
  readonly method?: string;
  /** Express: the path including the mount (`req.originalUrl`). */
  readonly originalUrl?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** A raw body from `express.raw()` (Buffer) or a string; parsed JSON bodies are refused. */
  readonly body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/** The parts of a Node / Express response the proxy writes. */
export interface NodeProxyResponse {
  statusCode: number;
  readonly headersSent?: boolean;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array): unknown;
  end(chunk?: string): unknown;
  flushHeaders?(): void;
  readonly writableEnded?: boolean;
  on?(event: "close", listener: () => void): unknown;
}

const encoder = new TextEncoder();

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : undefined;
}

/**
 * Express and plain `node:http` adapter. Mount it before any JSON body
 * parser (or with `express.raw({ type: "*\/*" })`):
 *
 * ```js
 * app.use("/api/kletia", expressKletiaProxy({ apiKey: process.env.KLETIA_API_KEY, mount: "/api/kletia" }));
 * ```
 */
export function expressKletiaProxy(
  options: KletiaProxyOptions,
): (request: NodeProxyRequest, response: NodeProxyResponse, next?: (error?: unknown) => void) => Promise<void> {
  const handler = createKletiaProxy(options);
  return async (request, response, next) => {
    // A response closed before it was finished means the browser went away: stop the upstream call too.
    // (The request's own "close" fires once its body is read, so it is not a signal of that.)
    const controller = new AbortController();
    response.on?.("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      const host = headerValue(request.headers.host) ?? "localhost";
      const target = new URL(request.originalUrl ?? request.url ?? "/", `http://${host.replace(/[^A-Za-z0-9.:[\]-]/gu, "") || "localhost"}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        const text = headerValue(value);
        if (text !== undefined && !name.startsWith(":")) headers.set(name, text);
      }
      const method = (request.method ?? "GET").toUpperCase();
      let body: Uint8Array | undefined;
      if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
        if (request.body instanceof Uint8Array) body = request.body;
        else if (typeof request.body === "string") body = encoder.encode(request.body);
        else if (request.body !== undefined && request.body !== null && !(typeof request.body === "object" && Object.keys(request.body as object).length === 0)) {
          // A JSON parser already consumed the raw body: forwarding a re-serialized copy is not supported.
          throw new Error("expressKletiaProxy needs the raw body: mount it before express.json() or use express.raw().");
        } else {
          const limit = (options.maxBodyBytes ?? DEFAULT_PROXY_MAX_BODY_BYTES) + 1;
          const iterate = request[Symbol.asyncIterator];
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (iterate) {
            const iterator = iterate.call(request);
            for (;;) {
              const { value, done } = await iterator.next();
              if (done) break;
              const chunk = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : null;
              if (!chunk) continue;
              size += chunk.byteLength;
              chunks.push(chunk);
              // One byte over the cap is enough for the handler to answer 413.
              if (size >= limit) break;
            }
          }
          body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk.subarray(0, Math.min(chunk.byteLength, size - offset)), offset);
            offset += chunk.byteLength;
          }
        }
      }
      const proxied = await handler(
        new Request(target, {
          method,
          headers,
          signal: controller.signal,
          ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
        }),
      );
      response.statusCode = proxied.status;
      proxied.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      if (!proxied.body) {
        response.end();
        return;
      }
      response.flushHeaders?.();
      const reader = proxied.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          response.write(value);
        }
      } catch {
        // The browser went away or Kletia closed the stream: end the response.
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      response.end();
    } catch (error) {
      if (next) {
        next(error);
        return;
      }
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Proxy error." } }));
      } else response.end();
    }
  };
}
