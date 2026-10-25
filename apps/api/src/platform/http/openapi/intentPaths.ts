/**
 * Health, catalog, quote, portfolio, intent and event paths.
 */
import { REJECTION_CODES } from "../../index.js";
import { CLARIFY_QUERY_PARAMETER } from "../clarifyOpenapi.js";
import { API_KEY_ID_PATTERN } from "../keys.js";
import { PORTFOLIO_ACCOUNT_READS_PER_MINUTE } from "../limits.js";
import {
  EVENT_STREAM_BUFFER_EVENTS,
  EVENT_STREAM_BUFFER_MS,
  EVENT_STREAMS_PER_KEY,
} from "../eventStream.js";
import {
  JOURNEY_READS_PARAMETER,
  journeyQueryParameter,
} from "../journeyOpenapi.js";
import { PORTFOLIO_BATCH_LIMITS } from "../../index.js";
import { PREVIEW_ACK_HEADER_SCHEMA } from "../previewOpenapi.js";
import { SSE_HEARTBEAT_MS, SSE_MAX_DURATION_MS, SSE_RETRY_MS } from "../sse.js";
import { WEBHOOK_SCOPES } from "../webhooks.js";
import {
  ACCOUNT_EXAMPLE,
  errors,
  IDEMPOTENCY_NOTE,
  idempotencyKeyParam,
  int,
  intentIdParam,
  jsonBody,
  type JsonObject,
  KEY_REQUIRED,
  ok,
  oneOfResponse,
  ref,
  REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  stepIdParam,
  str,
} from "./helpers.js";

/** Health, catalog, quotes, portfolio, intents and events. */
export function intentPaths(): JsonObject {
  return {
    "/v1/health": {
      get: {
        operationId: "getHealth",
        tags: ["System"],
        summary: "API and per-network RPC health",
        description: "Never fails: degraded networks are reported with ok=false. Results are cached for 10 seconds.",
        responses: { "200": ok("Health", "Health report."), ...errors() },
      },
    },
    "/v1/networks": {
      get: {
        operationId: "listNetworks",
        tags: ["Registry"],
        summary: "Chain registry plus per-network capabilities",
        description: "Capabilities are derived from the engine's execution adapters. Cacheable for 60 seconds.",
        responses: { "200": ok("NetworksResponse", "Networks."), ...errors() },
      },
    },
    "/v1/protocols": {
      get: {
        operationId: "listProtocols",
        tags: ["Registry"],
        summary: "Protocol registry",
        responses: { "200": ok("ProtocolsResponse", "Protocols."), ...errors() },
      },
    },
    "/v1/assets": {
      get: {
        operationId: "listAssets",
        tags: ["Registry"],
        summary: "Canonical asset registry",
        parameters: [
          { name: "network", in: "query", required: false, description: "Network key, CAIP-2 id or EVM chain id.", schema: str({ maxLength: 128 }) },
        ],
        responses: { "200": ok("AssetsResponse", "Assets."), ...errors() },
      },
    },
    "/v1/venues": {
      get: {
        operationId: "listVenues",
        tags: ["Registry"],
        summary: "EVM lending venues with rates, size and exit liquidity",
        description:
          "Every executable EVM lending venue in the registry (Aave V3, Compound V3, Morpho vaults, Moonwell), read on-chain and cached for 60 seconds. Values are advisory: plan and prepare re-read what they gate on. Solana venues (Jupiter Lend, Kamino) report their rate in plan notes.",
        parameters: [
          { name: "network", in: "query", required: false, description: "Network key, CAIP-2 id or EVM chain id.", schema: str({ maxLength: 128 }) },
          { name: "protocol", in: "query", required: false, description: "Lending protocol id, e.g. aave-v3, compound-v3, morpho, moonwell.", schema: str({ maxLength: 40 }) },
        ],
        responses: { "200": ok("VenuesResponse", "Venues."), ...errors() },
      },
    },
    "/v1/quotes": {
      post: {
        operationId: "quoteRoutes",
        tags: ["Quotes"],
        summary: "Best routes for one asset movement (same- or cross-network)",
        description: "Quotes are advisory and never persisted. Routes are ranked like the planner's bridge auction (guaranteed output net of priced extra costs, then time within `maxSeconds`, then transaction count); `best` is the first eligible route.",
        requestBody: jsonBody("QuoteRequest"),
        responses: { "200": ok("QuoteResponse", "Routes."), ...errors("413", "415", "422", "502", "504") },
      },
    },
    "/v1/portfolio": {
      get: {
        operationId: "listPortfolios",
        tags: ["Portfolio"],
        summary: "Balances of several CAIP-10 accounts in one request",
        description: `At most ${PORTFOLIO_BATCH_LIMITS.maxAccounts} accounts (comma separated; duplicates removed, request order kept), read ${PORTFOLIO_BATCH_LIMITS.concurrency} at a time with ${PORTFOLIO_BATCH_LIMITS.perAccountTimeoutMs / 1000} s per account and cached ${PORTFOLIO_BATCH_LIMITS.cacheTtlMs / 1000} s per account. An account that cannot be read is listed in \`failures\` and the request still answers 200. Costs one request of the tier limit plus one unit per account of a per-IP budget of ${PORTFOLIO_ACCOUNT_READS_PER_MINUTE} account reads per minute (429 RATE_LIMITED after).`,
        parameters: [
          {
            name: "accounts",
            in: "query",
            required: true,
            description: "Comma-separated CAIP-10 accounts; an invalid one is 400 INVALID_REQUEST with the issue path `accounts[i]`.",
            schema: str({ maxLength: 4096, examples: [`eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D,${ACCOUNT_EXAMPLE}`] }),
          },
          { name: "positions", in: "query", required: false, description: "Also read venue positions of each account.", schema: str({ enum: ["true", "false", "1", "0"] }) },
        ],
        responses: { "200": ok("PortfolioList", "Portfolios and failures."), ...errors() },
      },
    },
    "/v1/portfolio/{accountId}": {
      get: {
        operationId: "getPortfolio",
        tags: ["Portfolio"],
        summary: "Balances for one CAIP-10 account",
        description: "Every holding carries `priceSource` and `pricedAt`; gas assets and listed tokens are priced through the same advisory prices as fee estimates. `positions=true` adds the account's lending, savings and vault positions.",
        parameters: [
          { name: "accountId", in: "path", required: true, schema: ref("AccountId") },
          { name: "positions", in: "query", required: false, description: "Also read venue positions.", schema: str({ enum: ["true", "false", "1", "0"] }) },
        ],
        responses: { "200": ok("Portfolio", "Portfolio."), ...errors("422", "502", "504") },
      },
    },
    "/v1/intents": {
      post: {
        operationId: "createIntent",
        tags: ["Intents"],
        summary: "Plan an intent into an IntentGraph",
        description:
          "Natural-language `text` is compiled by a deterministic grammar; unsupported wording returns 422 INTENT_UNSUPPORTED with example phrases in `error.hints`. With `dryRun=true` the plan is quoted but not stored (200; Idempotency-Key is ignored). A repeated `clientReference` from the same API key returns the original intent (200).\n\n" +
          "With `clarify=true` the request is one turn of a task (`IntentTurnRequest`) and Kletia asks instead of refusing: `needs_input` (200) carries at most two questions, assumption chips and a draft; `planned` is 201 when stored (200 on a dry run, or with `Idempotent-Replayed: true` when the turn's clientReference already planned an intent); `cancelled` is 200; a refusal answers its catalogue status and the thread is unchanged. Threads are client-held by default (send `thread` back); `remember: true` (API keys only) keeps them at Kletia (`threadId`, `expectedRev`, `If-Match`). Idempotency-Key also applies to dry-run turns that create or change a Kletia-held thread." +
          IDEMPOTENCY_NOTE,
        parameters: [
          { name: "dryRun", in: "query", required: false, schema: str({ enum: ["true", "false", "1", "0"] }) },
          {
            name: "preview",
            in: "query",
            required: false,
            description: "Also return the asset-change preview (stage `plan`), simulated from the transactions the quotes already returned; never a failed create (unsimulated steps are quoted).",
            schema: str({ enum: ["true", "false", "1", "0"] }),
          },
          journeyQueryParameter("Also return the journey (where the money is after every step and what follows), built on the plan-stage preview, which it implies; dry runs too. Never a failed create (`journey: null`)."),
          JOURNEY_READS_PARAMETER,
          CLARIFY_QUERY_PARAMETER,
          idempotencyKeyParam,
          {
            name: "If-Match",
            in: "header",
            required: false,
            description: "With `clarify=true` and `threadId`: the thread revision the turn expects (as `expectedRev`), e.g. `\"3\"`; another revision is 409 THREAD_CONFLICT.",
            schema: str({ pattern: "^(W/)?\"?[0-9]{1,9}\"?$" }),
          },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { oneOf: [ref("IntentRequest"), ref("IntentTurnRequest")], description: "`IntentTurnRequest` with `clarify=true`, otherwise `IntentRequest`." } } },
        },
        responses: {
          "201": oneOfResponse(["IntentCreateResponse", "IntentTurnResponse"], "Intent planned and stored (with `clarify=true`: a planned turn that stored its intent).", REPLAYED_HEADER),
          "200": oneOfResponse(
            ["IntentCreateResponse", "IntentTurnResponse"],
            "Dry run, or idempotent replay of an existing intent. With `clarify=true`: needs_input, cancelled, a planned dry run or a replayed commit.",
            REPLAYED_HEADER,
          ),
          ...errors("404", "409", "413", "415", "422", "502", "504"),
        },
      },
      get: {
        operationId: "listIntents",
        tags: ["Intents"],
        summary: "List intents created with the caller's key (or a key below it)",
        description: "`owner=key_…`: the intents of an agent or publishable key in the caller's subtree (project keys: any such key of the project; agent keys: their descendants); 404 KEY_NOT_FOUND otherwise.",
        security: KEY_REQUIRED,
        parameters: [
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) },
          { name: "owner", in: "query", required: false, schema: str({ pattern: API_KEY_ID_PATTERN.source }) },
        ],
        responses: { "200": ok("IntentListResponse", "Most recent first."), ...errors("404") },
      },
    },
    "/v1/intents/{id}": {
      get: {
        operationId: "getIntent",
        tags: ["Intents"],
        summary: "Read an intent",
        parameters: [intentIdParam],
        responses: { "200": ok("IntentResponse", "Intent."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/steps/{stepId}/prepare": {
      post: {
        operationId: "prepareStep",
        tags: ["Intents"],
        summary: "Build wallet-ready transactions for a ready step",
        description:
          "Every transaction is sent (EVM) or fee-paid (Solana) by the step account. Sign and send them in order, then submit the references. A payload expires at `payload.expiresAt`; prepare again to re-quote. Never retried automatically: an `Idempotency-Key` header is refused with 400 IDEMPOTENCY_NOT_SUPPORTED. The payload is simulated before it is handed out (`payload.preview`, and the whole intent in `preview`); a payload whose simulated effect differs from its step is refused (SIMULATION_FAILED, SIMULATION_ASSET_CHANGE_REFUSED, QUOTE_MOVED, INSUFFICIENT_BALANCE). Send `acknowledgedPreview` (the digest of the preview the user approved): a materially worse payload answers 409 PREVIEW_CHANGED with `error.preview`; an unknown digest is not an error (`Kletia-Preview-Ack: unknown`).",
        parameters: [intentIdParam, stepIdParam, journeyQueryParameter("Also return the journey at signing time, built on the prepare-stage preview.")],
        requestBody: { required: false, content: { "application/json": { schema: ref("PrepareStepRequest") } } },
        responses: { "200": ok("PreparedStepResponse", "Payload, updated intent and preview.", PREVIEW_ACK_HEADER_SCHEMA), ...errors("404", "409", "410", "422", "502", "503", "504") },
      },
    },
    "/v1/intents/{id}/steps/{stepId}/submit": {
      post: {
        operationId: "submitStep",
        tags: ["Intents"],
        summary: "Submit transaction hashes / signatures for on-chain verification",
        description:
          `A reference advances the step only after Kletia observes it on-chain from the bound account. Same-network steps become \`settled\`; cross-network steps become \`settling\` until the settlement network reports the destination fill. References that are provably not this step's transactions are refused with 422 (${[...REJECTION_CODES].join(", ")}) and leave the step unchanged. References not yet visible on-chain are stored (\`submitted\`) and re-verified by refresh and the settlement poller; until one of them produces on-chain evidence, new references (e.g. after a wallet speed-up) replace them.${IDEMPOTENCY_NOTE}`,
        parameters: [intentIdParam, stepIdParam, idempotencyKeyParam],
        requestBody: jsonBody("SubmitRequest"),
        responses: { "200": ok("IntentResponse", "Updated intent.", REPLAYED_HEADER), ...errors("404", "409", "413", "415", "422", "502") },
      },
    },
    "/v1/intents/{id}/refresh": {
      post: {
        operationId: "refreshIntent",
        tags: ["Intents"],
        summary: "Re-read verification and settlement state now",
        parameters: [intentIdParam],
        responses: { "200": ok("IntentResponse", "Updated intent."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/cancel": {
      post: {
        operationId: "cancelIntent",
        tags: ["Intents"],
        summary: "Cancel an intent with no submitted steps",
        description: IDEMPOTENCY_NOTE.trim(),
        parameters: [intentIdParam, idempotencyKeyParam],
        responses: { "200": ok("IntentResponse", "Cancelled intent.", REPLAYED_HEADER), ...errors("404", "409", "422") },
      },
    },
    "/v1/intents/{id}/events": {
      get: {
        operationId: "streamIntentEvents",
        tags: ["Events"],
        summary: "Server-Sent Events stream of intent events",
        description: `Starts with \`retry: ${SSE_RETRY_MS}\`, replays buffered events after \`Last-Event-ID\` (or \`?since=\`; the whole buffer when absent, or when the id is no longer buffered, so de-duplicate by event id), then streams live events. Each frame is \`id: <event id>\`, \`event: <type>\`, \`data: <KletiaEvent JSON>\`. A comment heartbeat is sent every ${SSE_HEARTBEAT_MS / 1000} s and the stream ends after ${SSE_MAX_DURATION_MS / 60_000} minutes.`,
        parameters: [
          intentIdParam,
          { name: "Last-Event-ID", in: "header", required: false, schema: ref("EventId") },
          { name: "since", in: "query", required: false, schema: ref("EventId") },
        ],
        responses: {
          "200": {
            description: "Event stream. Every `data` line is a KletiaEvent (see components.schemas.KletiaEvent).",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: {
              "text/event-stream": {
                schema: str(),
                example: 'retry: 3000\n\nid: evt_0123456789abcdef0123456789abcdef\nevent: intent.created\ndata: {"id":"evt_0123456789abcdef0123456789abcdef","type":"intent.created","at":"2026-10-08T12:00:00.000Z","data":{"intentId":"int_0123456789abcdef0123456789abcdef","summary":{}}}\n\n',
              },
            },
          },
          ...errors("404"),
        },
      },
    },
    "/v1/events": {
      get: {
        operationId: "streamKeyEvents",
        tags: ["Events"],
        summary: "Server-Sent Events stream of the key's events (routed like its webhooks)",
        description: `Every event that would be delivered to the key's webhooks (intent, receipt, contract, link, Rule Book and key events), as \`id\`, \`event\` and \`data\` frames where \`data\` is the webhook envelope \`{ id, type, at, data }\`. \`scope=subtree\` adds the events of the key's descendant agent keys (and project-wide rule book events on project keys), like webhooks created with \`scope: "subtree"\`. Starts with \`retry: ${SSE_RETRY_MS}\`; \`Last-Event-ID\` (or \`?since=\`) replays the matching events after that id from this instance's buffer (${EVENT_STREAM_BUFFER_EVENTS} events, ${EVENT_STREAM_BUFFER_MS / 60_000} minutes; an id no longer buffered replays the whole buffer, so de-duplicate by event id); without it the stream starts with live events. A heartbeat comment every ${SSE_HEARTBEAT_MS / 1000} s re-checks the key (a revoked or expired key's stream ends); a stream lasts at most ${SSE_MAX_DURATION_MS / 60_000} minutes. At most ${EVENT_STREAMS_PER_KEY} open streams per key (429 TOO_MANY_STREAMS).`,
        security: KEY_REQUIRED,
        parameters: [
          { name: "scope", in: "query", required: false, schema: str({ enum: [...WEBHOOK_SCOPES], default: "self" }) },
          { name: "types", in: "query", required: false, description: "Comma-separated event types (default: every type).", schema: str({ maxLength: 2000, examples: ["intent.status_changed,link.created"] }) },
          { name: "Last-Event-ID", in: "header", required: false, schema: ref("EventId") },
          { name: "since", in: "query", required: false, schema: ref("EventId") },
        ],
        responses: {
          "200": {
            description: "Event stream. Every `data` line is a KletiaEvent (see components.schemas.KletiaEvent).",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: {
              "text/event-stream": {
                schema: str(),
                example: 'retry: 3000\n\nid: evt_0123456789abcdef0123456789abcdef\nevent: link.created\ndata: {"id":"evt_0123456789abcdef0123456789abcdef","type":"link.created","at":"2026-10-14T12:00:00.000Z","data":{"linkId":"lk_0123456789abcdef01234567","ownerKeyId":"key_0123456789abcdef01234567","revision":1}}\n\n',
              },
            },
          },
          ...errors(),
        },
      },
    },
  };
}
