/**
 * "Copy as" snippets for an explorer request. Secrets never appear in a
 * snippet: the API key is always read from KLETIA_API_KEY.
 */
import type { CodeTab } from "../../../site/ui/CodeBlock";
import { IDEMPOTENCY_HEADER, resolveRequest, type ExplorerOperation } from "./operations";

export interface SnippetInput {
  readonly operation: ExplorerOperation;
  readonly origin: string;
  readonly values: Readonly<Record<string, string>>;
  /** Parsed body, or undefined when the operation sends none. */
  readonly body: unknown;
  /** Raw body text, used when it is not valid JSON. */
  readonly bodyText?: string;
  readonly withKey: boolean;
  readonly idempotencyKey: string | null;
  readonly accept: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function jsonText(input: SnippetInput, indent = 2): string | null {
  if (input.body === undefined) return input.bodyText ?? null;
  return JSON.stringify(input.body, null, indent);
}

export function curlSnippet(input: SnippetInput): string {
  const { operation } = input;
  const resolved = resolveRequest(operation, input.values);
  const url = `${input.origin}${resolved.pathAndQuery}`;
  const lines = [`curl -sS${operation.method === "GET" ? "" : ` -X ${operation.method}`} ${shellQuote(url)}`];
  if (input.accept !== "application/json") lines.push(`-H ${shellQuote(`accept: ${input.accept}`)}`);
  if (input.withKey) lines.push(`-H "authorization: Bearer $KLETIA_API_KEY"`);
  if (input.idempotencyKey) lines.push(`-H ${shellQuote(`${IDEMPOTENCY_HEADER.toLowerCase()}: ${input.idempotencyKey}`)}`);
  for (const [name, value] of resolved.headers) lines.push(`-H ${shellQuote(`${name.toLowerCase()}: ${value}`)}`);
  const body = jsonText(input);
  if (body !== null) {
    lines.push(`-H "content-type: application/json"`);
    lines.push(`-d ${shellQuote(body.split("\n").join("\n    "))}`);
  }
  if (operation.produces.includes("text/event-stream") && operation.method === "GET") lines.push("-N");
  return lines.join(" \\\n  ");
}

export function fetchSnippet(input: SnippetInput): string {
  const { operation } = input;
  const resolved = resolveRequest(operation, input.values);
  const headers: string[] = [];
  headers.push(`    accept: ${JSON.stringify(input.accept)},`);
  if (input.withKey) headers.push("    authorization: `Bearer ${process.env.KLETIA_API_KEY}`, // server-side only");
  if (input.idempotencyKey) headers.push(`    "idempotency-key": ${JSON.stringify(input.idempotencyKey)},`);
  for (const [name, value] of resolved.headers) headers.push(`    ${JSON.stringify(name.toLowerCase())}: ${JSON.stringify(value)},`);
  const body = jsonText(input);
  if (body !== null) headers.push(`    "content-type": "application/json",`);
  const lines = [
    `const response = await fetch(${JSON.stringify(`${input.origin}${resolved.pathAndQuery}`)}, {`,
    `  method: ${JSON.stringify(operation.method)},`,
    "  headers: {",
    ...headers,
    "  },",
  ];
  if (body !== null) {
    if (input.body === undefined) {
      lines.push(`  body: ${JSON.stringify(body)},`);
    } else {
      const indented = JSON.stringify(input.body, null, 2).split("\n").join("\n  ");
      lines.push(`  body: JSON.stringify(${indented}),`);
    }
  }
  lines.push("});");
  lines.push(`console.log(response.status, response.headers.get("x-request-id"));`);
  if (operation.produces.includes("text/event-stream") && operation.method === "GET") {
    lines.push("// A stream: read response.body incrementally, or use kletia.intents.stream() from @kletia/sdk.");
  } else if (operation.produces.length > 0) {
    lines.push(
      operation.produces.every((type) => type.includes("json"))
        ? "const data = await response.json();"
        : "const data = await response.text();",
    );
  }
  return lines.join("\n");
}

function literal(value: unknown, indent = 0): string {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  // Unquote safe object keys for idiomatic TypeScript.
  const unquoted = text.replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gmu, "$1$2:");
  return indent > 0 ? unquoted.split("\n").join(`\n${" ".repeat(indent)}`) : unquoted;
}

function argList(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/** The call expression for an operation, or null when the SDK has no helper. */
function sdkCall(input: SnippetInput): string | null {
  const { operation, values } = input;
  const value = (name: string) => (values[name] ?? "").trim();
  const options: string[] = [];
  if (input.idempotencyKey) options.push(`idempotencyKey: ${JSON.stringify(input.idempotencyKey)}`);
  const opts = (extra: string[] = []) => {
    const all = [...extra, ...options];
    return all.length > 0 ? `{ ${all.join(", ")} }` : "";
  };
  const withOpts = (args: string[], extra: string[] = []) => {
    const o = opts(extra);
    return [...args, ...(o ? [o] : [])].join(", ");
  };
  const body = input.body;
  switch (operation.id) {
    case "getHealth":
      return "kletia.health()";
    case "listNetworks":
      return "kletia.networks()";
    case "listProtocols":
      return "kletia.protocols()";
    case "listAssets":
      return `kletia.assets(${value("network") ? JSON.stringify(value("network")) : ""})`;
    case "listVenues": {
      const filter = ["network", "protocol"].filter((name) => value(name)).map((name) => `${name}: ${JSON.stringify(value(name))}`);
      return `kletia.venues(${filter.length > 0 ? `{ ${filter.join(", ")} }` : ""})`;
    }
    case "quoteRoutes":
      return `kletia.quote(${literal(body ?? {})})`;
    case "getPortfolio":
      return `kletia.portfolio(${JSON.stringify(value("accountId"))})`;
    case "createIntent": {
      const dryRun = ["true", "1"].includes(value("dryRun")) ? ["dryRun: true"] : [];
      return `kletia.intents.create(${withOpts([literal(body ?? {})], dryRun)})`;
    }
    case "listIntents":
      return `kletia.intents.list(${value("limit") || ""})`;
    case "getIntent":
      return `kletia.intents.get(${argList([value("id")])})`;
    case "prepareStep":
      return `kletia.intents.prepareStep(${argList([value("id"), value("stepId")])})`;
    case "submitStep": {
      const references = (body as { references?: unknown } | undefined)?.references ?? [];
      return `kletia.intents.submitStep(${withOpts([argList([value("id"), value("stepId")]), literal(references)])})`;
    }
    case "refreshIntent":
      return `kletia.intents.refresh(${argList([value("id")])})`;
    case "cancelIntent":
      return `kletia.intents.cancel(${withOpts([argList([value("id")])])})`;
    case "streamIntentEvents": {
      const resume = value("Last-Event-ID") || value("since");
      return `kletia.intents.stream(${argList([value("id")])}, (event) => {\n  console.log(event.type, event.data);\n}${resume ? `, { lastEventId: ${JSON.stringify(resume)} }` : ""})`;
    }
    case "createWebhook":
      return `kletia.webhooks.create(${withOpts([literal(body ?? {})])})`;
    case "listWebhooks":
      return "kletia.webhooks.list()";
    case "deleteWebhook":
      return `kletia.webhooks.delete(${argList([value("id")])})`;
    case "testWebhook":
      return `kletia.webhooks.test(${argList([value("id")])})`;
    case "listWebhookDeliveries":
      return `kletia.webhooks.deliveries(${withOpts([argList([value("id")])], value("limit") ? [`limit: ${value("limit")}`] : [])})`;
    case "createApiKey": {
      const name = (body as { name?: unknown } | undefined)?.name;
      return `kletia.keys.create(${withOpts([JSON.stringify(typeof name === "string" ? name : "")])})`;
    }
    case "listApiKeys":
      return "kletia.keys.list()";
    case "rotateApiKey": {
      const grace = (body as { graceSeconds?: unknown } | undefined)?.graceSeconds;
      return `kletia.keys.rotate(${withOpts([argList([value("id")])], typeof grace === "number" ? [`graceSeconds: ${grace}`] : [])})`;
    }
    case "revokeApiKey":
      return `kletia.keys.revoke(${argList([value("id")])})`;
    case "getUsage":
      return `kletia.usage(${value("window") ? `{ window: ${JSON.stringify(value("window"))} }` : ""})`;
    case "listErrors":
      return "kletia.errors()";
    case "getOpenApi":
      return "kletia.openApi()";
    default:
      return null;
  }
}

export function sdkSnippet(input: SnippetInput): string {
  const call = sdkCall(input);
  const keyed = input.withKey || input.operation.auth === "key";
  const client = keyed
    ? "// Server-side only: never ship a kl_dev_ key to the browser.\nconst kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });"
    : "const kletia = new KletiaClient(); // public tier";
  if (call === null) {
    if (input.operation.id === "mcp") {
      return [
        "// MCP has no SDK helper: connect an MCP client to /v1/mcp (see the MCP recipe),",
        "// or send raw JSON-RPC with the fetch snippet.",
        "",
        "// Claude Code:",
        `// claude mcp add --transport http kletia ${input.origin}/v1/mcp`,
      ].join("\n");
    }
    const resolved = resolveRequest(input.operation, input.values);
    return [
      'import { KletiaClient } from "@kletia/sdk";',
      "",
      client,
      "",
      "// No typed helper for this operation; the low-level request parses JSON responses.",
      `const data = await kletia.request(${JSON.stringify(input.operation.method === "DELETE" ? "DELETE" : input.operation.method)}, ${JSON.stringify(resolved.pathAndQuery.replace(/^\/v1/u, ""))});`,
    ].join("\n");
  }
  const isVoid = ["deleteWebhook", "revokeApiKey"].includes(input.operation.id);
  const isStream = input.operation.id === "streamIntentEvents";
  return [
    'import { KletiaClient } from "@kletia/sdk";',
    "",
    client,
    "",
    isVoid || isStream ? `await ${call};` : `const result = await ${call};`,
    ...(isVoid || isStream ? [] : ["console.log(result);"]),
  ].join("\n");
}

/** The three "copy as" tabs. */
export function snippetTabs(input: SnippetInput): CodeTab[] {
  return [
    { id: "curl", label: "curl", language: "bash", code: curlSnippet(input), filename: "terminal" },
    { id: "fetch", label: "fetch", language: "ts", code: fetchSnippet(input), filename: "request.ts" },
    { id: "sdk", label: "SDK", language: "ts", code: sdkSnippet(input), filename: "kletia.ts" },
  ];
}
