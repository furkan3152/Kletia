#!/usr/bin/env node
// Generates a Postman Collection v2.1 for Platform API v1 from
// docs/platform/openapi.json (written by tooling/export-openapi.mjs):
//
//   node tooling/generate-collections.mjs           # write docs/platform/collections/
//   node tooling/generate-collections.mjs --check   # fail when the committed collection is stale
//
// Zero dependencies and deterministic (stable ids, no faker values), so the
// committed file only changes when the API contract does. Postman, Insomnia,
// Bruno and Hoppscotch all import Postman v2.1 collections.
//
// Layout: one folder per OpenAPI tag, one request per operation (plus named
// variants for operations with several useful bodies). Bearer auth with
// {{apiKey}} is set once on the collection; an empty apiKey sends no
// Authorization header, which is the public tier. Path ids are collection
// variables ({{intentId}}, {{webhookId}}, ...).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const input = resolve(root, "docs/platform/openapi.json");
const outputDirectory = resolve(root, "docs/platform/collections");
const output = resolve(outputDirectory, "kletia-platform-api.postman_collection.json");
const check = process.argv.includes("--check");
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const DOCS = "https://github.com/furkan3152/Kletia/blob/main/docs/platform";

// Demo accounts: dry runs and reads only, never funded or signed with.
const EVM_ACCOUNT = "eip155:8453:0x000000000000000000000000000000000000dEaD";
const SOLANA_ACCOUNT = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Collection variables; path parameters map onto them. */
const VARIABLES = [
  ["baseUrl", null, "API origin without a trailing slash. Use http://localhost:3001 for a local or self-hosted API."],
  ["apiKey", "", "Developer key (kl_dev_…) for keyed calls. Leave empty for the public tier. Keep keys in a Postman environment or vault, never in a shared collection."],
  ["intentId", "", "An intent id: plan one without dryRun (a stored intent), or list your intents."],
  ["stepId", "s1", "A step id from the intent's graph (s1, s2, ...)."],
  ["webhookId", "", "A webhook id from registering or listing webhooks."],
  ["keyId", "", "An API key id from issuing or listing keys."],
  ["accountId", SOLANA_ACCOUNT, "A CAIP-10 account for the portfolio request."],
  ["transactionReference", "", "Transaction hash (EVM) or signature (Solana) of a prepared step, for Submit."],
];

/** Request bodies and query values that make a useful first call, keyed by operationId. */
const CURATED = {
  quoteRoutes: [
    {
      label: "bridge auction",
      body: { from: { network: "base", asset: "USDC", amount: "25" }, to: { network: "arbitrum", asset: "USDC" }, slippageBps: 50, maxSeconds: 600 },
    },
    { label: "same-network swap", body: { network: "solana", from: "SOL", to: "USDC", amount: "1" } },
  ],
  createIntent: [
    {
      label: "dry run, natural language",
      query: { dryRun: "true" },
      body: { text: "bridge 25 USDC from base to solana then swap half to JitoSOL", accounts: [EVM_ACCOUNT, SOLANA_ACCOUNT], constraints: { maxSlippageBps: 50 } },
    },
    {
      label: "dry run, structured actions",
      query: { dryRun: "true" },
      body: {
        actions: [
          { kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "solana", to: "USDC" },
          { kind: "swap", network: "solana", from: "USDC", to: "JitoSOL", amount: "max" },
        ],
        accounts: [EVM_ACCOUNT, SOLANA_ACCOUNT],
      },
    },
    {
      label: "dry run, lending venue",
      query: { dryRun: "true" },
      body: { actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "100", params: { venue: "base:aave-v3:usdc" } }], accounts: [EVM_ACCOUNT] },
    },
  ],
  submitStep: [{ body: { references: ["{{transactionReference}}"] } }],
  createWebhook: [{ body: { url: "https://example.com/kletia/webhooks", events: ["intent.status_changed", "intent.step_updated"] } }],
  createApiKey: [{ body: { name: "my-server" } }],
  rotateApiKey: [{ body: { graceSeconds: 86400 } }],
  mcp: [
    { label: "tools/list", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } },
    {
      label: "plan_intent",
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "plan_intent", arguments: { text: "swap 1 SOL to USDC", accounts: [SOLANA_ACCOUNT] } } },
    },
    {
      label: "create_signing_link",
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_signing_link", arguments: { text: "swap 1 SOL to USDC" } } },
    },
  ],
  listAssets: [{ query: { network: "base" } }],
  listVenues: [{ query: { network: "base" } }],
  listIntents: [{ query: { limit: "5" } }],
  getUsage: [{ query: { window: "24h" } }],
  getStatusBadge: [{ query: { format: "shields" } }],
};

/** Extra request headers some operations need. */
const ACCEPT = { mcp: "application/json, text/event-stream", streamIntentEvents: "text/event-stream" };

/** Stable RFC 4122 version 5 style id from a name, so re-imports update in place. */
function stableId(name) {
  const hex = createHash("sha1").update(`kletia-postman:${name}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function generate(document) {
  const resolvePointer = (pointer) =>
    pointer
      .slice(2)
      .split("/")
      .reduce((node, key) => node?.[key.replace(/~1/gu, "/").replace(/~0/gu, "~")], document);
  const deref = (value, depth = 0) =>
    value && typeof value.$ref === "string" && depth < 16 ? deref(resolvePointer(value.$ref), depth + 1) : value;

  /** Deterministic example from a schema: explicit examples first, then required fields only. */
  const exampleFor = (raw, depth = 0) => {
    const schema = deref(raw);
    if (!schema || depth > 8) return null;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
    for (const key of ["oneOf", "anyOf"]) if (Array.isArray(schema[key]) && schema[key].length > 0) return exampleFor(schema[key][0], depth + 1);
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === "object" || schema.properties) {
      const out = {};
      const required = new Set(schema.required ?? []);
      for (const name of Object.keys(schema.properties ?? {})) {
        if (required.has(name)) out[name] = exampleFor(schema.properties[name], depth + 1);
      }
      return out;
    }
    if (type === "array") return [exampleFor(schema.items, depth + 1)];
    if (type === "integer" || type === "number") return schema.minimum ?? 0;
    if (type === "boolean") return false;
    if (type === "string") return schema.format === "uri" ? "https://example.com" : "";
    return null;
  };

  const variableFor = (path, name) => {
    if (name === "stepId") return "stepId";
    if (name === "accountId") return "accountId";
    const segments = path.split("/");
    const owner = segments[segments.indexOf(`{${name}}`) - 1] ?? "";
    const singular = { intents: "intent", webhooks: "webhook", keys: "key" }[owner];
    return singular ? `${singular}Id` : name;
  };
  const known = new Set(VARIABLES.map(([key]) => key));

  const describeAuth = (operation) => {
    const security = operation.security ?? document.security ?? [];
    const anonymous = security.length === 0 || security.some((requirement) => Object.keys(requirement).length === 0);
    return anonymous ? { anonymous: true, note: "Works without a key (public tier); a key raises the rate limit." } : { anonymous: false, note: "Requires an API key (set `apiKey`)." };
  };

  const folders = new Map((document.tags ?? []).map((tag) => [tag.name, { name: tag.name, description: tag.description ?? "", item: [] }]));
  const usedVariables = new Set(["baseUrl", "apiKey"]);
  const curatedSeen = new Set();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const shared = (pathItem.parameters ?? []).map((parameter) => deref(parameter));
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const operationId = operation.operationId;
      const parameters = [...shared, ...(operation.parameters ?? []).map((parameter) => deref(parameter))].filter(Boolean);
      const auth = describeAuth(operation);
      const variants = CURATED[operationId] ?? [{}];
      curatedSeen.add(operationId);

      variants.forEach((variant, index) => {
        const pathVariables = [];
        const urlPath = path
          .split("/")
          .filter(Boolean)
          .map((segment) => {
            const match = /^\{(.+)\}$/u.exec(segment);
            if (!match) return segment;
            const parameter = parameters.find((candidate) => candidate.in === "path" && candidate.name === match[1]);
            const variable = variableFor(path, match[1]);
            if (!known.has(variable)) throw new Error(`${operationId}: no collection variable for path parameter {${match[1]}}`);
            usedVariables.add(variable);
            pathVariables.push({ key: match[1], value: `{{${variable}}}`, ...(parameter?.description ? { description: parameter.description } : {}) });
            return `:${match[1]}`;
          });

        const query = parameters
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => {
            const curated = variant.query?.[parameter.name];
            const schema = deref(parameter.schema) ?? {};
            const fallback = schema.default ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined) ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
            return {
              key: parameter.name,
              value: String(curated ?? fallback ?? ""),
              ...(parameter.description ? { description: parameter.description } : {}),
              ...(curated === undefined && parameter.required !== true ? { disabled: true } : {}),
            };
          });

        const header = [];
        const accept = ACCEPT[operationId];
        if (accept) header.push({ key: "Accept", value: accept });
        const requestBody = deref(operation.requestBody);
        const media = requestBody?.content?.["application/json"];
        let body;
        if (media) {
          header.push({ key: "Content-Type", value: "application/json" });
          const value = variant.body ?? exampleFor(media.schema);
          const raw = JSON.stringify(value, null, 2);
          for (const [, name] of raw.matchAll(/\{\{([A-Za-z]+)\}\}/gu)) {
            if (!known.has(name)) throw new Error(`${operationId}: body uses unknown variable {{${name}}}`);
            usedVariables.add(name);
          }
          body = { mode: "raw", raw, options: { raw: { language: "json" } } };
        }
        for (const parameter of parameters.filter((candidate) => candidate.in === "header")) {
          if (parameter.name === "Idempotency-Key") {
            header.push({
              key: parameter.name,
              value: "{{$guid}}",
              description: "Replays the first response for a retry with the same key. Needs an API key; {{$guid}} makes a new key per send, so set a fixed value to test a replay.",
              ...(auth.anonymous ? { disabled: true } : {}),
            });
          } else {
            header.push({ key: parameter.name, value: "", ...(parameter.description ? { description: parameter.description } : {}), disabled: true });
          }
        }

        const enabledQuery = query.filter((item) => !item.disabled);
        const raw = `{{baseUrl}}/${urlPath.join("/")}${enabledQuery.length > 0 ? `?${enabledQuery.map((item) => `${item.key}=${item.value}`).join("&")}` : ""}`;
        const description = [
          operation.description ?? "",
          auth.note,
          `\`${method.toUpperCase()} ${path}\` · operationId \`${operationId}\` · [Platform API v1](${DOCS}/api-v1.md)`,
        ]
          .filter(Boolean)
          .join("\n\n");

        const name = variant.label ? `${operation.summary}: ${variant.label}` : operation.summary;
        const request = {
          method: method.toUpperCase(),
          header,
          ...(body ? { body } : {}),
          url: {
            raw,
            host: ["{{baseUrl}}"],
            path: urlPath,
            ...(query.length > 0 ? { query } : {}),
            ...(pathVariables.length > 0 ? { variable: pathVariables } : {}),
          },
          description,
        };
        const tag = operation.tags?.[0] ?? "Other";
        if (!folders.has(tag)) folders.set(tag, { name: tag, description: "", item: [] });
        folders.get(tag).item.push({ id: stableId(`${operationId}:${index}`), name, request, response: [] });
      });
    }
  }

  const stale = Object.keys(CURATED).filter((operationId) => !curatedSeen.has(operationId));
  if (stale.length > 0) throw new Error(`Curated examples name operations the document no longer has: ${stale.join(", ")}`);

  const servers = document.servers ?? [];
  const production = servers[0]?.url ?? "https://api.kletiaai.xyz";
  const variable = VARIABLES.filter(([key]) => usedVariables.has(key)).map(([key, value, description]) => ({
    key,
    value: key === "baseUrl" ? production : value,
    type: "string",
    description,
  }));

  const webhookNames = Object.values(document.webhooks ?? {}).map((item) => item.post?.summary).filter(Boolean);
  const description = [
    document.info.description ?? "",
    "## Using this collection",
    `- \`baseUrl\` is ${servers.map((server) => `\`${server.url}\` (${server.description ?? "server"})`).join(" or ")}.`,
    "- Public endpoints work with an empty `apiKey`. Issue a key with `POST /v1/keys` (Keys folder), then store it in an environment or vault variable named `apiKey`; never share a collection that contains a key.",
    "- The `POST /v1/intents` requests plan with `dryRun=true`: nothing is stored and nothing is signed. Kletia never holds keys; signing happens in the user's wallet.",
    "- Ids such as `intentId`, `webhookId` and `keyId` are collection variables. Copy them from responses.",
    webhookNames.length > 0
      ? `- Webhook deliveries (${webhookNames.join(", ")}) are requests Kletia sends to you; see the OpenAPI \`webhooks\` section and [webhook verification](${DOCS}/api-v1.md).`
      : "",
    `Generated from \`docs/platform/openapi.json\` (OpenAPI ${document.openapi}, API ${document.info.version}) by \`tooling/generate-collections.mjs\`. Do not edit by hand.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    info: {
      _postman_id: stableId(`collection:${document.info.title}`),
      name: document.info.title,
      description,
      version: document.info.version,
      schema: POSTMAN_SCHEMA,
    },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{apiKey}}", type: "string" }] },
    variable,
    item: [...folders.values()]
      .filter((folder) => folder.item.length > 0)
      .map((folder) => ({
        id: stableId(`folder:${folder.name}`),
        name: folder.name,
        description: folder.description,
        // Deletes run last, so "Run folder" exercises a resource before removing it.
        item: [...folder.item].sort((a, b) => Number(a.request.method === "DELETE") - Number(b.request.method === "DELETE")),
      })),
  };
}

if (!existsSync(input)) {
  console.error(`${relative(root, input)} is missing; run node tooling/export-openapi.mjs first.`);
  process.exit(1);
}
const document = JSON.parse(readFileSync(input, "utf8"));
const collection = generate(document);
const json = `${JSON.stringify(collection, null, 2)}\n`;
const requests = collection.item.reduce((total, folder) => total + folder.item.length, 0);
const target = relative(root, output);
const summary = `${collection.item.length} folders, ${requests} requests`;

if (!check) {
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(output, json);
  console.log(`Wrote ${target} (${summary}).`);
} else if (existsSync(output) && readFileSync(output, "utf8") === json) {
  console.log(`${target} is up to date (${summary}).`);
} else {
  console.error(`${target} is out of date with docs/platform/openapi.json. Run \`npm run generate:openapi\` and commit the result.`);
  process.exitCode = 1;
}
