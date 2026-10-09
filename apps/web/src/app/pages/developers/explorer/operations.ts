/**
 * Explorer operation model, built from GET /v1/openapi.json (or the static
 * fallback in staticOperations.ts when the API is unreachable).
 */
import { PREVIEW_ACCOUNTS } from "../../../../shared/platform/previewAccounts";
import { derefSchema, exampleFor, isRecord, resolveRef, type JsonSchema, type OpenApiDoc } from "./schema";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ParamLocation = "path" | "query" | "header";

export interface ExplorerParam {
  readonly name: string;
  readonly in: ParamLocation;
  readonly required: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface BodyExample {
  readonly label: string;
  readonly value: unknown;
}

export interface ExplorerBody {
  readonly required: boolean;
  readonly schema: JsonSchema;
  readonly examples: readonly BodyExample[];
}

export interface ExplorerOperation {
  /** operationId (stable; used for deep links: #op-<id>). */
  readonly id: string;
  readonly method: HttpMethod;
  /** Full path including /v1, with {placeholders}. */
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** "key": an API key is required; "public": optional. */
  readonly auth: "public" | "key";
  /** Path, query and header parameters, except Idempotency-Key. */
  readonly params: readonly ExplorerParam[];
  /** Honours the Idempotency-Key header. */
  readonly idempotent: boolean;
  readonly body: ExplorerBody | null;
  /** Success content types, used for the Accept header. */
  readonly produces: readonly string[];
  /** Response headers documented on success. */
  readonly responseHeaders: readonly string[];
}

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export const TAG_ORDER: readonly string[] = [
  "System",
  "Registry",
  "Quotes",
  "Portfolio",
  "Intents",
  "Events",
  "Webhooks",
  "Keys",
  "Usage",
  "MCP",
];

const EVM_ACCOUNT = PREVIEW_ACCOUNTS.evm;
const SOLANA_ACCOUNT = PREVIEW_ACCOUNTS.solana;

/**
 * Curated request bodies per operation: the first one is the default. They
 * use the read-only preview accounts, so a dry run never touches real funds.
 */
export const CURATED_BODIES: Readonly<Record<string, readonly BodyExample[]>> = {
  createIntent: [
    {
      label: "Natural language",
      value: {
        text: "bridge 25 USDC from base to solana then swap half to JitoSOL",
        accounts: [EVM_ACCOUNT, SOLANA_ACCOUNT],
        constraints: { maxSlippageBps: 50 },
      },
    },
    {
      label: "Structured actions",
      value: {
        actions: [
          { kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "solana", to: "USDC" },
          { kind: "swap", network: "solana", from: "USDC", to: "JitoSOL", amount: "max" },
        ],
        accounts: [EVM_ACCOUNT, SOLANA_ACCOUNT],
      },
    },
    {
      label: "Deposit into a venue",
      value: {
        actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "100", params: { venue: "base:aave-v3:usdc" } }],
        accounts: [EVM_ACCOUNT],
      },
    },
  ],
  quoteRoutes: [
    {
      label: "Bridge auction",
      value: {
        from: { network: "base", asset: "USDC", amount: "25" },
        to: { network: "arbitrum", asset: "USDC" },
        slippageBps: 50,
        maxSeconds: 600,
      },
    },
    { label: "Same-network swap", value: { network: "solana", from: "SOL", to: "USDC", amount: "1" } },
  ],
  submitStep: [{ label: "References", value: { references: [`0x${"0".repeat(64)}`] } }],
  createWebhook: [
    {
      label: "Status and steps",
      value: { url: "https://example.com/kletia/webhooks", events: ["intent.status_changed", "intent.step_updated"] },
    },
  ],
  createApiKey: [{ label: "Name", value: { name: "acme-staging" } }],
  rotateApiKey: [
    { label: "24 h grace", value: { graceSeconds: 86400 } },
    { label: "End the old secret now", value: { graceSeconds: 0 } },
  ],
  mcp: [
    { label: "tools/list", value: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    {
      label: "plan_intent",
      value: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "plan_intent", arguments: { text: "swap 1 SOL to USDC", accounts: [SOLANA_ACCOUNT] } },
      },
    },
    {
      label: "create_signing_link",
      value: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "create_signing_link", arguments: { text: "swap 1 SOL to USDC" } },
      },
    },
  ],
};

/** Default parameter values per operation (safe choices: dry runs, small limits). */
export const CURATED_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  createIntent: { dryRun: "true" },
  listAssets: { network: "base" },
  listVenues: { network: "base" },
  getPortfolio: { accountId: SOLANA_ACCOUNT },
  listIntents: { limit: "5" },
  listWebhookDeliveries: { limit: "20" },
  getUsage: { window: "24h" },
  getStatusBadge: { format: "shields" },
};

function operationAuth(operation: Record<string, unknown>): "public" | "key" {
  const security = operation.security;
  if (!Array.isArray(security)) return "public";
  // `[{}]` or a list that contains `{}` means anonymous access is allowed.
  if (security.some((entry) => isRecord(entry) && Object.keys(entry).length === 0)) return "public";
  return security.length > 0 ? "key" : "public";
}

function successResponses(doc: OpenApiDoc, operation: Record<string, unknown>): Record<string, unknown>[] {
  const responses = isRecord(operation.responses) ? operation.responses : {};
  return Object.entries(responses)
    .filter(([status]) => status.startsWith("2"))
    .map(([, response]) => resolveRef<Record<string, unknown>>(doc, response))
    .filter((response): response is Record<string, unknown> => response !== null);
}

function bodyFor(doc: OpenApiDoc, operation: Record<string, unknown>, id: string): ExplorerBody | null {
  const requestBody = resolveRef<Record<string, unknown>>(doc, operation.requestBody);
  if (!requestBody) return null;
  const content = isRecord(requestBody.content) ? requestBody.content : {};
  const media = isRecord(content["application/json"]) ? content["application/json"] : null;
  if (!media) return null;
  const schema = derefSchema(doc, media.schema);
  const curated = CURATED_BODIES[id];
  const examples: BodyExample[] = curated
    ? [...curated]
    : [{ label: "From schema", value: exampleFor(schema) }];
  return { required: requestBody.required === true, schema, examples };
}

/** Builds the explorer model from an OpenAPI 3.1 document. Unknown shapes are skipped, never thrown on. */
export function operationsFromOpenApi(doc: OpenApiDoc): ExplorerOperation[] {
  const out: ExplorerOperation[] = [];
  for (const [rawPath, rawItem] of Object.entries(doc.paths ?? {})) {
    if (!isRecord(rawItem)) continue;
    const shared = Array.isArray(rawItem.parameters) ? rawItem.parameters : [];
    for (const method of METHODS) {
      const operation = rawItem[method.toLowerCase()];
      if (!isRecord(operation)) continue;
      const id =
        typeof operation.operationId === "string" && operation.operationId
          ? operation.operationId
          : `${method.toLowerCase()}${rawPath.replace(/[^A-Za-z0-9]+/gu, "_")}`;
      const path = rawPath.startsWith("/v1") ? rawPath : `/v1${rawPath}`;
      const params: ExplorerParam[] = [];
      let idempotent = false;
      const declared = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      for (const raw of declared) {
        const param = resolveRef<Record<string, unknown>>(doc, raw);
        if (!param || typeof param.name !== "string") continue;
        const location = param.in;
        if (location !== "path" && location !== "query" && location !== "header") continue;
        if (location === "header" && param.name.toLowerCase() === IDEMPOTENCY_HEADER.toLowerCase()) {
          idempotent = true;
          continue;
        }
        const existing = params.findIndex((item) => item.name === param.name && item.in === location);
        const next: ExplorerParam = {
          name: param.name,
          in: location,
          required: location === "path" || param.required === true,
          ...(typeof param.description === "string" ? { description: param.description } : {}),
          schema: derefSchema(doc, param.schema),
        };
        if (existing >= 0) params[existing] = next;
        else params.push(next);
      }
      const responses = successResponses(doc, operation);
      const produces = [
        ...new Set(responses.flatMap((response) => (isRecord(response.content) ? Object.keys(response.content) : []))),
      ];
      const responseHeaders = [
        ...new Set(responses.flatMap((response) => (isRecord(response.headers) ? Object.keys(response.headers) : []))),
      ];
      const tags = Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [];
      out.push({
        id,
        method,
        path,
        tag: tags[0] ?? "Other",
        summary: typeof operation.summary === "string" ? operation.summary : id,
        ...(typeof operation.description === "string" ? { description: operation.description } : {}),
        auth: operationAuth(operation),
        params,
        idempotent,
        body: bodyFor(doc, operation, id),
        produces,
        responseHeaders,
      });
    }
  }
  return out;
}

export interface OperationGroup {
  readonly tag: string;
  readonly operations: readonly ExplorerOperation[];
}

/** Groups operations by tag in the documented order (unknown tags last, in first-seen order). */
export function groupOperations(operations: readonly ExplorerOperation[]): OperationGroup[] {
  const order = [...TAG_ORDER];
  for (const operation of operations) if (!order.includes(operation.tag)) order.push(operation.tag);
  return order
    .map((tag) => ({ tag, operations: operations.filter((operation) => operation.tag === tag) }))
    .filter((group) => group.operations.length > 0);
}

/** Initial parameter values: curated defaults, then documented defaults for required params. */
export function defaultParamValues(operation: ExplorerOperation): Record<string, string> {
  const curated = CURATED_PARAMS[operation.id] ?? {};
  const values: Record<string, string> = {};
  for (const param of operation.params) {
    const preset = curated[param.name];
    if (preset !== undefined) values[param.name] = preset;
    else if (param.required && param.schema.default !== undefined) values[param.name] = String(param.schema.default);
    else values[param.name] = "";
  }
  return values;
}

export interface ResolvedRequest {
  /** Path and query, e.g. `/v1/intents?dryRun=true`. */
  readonly pathAndQuery: string;
  readonly headers: readonly (readonly [string, string])[];
  /** Path parameters that are still empty. */
  readonly missing: readonly string[];
}

/** Fills path placeholders, appends non-empty query params and collects header params. */
export function resolveRequest(operation: ExplorerOperation, values: Readonly<Record<string, string>>): ResolvedRequest {
  const missing: string[] = [];
  let path = operation.path;
  for (const param of operation.params) {
    if (param.in !== "path") continue;
    const value = (values[param.name] ?? "").trim();
    if (!value) missing.push(param.name);
    path = path.replace(`{${param.name}}`, value ? encodeURIComponent(value) : `{${param.name}}`);
  }
  const query = new URLSearchParams();
  for (const param of operation.params) {
    if (param.in !== "query") continue;
    const value = (values[param.name] ?? "").trim();
    if (value) query.set(param.name, value);
  }
  const headers: (readonly [string, string])[] = [];
  for (const param of operation.params) {
    if (param.in !== "header") continue;
    const value = (values[param.name] ?? "").trim();
    if (value) headers.push([param.name, value]);
  }
  const search = query.toString();
  return { pathAndQuery: search ? `${path}?${search}` : path, headers, missing };
}

/** The Accept header for an operation: every success content type it documents. */
export function acceptHeader(operation: ExplorerOperation): string {
  return operation.produces.length > 0 ? operation.produces.join(", ") : "application/json";
}

/** Prefix of ids an `{id}` path parameter takes, by resource. */
export function idPrefixFor(operation: ExplorerOperation, paramName: string): string | null {
  if (paramName === "stepId") return null;
  if (paramName !== "id") return null;
  if (operation.path.startsWith("/v1/intents/")) return "int_";
  if (operation.path.startsWith("/v1/webhooks/")) return "wh_";
  if (operation.path.startsWith("/v1/keys/")) return "key_";
  return null;
}

const ID_PATTERNS: readonly { readonly prefix: string; readonly pattern: RegExp }[] = [
  { prefix: "int_", pattern: /^int_[0-9a-f]{32}$/u },
  { prefix: "wh_", pattern: /^wh_[0-9a-f]{24}$/u },
  { prefix: "key_", pattern: /^key_[0-9a-f]{24}$/u },
];

export interface CollectedIds {
  readonly ids: Readonly<Record<string, readonly string[]>>;
  /** Step ids of the most recent intent seen, newest intent first. */
  readonly stepIds: readonly string[];
}

/**
 * Collects resource ids from a response body (intent, webhook and key ids,
 * plus the step ids of an intent) so path parameters can offer them.
 */
export function collectIds(body: unknown, previous: CollectedIds | null = null): CollectedIds {
  const ids: Record<string, string[]> = {};
  for (const { prefix } of ID_PATTERNS) ids[prefix] = [...(previous?.ids[prefix] ?? [])];
  let stepIds = previous?.stepIds ?? [];
  let visited = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || visited > 4000) return;
    visited += 1;
    if (typeof node === "string") {
      for (const { prefix, pattern } of ID_PATTERNS) {
        if (pattern.test(node)) ids[prefix] = [node, ...ids[prefix]!.filter((id) => id !== node)].slice(0, 5);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 100)) walk(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.id === "string" && /^int_/u.test(node.id) && Array.isArray(node.steps)) {
      const steps = node.steps.map((step) => (isRecord(step) && typeof step.id === "string" ? step.id : null)).filter(
        (id): id is string => id !== null,
      );
      if (steps.length > 0) stepIds = steps;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(body, 0);
  return { ids, stepIds };
}
