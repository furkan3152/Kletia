/**
 * OpenAPI fragments of automations (tag *Automations*): rules, their runs
 * and the inbox, plus the `automation.*` event. Limits come from
 * @kletia/core `automation.ts`. Merged by http/openapi.ts.
 */
import {
  ACCOUNT_SESSION_HEADER,
  ACCOUNT_SESSION_TOKEN_PATTERN,
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LIMITS,
  AUTOMATION_RUN_ID_PATTERN,
  AUTOMATION_TRIGGER_KINDS,
} from "@kletia/core";
import { arrayOf, bool, errors, int, jsonBody, noContent, nullable, obj, ok, ref, str, type JsonObject } from "../http/openapiKit.js";

const TAGS = ["Automations"];
const TIME = str({ format: "date-time" });
const USD = str({ pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$", description: "USD, decimal string." });
const DIRECTION = str({ enum: ["above", "below"] });
const HYSTERESIS = int({ minimum: AUTOMATION_LIMITS.minHysteresisBps, maximum: AUTOMATION_LIMITS.maxHysteresisBps, description: `Re-arm band after a firing (default ${AUTOMATION_LIMITS.defaultHysteresisBps} bps).` });
const RUN_STATUS = str({ enum: ["firing", "prepared", "needs_signature", "skipped", "failed"] });
const STATUS = str({ enum: ["active", "paused", "completed", "expired"] });

const SESSION_HEADER: JsonObject = {
  name: ACCOUNT_SESSION_HEADER,
  in: "header",
  required: false,
  description: "Without an API key: a wallet session from the Kletia desk (first-party Origin). The wallet then owns the automations.",
  schema: str({ pattern: ACCOUNT_SESSION_TOKEN_PATTERN.source }),
};
const ID_PARAM: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: AUTOMATION_ID_PATTERN.source }) };

const OWNER_NOTE =
  "Owner: the API key, or without one a wallet session (`Kletia-Account-Session`) from the desk; else 401 AUTOMATION_OWNER_REQUIRED. " +
  "Another owner's automation answers 404 AUTOMATION_NOT_FOUND. Kletia never signs: a run plans an intent the owner signs, unless a native order provider executes it.";

export function automationSchemas(): JsonObject {
  return {
    AutomationTrigger: {
      description: "Evaluated every minute in UTC. Crossings fire once and re-arm past the hysteresis band; the first observation only arms.",
      oneOf: [
        obj(
          {
            kind: str({ const: "schedule" }),
            every: obj({ unit: str({ enum: ["hour", "day", "week", "month"] }), count: int({ minimum: 1, maximum: AUTOMATION_LIMITS.maxEvery }) }, ["unit", "count"]),
            startAt: TIME,
            endAt: TIME,
            maxRuns: int({ minimum: 1, maximum: AUTOMATION_LIMITS.maxRuns }),
            timezone: str({ description: "IANA zone, display only: runs never move with daylight saving." }),
          },
          ["kind", "every", "startAt"],
        ),
        obj({ kind: str({ const: "price" }), asset: str(), network: ref("NetworkKey"), direction: DIRECTION, priceUsd: USD, hysteresisBps: HYSTERESIS }, ["kind", "asset", "network", "direction", "priceUsd"]),
        obj({ kind: str({ const: "balance" }), account: ref("AccountId"), asset: str(), direction: DIRECTION, amount: str(), hysteresisBps: HYSTERESIS }, ["kind", "account", "asset", "direction", "amount"]),
        obj(
          { kind: str({ const: "apy" }), asset: str(), networks: arrayOf(ref("NetworkKey"), { minItems: 1 }), minDeltaBps: int({ minimum: 1, maximum: 10_000 }), current: str({ description: "Registry venue id of the current position (GET /v1/venues)." }) },
          ["kind", "asset", "networks", "minDeltaBps"],
        ),
        obj({ kind: str({ const: "event" }), account: ref("AccountId"), asset: str(), minAmount: str({ description: "Smallest balance increase that counts as an incoming transfer." }) }, ["kind", "account", "asset"]),
      ],
    },
    AutomationAction: {
      oneOf: [
        obj(
          {
            kind: str({ const: "intent" }),
            text: str({ maxLength: 1000 }),
            actions: arrayOf(ref("IntentActionSpec"), { maxItems: 8 }),
            accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6 }),
            sourceNetwork: str(),
            constraints: ref("IntentConstraints"),
          },
          ["kind", "accounts"],
          { description: "Planned at every run; metadata and clientReference are set by Kletia." },
        ),
        obj(
          { kind: str({ const: "rebalance" }), accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6 }), amount: str({ description: "Deposit when there is no current venue." }) },
          ["kind", "accounts"],
          { description: "apy triggers only: withdraw from the current venue, bridge when needed, deposit at the best." },
        ),
      ],
    },
    AutomationLimits: obj({
      maxUsdPerRun: USD,
      maxUsdTotal: USD,
      expiresAt: str({ format: "date-time", description: `Default ${AUTOMATION_LIMITS.defaultLifetimeDays} days, at most ${AUTOMATION_LIMITS.maxLifetimeDays}.` }),
      cooldownSeconds: int({ minimum: 0, maximum: AUTOMATION_LIMITS.maxCooldownSeconds }),
      networks: arrayOf(ref("NetworkKey")),
      protocols: arrayOf(str()),
      maxSlippageBps: int({ minimum: 1, maximum: 5_000 }),
    }),
    AutomationCreateRequest: obj(
      { label: str({ maxLength: AUTOMATION_LIMITS.maxLabel }), trigger: ref("AutomationTrigger"), action: ref("AutomationAction"), limits: ref("AutomationLimits") },
      ["trigger", "action"],
      { additionalProperties: false },
    ),
    AutomationPatchRequest: obj({ label: nullable(str({ maxLength: AUTOMATION_LIMITS.maxLabel })), limits: ref("AutomationLimits") }, [], { additionalProperties: false }),
    Automation: obj(
      {
        id: str({ pattern: AUTOMATION_ID_PATTERN.source }),
        label: nullable(str()),
        owner: obj({ kind: str({ enum: ["key", "wallet"] }), keyId: str(), projectId: nullable(str()), walletKind: str({ enum: ["evm", "solana"] }), address: str() }, ["kind"]),
        trigger: ref("AutomationTrigger"),
        action: ref("AutomationAction"),
        limits: ref("AutomationLimits"),
        status: STATUS,
        statusReason: nullable(str({ description: "`owner`, `max_runs`, `ended`, `expired`, `key_revoked`." })),
        state: obj({ armed: bool(), epoch: int({ minimum: 0 }), lastValue: str(), observedAt: TIME, lastSlot: TIME, venue: str() }, ["epoch"]),
        execution: obj({ mode: str({ enum: ["signature", "native"] }), provider: str() }, ["mode"]),
        runs: int({ minimum: 0 }),
        spentUsd: USD,
        lastRunAt: nullable(TIME),
        nextRunAt: nullable(TIME),
        createdAt: TIME,
        updatedAt: TIME,
      },
      ["id", "label", "owner", "trigger", "action", "limits", "status", "statusReason", "state", "execution", "runs", "spentUsd", "lastRunAt", "nextRunAt", "createdAt", "updatedAt"],
    ),
    AutomationResponse: obj({ automation: ref("Automation") }, ["automation"]),
    AutomationList: obj({ automations: arrayOf(ref("Automation")) }, ["automations"]),
    AutomationRun: obj(
      {
        id: str({ pattern: AUTOMATION_RUN_ID_PATTERN.source }),
        automationId: str({ pattern: AUTOMATION_ID_PATTERN.source }),
        window: str({ description: "One run per window, ever (a schedule slot, a crossing)." }),
        status: RUN_STATUS,
        reason: nullable(str({ description: "Skips: cooldown, over_run_limit, over_total_limit, unpriced, network_not_allowed, protocol_not_allowed. Failures: the error code." })),
        message: nullable(str()),
        observed: nullable(str()),
        intentId: nullable(str()),
        title: nullable(str()),
        notionalUsd: nullable(USD),
        provider: nullable(obj({ id: str(), reference: str() }, ["id", "reference"])),
        firedAt: TIME,
        updatedAt: TIME,
      },
      ["id", "automationId", "window", "status", "reason", "message", "observed", "intentId", "title", "notionalUsd", "provider", "firedAt", "updatedAt"],
    ),
    AutomationRunList: obj({ runs: arrayOf(ref("AutomationRun")) }, ["runs"]),
    AutomationInbox: obj(
      {
        runs: arrayOf({
          allOf: [ref("AutomationRun"), obj({ automationLabel: nullable(str()), intentStatus: str({ enum: ["planned", "executing"] }), intentExpiresAt: TIME }, ["automationLabel", "intentStatus", "intentExpiresAt"])],
        }),
      },
      ["runs"],
    ),
    AutomationEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...AUTOMATION_EVENT_TYPES] }),
        at: TIME,
        data: obj(
          { automationId: str(), ownerKeyId: str(), runId: str(), intentId: str(), status: str(), reason: str() },
          ["automationId", "ownerKeyId"],
        ),
      },
      ["id", "type", "at", "data"],
      { description: "Automation lifecycle and runs, delivered to the owning key's webhooks (and `scope: \"subtree\"` webhooks of its ancestors). Wallet-owned automations have no webhooks." },
    ),
  };
}

export function automationPaths(): JsonObject {
  return {
    "/v1/automations": {
      post: {
        operationId: "createAutomation",
        tags: TAGS,
        summary: "Create an automation",
        description: `${OWNER_NOTE} Triggers: ${AUTOMATION_TRIGGER_KINDS.join(", ")}. A wallet's automations use its own address only (403 AUTOMATION_ACCOUNT_FORBIDDEN); agent keys need \`permissions.automations\`. At most ${AUTOMATION_LIMITS.perOwner} live automations (409 AUTOMATION_LIMIT_REACHED) and ${AUTOMATION_LIMITS.creationsPerHour} creations an hour per owner.`,
        parameters: [SESSION_HEADER, { $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: jsonBody("AutomationCreateRequest"),
        responses: { "201": ok("AutomationResponse", "The automation."), ...errors("403", "409", "413", "415") },
      },
      get: {
        operationId: "listAutomations",
        tags: TAGS,
        summary: "The owner's automations",
        description: OWNER_NOTE,
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AutomationList", "Newest first."), ...errors("403") },
      },
    },
    "/v1/automations/inbox": {
      get: {
        operationId: "automationInbox",
        tags: TAGS,
        summary: "Runs waiting for the owner's signature",
        description: `${OWNER_NOTE} Runs of the last ${AUTOMATION_LIMITS.inboxDays} days whose intent is still planned or part-signed; open each intent's normal sign flow.`,
        parameters: [SESSION_HEADER],
        responses: { "200": ok("AutomationInbox", "Newest first."), ...errors("403") },
      },
    },
    "/v1/automations/{id}": {
      get: {
        operationId: "getAutomation",
        tags: TAGS,
        summary: "One automation",
        description: OWNER_NOTE,
        parameters: [SESSION_HEADER, ID_PARAM],
        responses: { "200": ok("AutomationResponse", "The automation."), ...errors("403", "404") },
      },
      patch: {
        operationId: "updateAutomation",
        tags: TAGS,
        summary: "Change the label or limits",
        description: `${OWNER_NOTE} The trigger and action never change: create a new automation. 409 AUTOMATION_CONFLICT when another change landed first.`,
        parameters: [SESSION_HEADER, ID_PARAM],
        requestBody: jsonBody("AutomationPatchRequest"),
        responses: { "200": ok("AutomationResponse", "The automation."), ...errors("403", "404", "409", "413", "415") },
      },
      delete: {
        operationId: "deleteAutomation",
        tags: TAGS,
        summary: "Delete an automation",
        description: `${OWNER_NOTE} Intents already planned stay; nothing was signed for them.`,
        parameters: [SESSION_HEADER, ID_PARAM],
        responses: { "204": noContent("Deleted."), ...errors("403", "404") },
      },
    },
    "/v1/automations/{id}/pause": {
      post: {
        operationId: "pauseAutomation",
        tags: TAGS,
        summary: "Pause an automation",
        description: `${OWNER_NOTE} Always allowed, agent keys included.`,
        parameters: [SESSION_HEADER, ID_PARAM],
        responses: { "200": ok("AutomationResponse", "The paused automation."), ...errors("403", "404", "409") },
      },
    },
    "/v1/automations/{id}/resume": {
      post: {
        operationId: "resumeAutomation",
        tags: TAGS,
        summary: "Resume a paused automation",
        description: `${OWNER_NOTE} A completed or expired automation answers 409 AUTOMATION_ENDED.`,
        parameters: [SESSION_HEADER, ID_PARAM],
        responses: { "200": ok("AutomationResponse", "The active automation."), ...errors("403", "404", "409") },
      },
    },
    "/v1/automations/{id}/runs": {
      get: {
        operationId: "listAutomationRuns",
        tags: TAGS,
        summary: "Runs of an automation",
        description: OWNER_NOTE,
        parameters: [SESSION_HEADER, ID_PARAM, { name: "limit", in: "query", schema: int({ minimum: 1, maximum: AUTOMATION_LIMITS.runsListed, default: 20 }) }],
        responses: { "200": ok("AutomationRunList", "Newest first."), ...errors("403", "404") },
      },
    },
  };
}
