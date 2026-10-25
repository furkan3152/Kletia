/**
 * Webhook, key, usage, contract, session and system paths, and the
 * complete path map.
 */
import { CONTRACT_LIMITS, KLETIA_WELL_KNOWN_PATH } from "@kletia/core";
import { clarifyPaths } from "../clarifyOpenapi.js";
import {
  MAX_DELIVERIES_PER_WEBHOOK,
  MEMORY_DELIVERIES_PER_WEBHOOK,
  TEST_DELIVERIES_PER_MINUTE,
} from "../deliveries.js";
import {
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ACTIVE_KEYS_PER_PROJECT,
  MAX_ROTATION_GRACE_SECONDS,
} from "../keys.js";
import {
  CONTRACT_TESTS_PER_MINUTE,
  CONTRACT_WRITES_PER_HOUR,
  KEY_ISSUANCE_LIMIT_PER_HOUR,
} from "../limits.js";
import { HANDOFF_MAX_TEXT } from "../mcp/handoff.js";
import { journeyPaths } from "../journeyOpenapi.js";
import { previewPaths } from "../previewOpenapi.js";
import { receiptPaths } from "../receipts/openapi.js";
import { keyPatchOperation, policyPaths } from "../policies/openapi.js";
import { linkPaths } from "../links/openapi.js";
import { assistantPaths } from "../assistantOpenapi.js";
import { dataPaths } from "../dataOpenapi.js";
import { projectPaths } from "../projects/openapi.js";
import { accountPaths } from "../accounts/openapi.js";
import { automationPaths } from "../../automation/openapi.js";
import { orderPaths } from "../orders/openapi.js";
import { perpsPaths } from "../perps/openapi.js";
import { predictionPaths } from "../predictions/openapi.js";
import { agentPaths } from "../agents/openapi.js";
import { KLETIA_TOOLS } from "../mcp/tools.js";
import { MAX_WEBHOOKS_PER_KEY } from "../webhooks.js";
import {
  contractIdParam,
  errors,
  EVM_ADDRESS,
  IDEMPOTENCY_NOTE,
  idempotencyKeyParam,
  int,
  jsonBody,
  type JsonObject,
  KEY_REQUIRED,
  keyIdParam,
  mcpErrorResponse,
  ok,
  ref,
  REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  sessionIdParam,
  str,
  webhookIdParam,
} from "./helpers.js";
import { intentPaths } from "./intentPaths.js";

/** Webhooks, API keys and usage. */
function webhookKeyPaths(): JsonObject {
  return {
    "/v1/webhooks": {
      post: {
        operationId: "createWebhook",
        tags: ["Webhooks"],
        summary: "Register a webhook (secret returned once)",
        description: `At most ${MAX_WEBHOOKS_PER_KEY} webhooks per key. Deliveries are signed with \`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>\`; verify with verifyWebhookSignature from @kletia/core.${IDEMPOTENCY_NOTE} The stored response (with the secret) is encrypted at rest.`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("WebhookCreateRequest"),
        responses: { "201": ok("WebhookResponse", "Webhook with its signing secret.", REPLAYED_HEADER), ...errors("409", "413", "415", "422") },
      },
      get: {
        operationId: "listWebhooks",
        tags: ["Webhooks"],
        summary: "List webhooks",
        security: KEY_REQUIRED,
        responses: { "200": ok("WebhookListResponse", "Webhooks (without secrets)."), ...errors() },
      },
    },
    "/v1/webhooks/{id}": {
      delete: {
        operationId: "deleteWebhook",
        tags: ["Webhooks"],
        summary: "Delete a webhook (and its delivery log)",
        security: KEY_REQUIRED,
        parameters: [webhookIdParam],
        responses: { "204": { description: "Deleted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("404") },
      },
    },
    "/v1/webhooks/{id}/test": {
      post: {
        operationId: "testWebhook",
        tags: ["Webhooks"],
        summary: "Send a signed webhook.test event now",
        description: `Makes one synchronous delivery attempt of a \`webhook.test\` event (see the webhookTest webhook) with the same signing, network rules, 5 s timeout and no-redirect policy as real deliveries, records it in the delivery log and returns the outcome. Always 200 when the attempt was made, whatever the endpoint answered. Test deliveries never pause a webhook. At most ${TEST_DELIVERIES_PER_MINUTE} per minute per webhook.`,
        security: KEY_REQUIRED,
        parameters: [webhookIdParam],
        responses: { "200": ok("WebhookDeliveryResponse", "The delivery attempt."), ...errors("404") },
      },
    },
    "/v1/webhooks/{id}/deliveries": {
      get: {
        operationId: "listWebhookDeliveries",
        tags: ["Webhooks"],
        summary: "Delivery log of a webhook",
        description: `Every attempt, drop and test delivery, newest first. Payloads and error text are never stored. Kept for 7 days (at most ${MAX_DELIVERIES_PER_WEBHOOK} per webhook; ${MEMORY_DELIVERIES_PER_WEBHOOK} with in-memory storage).`,
        security: KEY_REQUIRED,
        parameters: [webhookIdParam, { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) }],
        responses: { "200": ok("WebhookDeliveryListResponse", "Deliveries, newest first."), ...errors("404") },
      },
    },
    "/v1/keys": {
      post: {
        operationId: "createApiKey",
        tags: ["Keys"],
        summary: "Issue a developer key",
        description: `The key is shown once and stored only as a SHA-256 hash. Without a key this starts a new project; with a developer key the new key joins the caller's project (at most ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys, else 409 KEY_LIMIT_REACHED). Limited to ${KEY_ISSUANCE_LIMIT_PER_HOUR} keys per hour per IP; a request refused with a 4xx (an invalid body, a key limit) does not count. \`sandbox: true\` issues a key kept on the testnet lane by its own rule book. Body: \`{ "name": "acme-dev", "sandbox": true }\`.${IDEMPOTENCY_NOTE} The stored response is encrypted at rest.`,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("ApiKeyCreateRequest"),
        responses: { "201": ok("ApiKeyResponse", "The new key.", REPLAYED_HEADER), ...errors("403", "409", "413", "415", "422") },
      },
      get: {
        operationId: "listApiKeys",
        tags: ["Keys"],
        summary: "List the keys of the caller's project",
        description: "Never returns secrets, only `last4`. Operator keys cannot be listed (409 KEY_NOT_MANAGEABLE); a secret inside its rotation grace window cannot manage keys (403 KEY_SECRET_ROTATED).",
        security: KEY_REQUIRED,
        responses: { "200": ok("ApiKeyListResponse", "The project's keys."), ...errors("403", "409") },
      },
    },
    "/v1/keys/{id}/rotate": {
      post: {
        operationId: "rotateApiKey",
        tags: ["Keys"],
        summary: "Replace a key's secret (same id)",
        description: `Issues a new secret for an active key of the caller's project. The key id is unchanged, so intents, webhooks and usage stay attached. The previous secret keeps authenticating for \`graceSeconds\` (default ${DEFAULT_ROTATION_GRACE_SECONDS / 3600} h, at most ${MAX_ROTATION_GRACE_SECONDS / 86_400} days, 0 = stop now) but cannot manage keys; rotating again ends an earlier grace window. Other instances notice within 15 s.${IDEMPOTENCY_NOTE} The stored response is encrypted at rest and replayed only to the current secret or to the secret that made the request (a key that rotated itself can retry with its old secret during the grace window); any other rotated-out secret gets 403 KEY_SECRET_ROTATED.`,
        security: KEY_REQUIRED,
        parameters: [keyIdParam, idempotencyKeyParam],
        requestBody: { ...jsonBody("ApiKeyRotateRequest", false) },
        responses: { "200": ok("RotatedApiKeyResponse", "The key with its new secret.", REPLAYED_HEADER), ...errors("403", "404", "409", "413", "415", "422") },
      },
    },
    "/v1/keys/{id}": {
      delete: {
        operationId: "revokeApiKey",
        tags: ["Keys"],
        summary: "Revoke a key of the caller's project",
        description: "Idempotent. The key and every agent key below it (its subtree) stop authenticating at once on the answering instance and within 15 s everywhere (`key.revoked` lists the cascade). A key may revoke itself. Its webhooks and their delivery logs are deleted and its intents' events are no longer delivered; repeating the call finishes a cleanup that failed (503).",
        security: KEY_REQUIRED,
        parameters: [keyIdParam],
        responses: { "204": { description: "Revoked.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("403", "404", "409") },
      },
      patch: keyPatchOperation(),
    },
    "/v1/usage": {
      get: {
        operationId: "getUsage",
        tags: ["Usage"],
        summary: "Requests, status classes and intents of the caller's key",
        description: "Counts every request made with the key, by hour, route and status class (flushed every 30 s), plus the live rate-limit window of the answering instance and the intents the key created in the window.",
        security: KEY_REQUIRED,
        parameters: [
          { name: "window", in: "query", required: false, schema: str({ enum: ["24h", "7d"], default: "24h" }) },
          { name: "scope", in: "query", required: false, description: "`subtree`: add per-key attribution of the caller's subtree (project keys: every key of the project).", schema: str({ enum: ["self", "subtree"], default: "self" }) },
        ],
        responses: { "200": ok("UsageReport", "Usage report."), ...errors() },
      },
    },
  };
}

/** Contracts and sessions. */
function contractSessionPaths(): JsonObject {
  return {
    "/v1/contracts": {
      post: {
        operationId: "registerContract",
        tags: ["Contracts"],
        summary: "Register a custom contract (EVM) or Solana Actions endpoint",
        description:
          `Validates the definition (the same rules as validateContractDefinition in @kletia/core: forbidden functions, argument and event bindings, reserved names, deny lists), pins the code identity on-chain (code hash, proxy implementation; Solana program data, deploy slot, upgrade authority), records source (Sourcify) / program (OtterSec) verification and, for Solana, each action's metadata. Mainnet registrations stay \`pending\` for the activation delay (default ${CONTRACT_LIMITS.defaultActivationDelaySeconds / 60} minutes; testnets activate at once) and send \`contract.registered\` then \`contract.activated\` webhooks; integrator names that use a reserved brand also wait for domain verification. At most ${CONTRACT_LIMITS.registrationsPerKey} registrations per key; registrations, updates and reverifications share ${CONTRACT_WRITES_PER_HOUR} per hour per key. A rotated-out secret cannot register (403 KEY_SECRET_ROTATED).${IDEMPOTENCY_NOTE}`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("ContractDefinition"),
        responses: {
          "201": ok("ContractResponse", "The registration (status pending or active).", REPLAYED_HEADER),
          ...errors("403", "409", "413", "415", "422", "502", "504"),
        },
      },
      get: {
        operationId: "listContracts",
        tags: ["Contracts"],
        summary: "List the caller's registrations and its project's visible ones",
        security: KEY_REQUIRED,
        parameters: [
          { name: "network", in: "query", required: false, schema: str({ maxLength: 128 }) },
          { name: "vm", in: "query", required: false, schema: ref("ContractVm") },
          { name: "status", in: "query", required: false, schema: str({ enum: ["pending", "active", "suspended"] }) },
        ],
        responses: { "200": ok("ContractListResponse", "Registrations, oldest first."), ...errors() },
      },
    },
    "/v1/contracts/inspect": {
      get: {
        operationId: "inspectContract",
        tags: ["Contracts"],
        summary: "What registering an address or programs would pin and allow",
        description: `EVM (\`network\` + \`address\`): deployment, EIP-7702 delegation, deny-list reason, pins with proxy detection, Sourcify status and ABI, every function marked allowed or forbidden with the reason, and \`hints.erc4626\` (\`asset()\` read once, with its registry symbol) when the ABI is an ERC-4626 vault. Solana (\`network\` + \`programs\`, comma separated): program pins, deny-list reasons and OtterSec status. Nothing is stored. Shares ${CONTRACT_TESTS_PER_MINUTE} calls per minute per key with the test endpoint.`,
        security: KEY_REQUIRED,
        parameters: [
          { name: "network", in: "query", required: true, schema: str({ maxLength: 128 }) },
          { name: "address", in: "query", required: false, schema: str({ pattern: EVM_ADDRESS }) },
          { name: "programs", in: "query", required: false, schema: str({ maxLength: 400 }) },
        ],
        responses: { "200": ok("ContractInspectionResponse", "Inspection."), ...errors("422", "502", "504") },
      },
    },
    "/v1/contracts/{id}": {
      get: {
        operationId: "getContract",
        tags: ["Contracts"],
        summary: "Read a registration",
        description: "The owner also gets the ABI (or programs and payees) and the revision history. Unknown ids and other keys' private registrations both answer 404 CONTRACT_NOT_FOUND.",
        security: KEY_REQUIRED,
        parameters: [contractIdParam],
        responses: { "200": ok("ContractResponse", "Registration."), ...errors("404") },
      },
      patch: {
        operationId: "updateContract",
        tags: ["Contracts"],
        summary: "Change a registration (owner only)",
        description: `Labels and phrases change in place. Any other change is re-validated, re-pinned and stored as a new revision: pending for the activation delay on mainnet (the active revision keeps serving until then; intents planned on it stop preparing once the new one activates, 409 CONTRACT_REVISION_CHANGED), immediate on testnets.${IDEMPOTENCY_NOTE}`,
        security: KEY_REQUIRED,
        parameters: [contractIdParam, idempotencyKeyParam],
        requestBody: jsonBody("ContractDefinitionPatch"),
        responses: { "200": ok("ContractResponse", "The registration.", REPLAYED_HEADER), ...errors("403", "404", "409", "413", "415", "422", "502", "504") },
      },
      delete: {
        operationId: "deleteContract",
        tags: ["Contracts"],
        summary: "Delete a registration (owner only; idempotent)",
        description: "Planned intents that use it stop preparing (409 CONTRACT_NOT_USABLE); verification of submitted steps continues.",
        security: KEY_REQUIRED,
        parameters: [contractIdParam],
        responses: { "204": { description: "Deleted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("403", "404") },
      },
    },
    "/v1/contracts/{id}/test": {
      post: {
        operationId: "testContract",
        tags: ["Contracts"],
        summary: "Dry-run an action for an account (simulation + review)",
        description: `Runs the plan and prepare pipeline of one entry for \`account\` (the owner tests the latest revision, also while it is pending): bindings, approvals, simulation and the review users will see. Never stored, never signed, and the response carries no calldata to persist. ${CONTRACT_TESTS_PER_MINUTE} per minute per key (shared with inspect).`,
        security: KEY_REQUIRED,
        parameters: [contractIdParam],
        requestBody: jsonBody("ContractTestRequest"),
        responses: { "200": ok("ContractTestResponse", "The dry run."), ...errors("404", "409", "413", "415", "422", "502", "504") },
      },
    },
    "/v1/contracts/{id}/reverify": {
      post: {
        operationId: "reverifyContract",
        tags: ["Contracts"],
        summary: "Re-read pins and verification after an intended upgrade (owner only)",
        description: `Re-pins the code, re-checks Sourcify / OtterSec and the domain file (\`${KLETIA_WELL_KNOWN_PATH}\` listing the id). Changed pins, or a suspension for pins_changed, program_changed or outcome_mismatch, create a new revision (pending on mainnet; the registration becomes active again when it activates). Unchanged code only refreshes the verification. Operator suspensions cannot be lifted here.${IDEMPOTENCY_NOTE}`,
        security: KEY_REQUIRED,
        parameters: [contractIdParam, idempotencyKeyParam],
        responses: { "200": ok("ContractResponse", "The registration.", REPLAYED_HEADER), ...errors("403", "404", "409", "422", "502", "504") },
      },
    },
    "/v1/contracts/{id}/suspend": {
      post: {
        operationId: "suspendContract",
        tags: ["Contracts"],
        summary: "Suspend any registration (operator key)",
        description: "Abuse handling. Sends contract.suspended to the owner's webhooks; the owner cannot lift it.",
        security: KEY_REQUIRED,
        parameters: [contractIdParam],
        requestBody: jsonBody("ContractSuspendRequest"),
        responses: { "200": ok("ContractResponse", "The suspended registration."), ...errors("404", "413", "415") },
      },
    },
    "/v1/sessions": {
      post: {
        operationId: "createSession",
        tags: ["Sessions"],
        summary: "Create a session the embed turns into an intent for a visitor",
        description: `A fixed template of structured actions (custom contract steps of the caller's registrations included), the origins allowed to embed it, an optional visitor-chosen amount within bounds, a TTL and a use count. The template is planned once as a dry run, so a broken template fails here. The response's \`embedUrl\` carries the id in the URL fragment. At most ${CONTRACT_LIMITS.activeSessionsPerKey} active sessions per key (429 RATE_LIMITED beyond). A registration that is still pending (mainnet activation delay) adds \`warnings: [{ code: "CONTRACT_PENDING", contract, activatesAt }]\`; a session that would expire before it activates is refused with 422 SESSION_EXPIRES_BEFORE_ACTIVATION (\`details.minimumExpiresInSeconds\`). Every session intent counts in the owner key's own Rule Book spend windows. With a publishable key, send only \`{ flow, hostOrigin }\`: a single-use 600 s session from the project's stored flow, owned by the publishable key, whose call / action steps use the registrations of the key that saved the flow (404 FLOW_UNKNOWN; 403 PUBLISHABLE_ORIGIN_FORBIDDEN when hostOrigin is not an allowed origin).${IDEMPOTENCY_NOTE}`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParam],
        requestBody: { required: true, content: { "application/json": { schema: { oneOf: [ref("SessionCreateRequest"), ref("FlowSessionRequest")] } } } },
        responses: { "201": ok("SessionResponse", "The session.", REPLAYED_HEADER), ...errors("403", "404", "409", "413", "415", "422", "502", "504") },
      },
    },
    "/v1/sessions/{id}": {
      get: {
        operationId: "getSession",
        tags: ["Sessions"],
        summary: "Session view for the embed (public; the id is the capability)",
        description: "Integrator identity, allowed origins, action labels, amount bounds, status and expiry, and `warnings` while a registration of the template is still pending. Never the key or the project.",
        parameters: [sessionIdParam],
        responses: { "200": ok("SessionResponse", "The session."), ...errors("404") },
      },
    },
    "/v1/sessions/{id}/intents": {
      post: {
        operationId: "createSessionIntent",
        tags: ["Sessions"],
        summary: "Turn a session into an intent for the visitor's accounts (public)",
        description:
          "Re-checks expiry (410 SESSION_EXPIRED), the use count (409 SESSION_USED; one atomic use) and that `hostOrigin` is an allowed origin (403 SESSION_ORIGIN_FORBIDDEN), then plans the template with the visitor's accounts under the session owner's key, with `metadata.sessionId` set. A plan that fails gives the use back. The visitor reviews and signs every step in their own wallet.",
        parameters: [sessionIdParam],
        requestBody: jsonBody("SessionIntentRequest"),
        responses: {
          "201": ok("IntentResponse", "The intent."),
          "200": ok("IntentResponse", "The intent this visitor already created with the session's clientReference.", REPLAYED_HEADER),
          ...errors("403", "404", "409", "410", "413", "415", "422", "502", "504"),
        },
      },
    },
  };
}

/** Error catalog, status badge, MCP and the OpenAPI document. */
function systemPaths(): JsonObject {
  return {
    "/v1/errors": {
      get: {
        operationId: "listErrors",
        tags: ["System"],
        summary: "Error catalog",
        description: "Every error code the API returns, and every step failure code, with its status, category, retryability and remedy. Cacheable for 5 minutes.",
        responses: { "200": ok("ErrorCatalogResponse", "The catalog, sorted by code."), ...errors() },
      },
    },
    "/v1/status/badge": {
      get: {
        operationId: "getStatusBadge",
        tags: ["System"],
        summary: "API status badge",
        description: "operational / degraded / down from the health report. SVG by default; `format=shields` returns a shields.io endpoint document for `https://img.shields.io/endpoint?url=<encoded URL>`. Cacheable for 60 seconds.",
        parameters: [{ name: "format", in: "query", required: false, schema: str({ enum: ["svg", "shields"], default: "svg" }) }],
        responses: {
          "200": {
            description: "Badge.",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: { "image/svg+xml": { schema: str() }, "application/json": { schema: ref("ShieldsBadge") } },
          },
          ...errors(),
        },
      },
    },
    "/v1/mcp": {
      post: {
        operationId: "mcp",
        tags: ["MCP"],
        summary: "Model Context Protocol server (Streamable HTTP)",
        description: `MCP revision 2026-07-28, plus stateless serving of 2025-era clients that open with \`initialize\`. Send one JSON-RPC message per request with \`Accept: application/json, text/event-stream\`; batches are refused and GET answers 405 (no server-initiated stream). Tools: ${KLETIA_TOOLS.map((tool) => `\`${tool.name}\``).join(", ")}. Every tool is read-only except \`create_intent\` (stores an intent within the key's rule book; agent keys need \`permissions.mcpCreateIntents\`) and \`create_link\` (publishes a link; \`permissions.links\`). No tool prepares, signs or submits a transaction; \`create_signing_link\` returns a Studio link (text up to ${HANDOFF_MAX_TEXT} characters) for the user to sign with their own wallet. An API key maps to the MCP auth info (\`clientId\` = key id). Requests with an \`Origin\` header must come from an HTTPS origin (or localhost in development), else 403 MCP_ORIGIN_FORBIDDEN. Add it to Claude Code with \`claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp\`.`,
        requestBody: jsonBody("JsonRpcRequest"),
        responses: {
          "200": {
            description: "JSON-RPC response (application/json), or an event stream for 2025-era requests.",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: { "application/json": { schema: ref("JsonRpcResponse") }, "text/event-stream": { schema: str() } },
          },
          "202": { description: "Notification accepted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } },
          // The router's guards (401, 403, 413, 415, 429, 503) answer with the platform error envelope; the MCP server with JSON-RPC errors.
          ...errors("403", "413", "415"),
          "400": mcpErrorResponse(
            "A JSON-RPC error for a batch, a body that is not one JSON-RPC message, an unsupported protocol revision or MCP headers that disagree with the body; the platform error envelope (INVALID_JSON) for a body that is not JSON.",
            true,
          ),
          "404": mcpErrorResponse("A JSON-RPC error (-32601) for an unknown method on the 2026-07-28 revision."),
          "406": mcpErrorResponse("A JSON-RPC error when Accept does not list both application/json and text/event-stream."),
          "500": mcpErrorResponse("A JSON-RPC error (-32603) when the MCP server fails; the platform error envelope (INTERNAL_ERROR) for a failure before it.", true),
        },
      },
    },
    "/v1/openapi.json": {
      get: {
        operationId: "getOpenApi",
        tags: ["System"],
        summary: "This OpenAPI document",
        responses: {
          "200": { description: "OpenAPI 3.1 document.", headers: { "X-Request-Id": REQUEST_ID_HEADER }, content: { "application/json": { schema: { type: "object" } } } },
          ...errors(),
        },
      },
    },
  };
}

export function paths(): JsonObject {
  return {
    ...intentPaths(),
    ...journeyPaths(),
    ...clarifyPaths(),
    ...previewPaths(),
    ...receiptPaths(),
    ...policyPaths(),
    ...linkPaths(),
    ...dataPaths(),
    ...assistantPaths(),
    ...projectPaths(),
    ...accountPaths(),
    ...automationPaths(),
    ...orderPaths(),
    ...perpsPaths(),
    ...predictionPaths(),
    ...agentPaths(),
    ...webhookKeyPaths(),
    ...contractSessionPaths(),
    ...systemPaths(),
  };
}
