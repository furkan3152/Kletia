/**
 * Primitive, error, intent, transaction and event schemas.
 */
import {
  AUTOMATION_EVENT_TYPES,
  CHAINS,
  AGENT_EVENT_TYPES,
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_EVENT_TYPES,
  CONTRACT_ID_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_REFERENCE_PATTERN,
  ERROR_CATEGORIES,
  GAS_ON_ARRIVAL_USD,
  INTENT_SPEC_VERSION,
  KEY_EVENT_TYPES,
  LINK_EVENT_TYPES,
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  NETWORK_KEYS,
  POLICY_EVENT_TYPES,
  PROTOCOLS,
} from "@kletia/core";
import { ACTION_KINDS } from "../catalog.js";
import { interpretationClarifyFields } from "../clarifyOpenapi.js";
import {
  EVENT_ID_PATTERN,
  INTENT_ID_PATTERN,
  STEP_ID_PATTERN,
  WEBHOOK_ID_PATTERN,
} from "../context.js";
import {
  gasOnArrivalSchema,
  intentStepJourneyFields,
} from "../journeyOpenapi.js";
import {
  ACCOUNT_EXAMPLE,
  arrayOf,
  bool,
  int,
  INTENT_STATUSES,
  type JsonObject,
  num,
  obj,
  ref,
  STEP_STATUSES,
  str,
} from "./helpers.js";

/** Primitives, errors, intents, transactions and events. */
export function intentSchemas(): JsonObject {
  return {
    NetworkKey: str({ enum: [...NETWORK_KEYS], description: "Kletia network key." }),
    CaipChainId: str({ enum: NETWORK_KEYS.map((key) => CHAINS[key].id), description: "CAIP-2 chain id." }),
    AccountId: str({
      description: "CAIP-10 account id: `<CAIP-2>:<address>`.",
      pattern: "^(eip155|solana):[-_a-zA-Z0-9]{1,32}:[A-Za-z0-9]{32,44}$",
      examples: [ACCOUNT_EXAMPLE, "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D"],
    }),
    AssetId: str({
      description: "CAIP-19 asset id. Natives use `slip44`, ERC-20s `erc20`, SPL mints `token`.",
      pattern: "^(eip155|solana):[-_a-zA-Z0-9]{1,32}/(slip44|erc20|token):[A-Za-z0-9]+$",
      examples: ["eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501"],
    }),
    BaseUnits: str({ pattern: "^(0|[1-9][0-9]*)$", description: "Integer amount in base units, as a string." }),
    DecimalAmount: str({ pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", description: "Decimal amount in human units, as a string." }),
    ProtocolId: str({ enum: PROTOCOLS.map((protocol) => protocol.id) }),
    IntentActionKind: str({ enum: [...ACTION_KINDS] }),
    IntentStatus: str({ enum: INTENT_STATUSES }),
    StepStatus: str({ enum: STEP_STATUSES }),
    IntentId: str({ pattern: INTENT_ID_PATTERN.source }),
    StepId: str({ pattern: STEP_ID_PATTERN.source }),
    EventId: str({ pattern: EVENT_ID_PATTERN.source }),

    Error: obj(
      {
        error: obj(
          {
            code: str({
              pattern: "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
              description: "Stable UPPER_SNAKE_CASE code from the error catalog (GET /v1/errors). Provider failures name the provider (`RELAY_UNAVAILABLE`) and resolve to a catalog family entry.",
              examples: ["INTENT_UNSUPPORTED"],
            }),
            message: str(),
            issues: arrayOf(obj({ path: str(), message: str() }, ["path", "message"])),
            hints: arrayOf(str(), { description: "Optional guidance, e.g. example phrases on INTENT_UNSUPPORTED." }),
            docs: str({ format: "uri", description: "Documentation of the code: `https://kletiaai.xyz/developers#error-<CODE>`." }),
            details: {
              type: "object",
              additionalProperties: true,
              description:
                "Structured context of some codes (a JSON object of at most 4 KB), e.g. `SOURCE_REQUIRED` `{ asset, amount, toNetwork, candidates: [{ network, balance, enough }] }`, `SOURCE_UNREACHABLE` `{ sourceNetwork, actionNetwork, asset, kind }`, `SESSION_EXPIRES_BEFORE_ACTIVATION` `{ contract, activatesAt, expiresAt, minimumExpiresInSeconds }`. Clients must tolerate unknown keys.",
            },
            policy: { ...ref("PolicyErrorDetails"), description: "Rule Book refusals: every violated rule, the refusing key, when to retry and the approval to share." },
          },
          ["code", "message"],
        ),
        requestId: str({ format: "uuid" }),
      },
      ["error", "requestId"],
    ),
    ErrorCatalogEntry: obj(
      {
        code: str({ pattern: "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$" }),
        status: { type: ["integer", "null"], description: "HTTP status when returned as an API error; null when the code only appears as `step.failure.code`." },
        otherStatuses: arrayOf(int(), { description: "Statuses the code is also returned with on another path." }),
        category: str({ enum: [...ERROR_CATEGORIES] }),
        retryable: bool({ description: "True when repeating the same request later can succeed without changing it." }),
        step: bool({ description: "Also reported as `step.failure.code`." }),
        title: str(),
        remedy: str(),
        docs: str({ format: "uri" }),
      },
      ["code", "status", "category", "retryable", "title", "remedy", "docs"],
    ),
    ErrorCatalogResponse: obj(
      {
        errors: arrayOf(ref("ErrorCatalogEntry")),
        families: arrayOf(obj({ pattern: str({ examples: ["<PROVIDER>_UNAVAILABLE"] }), code: str() }, ["pattern", "code"]), {
          description: "Dynamic provider codes and the catalog entry describing them.",
        }),
      },
      ["errors", "families"],
    ),

    IntentActionSpec: obj(
      {
        kind: ref("IntentActionKind"),
        network: ref("NetworkKey"),
        from: str({ maxLength: 128, description: "Input asset: symbol on `network`, address/mint or CAIP-19 id." }),
        to: str({ maxLength: 128, description: "Output asset (on `toNetwork` for bridges)." }),
        amount: str({ pattern: "^(max|(0|[1-9][0-9]*)(\\.[0-9]+)?)$", description: "Decimal amount of `from`, or `max` (on a dependent step: the guaranteed output of the previous step)." }),
        toNetwork: ref("NetworkKey"),
        recipient: str({ maxLength: 128, description: "Address or CAIP-10 account. Defaults to the acting account." }),
        protocol: ref("ProtocolId"),
        params: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        contract: str({
          maxLength: CONTRACT_LIMITS.referenceLength,
          pattern: CONTRACT_REFERENCE_PATTERN.source,
          description: "`call` / `action` only (required there): a contract registration id (ct_…) or one of its aliases. Only intents created with the registration's key (or a key of its project, for project-visible registrations) can use it.",
        }),
        entry: str({ pattern: CONTRACT_ENTRY_ID_PATTERN.source, description: "`call` / `action` only (required there): the registration's action id, e.g. `deposit`." }),
      },
      ["kind", "network"],
    ),
    IntentConstraints: obj({
      maxSlippageBps: int({ minimum: 1, maximum: 1000, default: 50 }),
      deadline: int({ minimum: 1, description: "Unix seconds after which the plan must not be executed." }),
      maxFeeUsd: num({ minimum: 0 }),
      preferProtocols: arrayOf(ref("ProtocolId")),
      avoidProtocols: arrayOf(ref("ProtocolId")),
      allowTestnets: bool(),
      maxSeconds: int({
        minimum: MIN_MAX_SECONDS,
        maximum: MAX_MAX_SECONDS,
        default: 600,
        description: "Longest settlement estimate a cross-network step may take; slower venue quotes lose the bridge auction.",
      }),
      gasOnArrival: gasOnArrivalSchema(
        NETWORK_KEYS.filter((key) => CHAINS[key].vm === "evm"),
        GAS_ON_ARRIVAL_USD.min,
        GAS_ON_ARRIVAL_USD.max,
      ),
    }),
    IntentRequest: {
      ...obj(
        {
          text: str({ minLength: 1, maxLength: 1000, examples: ["bridge 25 USDC from base to solana then swap half to JitoSOL"] }),
          actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: 8 }),
          accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6 }),
          defaultNetwork: ref("NetworkKey"),
          sourceNetwork: {
            oneOf: [ref("NetworkKey"), str({ const: "auto" })],
            description:
              "Where the money starts. A network key: the first action spends funds there, and when it runs on another network the planner adds a bridge from this one first (a transfer elsewhere, an input the network does not have, or another capital lane is 422 SOURCE_UNREACHABLE). `auto`: the planner picks a network whose accounts hold enough of the first action's input (422 SOURCE_REQUIRED with `details.candidates` when a bridge has no source and nobody holds enough). A sentence that names the network wins. A network key also serves as `defaultNetwork` when that is absent. Absent: unchanged behaviour. See `interpretation.departure`.",
          },
          constraints: ref("IntentConstraints"),
          metadata: { type: "object", maxProperties: 20, propertyNames: { maxLength: 40 }, additionalProperties: str({ maxLength: 500 }) },
          clientReference: str({ pattern: "^[A-Za-z0-9_.:-]{1,80}$", description: "Idempotency key (honoured for callers with an API key)." }),
          textRedaction: obj(
            {
              alg: str({ const: "sha256-salted-v1" }),
              digest: str({ pattern: "^[0-9a-f]{64}$", description: 'hex SHA-256(UTF8("kletia.request-text.v1:" + salt + ":" + text)).' }),
              salt: str({ pattern: "^[A-Za-z0-9_-]{22}$" }),
              length: int({ minimum: 0, description: "Length of the removed text in Unicode code points." }),
              redactedAt: str({ format: "date-time" }),
            },
            ["alg", "digest", "salt", "length", "redactedAt"],
            {
              readOnly: true,
              description: "Stored intents only, never accepted in a request: retention removed `text` (24 hours after the intent became final) and kept this digest and length instead.",
            },
          ),
        },
        ["accounts"],
      ),
      anyOf: [{ required: ["text"] }, { required: ["actions"] }, { required: ["textRedaction"] }],
    },

    AssetAmount: obj(
      {
        asset: ref("AssetId"),
        symbol: str(),
        decimals: int({ minimum: 0, maximum: 36 }),
        amount: ref("BaseUnits"),
        formatted: ref("DecimalAmount"),
        usd: num(),
      },
      ["asset", "symbol", "decimals", "amount", "formatted"],
    ),
    StepEvidence: obj(
      {
        kind: str({ enum: ["transaction", "receipt", "settlement", "quote", "balance", "note"] }),
        network: ref("NetworkKey"),
        reference: str(),
        url: str({ format: "uri" }),
        observedAt: str({ format: "date-time" }),
        detail: str(),
      },
      ["kind", "network", "observedAt"],
    ),
    StepSettlement: obj(
      {
        kind: str({ enum: ["same-network", "cross-network"] }),
        destinationNetwork: ref("NetworkKey"),
        trackingId: str({ description: "Settlement-network reference (e.g. Relay request id)." }),
        expectedSeconds: int({ minimum: 0 }),
      },
      ["kind"],
    ),
    PreparedStepRecord: obj(
      {
        quoteBinding: str({ description: "SHA-256 binding of the prepared transactions." }),
        preparedAt: str({ format: "date-time" }),
        expiresAt: int({ description: "Unix seconds." }),
        transactions: arrayOf(
          obj(
            {
              vm: str({ enum: ["evm", "svm"] }),
              network: ref("NetworkKey"),
              to: str({ description: "EVM call target; for Solana steps, the program invoked." }),
              feePayer: str({ description: "Solana fee payer." }),
              description: str(),
            },
            ["vm", "network", "description"],
          ),
        ),
      },
      ["quoteBinding", "preparedAt", "expiresAt", "transactions"],
    ),
    IntentStep: obj(
      {
        id: ref("StepId"),
        index: int({ minimum: 0 }),
        kind: ref("IntentActionKind"),
        title: str(),
        network: ref("NetworkKey"),
        chain: ref("CaipChainId"),
        account: ref("AccountId"),
        protocol: ref("ProtocolId"),
        mode: str({ enum: ["wallet", "settlement", "read"] }),
        input: ref("AssetAmount"),
        expectedOutput: ref("AssetAmount"),
        minimumOutput: ref("AssetAmount"),
        recipient: ref("AccountId"),
        recipientName: str({ description: "Name the recipient was resolved from (ENS, Basenames, SNS); resolved again before every prepare." }),
        venue: str({ description: "Registry venue id (e.g. base:aave-v3:usdc) a deposit or withdraw executes against." }),
        dependsOn: arrayOf(str()),
        settlement: ref("StepSettlement"),
        feesUsd: num(),
        extraCosts: arrayOf(ref("AssetAmount"), { description: "Value paid on top of the input, such as a bridge's fixed native fee." }),
        estimatedSeconds: int({ minimum: 0 }),
        status: ref("StepStatus"),
        evidence: arrayOf(ref("StepEvidence")),
        quoteRef: str({ description: "Opaque adapter quote handle." }),
        warnings: arrayOf(str()),
        prepared: ref("PreparedStepRecord"),
        references: arrayOf(str(), { description: "Submitted transaction hashes / signatures, in order." }),
        actualOutput: ref("AssetAmount"),
        failure: obj({ code: str(), message: str() }, ["code", "message"]),
        call: ref("ContractStepCall"),
        ...intentStepJourneyFields(),
      },
      ["id", "index", "kind", "title", "network", "chain", "account", "protocol", "mode", "dependsOn", "status", "evidence"],
    ),
    IntentEdge: obj({ from: str(), to: str(), kind: str({ enum: ["funds", "orders"] }) }, ["from", "to", "kind"]),
    IntentSummary: obj(
      {
        title: str(),
        networks: arrayOf(ref("NetworkKey")),
        inputs: arrayOf(ref("AssetAmount")),
        outputs: arrayOf(ref("AssetAmount")),
        totalFeesUsd: num(),
        estimatedSeconds: int({ minimum: 0 }),
        signaturesRequired: int({ minimum: 0 }),
        crossNetwork: bool(),
      },
      ["title", "networks", "inputs", "outputs", "signaturesRequired", "crossNetwork"],
    ),
    IntentGraph: obj(
      {
        spec: str({ const: INTENT_SPEC_VERSION }),
        id: ref("IntentId"),
        createdAt: str({ format: "date-time" }),
        updatedAt: str({ format: "date-time" }),
        expiresAt: str({ format: "date-time" }),
        status: ref("IntentStatus"),
        request: ref("IntentRequest"),
        interpretation: obj(
          {
            source: str({ enum: ["structured", "grammar", "assistant"] }),
            normalizedText: str(),
            confidence: num({ minimum: 0, maximum: 1 }),
            optimizations: arrayOf(str()),
            departure: obj(
              {
                network: ref("NetworkKey"),
                chosen: str({ enum: ["text", "request", "auto", "inferred"], description: "`text`: the sentence named it; `request`: sourceNetwork; `auto`: chosen by balance; `inferred`: no hint was given." }),
                bridged: bool({ description: "True when the planner added a bridge from `network` in front of the first action." }),
                reason: str({ maxLength: 160, description: "One sentence, e.g. \"Base holds 120.40 USDC; Solana 2.00\"." }),
              },
              ["network", "chosen"],
              { description: "Where the money starts. Present when the request set `sourceNetwork` (or a clarify answer chose a departure); absent on older deployments." },
            ),
            ...interpretationClarifyFields(),
          },
          ["source", "confidence"],
        ),
        steps: arrayOf(ref("IntentStep")),
        edges: arrayOf(ref("IntentEdge")),
        summary: ref("IntentSummary"),
        warnings: arrayOf(str()),
        metadata: { type: "object", additionalProperties: str() },
        plan: obj(
          { digest: str({ pattern: "^[0-9a-f]{64}$" }), record: ref("PlanRecord") },
          ["digest", "record"],
          { description: "The plan as created, recorded once (receipts commit to it); prepare never changes it." },
        ),
        policy: ref("IntentPolicyStamp"),
      },
      ["spec", "id", "createdAt", "updatedAt", "expiresAt", "status", "request", "interpretation", "steps", "edges", "summary", "warnings"],
    ),

    EvmTransactionRequest: obj(
      {
        vm: str({ const: "evm" }),
        network: ref("NetworkKey"),
        chainId: int(),
        from: str({ pattern: "^0x[0-9a-fA-F]{40}$" }),
        to: str({ pattern: "^0x[0-9a-fA-F]{40}$" }),
        data: str({ pattern: "^0x([0-9a-fA-F]{2})*$" }),
        value: ref("BaseUnits"),
        gas: ref("BaseUnits"),
        description: str(),
      },
      ["vm", "network", "chainId", "from", "to", "data", "value", "description"],
      { description: "Send with eth_sendTransaction { from, to, data, value } from `from`." },
    ),
    SolanaTransactionRequest: obj(
      {
        vm: str({ const: "svm" }),
        network: ref("NetworkKey"),
        feePayer: str(),
        transaction: str({ contentEncoding: "base64", description: "Serialized, unsigned v0 transaction." }),
        encoding: str({ const: "base64" }),
        lastValidBlockHeight: int(),
        description: str(),
      },
      ["vm", "network", "feePayer", "transaction", "encoding", "description"],
      { description: "Sign and send with the wallet that owns `feePayer` (solana:signAndSendTransaction)." },
    ),
    TransactionRequest: {
      oneOf: [ref("EvmTransactionRequest"), ref("SolanaTransactionRequest")],
      discriminator: {
        propertyName: "vm",
        mapping: { evm: "#/components/schemas/EvmTransactionRequest", svm: "#/components/schemas/SolanaTransactionRequest" },
      },
    },
    StepExecutionPayload: obj(
      {
        vm: str({ enum: ["evm", "svm"] }),
        transactions: arrayOf(ref("TransactionRequest"), { minItems: 1 }),
        expiresAt: int({ description: "Unix seconds; prepare again after this." }),
        quoteBinding: str(),
        review: { ...ref("ContractReview"), description: "Custom contract steps: the review of exactly these transactions. Show it to the user before handing the transactions to the wallet." },
        preview: { ...ref("StepPreview"), description: "The simulated (or quoted) effect of exactly these transactions; `preview.quoteBinding` equals `quoteBinding`." },
        policy: ref("StepPolicyClearance"),
      },
      ["vm", "transactions", "expiresAt", "quoteBinding"],
    ),

    IntentCreatedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.created" }),
        at: str({ format: "date-time" }),
        data: obj(
          { intentId: ref("IntentId"), summary: ref("IntentSummary"), metadata: { type: "object", additionalProperties: str() } },
          ["intentId", "summary"],
        ),
      },
      ["id", "type", "at", "data"],
    ),
    IntentStatusChangedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.status_changed" }),
        at: str({ format: "date-time" }),
        data: obj({ intentId: ref("IntentId"), status: ref("IntentStatus"), previous: ref("IntentStatus") }, ["intentId", "status", "previous"]),
      },
      ["id", "type", "at", "data"],
    ),
    IntentStepUpdatedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.step_updated" }),
        at: str({ format: "date-time" }),
        data: obj(
          {
            intentId: ref("IntentId"),
            stepId: str(),
            network: ref("NetworkKey"),
            status: ref("StepStatus"),
            evidence: ref("StepEvidence"),
          },
          ["intentId", "stepId", "network", "status"],
        ),
      },
      ["id", "type", "at", "data"],
    ),
    WebhookTestEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "webhook.test" }),
        at: str({ format: "date-time" }),
        data: obj({ webhookId: str({ pattern: WEBHOOK_ID_PATTERN.source }) }, ["webhookId"]),
      },
      ["id", "type", "at", "data"],
    ),
    ContractEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...CONTRACT_EVENT_TYPES] }),
        at: str({ format: "date-time" }),
        data: obj(
          {
            contractId: str({ pattern: CONTRACT_ID_PATTERN.source }),
            ownerKeyId: str(),
            network: ref("NetworkKey"),
            target: str({ description: "Lower-case contract address (EVM) or the Solana Actions origin." }),
            revision: int({ minimum: 1 }),
            reason: str({ description: "Suspensions: pins_changed, outcome_mismatch, program_changed, domain_unverified or `operator: <reason>`." }),
          },
          ["contractId", "ownerKeyId", "network", "target", "revision"],
        ),
      },
      ["id", "type", "at", "data"],
      { description: "Contract registration lifecycle, delivered to the webhooks of the registration's own key only." },
    ),
    KletiaEvent: {
      oneOf: [ref("IntentCreatedEvent"), ref("IntentStatusChangedEvent"), ref("IntentStepUpdatedEvent"), ref("ReceiptIssuedEvent"), ref("ContractEvent"), ref("LinkEvent"), ref("AutomationEvent"), ref("PolicyEvent"), ref("KeyEvent")],
      discriminator: {
        propertyName: "type",
        mapping: {
          "intent.created": "#/components/schemas/IntentCreatedEvent",
          "intent.status_changed": "#/components/schemas/IntentStatusChangedEvent",
          "intent.step_updated": "#/components/schemas/IntentStepUpdatedEvent",
          "intent.receipt_issued": "#/components/schemas/ReceiptIssuedEvent",
          ...Object.fromEntries(CONTRACT_EVENT_TYPES.map((type) => [type, "#/components/schemas/ContractEvent"])),
          ...Object.fromEntries(LINK_EVENT_TYPES.map((type) => [type, "#/components/schemas/LinkEvent"])),
          ...Object.fromEntries(AUTOMATION_EVENT_TYPES.map((type) => [type, "#/components/schemas/AutomationEvent"])),
          ...Object.fromEntries(POLICY_EVENT_TYPES.map((type) => [type, "#/components/schemas/PolicyEvent"])),
          ...Object.fromEntries(KEY_EVENT_TYPES.map((type) => [type, "#/components/schemas/KeyEvent"])),
          ...Object.fromEntries(AGENT_EVENT_TYPES.map((type) => [type, "#/components/schemas/AgentEvent"])),
        },
      },
    },
  };
}
