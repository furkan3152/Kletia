/**
 * OpenAPI fragments of the portfolio assistant (`/v1/assistant/*`,
 * docs/platform/assistant.md). Merged by openapi.ts.
 */
import {
  ACCOUNT_SESSION_HEADER,
  ASSISTANT_AGGREGATES,
  ASSISTANT_LIMITS,
  ASSISTANT_SUBJECTS,
  ASSISTANT_TX_KINDS,
  ASSISTANT_WINDOW_NAMES,
  NETWORK_KEYS,
} from "@kletia/core";
import { arrayOf, bool, errors, int, jsonBody, num, obj, ok, ref, str, type JsonObject } from "./openapiKit.js";

const TAGS = ["Assistant"];
const NULLABLE_ISO: JsonObject = { type: ["string", "null"], format: "date-time" };
const NETWORK = str({ enum: [...NETWORK_KEYS] });

export const ASSISTANT_TAG: JsonObject = {
  name: "Assistant",
  description: "Questions about the caller's own wallets answered from the data API, every number with its source; portfolio requests turned into sentences for the normal plan, confirm and sign flow.",
};

const SESSION_HEADER: JsonObject = {
  name: ACCOUNT_SESSION_HEADER,
  in: "header",
  required: false,
  description: "Without an API key: the desk's wallet session (first-party origin only). The answer covers that wallet.",
  schema: str(),
};

export function assistantSchemas(): JsonObject {
  return {
    AssistantAskRequest: obj(
      {
        question: str({ minLength: 1, maxLength: ASSISTANT_LIMITS.questionChars, examples: ["How much did I spend on fees last month?"] }),
        wallets: obj(
          {
            evm: arrayOf(str(), { maxItems: 2 }),
            solana: arrayOf(str(), { maxItems: 2 }),
            lane: str({ enum: ["production", "testnet"] }),
          },
          [],
          { description: "Required with an API key; a wallet session answers for its own wallet (naming another is 403 ASSISTANT_ACCOUNT_FORBIDDEN)." },
        ),
        model: str({ enum: ["on", "off"], description: "Opt in to the model steps (reading a question the parser cannot, wording the answer). Default off." }),
        consent: str({ maxLength: 2048, description: "Desk only: the session token of POST /v1/assistant/consent." }),
      },
      ["question"],
    ),
    AssistantQuery: obj(
      {
        subject: str({ enum: [...ASSISTANT_SUBJECTS] }),
        filter: obj({
          kinds: arrayOf(str({ enum: [...ASSISTANT_TX_KINDS] })),
          assets: arrayOf(str()),
          networks: arrayOf(NETWORK),
          destinations: arrayOf(NETWORK),
          protocols: arrayOf(str()),
        }),
        window: obj(
          { name: str({ enum: [...ASSISTANT_WINDOW_NAMES] }), from: NULLABLE_ISO, to: str({ format: "date-time" }), label: str(), days: int(), assumed: bool() },
          ["name", "from", "to", "label"],
        ),
        aggregate: str({ enum: [...ASSISTANT_AGGREGATES] }),
        by: str({ enum: ["asset", "network", "protocol"] }),
        limit: int(),
      },
      ["subject", "filter", "aggregate"],
    ),
    AssistantFact: obj(
      {
        id: str(),
        label: str(),
        value: str({ description: "As printed in the answer." }),
        number: { type: ["number", "null"] },
        unit: str({ enum: ["usd", "count", "fraction", "amount", "ratio", "date", "text"] }),
        source: str({ description: "Where the value comes from (a data API source, or chain)." }),
        asOf: NULLABLE_ISO,
      },
      ["id", "label", "value", "number", "unit", "source", "asOf"],
    ),
    AssistantAnswer: obj(
      {
        route: { type: ["string", "null"], enum: ["portfolio-question", "portfolio-action", "market-question", null] },
        status: str({ enum: ["answered", "partial", "unknown", "refused", "needs-model"] }),
        text: str(),
        facts: arrayOf(ref("AssistantFact")),
        query: { oneOf: [ref("AssistantQuery"), { type: "null" }] },
        table: obj({
          columns: arrayOf(obj({ key: str(), label: str(), numeric: bool() }, ["key", "label"])),
          rows: arrayOf({ type: "object", additionalProperties: str() }),
        }, ["columns", "rows"]),
        chart: obj({ kind: str({ enum: ["bar"] }), label: str(), unit: str({ enum: ["usd", "fraction"] }), points: arrayOf(obj({ label: str(), value: num() }, ["label", "value"])) }, ["kind", "label", "unit", "points"]),
        followUps: arrayOf(str()),
        action: obj(
          {
            goal: str({ enum: ["rebalance", "sell", "best-yield", "exit"] }),
            summary: str(),
            sentences: arrayOf(str(), { maxItems: ASSISTANT_LIMITS.sentences, description: "Desk sentences with amounts from the data; plan each with POST /v1/intents (or the desk), which confirms before anything is signed." }),
          },
          ["goal", "summary", "sentences"],
        ),
        assumptions: arrayOf(str()),
        gaps: arrayOf(str()),
        wording: str({ enum: ["template", "model"] }),
        understoodBy: { type: ["string", "null"], enum: ["parser", "model", null] },
        wallets: arrayOf(obj({ label: str(), address: str(), vm: str({ enum: ["evm", "solana"] }) }, ["label", "address", "vm"])),
        asOf: str({ format: "date-time" }),
      },
      ["route", "status", "text", "facts", "query", "followUps", "assumptions", "gaps", "wording", "understoodBy", "wallets", "asOf"],
    ),
    AssistantAskResponse: obj({ answer: ref("AssistantAnswer") }, ["answer"]),
    AssistantConsentResponse: obj({ token: str(), expiresAt: str({ format: "date-time" }), scope: str({ enum: ["session"] }) }, ["token", "expiresAt", "scope"]),
  };
}

export function assistantPaths(): JsonObject {
  return {
    "/v1/assistant/ask": {
      post: {
        operationId: "askAssistant",
        tags: TAGS,
        summary: "Ask about your own portfolio",
        description:
          "Answers a question about the caller's own wallets (holdings, positions, loan health, fees, transactions, results) from the data API, deterministically first: the question is read into a typed query, run in code, and every number in the answer is one of `facts` (with source and reading time). " +
          "A portfolio request that wants action (rebalance to 60/40, sell the worst performer, move idle stables to the best yield, close everything risky) returns `action.sentences` built from the real holdings; plan each one normally, which confirms before anything is signed. " +
          "Owner: an API key with `wallets` (agent keys only accounts their rule book pins; publishable keys never), or without a key the desk's wallet session for its own wallet; else 401 ASSISTANT_OWNER_REQUIRED, another wallet 403 ASSISTANT_ACCOUNT_FORBIDDEN. " +
          "Questions about someone else's wallet, keys or seed phrases are answered `refused`. The model steps run only when the deployment turns them on, with `model: \"on\"` and consent (server keys: the project setting `modelReading: \"enabled\"`); without them a question the parser cannot read answers `needs-model`. Spends the data budget (one unit per account).",
        parameters: [SESSION_HEADER],
        requestBody: jsonBody("AssistantAskRequest"),
        responses: { "200": ok("AssistantAskResponse", "The answer."), ...errors("403", "413", "415") },
      },
    },
    "/v1/assistant/consent": {
      post: {
        operationId: "assistantConsent",
        tags: TAGS,
        summary: "Turn on model help for a desk session",
        description: "Desk only (wallet session from the first-party origin): a session consent token bound to the signed-in wallet, sent back as `consent` with `model: \"on\"`. Server keys are refused (403 CONFIRM_AUTHORITY_REQUIRED); 503 ASSISTANT_MODEL_NOT_CONFIGURED when the model steps are not configured.",
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AssistantConsentResponse", "The consent token."), ...errors("403") },
      },
    },
  };
}
