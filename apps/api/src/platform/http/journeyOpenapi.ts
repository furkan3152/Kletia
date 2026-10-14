/**
 * OpenAPI fragments of the journey: the `Journey` schemas from @kletia/core
 * `journey.ts` (enums from its constants, never hand-copied), `StepFunding` and
 * `VenuePosition`, the query parameters of create and prepare, and the two
 * routes `GET /v1/intents/{id}/journey` and `POST /v1/intents/{id}/stop`.
 * Merged by openapi.ts.
 */
import {
  ASSET_IDENTITY_KINDS,
  CONSEQUENCE_KINDS,
  CONSEQUENCE_SEVERITIES,
  CUSTODY_STATES,
  HOLDING_ROLES,
  JOURNEY_CERTAINTY_ORDER,
  JOURNEY_DIGEST_PATTERN,
  JOURNEY_OPTION_ACTION_TYPES,
  JOURNEY_OPTION_KINDS,
  JOURNEY_SPEC,
  JOURNEY_STAGES,
  JOURNEY_VALUE_SOURCES,
  REFUND_MODES,
  STOP_KINDS,
  STOP_STATES,
} from "@kletia/core";
import { arrayOf, bool, errors, idempotencyKeyParameter, int, intentIdParameter, nullable, obj, ok, ref, str, type JsonObject } from "./openapiKit.js";
import { JOURNEY_READS_PER_INTENT_PER_MINUTE, JOURNEY_REFRESH_INTERVAL_SECONDS } from "./journey.js";

const nullableNumber = (description?: string): JsonObject => ({ type: ["number", "null"], ...(description ? { description } : {}) });
const nullableString = (extra: JsonObject = {}): JsonObject => ({ type: ["string", "null"], ...extra });
const BOOLEAN_QUERY: JsonObject = str({ enum: ["true", "false", "1", "0"] });

/** `?journey=true` on create and prepare. */
export function journeyQueryParameter(description: string): JsonObject {
  return { name: "journey", in: "query", required: false, description, schema: BOOLEAN_QUERY };
}

/** `?journeyReads=` on create. */
export const JOURNEY_READS_PARAMETER: JsonObject = {
  name: "journeyReads",
  in: "query",
  required: false,
  description: "With `journey=true`: `live` (default) reads the accounts' gas and token balances; `none` reads nothing (demo or placeholder accounts).",
  schema: str({ enum: ["live", "none"] }),
};

function optionAction(type: string, properties: JsonObject, required: readonly string[], description: string): JsonObject {
  return obj({ type: str({ const: type }), ...properties }, ["type", ...required], { description });
}

export function journeySchemas(): JsonObject {
  const certainty = str({ enum: [...JOURNEY_CERTAINTY_ORDER], description: "`observed` (seen on-chain) plus the preview's certainty labels, strongest first." });
  const assetRef = ref("PreviewAssetRef");
  return {
    StepFunding: obj(
      {
        from: str({ description: "Step whose output this step spends (the `funds` edge)." }),
        portionBps: int({ minimum: 1, maximum: 10_000, description: "Share of that output in basis points (10000 = all of it)." }),
        gasReserve: { ...ref("AssetAmount"), description: "Gas-asset units kept back from what arrives for network fees there (the input is the gas asset and the account held too little)." },
      },
      ["from", "portionBps"],
    ),
    VenuePosition: obj(
      {
        venue: str({ description: "Registry venue id (e.g. base:aave-v3:usdc)." }),
        network: ref("NetworkKey"),
        protocol: ref("ProtocolId"),
        name: str({ examples: ["Aave V3 USDC"] }),
        receipt: { ...ref("AssetAmount"), description: "The position token held (aToken, vault shares, mToken, jlToken)." },
        underlying: { ...ref("AssetAmount"), description: "What it is worth in the underlying at `rate`." },
        rate: nullableString({ pattern: "^[0-9]+$", description: "Underlying per whole receipt, 18-decimal fixed point; null for 1:1 receipts." }),
        usd: nullableNumber(),
        apy: nullableNumber("Supply APY as a fraction; null when unread."),
        withdrawableNow: nullable(ref("AssetAmount")),
        observedAt: str({ format: "date-time" }),
      },
      ["venue", "network", "protocol", "name", "receipt", "underlying", "rate", "usd", "apy", "withdrawableNow", "observedAt"],
    ),
    AmountView: obj({ amount: ref("BaseUnits"), formatted: str({ description: "Display text without sign." }) }, ["amount", "formatted"]),
    AssetIdentity: obj(
      {
        kind: str({ enum: [...ASSET_IDENTITY_KINDS] }),
        label: str({ examples: ["Circle-issued USDC (CCTP domain 6)"] }),
        underlying: { ...assetRef, description: "Receipts and liquid-staking tokens: what they are a claim on." },
      },
      ["kind", "label"],
    ),
    JourneyValue: obj(
      {
        expectedUsd: nullableNumber(),
        atLeastUsd: nullableNumber(),
        price: nullableNumber("USD per whole token; null: unpriced (never shown as $0)."),
        source: str({ enum: [...JOURNEY_VALUE_SOURCES] }),
        at: nullableString({ format: "date-time" }),
        basis: str({ description: "How a receipt or share was converted, e.g. \"1 steakUSDC = 1.0474 USDC (convertToAssets, 13:51 UTC)\"." }),
      },
      ["expectedUsd", "atLeastUsd", "price", "source", "at"],
    ),
    JourneyHolding: obj(
      {
        asset: assetRef,
        identity: ref("AssetIdentity"),
        expected: ref("AmountView"),
        atLeast: { ...ref("AmountView"), description: "Bound in the user's disfavour (the smallest credit)." },
        certainty,
        value: ref("JourneyValue"),
        role: str({ enum: [...HOLDING_ROLES] }),
        next: obj({ legId: str(), portionBps: int({ minimum: 1, maximum: 10_000 }) }, ["legId", "portionBps"], { description: "`spent-next`: the leg that spends it and its share." }),
      },
      ["asset", "identity", "expected", "atLeast", "certainty", "value", "role"],
    ),
    JourneyStop: obj(
      {
        id: str({ description: "`start:<stepId>`, `transit:<stepId>` or `out:<stepId>`; stable across polls." }),
        index: int({ minimum: 0 }),
        kind: str({ enum: [...STOP_KINDS] }),
        network: ref("NetworkKey"),
        holder: obj({ account: nullable(ref("AccountId")), own: bool(), label: str({ examples: ["Your wallet", "Relay (in transit)"] }) }, ["account", "own", "label"]),
        custody: str({ enum: [...CUSTODY_STATES] }),
        state: str({ enum: [...STOP_STATES] }),
        holdings: arrayOf(ref("JourneyHolding")),
        eta: obj(
          { afterFirstSignatureSeconds: int({ minimum: 0 }), remainingSeconds: int({ minimum: 0 }), certainty: str({ enum: ["quoted", "estimated", "observed"] }) },
          ["afterFirstSignatureSeconds", "certainty"],
        ),
        reachedAt: str({ format: "date-time" }),
        evidence: obj({ reference: str(), url: str({ format: "uri" }) }, ["reference"]),
        venue: obj({ id: str(), name: str(), protocol: ref("ProtocolId") }, ["id", "name", "protocol"]),
      },
      ["id", "index", "kind", "network", "holder", "custody", "state", "holdings"],
    ),
    JourneyRefund: obj(
      {
        mode: str({ enum: [...REFUND_MODES] }),
        network: ref("NetworkKey"),
        to: nullable(ref("AccountId")),
        asset: nullable(assetRef),
        upTo: ref("AmountView"),
        label: str({ examples: ["If Relay cannot fill, it refunds up to 100 USDC to your Solana wallet, minus the refund's gas."] }),
        needs: obj({ network: ref("NetworkKey"), account: nullable(ref("AccountId")), asset: assetRef, why: str() }, ["network", "account", "asset", "why"]),
        typicalDelay: str({ enum: ["minutes", "hours", "unknown"] }),
      },
      ["mode", "network", "to", "asset", "label", "typicalDelay"],
    ),
    JourneyLeg: obj(
      {
        id: str({ description: "The step id." }),
        index: int({ minimum: 0 }),
        from: str(),
        via: str(),
        to: str(),
        kind: ref("IntentActionKind"),
        title: str(),
        network: ref("NetworkKey"),
        destinationNetwork: ref("NetworkKey"),
        venue: obj({ protocol: ref("ProtocolId"), name: str(), venueId: str() }, ["protocol", "name"]),
        signer: nullable(ref("AccountId")),
        signatures: int({ minimum: 0 }),
        seconds: { type: ["integer", "null"], minimum: 0 },
        status: ref("StepStatus"),
        failure: obj({ code: str(), message: str() }, ["code", "message"]),
        refund: ref("JourneyRefund"),
        gasTopup: obj({ asset: assetRef, amount: ref("AmountView"), usd: nullableNumber() }, ["asset", "amount", "usd"]),
        tracking: obj({ url: str({ format: "uri" }), label: str() }, ["url", "label"]),
      },
      ["id", "index", "from", "to", "kind", "title", "network", "destinationNetwork", "venue", "signer", "signatures", "seconds", "status"],
    ),
    JourneyActionReplan: optionAction("replan", { request: ref("IntentRequest") }, ["request"], "Plan this request as a new intent: show its fare and journey, then the user signs."),
    JourneyActionPlanNew: optionAction("plan-new", { text: str() }, ["text"], "A separate new intent, as a sentence."),
    JourneyActionRetry: optionAction("retry", { legId: str() }, ["legId"], "Prepare the failed leg again."),
    JourneyActionStop: optionAction("stop", {}, [], "POST /v1/intents/{id}/stop."),
    JourneyActionAcknowledge: optionAction("acknowledge", {}, [], "The user takes care of it (remembered client-side)."),
    JourneyActionLink: optionAction("link", { url: str({ format: "uri", pattern: "^https://" }) }, ["url"], "A provider status page or an explorer."),
    JourneyOption: obj(
      {
        id: str({ description: `One of ${JOURNEY_OPTION_KINDS.join(", ")}, or \`deposit:<venue id>\`.`, pattern: `^(?:${JOURNEY_OPTION_KINDS.join("|")}|deposit:[a-z0-9:.-]+)$` }),
        label: str(),
        effect: str({ description: "What happens, with costs." }),
        costUsd: nullableNumber(),
        recommended: bool(),
        action: {
          oneOf: [ref("JourneyActionReplan"), ref("JourneyActionPlanNew"), ref("JourneyActionRetry"), ref("JourneyActionStop"), ref("JourneyActionAcknowledge"), ref("JourneyActionLink")],
          discriminator: {
            propertyName: "type",
            mapping: Object.fromEntries(
              JOURNEY_OPTION_ACTION_TYPES.map((type) => [
                type,
                `#/components/schemas/JourneyAction${type.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")}`,
              ]),
            ),
          },
        },
      },
      ["id", "label", "effect", "costUsd", "recommended", "action"],
    ),
    JourneyConsequence: obj(
      {
        id: str({ description: "`<kind>:<stopId>[:<qualifier>]`; stable across polls, so answers are remembered by id." }),
        kind: str({ enum: [...CONSEQUENCE_KINDS] }),
        severity: str({
          enum: [...CONSEQUENCE_SEVERITIES],
          description: "`block`: a later leg cannot be signed or will be refused (answer it before the next signature); `act`: an action now avoids a likely problem; `warn`: a risk worth knowing; `info`: facts about the route.",
        }),
        stopId: nullableString(),
        legIds: arrayOf(str()),
        title: str(),
        detail: str(),
        certainty,
        facts: { type: "object", additionalProperties: str(), description: "Numbers used (need, have, headroom, …): base units or decimal USD strings." },
        source: str({ description: "Where the facts come from, e.g. \"Base RPC read at 13:51:04 UTC\"." }),
        options: arrayOf(ref("JourneyOption")),
        prompt: obj({ question: str(), defaultOptionId: nullableString() }, ["question", "defaultOptionId"], { description: "On `block`, and on `act` with a recommended option: the one question to ask." }),
        collapsed: bool({ description: "Folded under \"More about this route\" by default." }),
      },
      ["id", "kind", "severity", "stopId", "legIds", "title", "detail", "certainty", "facts", "source", "options", "collapsed"],
    ),
    Journey: obj(
      {
        spec: str({ const: JOURNEY_SPEC }),
        intentId: ref("IntentId"),
        computedAt: str({ format: "date-time" }),
        stage: str({ enum: [...JOURNEY_STAGES], description: "`plan` while nothing was submitted, `final` once the intent is terminal, else `live`." }),
        basis: obj(
          {
            intentUpdatedAt: str({ format: "date-time" }),
            previewDigest: nullable(ref("PreviewDigest")),
            reads: str({ enum: ["live", "cached", "none"] }),
            factsAt: nullableString({ format: "date-time" }),
          },
          ["intentUpdatedAt", "previewDigest", "reads", "factsAt"],
        ),
        stops: arrayOf(ref("JourneyStop")),
        legs: arrayOf(ref("JourneyLeg")),
        now: obj(
          { stopIds: arrayOf(str()), legId: nullableString(), waitingFor: str({ enum: ["signature", "settlement", "decision", "nothing"] }) },
          ["stopIds", "legId", "waitingFor"],
          { description: "Where the money is now and what the journey waits for." },
        ),
        consequences: arrayOf(ref("JourneyConsequence")),
        blockers: arrayOf(str(), { description: "Ids of `block` consequences the user must answer before the next signature." }),
        digest: str({ pattern: JOURNEY_DIGEST_PATTERN.source, description: "`sha256:` over stops, amounts and consequence ids and severities (no USD, no times)." }),
      },
      ["spec", "intentId", "computedAt", "stage", "basis", "stops", "legs", "now", "consequences", "blockers", "digest"],
      { description: "Where the money is after every step, and what follows (kletia.journey/v1). See docs/platform/journey.md." },
    ),
    JourneyResponse: obj({ journey: ref("Journey") }, ["journey"]),
    IntentStopResponse: obj(
      { intent: ref("IntentGraph"), journey: { ...nullable(ref("Journey")), description: "The journey after the stop; null when it could not be built." } },
      ["intent", "journey"],
    ),
  };
}

export function journeyPaths(): JsonObject {
  return {
    "/v1/intents/{id}/journey": {
      get: {
        operationId: "getIntentJourney",
        tags: ["Intents"],
        summary: "Where the money is after every step, and what follows",
        description: `The journey of a stored intent on its latest preview (recomputed when older than 60 s and the intent is not finished): stops with holdings, legs with refund paths, and consequences by severity with options. Results are cached for 15 s. At most ${JOURNEY_READS_PER_INTENT_PER_MINUTE} reads per intent per minute on top of the tier limit; \`refresh=true\` bypasses the cache at most once per ${JOURNEY_REFRESH_INTERVAL_SECONDS} s per intent. Fetch it with the plan and when a step changes (intent events), not on a timer.`,
        parameters: [
          intentIdParameter,
          { name: "refresh", in: "query", required: false, description: "Read the facts again instead of serving the 15 s cache.", schema: BOOLEAN_QUERY },
          { name: "reads", in: "query", required: false, description: "`none` skips every account read.", schema: str({ enum: ["live", "none"] }) },
        ],
        responses: { "200": ok("JourneyResponse", "Journey."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/stop": {
      post: {
        operationId: "stopIntent",
        tags: ["Intents"],
        summary: "End an intent at its current stop",
        description:
          "Every step not started (or failed) is skipped; the money stays where the journey says (stopping never moves money). Nothing started: the intent is `cancelled`; otherwise `partially_completed` once a step settled. Idempotent. Refused with 409 INTENT_IN_FLIGHT (retryable, `Retry-After`) while a step is submitted, settling or under review, or holds a prepared payload that can still be signed (until it expires). Honours `Idempotency-Key` (with an API key).",
        parameters: [intentIdParameter, idempotencyKeyParameter],
        responses: {
          "200": ok("IntentStopResponse", "Stopped intent and its journey.", { "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" } }),
          ...errors("404", "409", "422"),
        },
      },
    },
  };
}

/** Optional journey fields on IntentStep. */
export function intentStepJourneyFields(): JsonObject {
  return {
    funding: ref("StepFunding"),
    gasTopup: { ...ref("AssetAmount"), description: "Gas delivered with a cross-network fill (`constraints.gasOnArrival`, Relay); never bound on-chain, the step settles on its main output." },
    observedCredit: { ...ref("AssetAmount"), description: "Set on a failed leg when the destination credited less than the floor: that amount is in the recipient's wallet." },
  };
}

/** `constraints.gasOnArrival`. */
export function gasOnArrivalSchema(evmNetworks: readonly string[], min: string, max: string): JsonObject {
  return {
    type: "object",
    minProperties: 1,
    maxProperties: evmNetworks.length,
    propertyNames: { enum: [...evmNetworks] },
    additionalProperties: str({ pattern: "^[0-9]{1,2}(\\.[0-9]{1,2})?$" }),
    description: `Opt-in gas to deliver with the first cross-network leg arriving on each named EVM network, in USD ("${min}" to "${max}"), e.g. { "base": "0.50" }. Only venues that deliver gas with the fill can serve that leg (Relay today); otherwise 422 GAS_TOPUP_UNAVAILABLE.`,
  };
}
