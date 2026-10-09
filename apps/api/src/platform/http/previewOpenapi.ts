/**
 * OpenAPI fragments of the asset-change preview (asset-preview design V3):
 * the preview schemas from @kletia/core `preview.ts` and the two
 * `/v1/intents/{id}/preview` operations. Merged by openapi.ts.
 */
import { CERTAINTY_ORDER, PREVIEW_DIGEST_PATTERN, PREVIEW_SPEC } from "@kletia/core";
import { arrayOf, bool, errors, int, intentIdParameter, num, obj, ok, ref, str, type JsonObject } from "./openapiKit.js";
import { PREVIEW_ACK_HEADER, PREVIEWS_PER_INTENT_PER_MINUTE } from "./preview.js";

const nullableUsd = (description?: string): JsonObject => ({ type: ["number", "null"], ...(description ? { description } : {}) });
const range = (description: string): JsonObject => obj({ expected: nullableUsd(), worst: nullableUsd() }, ["expected", "worst"], { description });

export function previewSchemas(): JsonObject {
  const certainty = ref("PreviewCertainty");
  return {
    PreviewDigest: str({ pattern: PREVIEW_DIGEST_PATTERN.source, description: "`sha256:` + hex SHA-256 over what moves (rows, payments, approvals); USD, times and fees are excluded." }),
    PreviewCertainty: str({
      enum: [...CERTAINTY_ORDER],
      description:
        "How a number was obtained: `simulated` (exact transactions, current state), `simulated-assumed-funds` (simulated with a balance override for funds still in flight), `venue-minimum` (a bridge's committed floor, checked on arrival), `quoted` (venue quote, not simulated), `estimated` (derived). Aggregates keep the weakest.",
    }),
    PreviewAmount: obj(
      {
        amount: str({ pattern: "^-?(0|[1-9][0-9]*)$", description: "Signed base units; negative leaves the account." }),
        formatted: str({ description: "Display text with sign, e.g. -100 or +95.4773." }),
        usd: num({ description: "Signed USD; absent when unpriced (never 0 for unknown)." }),
      },
      ["amount", "formatted"],
    ),
    AssetDeltaRow: obj(
      {
        network: ref("NetworkKey"),
        account: ref("AccountId"),
        asset: ref("AssetId"),
        symbol: str(),
        decimals: int({ minimum: 0 }),
        listed: bool({ description: "In Kletia's asset registry." }),
        expected: ref("PreviewAmount"),
        worst: { ...ref("PreviewAmount"), description: "Bound in the user's disfavour: the largest debit or the smallest credit." },
        certainty,
        steps: arrayOf(str()),
        role: str({ enum: ["you", "transit"], description: "`transit`: credits and debits cancel (funds passing through your wallet)." }),
      },
      ["network", "account", "asset", "symbol", "decimals", "listed", "expected", "worst", "certainty", "steps", "role"],
    ),
    ExternalPayment: obj(
      {
        stepId: str(),
        network: ref("NetworkKey"),
        recipient: ref("AccountId"),
        recipientName: str({ description: "ENS, Basenames or SNS name the address was resolved from." }),
        asset: ref("AssetId"),
        symbol: str(),
        decimals: int({ minimum: 0 }),
        expected: ref("PreviewAmount"),
        worst: ref("PreviewAmount"),
        certainty,
      },
      ["stepId", "network", "recipient", "asset", "symbol", "decimals", "expected", "worst", "certainty"],
    ),
    PreviewAssetRef: obj({ asset: ref("AssetId"), symbol: str(), decimals: int({ minimum: 0 }) }, ["asset", "symbol", "decimals"]),
    FeeLine: obj(
      {
        stepId: str(),
        network: ref("NetworkKey"),
        kind: str({ enum: ["network", "l1-data", "venue", "extra", "rent"] }),
        label: str({ examples: ["Base network fee", "Relay relayer fee"] }),
        asset: ref("PreviewAssetRef"),
        amount: ref("BaseUnits"),
        formatted: str(),
        usd: num(),
        paid: str({ enum: ["deducted", "on-top", "refundable"], description: "`deducted`: already inside a lower output (not added again); `on-top`: debited in addition; `refundable`: Solana rent returned when the account closes." }),
        certainty,
      },
      ["stepId", "network", "kind", "label", "paid", "certainty"],
    ),
    ApprovalLine: obj(
      {
        stepId: str(),
        network: ref("NetworkKey"),
        token: ref("PreviewAssetRef"),
        spender: str(),
        spenderLabel: str({ description: "Venue or integrator name." }),
        amount: ref("BaseUnits"),
        formatted: str(),
        leftAfter: { type: ["string", "null"], description: "Allowance left after the simulated step (\"0\": nothing left); null when not simulated." },
      },
      ["stepId", "network", "token", "spender", "spenderLabel", "amount", "formatted", "leftAfter"],
    ),
    PreviewIssue: obj(
      {
        code: str({ description: "A catalogued error code (GET /v1/errors) or a preview warning code (docs/platform/preview.md)." }),
        severity: str({ enum: ["block", "warn"] }),
        message: str(),
      },
      ["code", "severity", "message"],
    ),
    StepPreview: obj(
      {
        stepId: str(),
        network: ref("NetworkKey"),
        kind: ref("IntentActionKind"),
        status: str({ enum: ["simulated", "simulated-assumed-funds", "quoted", "unavailable", "failed"] }),
        at: str({ format: "date-time" }),
        block: str({ description: "Simulated block number (EVM)." }),
        slot: str({ description: "Simulation context slot (Solana)." }),
        endpoint: str({ description: "Host of the simulating endpoint." }),
        overrides: arrayOf(obj({ asset: ref("AssetId"), amount: ref("BaseUnits") }, ["asset", "amount"]), { description: "Balances assumed for funds still in flight." }),
        quoteBinding: str({ description: "Prepare stage: equals `payload.quoteBinding`, tying the preview to these exact transactions." }),
        deltas: arrayOf(ref("AssetDeltaRow")),
        payments: arrayOf(ref("ExternalPayment")),
        fees: arrayOf(ref("FeeLine")),
        approvals: arrayOf(ref("ApprovalLine")),
        gas: obj({ used: ref("BaseUnits"), price: ref("BaseUnits"), l1Fee: ref("BaseUnits") }, ["used", "price"]),
        issues: arrayOf(ref("PreviewIssue")),
      },
      ["stepId", "network", "kind", "status", "at", "deltas", "payments", "fees", "approvals", "issues"],
    ),
    PreviewNeed: obj(
      {
        network: ref("NetworkKey"),
        account: ref("AccountId"),
        asset: ref("PreviewAssetRef"),
        amount: ref("BaseUnits"),
        formatted: str(),
        reason: str({ enum: ["input-balance", "gas-on-arrival", "rent"] }),
        have: { ...ref("BaseUnits"), description: "Balance read, when read." },
      },
      ["network", "account", "asset", "amount", "formatted", "reason"],
    ),
    IntentPreview: obj(
      {
        spec: str({ const: PREVIEW_SPEC }),
        intentId: str(),
        computedAt: str({ format: "date-time" }),
        stage: str({ enum: ["plan", "prepare", "refresh", "indicative"] }),
        basis: str({ enum: ["simulated", "partial", "quoted", "unavailable"] }),
        digest: ref("PreviewDigest"),
        rows: arrayOf(ref("AssetDeltaRow"), { description: "Net change per network, account and asset of the whole intent (bridge legs included)." }),
        payments: arrayOf(ref("ExternalPayment"), { description: "Fixed recipients that are not your accounts." }),
        fees: arrayOf(ref("FeeLine")),
        approvals: arrayOf(ref("ApprovalLine")),
        steps: arrayOf(ref("StepPreview")),
        totals: obj(
          {
            youPayUsd: nullableUsd("Sum of your debits."),
            youGetUsd: range("Your credits."),
            paidToOthersUsd: range("External payments."),
            networkFeesUsd: nullableUsd("Network and L1 data fees."),
            venueFeesUsd: nullableUsd("Venue fees already deducted from outputs."),
            extraCostsUsd: nullableUsd("Venue costs paid on top."),
            costUsd: range("What the intent costs you."),
            priceDifferenceUsd: nullableUsd("Cost not explained by fees (may be negative)."),
            unpriced: arrayOf(ref("AssetId"), { description: "Assets without a price; totals that need them are null." }),
          },
          ["youPayUsd", "youGetUsd", "paidToOthersUsd", "networkFeesUsd", "venueFeesUsd", "extraCostsUsd", "costUsd", "priceDifferenceUsd", "unpriced"],
        ),
        arrival: obj({ network: ref("NetworkKey"), seconds: int({ minimum: 0 }) }, ["network", "seconds"]),
        needs: arrayOf(ref("PreviewNeed"), { description: "What your wallets must hold: input balances, gas on arrival, rent." }),
        warnings: arrayOf(str()),
      },
      ["spec", "intentId", "computedAt", "stage", "basis", "digest", "rows", "payments", "fees", "approvals", "steps", "totals", "needs", "warnings"],
      { description: "The fare breakdown of a whole intent: every number carries how it was obtained. Previews are never stored in the intent." },
    ),
    PreviewResponse: obj({ preview: ref("IntentPreview") }, ["preview"]),
    PrepareStepRequest: obj(
      {
        acknowledgedPreview: {
          ...ref("PreviewDigest"),
          description: "Digest of the preview the user saw. When the fresh simulation is materially worse, prepare answers 409 PREVIEW_CHANGED with `error.preview` (the fresh preview) and `error.changes`.",
        },
      },
      [],
      { additionalProperties: false },
    ),
  };
}

export function previewPaths(): JsonObject {
  return {
    "/v1/intents/{id}/preview": {
      post: {
        operationId: "refreshIntentPreview",
        tags: ["Intents"],
        summary: "Recompute an intent's asset-change preview",
        description: `Simulates the transactions the plan's quotes already returned (or quotes steps that cannot be simulated) and aggregates the whole intent: what leaves your wallets, what arrives, fees, approvals and what your wallets must hold. No provider is called unless \`quotes=refresh\` (ready steps re-quoted, once per 20 s per intent, at most 4 steps). At most ${PREVIEWS_PER_INTENT_PER_MINUTE} recomputations per intent per minute (429 RATE_LIMITED with Retry-After). Takes no body.`,
        parameters: [
          intentIdParameter,
          { name: "quotes", in: "query", required: false, schema: str({ enum: ["cached", "refresh"], default: "cached" }) },
        ],
        responses: { "200": ok("PreviewResponse", "Fresh preview (stage `refresh`)."), ...errors("404", "502", "504") },
      },
      get: {
        operationId: "getIntentPreview",
        tags: ["Intents"],
        summary: "The last preview computed for an intent",
        description: "Any stage (plan, prepare, refresh), kept for 30 minutes. 404 PREVIEW_NOT_FOUND when none is kept.",
        parameters: [intentIdParameter],
        responses: { "200": ok("PreviewResponse", "Last preview."), ...errors("404") },
      },
    },
  };
}

/** The `Kletia-Preview-Ack` response header of prepare. */
export const PREVIEW_ACK_HEADER_SCHEMA: JsonObject = {
  [PREVIEW_ACK_HEADER]: {
    description: "Sent when the request carried `acknowledgedPreview`: `matched` (found, nothing material changed) or `unknown` (expired or not kept here; show the fresh `preview`).",
    schema: str({ enum: ["matched", "unknown"] }),
  },
};
