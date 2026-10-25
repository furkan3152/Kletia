/**
 * Core response envelopes and the complete component schema map.
 */
import { clarifySchemas } from "../clarifyOpenapi.js";
import { journeySchemas } from "../journeyOpenapi.js";
import { previewSchemas } from "../previewOpenapi.js";
import { receiptSchemas } from "../receipts/openapi.js";
import { policySchemas } from "../policies/openapi.js";
import { linkSchemas } from "../links/openapi.js";
import { assistantSchemas } from "../assistantOpenapi.js";
import { dataSchemas } from "../dataOpenapi.js";
import { privacySchemas } from "../privacyOpenapi.js";
import { projectSchemas } from "../projects/openapi.js";
import { accountSchemas } from "../accounts/openapi.js";
import { automationSchemas } from "../../automation/openapi.js";
import { orderSchemas } from "../orders/openapi.js";
import { perpsSchemas } from "../perps/openapi.js";
import { predictionSchemas } from "../predictions/openapi.js";
import { agentSchemas } from "../agents/openapi.js";
import { arrayOf, int, type JsonObject, obj, ref, str } from "./helpers.js";
import { contractSchemas } from "./contractSchemas.js";
import { intentSchemas } from "./intentSchemas.js";
import { catalogSchemas, platformSchemas } from "./catalogSchemas.js";

/** Response envelopes of the core routes. */
function responseSchemas(): JsonObject {
  return {
    IntentResponse: obj({ intent: ref("IntentGraph") }, ["intent"]),
    IntentCreateResponse: obj(
      {
        intent: ref("IntentGraph"),
        preview: { ...ref("IntentPreview"), description: "With `preview=true` or `journey=true`: the plan-stage asset-change preview (stage `plan`)." },
        journey: {
          oneOf: [ref("Journey"), { type: "null" }],
          description: "With `journey=true`: the journey built on `preview` (`journey.basis.previewDigest` equals `preview.digest`); null when it could not be built.",
        },
        privacy: ref("PlatformPrivacyTrace"),
      },
      ["intent", "privacy"],
    ),
    IntentListResponse: obj({ intents: arrayOf(ref("IntentGraph")) }, ["intents"]),
    PreparedStepResponse: obj(
      {
        payload: ref("StepExecutionPayload"),
        intent: ref("IntentGraph"),
        preview: { ...ref("IntentPreview"), description: "The whole intent with this step freshly simulated (stage `prepare`)." },
        previewAck: str({ enum: ["matched", "unknown"], description: "Present when `acknowledgedPreview` was sent (also in the response header)." }),
        journey: {
          oneOf: [ref("Journey"), { type: "null" }],
          description: "With `journey=true`: the journey at signing time, built on `preview`; null when it could not be built.",
        },
      },
      ["payload", "intent"],
    ),
    NetworksResponse: obj({ networks: arrayOf(ref("NetworkCapabilities")) }, ["networks"]),
    ProtocolsResponse: obj({ protocols: arrayOf(ref("Protocol")) }, ["protocols"]),
    AssetsResponse: obj({ assets: arrayOf(ref("Asset")) }, ["assets"]),
    LendingMetrics: obj(
      {
        venue: str({ description: "Registry venue id, e.g. base:aave-v3:usdc (use as params.venue)." }),
        protocol: ref("ProtocolId"),
        network: ref("NetworkKey"),
        name: str(),
        asset: str({ description: "Underlying asset symbol." }),
        supplyApy: { type: ["number", "null"], description: "Variable supply APY as a fraction (0.045 = 4.5%); advisory, null when unreadable." },
        apySource: str({ enum: ["rate", "share-price", "unavailable"], description: "`rate`: the current on-chain supply rate; `share-price`: realised share-price growth over apyWindowSeconds." }),
        apyWindowSeconds: int({ minimum: 0 }),
        totalSupplied: { oneOf: [ref("AssetAmount"), { type: "null" }], description: "Underlying supplied to the venue (TVL)." },
        exitLiquidity: { oneOf: [ref("AssetAmount"), { type: "null" }], description: "Underlying that can leave the venue now." },
        utilization: { type: ["number", "null"], minimum: 0, maximum: 1 },
        observedAt: str({ format: "date-time" }),
        warnings: arrayOf(str()),
      },
      ["venue", "protocol", "network", "name", "asset", "supplyApy", "apySource", "totalSupplied", "exitLiquidity", "utilization", "observedAt", "warnings"],
    ),
    VenuesResponse: obj(
      {
        venues: arrayOf(ref("LendingMetrics")),
        unavailable: arrayOf(obj({ venue: str(), code: str(), message: str() }, ["venue", "code", "message"]), {
          description: "Venues whose on-chain reads failed or no longer match the registry.",
        }),
      },
      ["venues", "unavailable"],
    ),
    WebhookResponse: obj({ webhook: ref("Webhook") }, ["webhook"]),
    WebhookListResponse: obj({ webhooks: arrayOf(ref("Webhook")) }, ["webhooks"]),
    WebhookDeliveryResponse: obj({ delivery: ref("WebhookDelivery") }, ["delivery"]),
    WebhookDeliveryListResponse: obj({ deliveries: arrayOf(ref("WebhookDelivery"), { description: "Newest first." }) }, ["deliveries"]),
    ApiKeyResponse: obj({ key: ref("ApiKey") }, ["key"]),
    RotatedApiKeyResponse: obj({ key: ref("RotatedApiKey") }, ["key"]),
    ApiKeyListResponse: obj({ keys: arrayOf(ref("ApiKeyView"), { description: "The project's keys, newest first (at most 50)." }) }, ["keys"]),
  };
}

export function schemas(): JsonObject {
  return {
    ...intentSchemas(),
    ...catalogSchemas(),
    ...platformSchemas(),

    ...contractSchemas(),
    ...previewSchemas(),
    ...receiptSchemas(),
    ...policySchemas(),
    ...linkSchemas(),
    ...dataSchemas(),
    ...assistantSchemas(),
    ...projectSchemas(),
    ...accountSchemas(),
    ...automationSchemas(),
    ...orderSchemas(),
    ...perpsSchemas(),
    ...predictionSchemas(),
    ...agentSchemas(),
    ...journeySchemas(),
    ...clarifySchemas(),
    ...privacySchemas(),

    ...responseSchemas(),
  };
}
