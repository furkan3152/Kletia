/**
 * Hand-written OpenAPI 3.1 document for Platform API v1. Enumerations
 * (networks, CAIP-2 ids, protocols, action kinds) are generated from
 * @kletia/core so they never drift from the registries; shapes mirror the
 * handlers in router.ts and the types in @kletia/core.
 */
import {
  CHAINS,
  CONTRACT_ADDRESS_LABEL_PATTERN,
  CONTRACT_ALIAS_PATTERN,
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_EVENT_TYPES,
  CONTRACT_ID_PATTERN,
  CONTRACT_LIMITS,
  CONTRACT_PARAM_NAME_PATTERN,
  CONTRACT_REFERENCE_PATTERN,
  CONTRACT_REVIEW_NOTICE,
  CONTRACT_VERB_PATTERN,
  ERROR_CATEGORIES,
  INTENT_SPEC_VERSION,
  KEY_EVENT_TYPES,
  KLETIA_WELL_KNOWN_PATH,
  LINK_EVENT_TYPES,
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  NETWORK_KEYS,
  POLICY_EVENT_TYPES,
  PROTOCOLS,
  SESSION_ID_PATTERN,
} from "@kletia/core";
import { REJECTION_CODES } from "../index.js";
import { ACTION_KINDS } from "./catalog.js";
import { EVENT_ID_PATTERN, INTENT_ID_PATTERN, MAX_REFERENCE_LENGTH, MAX_REFERENCES, STEP_ID_PATTERN, WEBHOOK_ID_PATTERN } from "./context.js";
import { DELIVERY_ERRORS, MAX_DELIVERIES_PER_WEBHOOK, MEMORY_DELIVERIES_PER_WEBHOOK, TEST_DELIVERIES_PER_MINUTE } from "./deliveries.js";
import { PLATFORM_API_VERSION } from "./health.js";
import { IDEMPOTENCY_LOCK_MS, IDEMPOTENCY_TTL_MS } from "./idempotency.js";
import { API_KEY_ID_PATTERN, DEFAULT_ROTATION_GRACE_SECONDS, MAX_ACTIVE_KEYS_PER_PROJECT, MAX_ROTATION_GRACE_SECONDS } from "./keys.js";
import { CONTRACT_TESTS_PER_MINUTE, CONTRACT_WRITES_PER_HOUR, KEY_ISSUANCE_LIMIT_PER_HOUR, TIER_LIMITS } from "./limits.js";
import { HANDOFF_MAX_TEXT } from "./mcp/handoff.js";
import { PREVIEW_ACK_HEADER_SCHEMA, previewPaths, previewSchemas } from "./previewOpenapi.js";
import { receiptPaths, receiptSchemas } from "./receipts/openapi.js";
import { keyPatchOperation, policyPaths, policySchemas } from "./policies/openapi.js";
import { linkPaths, linkSchemas } from "./links/openapi.js";
import { KLETIA_TOOLS } from "./mcp/tools.js";
import { SSE_HEARTBEAT_MS, SSE_MAX_DURATION_MS, SSE_RETRY_MS } from "./sse.js";
import { MAX_WEBHOOKS_PER_KEY, WEBHOOK_EVENT_TYPES } from "./webhooks.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (items: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: "array", items, ...extra });
const str = (extra: JsonObject = {}): JsonObject => ({ type: "string", ...extra });
const int = (extra: JsonObject = {}): JsonObject => ({ type: "integer", ...extra });
const num = (extra: JsonObject = {}): JsonObject => ({ type: "number", ...extra });
const bool = (extra: JsonObject = {}): JsonObject => ({ type: "boolean", ...extra });
const obj = (properties: JsonObject, required: readonly string[] = [], extra: JsonObject = {}): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  ...extra,
});

const INTENT_STATUSES = ["planned", "executing", "settling", "completed", "partially_completed", "failed", "expired", "cancelled", "indeterminate"];
const STEP_STATUSES = ["pending", "ready", "awaiting_signature", "submitted", "confirmed", "settling", "settled", "failed", "skipped", "indeterminate"];
const ACCOUNT_EXAMPLE = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";


const EVM_ADDRESS = "^0x[0-9a-fA-F]{40}$";
const BASE58 = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";
const WEI = "^(0|[1-9][0-9]*)$";
const DECIMAL = "^(0|[1-9][0-9]*)(\\.[0-9]+)?$";

/** Custom contracts (BYOC): registrations, reviews, tests, inspections and sessions. */
function contractSchemas(): JsonObject {
  const sourceStatus = str({ enum: ["exact_match", "match", "unverified", "unknown"] });
  const phrases = obj(
    {
      verbs: arrayOf(str({ pattern: CONTRACT_VERB_PATTERN.source }), { minItems: 1, maxItems: CONTRACT_LIMITS.verbsPerAction }),
      aliases: arrayOf(str({ pattern: CONTRACT_ALIAS_PATTERN.source }), {
        minItems: 1,
        maxItems: CONTRACT_LIMITS.aliasesPerAction,
        description: "Not a network, asset symbol, built-in venue word, `kletia` or grammar keyword.",
      }),
    },
    ["verbs", "aliases"],
    { description: "Natural-language phrases: `<verb> <amount> into <alias>`." },
  );
  const limits = obj({ minAmount: str({ pattern: DECIMAL }), maxAmount: str({ pattern: DECIMAL, description: "Required on mainnet for spending actions." }) });
  return {
    ContractVm: str({ enum: ["evm", "svm"] }),
    AbiParameter: obj(
      {
        name: str(),
        type: str({ description: "Canonical ABI type (`uint256`, `address[]`, `tuple`)." }),
        internalType: str(),
        indexed: bool(),
        components: arrayOf(ref("AbiParameter")),
      },
      ["type"],
    ),
    AbiItem: obj(
      {
        type: str({ enum: ["function", "event", "error"] }),
        name: str(),
        stateMutability: str({ enum: ["nonpayable", "payable", "view", "pure"] }),
        anonymous: bool(),
        inputs: arrayOf(ref("AbiParameter")),
        outputs: arrayOf(ref("AbiParameter")),
      },
      ["type", "name", "inputs"],
    ),
    ArgBinding: {
      description:
        "An argument's value source: `$amount`, `$account`, `$recipient`, `$token`, `$self`, `$minimumOutput`, `$deadline`, `$previous.output.amount`, `$previous.output.asset`, `$param.<name>`, a literal, a tuple or a literal-only array. Kletia encodes every call from the ABI and these bindings; arbitrary calldata never exists.",
      oneOf: [
        str({ pattern: "^\\$(amount|account|recipient|token|self|minimumOutput|deadline|previous\\.output\\.amount|previous\\.output\\.asset|param\\.[a-z][A-Za-z0-9_]{0,31})$" }),
        obj({ literal: { type: ["string", "boolean"] } }, ["literal"], { additionalProperties: false }),
        obj({ tuple: arrayOf(ref("ArgBinding")) }, ["tuple"], { additionalProperties: false }),
        obj({ array: arrayOf(ref("ArgBinding"), { maxItems: CONTRACT_LIMITS.arrayElements }) }, ["array"], { additionalProperties: false }),
      ],
    },
    EventBinding: obj(
      {
        event: str({ description: "Name or full signature of an ABI event (normalised to the signature)." }),
        emitter: str({ description: "`$self` or an `addresses` label; the log must come from that pinned address." }),
        where: {
          type: "object",
          additionalProperties: {
            oneOf: [str({ enum: ["$account", "$recipient", "$amount", "$token", "$self"] }), obj({ literal: { type: ["string", "boolean"] } }, ["literal"])],
          },
          description: "Event input name → binding; at least one binds `$account` or `$recipient`.",
        },
        output: str({ description: "Event input reporting the output amount (needs the action's `output`)." }),
      },
      ["event", "emitter", "where"],
    ),
    ActionParam: obj(
      {
        name: str({ pattern: CONTRACT_PARAM_NAME_PATTERN.source }),
        type: str({ enum: ["uint", "int", "bool", "enum"] }),
        min: str(),
        max: str(),
        enum: arrayOf(str()),
        default: { type: ["string", "boolean"] },
        required: bool(),
      },
      ["name", "type"],
    ),
    EvmContractAction: obj(
      {
        id: str({ pattern: CONTRACT_ENTRY_ID_PATTERN.source }),
        label: str({ maxLength: CONTRACT_LIMITS.labelLength }),
        function: str({ description: "Canonical signature, e.g. `deposit(uint256,address)`; nonpayable or payable." }),
        args: arrayOf(ref("ArgBinding"), { description: "One binding per ABI input, in order." }),
        input: obj(
          {
            token: str({ description: "Registry symbol on the network, CAIP-19 id, or `native`." }),
            approval: obj({ spender: str({ description: "`$self` or an `addresses` label: always an exact approve of the step amount." }) }, ["spender"]),
          },
          ["token"],
        ),
        value: obj({ bind: str({ description: "`$amount` (native input) or a wei literal." }), max: str({ pattern: WEI, description: "Wei cap." }) }, ["bind", "max"]),
        output: obj({ token: str({ description: "`$self`, an `addresses` label or an ERC-20 address." }), toleranceBps: int({ minimum: 0, maximum: CONTRACT_LIMITS.maxToleranceBps, default: CONTRACT_LIMITS.defaultToleranceBps }) }, ["token"]),
        events: arrayOf(ref("EventBinding"), { minItems: 1, maxItems: CONTRACT_LIMITS.eventsPerAction }),
        params: arrayOf(ref("ActionParam"), { maxItems: CONTRACT_LIMITS.paramsPerAction }),
        recipient: str({ enum: ["account", "any"], default: "account" }),
        phrases,
        limits,
        selector: str({ pattern: "^0x[0-9a-f]{8}$", description: "In responses." }),
      },
      ["id", "label", "function", "args", "events"],
    ),
    SolanaActionEndpoint: obj(
      {
        id: str({ pattern: CONTRACT_ENTRY_ID_PATTERN.source }),
        label: str({ maxLength: CONTRACT_LIMITS.labelLength }),
        href: str({ maxLength: CONTRACT_LIMITS.hrefLength, description: "Action URL on `origin`; placeholders `{amount}`, `{amountBaseUnits}` and `{<param>}` only." }),
        primaryProgram: str({ pattern: BASE58 }),
        input: obj({ token: str() }, ["token"]),
        output: obj({ mint: str({ pattern: BASE58 }), toleranceBps: int({ minimum: 0, maximum: CONTRACT_LIMITS.maxToleranceBps }) }, ["mint"]),
        params: arrayOf(ref("ActionParam"), { maxItems: CONTRACT_LIMITS.paramsPerAction }),
        phrases,
        limits,
        metadata: { oneOf: [ref("SolanaActionMetadata"), { type: "null" }], description: "In responses: the action's metadata as fetched at registration." },
      },
      ["id", "label", "href", "primaryProgram"],
    ),
    ContractIntegrator: obj(
      {
        name: str({ minLength: 2, maxLength: 40, description: "Reserved brand names need the brand's own website and a verified domain." }),
        website: str({ format: "uri", description: "HTTPS origin; required on mainnet. Publish `" + KLETIA_WELL_KNOWN_PATH + "` listing the registration id to verify it." }),
      },
      ["name"],
    ),
    EvmContractDefinition: obj(
      {
        vm: str({ const: "evm" }),
        network: ref("NetworkKey"),
        address: str({ pattern: EVM_ADDRESS }),
        integrator: ref("ContractIntegrator"),
        visibility: str({ enum: ["private", "project"], default: "private" }),
        abi: arrayOf(ref("AbiItem"), { minItems: 1, maxItems: CONTRACT_LIMITS.abiItems, description: "An allowlist: every function item must be used by an action." }),
        addresses: arrayOf(obj({ label: str({ pattern: CONTRACT_ADDRESS_LABEL_PATTERN.source }), address: str({ pattern: EVM_ADDRESS }) }, ["label", "address"]), {
          maxItems: CONTRACT_LIMITS.extraAddresses,
          description: "Other contracts an action may name as approval spender or event emitter (pinned like the target).",
        }),
        actions: arrayOf(ref("EvmContractAction"), { minItems: 1, maxItems: CONTRACT_LIMITS.actionsPerRegistration }),
      },
      ["vm", "network", "address", "integrator", "abi", "actions"],
    ),
    SolanaActionDefinition: obj(
      {
        vm: str({ const: "svm" }),
        network: ref("NetworkKey"),
        integrator: ref("ContractIntegrator"),
        visibility: str({ enum: ["private", "project"], default: "private" }),
        origin: str({ format: "uri", description: "HTTPS origin every `href` is on (public DNS name, port 443 or 1024+)." }),
        programs: arrayOf(str({ pattern: BASE58 }), { minItems: 1, maxItems: CONTRACT_LIMITS.programs, description: "Allowlisted top-level programs (pinned)." }),
        payees: arrayOf(obj({ label: str(), address: str({ pattern: BASE58 }), maxLamports: str({ pattern: WEI }) }, ["label", "address", "maxLamports"]), {
          maxItems: CONTRACT_LIMITS.payees,
          description: "The only third parties a top-level System transfer may pay, each with a lamport cap.",
        }),
        actions: arrayOf(ref("SolanaActionEndpoint"), { minItems: 1, maxItems: CONTRACT_LIMITS.actionsPerRegistration }),
      },
      ["vm", "network", "integrator", "origin", "programs", "actions"],
    ),
    ContractDefinition: {
      oneOf: [ref("EvmContractDefinition"), ref("SolanaActionDefinition")],
      discriminator: {
        propertyName: "vm",
        mapping: { evm: "#/components/schemas/EvmContractDefinition", svm: "#/components/schemas/SolanaActionDefinition" },
      },
      description: `Validated by validateContractDefinition (@kletia/core), which reports the same issues locally. At most ${CONTRACT_LIMITS.definitionBytes / 1024} KB as canonical JSON.`,
    },
    ContractDefinitionPatch: {
      type: "object",
      minProperties: 1,
      description:
        "Fields of the definition to replace (`null` removes an optional field); `vm`, `network`, `address` and `origin` cannot change. Changing only labels and phrases updates the current revision; any other change creates a new revision, pending for the activation delay on mainnet.",
      properties: {
        integrator: ref("ContractIntegrator"),
        visibility: str({ enum: ["private", "project"] }),
        abi: arrayOf(ref("AbiItem")),
        addresses: { type: ["array", "null"], items: obj({ label: str(), address: str({ pattern: EVM_ADDRESS }) }, ["label", "address"]) },
        programs: arrayOf(str({ pattern: BASE58 })),
        payees: { type: ["array", "null"], items: obj({ label: str(), address: str(), maxLamports: str() }, ["label", "address", "maxLamports"]) },
        actions: arrayOf({ oneOf: [ref("EvmContractAction"), ref("SolanaActionEndpoint")] }),
      },
    },
    EvmProxyPin: obj(
      {
        kind: str({ enum: ["eip1967", "eip1967-beacon", "eip1822", "zeppelinos", "eip1167"] }),
        implementation: str({ pattern: EVM_ADDRESS }),
        implementationCodeHash: str(),
        admin: { type: ["string", "null"] },
        beacon: { type: ["string", "null"] },
        beaconCodeHash: { type: ["string", "null"] },
      },
      ["kind", "implementation", "implementationCodeHash", "admin", "beacon", "beaconCodeHash"],
    ),
    EvmContractPins: obj(
      {
        codeHash: str(),
        codeSize: int({ minimum: 0 }),
        proxy: { oneOf: [ref("EvmProxyPin"), { type: "null" }] },
        addresses: arrayOf(
          obj(
            { label: str(), address: str(), codeHash: str(), codeSize: int(), proxy: { oneOf: [ref("EvmProxyPin"), { type: "null" }] } },
            ["label", "address", "codeHash", "codeSize", "proxy"],
          ),
        ),
        blockNumber: ref("BaseUnits"),
        checkedAt: str({ format: "date-time" }),
      },
      ["codeHash", "codeSize", "proxy", "addresses", "blockNumber", "checkedAt"],
      { description: "Code identity re-read at every prepare and at the receipt block; any change suspends the registration." },
    ),
    SolanaProgramPin: obj(
      {
        program: str({ pattern: BASE58 }),
        loader: str(),
        programData: { type: ["string", "null"] },
        lastDeploySlot: { type: ["string", "null"] },
        upgradeAuthority: { type: ["string", "null"] },
        dataHash: { type: ["string", "null"] },
      },
      ["program", "loader", "programData", "lastDeploySlot", "upgradeAuthority"],
    ),
    SourceVerification: obj(
      {
        status: sourceStatus,
        provider: str({ const: "sourcify" }),
        checkedAt: { type: ["string", "null"], format: "date-time" },
        url: str({ format: "uri" }),
        proxyType: { type: ["string", "null"] },
      },
      ["status", "provider", "checkedAt"],
    ),
    ProgramVerification: obj(
      {
        program: str(),
        verified: { type: ["boolean", "null"] },
        provider: str({ const: "ottersec" }),
        checkedAt: { type: ["string", "null"], format: "date-time" },
        repository: str({ format: "uri" }),
        commit: str(),
      },
      ["program", "verified", "provider", "checkedAt"],
    ),
    ContractVerification: obj(
      {
        source: { oneOf: [ref("SourceVerification"), { type: "null" }] },
        implementationSource: { oneOf: [ref("SourceVerification"), { type: "null" }] },
        programs: arrayOf(ref("ProgramVerification")),
        domain: obj({ verified: bool(), checkedAt: { type: ["string", "null"], format: "date-time" } }, ["verified", "checkedAt"]),
        risk: { oneOf: [obj({ provider: str({ const: "webacy" }), score: { type: ["number", "null"] }, level: str(), checkedAt: str({ format: "date-time" }) }, ["provider", "score", "checkedAt"]), { type: "null" }] },
      },
      ["domain"],
    ),
    SolanaActionMetadata: obj(
      {
        url: str({ format: "uri" }),
        title: str(),
        label: str(),
        description: str(),
        icon: str(),
        disabled: bool(),
        actionVersion: str(),
        blockchainIds: arrayOf(str()),
        fetchedAt: str({ format: "date-time" }),
      },
      ["url", "title", "label", "disabled", "fetchedAt"],
    ),
    ContractRevisionSummary: obj({ revision: int({ minimum: 1 }), definitionHash: str(), createdAt: str({ format: "date-time" }) }, ["revision", "definitionHash", "createdAt"]),
    ContractView: obj(
      {
        id: str({ pattern: CONTRACT_ID_PATTERN.source }),
        vm: ref("ContractVm"),
        network: ref("NetworkKey"),
        address: str({ pattern: EVM_ADDRESS, description: "EVM: checksummed contract address." }),
        origin: str({ format: "uri", description: "Solana Actions: the registered origin." }),
        integrator: obj({ name: str(), website: str({ format: "uri" }), domainVerified: bool() }, ["name", "domainVerified"]),
        visibility: str({ enum: ["private", "project"] }),
        status: str({ enum: ["pending", "active", "suspended"] }),
        revision: int({ minimum: 1, description: "Latest revision; the definition fields describe it." }),
        activeRevision: { type: ["integer", "null"], description: "The revision intents use; null while the first revision waits for activation." },
        pendingRevision: { type: ["integer", "null"] },
        activatesAt: { type: ["string", "null"], format: "date-time" },
        definitionHash: str({ pattern: "^[0-9a-f]{64}$", description: "sha256 of the canonical security-relevant fields." }),
        pins: { oneOf: [ref("EvmContractPins"), arrayOf(ref("SolanaProgramPin"))] },
        verification: ref("ContractVerification"),
        actions: arrayOf({ oneOf: [ref("EvmContractAction"), ref("SolanaActionEndpoint")] }),
        abi: arrayOf(ref("AbiItem"), { description: "Owner only." }),
        addresses: arrayOf(obj({ label: str(), address: str() }, ["label", "address"]), { description: "Owner only." }),
        programs: arrayOf(str(), { description: "Owner only." }),
        payees: arrayOf(obj({ label: str(), address: str(), maxLamports: str() }, ["label", "address", "maxLamports"]), { description: "Owner only." }),
        revisions: arrayOf(ref("ContractRevisionSummary"), { description: "Owner only, GET /v1/contracts/{id}: newest first." }),
        createdAt: str({ format: "date-time" }),
        updatedAt: str({ format: "date-time" }),
        suspendedReason: { type: ["string", "null"], description: "pins_changed, outcome_mismatch, program_changed, domain_unverified or `operator: <reason>`." },
      },
      ["id", "vm", "network", "integrator", "visibility", "status", "revision", "activeRevision", "pendingRevision", "activatesAt", "definitionHash", "pins", "verification", "actions", "createdAt", "updatedAt", "suspendedReason"],
    ),
    AssetChange: obj(
      {
        asset: str({ description: "CAIP-19 id." }),
        symbol: str(),
        decimals: int(),
        listed: bool({ description: "True for registry assets." }),
        delta: str({ pattern: "^-?(0|[1-9][0-9]*)$", description: "Signed base units (negative: debit)." }),
        formatted: str(),
      },
      ["asset", "symbol", "decimals", "listed", "delta", "formatted"],
    ),
    ContractReview: obj(
      {
        kind: str({ enum: ["evm-call", "solana-action"] }),
        integrator: obj({ name: str(), website: str({ format: "uri" }), domainVerified: bool() }, ["name", "domainVerified"]),
        notices: arrayOf(str(), { minItems: 1, description: `Always starts with "${CONTRACT_REVIEW_NOTICE}"` }),
        contract: obj(
          {
            network: ref("NetworkKey"),
            address: str(),
            explorerUrl: str({ format: "uri" }),
            source: sourceStatus,
            proxy: obj({ kind: str(), implementation: str(), implementationSource: sourceStatus }, ["kind", "implementation", "implementationSource"]),
            registeredAt: str({ format: "date-time" }),
            revision: int(),
          },
          ["network", "address", "explorerUrl", "source", "registeredAt", "revision"],
        ),
        call: obj(
          {
            label: str(),
            function: str({ examples: ["deposit(uint256 assets, address receiver)"] }),
            args: arrayOf(
              obj(
                {
                  name: str(),
                  type: str(),
                  display: str(),
                  source: str({ enum: ["amount", "account", "recipient", "token", "self", "minimumOutput", "deadline", "previousOutput", "param", "literal"] }),
                },
                ["name", "type", "display", "source"],
              ),
            ),
            value: ref("AssetAmount"),
          },
          ["label", "function", "args"],
        ),
        approvals: arrayOf(
          obj(
            {
              token: obj({ asset: ref("AssetId"), symbol: str(), decimals: int() }, ["asset", "symbol", "decimals"]),
              spender: str(),
              amount: ref("AssetAmount"),
              existingAllowance: ref("AssetAmount"),
            },
            ["token", "spender", "amount"],
          ),
        ),
        action: obj(
          {
            url: str({ format: "uri" }),
            domain: str(),
            title: str(),
            programs: arrayOf(obj({ id: str(), verified: { type: ["boolean", "null"] }, upgradeable: bool(), upgradeAuthority: { type: ["string", "null"] } }, ["id", "verified", "upgradeable", "upgradeAuthority"])),
            instructionCount: int(),
          },
          ["url", "domain", "programs", "instructionCount"],
        ),
        simulation: obj(
          {
            status: str({ enum: ["ok", "unavailable"] }),
            at: str({ format: "date-time" }),
            block: str(),
            slot: str(),
            assetChanges: arrayOf(ref("AssetChange")),
            networkFee: ref("AssetAmount"),
            warnings: arrayOf(str()),
          },
          ["status", "at", "assetChanges", "warnings"],
        ),
      },
      ["kind", "integrator", "notices", "approvals", "simulation"],
      { description: "What the user reviews before signing a custom contract step: who, what, permissions, result, provenance, notice. Kletia has not audited the contract." },
    ),
    ContractStepCall: obj(
      {
        contract: str({ pattern: CONTRACT_ID_PATTERN.source }),
        revision: int({ minimum: 1 }),
        definitionHash: str(),
        entry: str({ pattern: CONTRACT_ENTRY_ID_PATTERN.source }),
        vm: ref("ContractVm"),
        target: str({ description: "EVM contract address or the Solana Action's primary program." }),
        integrator: obj({ name: str(), website: str(), domainVerified: bool() }, ["name", "domainVerified"]),
        label: str(),
        function: str(),
        selector: str(),
        fragment: ref("AbiItem"),
        bindings: arrayOf(ref("ArgBinding")),
        approvalSpender: str(),
        value: obj({ bind: str(), max: str() }, ["bind", "max"]),
        events: arrayOf(obj({ fragment: ref("AbiItem"), emitter: str(), where: { type: "object" }, output: str() }, ["fragment", "emitter", "where"])),
        pins: ref("EvmContractPins"),
        recipientMode: str({ enum: ["account", "any"] }),
        toleranceBps: int(),
        origin: str(),
        href: str(),
        programs: arrayOf(ref("SolanaProgramPin")),
        payees: arrayOf(obj({ address: str(), maxLamports: str() }, ["address", "maxLamports"])),
        params: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        output: obj({ asset: ref("AssetId"), symbol: str(), decimals: int() }, ["asset", "symbol", "decimals"]),
        review: ref("ContractReview"),
      },
      ["contract", "revision", "definitionHash", "entry", "vm", "target", "integrator", "review"],
      { description: "Self-contained snapshot of the registration a call/action step was planned with; verification never needs the registry." },
    ),
    ContractTestRequest: obj(
      {
        entry: str({ pattern: CONTRACT_ENTRY_ID_PATTERN.source }),
        account: ref("AccountId"),
        amount: ref("DecimalAmount"),
        params: { type: "object", maxProperties: 8, additionalProperties: { type: ["string", "number", "boolean"] } },
        recipient: str({ maxLength: 128 }),
      },
      ["entry", "account"],
    ),
    ContractTestResult: obj(
      {
        contract: str({ pattern: CONTRACT_ID_PATTERN.source }),
        revision: int(),
        entry: str(),
        network: ref("NetworkKey"),
        account: ref("AccountId"),
        input: ref("AssetAmount"),
        expectedOutput: ref("AssetAmount"),
        minimumOutput: ref("AssetAmount"),
        transactions: arrayOf(
          obj({ description: str(), to: str(), selector: str(), value: ref("BaseUnits"), programs: arrayOf(str()) }, ["description"]),
          { description: "What would be signed (never calldata to persist)." },
        ),
        gas: ref("BaseUnits"),
        feesUsd: num(),
        review: ref("ContractReview"),
        warnings: arrayOf(str()),
      },
      ["contract", "revision", "entry", "network", "account", "transactions", "review", "warnings"],
    ),
    AbiFunctionClassification: obj(
      {
        name: str(),
        signature: str(),
        selector: str(),
        stateMutability: str({ enum: ["nonpayable", "payable", "view", "pure"] }),
        allowed: bool(),
        code: { type: ["string", "null"], enum: ["CONTRACT_FUNCTION_FORBIDDEN", "CONTRACT_ARGUMENT_FORBIDDEN", null] },
        reason: { type: ["string", "null"] },
        notes: arrayOf(str()),
      },
      ["name", "signature", "selector", "stateMutability", "allowed", "code", "reason", "notes"],
    ),
    EvmContractInspection: obj(
      {
        vm: str({ const: "evm" }),
        network: ref("NetworkKey"),
        address: str(),
        deployed: bool(),
        codeSize: int({ minimum: 0 }),
        eip7702: bool({ description: "EIP-7702 delegated account (cannot be registered)." }),
        denied: { type: ["string", "null"], description: "Why the address can never be registered, or null." },
        pins: { oneOf: [ref("EvmContractPins"), { type: "null" }] },
        verification: obj({ source: ref("SourceVerification"), implementationSource: { oneOf: [ref("SourceVerification"), { type: "null" }] } }, ["source", "implementationSource"]),
        abi: { type: ["array", "null"], items: ref("AbiItem"), description: "From Sourcify when verified (the implementation's for a proxy)." },
        functions: arrayOf(ref("AbiFunctionClassification")),
      },
      ["vm", "network", "address", "deployed", "codeSize", "eip7702", "denied", "pins", "verification", "abi", "functions"],
    ),
    SolanaProgramInspection: obj(
      {
        vm: str({ const: "svm" }),
        network: ref("NetworkKey"),
        programs: arrayOf(
          obj(
            { program: str(), pin: { oneOf: [ref("SolanaProgramPin"), { type: "null" }] }, denied: { type: ["string", "null"] }, verification: ref("ProgramVerification") },
            ["program", "pin", "denied", "verification"],
          ),
        ),
      },
      ["vm", "network", "programs"],
    ),
    ContractInspection: {
      oneOf: [ref("EvmContractInspection"), ref("SolanaProgramInspection")],
      discriminator: { propertyName: "vm", mapping: { evm: "#/components/schemas/EvmContractInspection", svm: "#/components/schemas/SolanaProgramInspection" } },
    },
    ContractSuspendRequest: obj({ reason: str({ minLength: 1, maxLength: 200 }) }, ["reason"]),
    ContractResponse: obj({ contract: ref("ContractView") }, ["contract"]),
    ContractListResponse: obj({ contracts: arrayOf(ref("ContractView")) }, ["contracts"]),
    ContractTestResponse: obj({ test: ref("ContractTestResult") }, ["test"]),
    ContractInspectionResponse: obj({ inspection: ref("ContractInspection") }, ["inspection"]),

    SessionCreateRequest: obj(
      {
        actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: 8, description: "Structured actions only (no text)." }),
        amount: obj(
          {
            action: int({ minimum: 0, description: "Index of the action whose amount the visitor may choose (its amount is the default)." }),
            min: ref("DecimalAmount"),
            max: ref("DecimalAmount"),
          },
          ["action", "min", "max"],
        ),
        allowedOrigins: arrayOf(str({ format: "uri" }), {
          minItems: 1,
          maxItems: CONTRACT_LIMITS.sessionAllowedOrigins,
          description: "Origins of the pages that may embed the session (https, or http://localhost for development).",
        }),
        expiresInSeconds: int({ minimum: CONTRACT_LIMITS.sessionMinTtlSeconds, maximum: CONTRACT_LIMITS.sessionMaxTtlSeconds, default: CONTRACT_LIMITS.sessionDefaultTtlSeconds }),
        maxIntents: int({ minimum: 1, maximum: CONTRACT_LIMITS.sessionMaxIntents, default: 1 }),
        constraints: ref("IntentConstraints"),
        metadata: { type: "object", maxProperties: 19, additionalProperties: str({ maxLength: 500 }), description: "Copied to every intent, plus `sessionId`." },
        clientReference: str({ pattern: "^[A-Za-z0-9_.:-]{1,80}$" }),
      },
      ["actions", "allowedOrigins"],
    ),
    SessionView: obj(
      {
        id: str({ pattern: SESSION_ID_PATTERN.source }),
        status: str({ enum: ["active", "expired", "used"] }),
        expiresAt: str({ format: "date-time" }),
        createdAt: str({ format: "date-time" }),
        integrator: obj({ name: str(), website: str({ format: "uri" }), domainVerified: bool() }, ["name", "domainVerified"]),
        allowedOrigins: arrayOf(str()),
        actions: arrayOf(
          obj(
            {
              kind: ref("IntentActionKind"),
              network: ref("NetworkKey"),
              toNetwork: ref("NetworkKey"),
              from: str(),
              to: str(),
              amount: str(),
              contract: str(),
              entry: str(),
              label: str(),
            },
            ["kind", "network", "label"],
          ),
        ),
        amount: obj({ action: int(), min: ref("DecimalAmount"), max: ref("DecimalAmount"), default: ref("DecimalAmount"), symbol: str() }, ["action", "min", "max"]),
        maxIntents: int({ minimum: 1 }),
        used: int({ minimum: 0 }),
        embedUrl: str({ format: "uri", description: "Creation response only: the embed page with the id in the URL fragment." }),
      },
      ["id", "status", "expiresAt", "createdAt", "integrator", "allowedOrigins", "actions", "maxIntents", "used"],
      { description: "Never carries the API key or the project." },
    ),
    SessionIntentRequest: obj(
      {
        accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6, description: "The visitor's connected accounts." }),
        amount: ref("DecimalAmount"),
        hostOrigin: str({ format: "uri", description: "Origin of the page hosting the frame; must be one of the session's allowedOrigins." }),
      },
      ["accounts", "hostOrigin"],
    ),
    SessionResponse: obj({ session: ref("SessionView") }, ["session"]),
  };
}

function schemas(): JsonObject {
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
    }),
    IntentRequest: {
      ...obj(
        {
          text: str({ minLength: 1, maxLength: 1000, examples: ["bridge 25 USDC from base to solana then swap half to JitoSOL"] }),
          actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: 8 }),
          accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6 }),
          defaultNetwork: ref("NetworkKey"),
          constraints: ref("IntentConstraints"),
          metadata: { type: "object", maxProperties: 20, propertyNames: { maxLength: 40 }, additionalProperties: str({ maxLength: 500 }) },
          clientReference: str({ pattern: "^[A-Za-z0-9_.:-]{1,80}$", description: "Idempotency key (honoured for callers with an API key)." }),
        },
        ["accounts"],
      ),
      anyOf: [{ required: ["text"] }, { required: ["actions"] }],
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
      oneOf: [ref("IntentCreatedEvent"), ref("IntentStatusChangedEvent"), ref("IntentStepUpdatedEvent"), ref("ReceiptIssuedEvent"), ref("ContractEvent"), ref("LinkEvent"), ref("PolicyEvent"), ref("KeyEvent")],
      discriminator: {
        propertyName: "type",
        mapping: {
          "intent.created": "#/components/schemas/IntentCreatedEvent",
          "intent.status_changed": "#/components/schemas/IntentStatusChangedEvent",
          "intent.step_updated": "#/components/schemas/IntentStepUpdatedEvent",
          "intent.receipt_issued": "#/components/schemas/ReceiptIssuedEvent",
          ...Object.fromEntries(CONTRACT_EVENT_TYPES.map((type) => [type, "#/components/schemas/ContractEvent"])),
          ...Object.fromEntries(LINK_EVENT_TYPES.map((type) => [type, "#/components/schemas/LinkEvent"])),
          ...Object.fromEntries(POLICY_EVENT_TYPES.map((type) => [type, "#/components/schemas/PolicyEvent"])),
          ...Object.fromEntries(KEY_EVENT_TYPES.map((type) => [type, "#/components/schemas/KeyEvent"])),
        },
      },
    },

    Chain: obj(
      {
        key: ref("NetworkKey"),
        id: ref("CaipChainId"),
        namespace: str({ enum: ["eip155", "solana"] }),
        reference: str(),
        vm: str({ enum: ["evm", "svm"] }),
        name: str(),
        shortName: str(),
        environment: str({ enum: ["mainnet", "testnet"] }),
        lane: str({ enum: ["production", "beta", "testnet"] }),
        nativeAsset: obj({ symbol: str(), name: str(), decimals: int() }, ["symbol", "name", "decimals"]),
        explorer: obj({ name: str(), tx: str(), address: str() }, ["name", "tx", "address"]),
        color: str(),
        evmChainId: int(),
        walletChain: str(),
        settlement: obj({ cctpDomain: int(), relayChainId: int(), debridgeChainId: int(), acrossChainId: int() }),
        counterpart: ref("NetworkKey"),
      },
      ["key", "id", "namespace", "reference", "vm", "name", "shortName", "environment", "lane", "nativeAsset", "explorer", "color", "settlement"],
    ),
    NetworkCapabilities: {
      allOf: [
        ref("Chain"),
        obj(
          {
            actions: arrayOf(ref("IntentActionKind"), { description: "Action kinds executable with this network as the source." }),
            protocols: arrayOf(ref("ProtocolId"), { description: "Registry protocols present on this network." }),
            executableProtocols: arrayOf(ref("ProtocolId")),
            routes: arrayOf(
              obj({ kind: ref("IntentActionKind"), protocol: ref("ProtocolId"), toNetworks: arrayOf(ref("NetworkKey")) }, ["kind", "protocol", "toNetworks"]),
            ),
            assetCount: int({ minimum: 0 }),
            customContracts: obj(
              {
                kind: str({ enum: ["call", "action"] }),
                protocol: ref("ProtocolId"),
                enabled: bool({ description: "False while the deployment disables custom contracts or no adapter executes them." }),
              },
              ["kind", "protocol", "enabled"],
              { description: "How this network takes integrator contracts: EVM `call` steps, Solana `action` steps (registrations: POST /v1/contracts)." },
            ),
          },
          ["actions", "protocols", "executableProtocols", "routes", "assetCount", "customContracts"],
        ),
      ],
    },
    Protocol: obj(
      {
        id: ref("ProtocolId"),
        name: str(),
        category: str({ enum: [...new Set(["dex-aggregator", "dex", "bridge", "intent-network", "lending", "liquid-staking", "yield", "naming", "payments", "security", "data", "token-program", "custom", ...PROTOCOLS.map((protocol) => protocol.category)])] }),
        networks: arrayOf(ref("NetworkKey")),
        capabilities: arrayOf(str({ enum: ["execute", "quote", "discover"] })),
        website: str({ format: "uri" }),
        summary: str(),
        crossChain: bool(),
        executable: bool({ description: "True when the engine has an execution adapter for this protocol." }),
      },
      ["id", "name", "category", "networks", "capabilities", "website", "summary", "executable"],
    ),
    Asset: obj(
      {
        id: ref("AssetId"),
        network: ref("NetworkKey"),
        symbol: str(),
        name: str(),
        decimals: int(),
        address: { type: ["string", "null"], description: "ERC-20 contract or SPL mint; null for the native asset." },
        category: str({ enum: ["native", "stablecoin", "wrapped", "liquid-staking", "governance", "meme", "btc"] }),
        tokenProgram: str({ enum: ["spl-token", "token-2022"] }),
        group: str({ enum: ["USDC", "USDT", "ETH", "BTC", "EURC", "SOL"] }),
      },
      ["id", "network", "symbol", "name", "decimals", "address", "category"],
    ),

    QuoteRequest: {
      oneOf: [
        obj(
          {
            network: ref("NetworkKey"),
            from: str({ maxLength: 128, description: "Input asset on `network`: symbol, address/mint or CAIP-19 id." }),
            to: str({ maxLength: 128, description: "Output asset on `toNetwork`." }),
            toNetwork: ref("NetworkKey"),
            amount: ref("DecimalAmount"),
            account: str({ maxLength: 128, description: "Sender address or CAIP-10 account (placeholder when omitted)." }),
            recipient: str({ maxLength: 128 }),
            slippageBps: int({ minimum: 1, maximum: 1000 }),
            maxSeconds: int({ minimum: MIN_MAX_SECONDS, maximum: MAX_MAX_SECONDS, default: 600, description: "Longest acceptable settlement estimate; slower routes are not eligible as best." }),
          },
          ["network", "from", "to", "amount"],
          { title: "Flat" },
        ),
        obj(
          {
            from: obj(
              {
                network: ref("NetworkKey"),
                asset: str({ maxLength: 128 }),
                amount: ref("DecimalAmount"),
                account: str({ maxLength: 128, description: "Sender address or CAIP-10 account (overrides top-level `account`)." }),
              },
              ["network", "asset", "amount"],
            ),
            to: obj(
              {
                network: { ...ref("NetworkKey"), description: "Defaults to `from.network`." },
                asset: str({ maxLength: 128 }),
                recipient: str({ maxLength: 128, description: "Recipient address or CAIP-10 account (overrides top-level `recipient`)." }),
              },
              ["asset"],
            ),
            account: str({ maxLength: 128 }),
            recipient: str({ maxLength: 128 }),
            slippageBps: int({ minimum: 1, maximum: 1000 }),
            maxSeconds: int({ minimum: MIN_MAX_SECONDS, maximum: MAX_MAX_SECONDS, default: 600, description: "Longest acceptable settlement estimate; slower routes are not eligible as best." }),
          },
          ["from", "to"],
          { title: "Nested (SDK)" },
        ),
      ],
    },
    QuoteRoute: obj(
      {
        protocol: ref("ProtocolId"),
        label: str(),
        network: ref("NetworkKey"),
        toNetwork: ref("NetworkKey"),
        input: ref("AssetAmount"),
        output: ref("AssetAmount"),
        minimumOutput: ref("AssetAmount"),
        netMinimumOutput: { ...ref("AssetAmount"), description: "Guaranteed output net of extra costs; absent when those costs cannot be priced." },
        feesUsd: num(),
        extraCosts: arrayOf(ref("AssetAmount"), { description: "Value paid on top of the input (e.g. a fixed native fee)." }),
        estimatedSeconds: int({ minimum: 0 }),
        transactionCount: int({ minimum: 0 }),
        settlement: ref("StepSettlement"),
        warnings: arrayOf(str()),
        quoteId: str(),
        eligible: bool({ description: "False when the route cannot be chosen as best (too slow, unpriced extra costs, another asset)." }),
      },
      ["protocol", "label", "network", "toNetwork", "input", "output", "minimumOutput", "estimatedSeconds", "transactionCount", "settlement", "warnings", "eligible"],
    ),
    QuoteResponse: obj(
      {
        routes: arrayOf(ref("QuoteRoute")),
        best: { oneOf: [ref("QuoteRoute"), { type: "null" }] },
        quotedAt: str({ format: "date-time" }),
        unavailable: arrayOf(obj({ protocol: ref("ProtocolId"), code: str(), message: str() }, ["protocol", "code", "message"])),
      },
      ["routes", "best", "quotedAt", "unavailable"],
    ),
    PortfolioHolding: obj(
      {
        asset: ref("AssetId"),
        symbol: str(),
        name: str(),
        decimals: int(),
        amount: ref("BaseUnits"),
        formatted: ref("DecimalAmount"),
        usd: { type: ["number", "null"] },
        verified: bool(),
        isNative: bool(),
      },
      ["asset", "symbol", "name", "decimals", "amount", "formatted", "usd", "verified", "isNative"],
    ),
    Portfolio: obj(
      {
        account: ref("AccountId"),
        network: ref("NetworkKey"),
        holdings: arrayOf(ref("PortfolioHolding")),
        totalUsd: num(),
        unpricedCount: int({ minimum: 0 }),
        observedAt: str({ format: "date-time" }),
      },
      ["account", "network", "holdings", "totalUsd", "unpricedCount", "observedAt"],
    ),
    Health: obj(
      {
        status: str({ enum: ["ok", "degraded", "down"] }),
        api: str({ const: "v1" }),
        version: str(),
        time: str({ format: "date-time" }),
        uptimeSeconds: int({ minimum: 0 }),
        networks: arrayOf(
          obj(
            {
              network: ref("NetworkKey"),
              chain: ref("CaipChainId"),
              name: str(),
              environment: str({ enum: ["mainnet", "testnet"] }),
              ok: bool(),
              latencyMs: int({ minimum: 0 }),
              height: str({ description: "Latest block (EVM) or slot (Solana)." }),
              detail: str(),
            },
            ["network", "chain", "name", "environment", "ok", "latencyMs"],
          ),
        ),
        storage: obj({ intents: str(), apiKeys: str(), webhooks: str(), contracts: str(), sessions: str() }, ["intents", "apiKeys", "webhooks", "contracts", "sessions"]),
        policies: obj(
          {
            enabled: bool({ description: "False when the deployment switched enforcement off: rule books are stored but not enforced." }),
            stores: obj({ ruleBooks: str(), spend: str(), decisions: str(), approvals: str() }, ["ruleBooks", "spend", "decisions", "approvals"]),
          },
          ["enabled", "stores"],
        ),
        links: obj({ enabled: bool(), blinks: bool(), store: str() }, ["enabled", "blinks", "store"]),
        webhooks: obj(
          {
            status: str({ enum: ["enabled", "needs_configuration"] }),
            sealing: str({
              enum: ["configured", "development_fallback", "missing"],
              description: "`development_fallback` (a published key) is only used by development processes with in-memory stores.",
            }),
            dispatcher: {
              oneOf: [
                obj(
                  {
                    running: bool(),
                    storage: str({ enum: ["memory", "postgres"] }),
                    queued: int(),
                    inFlight: int(),
                    scheduledRetries: int(),
                    delivered: int(),
                    failed: int(),
                    dropped: int(),
                    pausedWebhooks: int({ description: "Webhooks paused after consecutive delivery failures." }),
                  },
                  ["running", "storage", "queued", "inFlight", "scheduledRetries", "delivered", "failed", "dropped", "pausedWebhooks"],
                ),
                { type: "null" },
              ],
            },
          },
          ["status", "dispatcher"],
        ),
        contracts: obj(
          {
            enabled: bool({ description: "False when the deployment's kill switch disables custom contracts." }),
            simulation: {
              type: ["object", "null"],
              additionalProperties: str({ enum: ["ok", "unavailable"] }),
              description: "Per network: whether a configured endpoint can simulate now (custom contract steps are never prepared unsimulated). Null when not probed.",
            },
          },
          ["enabled", "simulation"],
        ),
        receipts: obj(
          {
            signer: str({ enum: ["configured", "development", "missing", "disabled"], description: "`missing`: receipts queue until a signing key is configured; `disabled`: the kill switch is on." }),
            store: str({ enum: ["memory", "postgres", "unavailable"] }),
            queue: { type: ["integer", "null"], minimum: 0, description: "Intents waiting for a receipt (finality, retries, a missing key)." },
            oldestPendingSeconds: { type: ["integer", "null"], minimum: 0 },
            lastBatch: { oneOf: [obj({ seq: int({ minimum: 1 }), anchored: bool() }, ["seq", "anchored"]), { type: "null" }] },
          },
          ["signer", "store", "queue", "oldestPendingSeconds", "lastBatch"],
        ),
        preview: obj({ store: str({ enum: ["memory", "postgres", "custom"] }) }, ["store"]),
      },
      ["status", "api", "version", "time", "uptimeSeconds", "networks", "storage", "policies", "links", "webhooks", "contracts", "receipts", "preview"],
    ),

    Webhook: obj(
      {
        id: str({ pattern: "^wh_[0-9a-f]{24}$" }),
        url: str({ format: "uri" }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] })),
        createdAt: str({ format: "date-time" }),
        scope: str({ enum: ["self", "subtree"], description: "`subtree`: also events of the owner's descendant agent keys (and, on project keys, project-wide Rule Book events)." }),
        secret: str({ pattern: "^whsec_[0-9A-Za-z]{32}$", description: "Signing secret. Returned only by POST /v1/webhooks." }),
      },
      ["id", "url", "events", "createdAt", "scope"],
    ),
    WebhookCreateRequest: obj(
      {
        url: str({ format: "uri", pattern: "^https://", maxLength: 2048, description: "Public HTTPS endpoint (private, loopback and link-local targets are refused)." }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] }), {
          minItems: 1,
          uniqueItems: true,
          description: "Defaults to every event type that exists when the webhook is created (intent events of the key's intents, contract events of its registrations, link events of its links, Rule Book and key events of the key).",
        }),
        scope: str({ enum: ["self", "subtree"], default: "self", description: "`subtree`: also deliver the events of every descendant agent key (and, on a project key, the project's Rule Book events)." }),
      },
      ["url"],
    ),
    ApiKeyCreateRequest: obj({ name: str({ minLength: 1, maxLength: 64 }) }, ["name"]),
    ApiKey: obj(
      {
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        tier: str({ enum: ["developer", "operator"] }),
        createdAt: str({ format: "date-time" }),
        key: str({ pattern: "^kl_dev_[0-9A-Za-z]{32}$", description: "The raw key. Shown once; only its SHA-256 hash is stored." }),
      },
      ["id", "name", "tier", "createdAt", "key"],
    ),
    RotatedApiKey: {
      allOf: [
        ref("ApiKey"),
        obj(
          {
            rotatedAt: str({ format: "date-time" }),
            previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "When the previous secret stops authenticating; null when it already has (graceSeconds 0)." },
          },
          ["rotatedAt", "previousExpiresAt"],
        ),
      ],
    },
    ApiKeyRotateRequest: obj({
      graceSeconds: int({
        minimum: 0,
        maximum: MAX_ROTATION_GRACE_SECONDS,
        default: DEFAULT_ROTATION_GRACE_SECONDS,
        description: "How long the previous secret keeps authenticating (it can never manage keys). 0 revokes it immediately.",
      }),
    }),
    ApiKeyView: obj(
      {
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        tier: str({ enum: ["developer"] }),
        kind: str({ enum: ["project", "agent"], description: "`agent`: a kl_agt_ key issued under another key (POST /v1/keys/{id}/children)." }),
        parentId: { type: ["string", "null"], description: "Parent of an agent key." },
        depth: int({ minimum: 0, description: "Levels below the project key (0 for project keys)." }),
        expiresAt: { type: ["string", "null"], format: "date-time", description: "When the key stops authenticating (always set on agent keys)." },
        policyVersion: { type: ["integer", "null"], description: "Active rule book version (null: none; an agent key without one is an observer)." },
        descendants: int({ minimum: 0, description: "Active agent keys below this key." }),
        last4: { type: ["string", "null"], description: "Last four characters of the current secret (null for keys issued before they were recorded)." },
        createdAt: str({ format: "date-time" }),
        lastUsedAt: { type: ["string", "null"], format: "date-time", description: "Updated at most once a minute." },
        rotatedAt: { type: ["string", "null"], format: "date-time" },
        previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "End of the open grace window of the previous secret." },
        revokedAt: { type: ["string", "null"], format: "date-time" },
        current: bool({ description: "The key that made this request." }),
      },
      ["id", "name", "tier", "kind", "parentId", "depth", "last4", "createdAt", "lastUsedAt", "rotatedAt", "previousExpiresAt", "revokedAt", "expiresAt", "policyVersion", "descendants", "current"],
    ),
    WebhookDelivery: obj(
      {
        id: str({ pattern: "^whd_[0-9a-f]{24}$" }),
        webhookId: str({ pattern: WEBHOOK_ID_PATTERN.source }),
        eventId: ref("EventId"),
        eventType: str({ enum: [...WEBHOOK_EVENT_TYPES, "webhook.test"] }),
        intentId: ref("IntentId"),
        attempt: int({ minimum: 1, maximum: 4 }),
        status: str({ enum: ["succeeded", "failed", "dropped"] }),
        httpStatus: int({ description: "Status the endpoint answered with." }),
        durationMs: int({ minimum: 0 }),
        error: str({
          enum: [...DELIVERY_ERRORS],
          description: "Failure class (error text and payloads are never stored). `redirect`: a 3xx answer, which is never followed; `queue_full`: dropped before sending.",
        }),
        nextRetryAt: str({ format: "date-time", description: "When a failed attempt is retried." }),
        test: bool({ description: "A POST /v1/webhooks/{id}/test delivery." }),
        at: str({ format: "date-time" }),
      },
      ["id", "webhookId", "eventId", "eventType", "attempt", "status", "at"],
    ),
    UsageReport: obj(
      {
        keyId: str(),
        tier: str({ enum: ["developer", "operator"] }),
        window: str({ enum: ["24h", "7d"] }),
        since: str({ format: "date-time", description: "Start of the first hour in the window." }),
        generatedAt: str({ format: "date-time" }),
        rateLimit: obj(
          {
            limit: int(),
            remaining: int({ minimum: 0 }),
            resetAt: { type: ["string", "null"], format: "date-time" },
            windowSeconds: int(),
          },
          ["limit", "remaining", "resetAt", "windowSeconds"],
          { description: "The current 1-minute window as seen by the answering instance." },
        ),
        totals: obj(
          { requests: int({ minimum: 0 }), byStatusClass: { type: "object", additionalProperties: int({ minimum: 0 }), examples: [{ "2xx": 120, "4xx": 3 }] } },
          ["requests", "byStatusClass"],
        ),
        byRoute: arrayOf(
          obj(
            {
              route: str({ examples: ["POST /intents"] }),
              requests: int({ minimum: 0 }),
              byStatusClass: { type: "object", additionalProperties: int({ minimum: 0 }) },
            },
            ["route", "requests", "byStatusClass"],
          ),
        ),
        series: arrayOf(obj({ hour: str({ format: "date-time" }), requests: int({ minimum: 0 }) }, ["hour", "requests"]), {
          description: "One entry per hour of the window, oldest first.",
        }),
        intents: obj(
          { created: int({ minimum: 0 }), byStatus: { type: "object", additionalProperties: int({ minimum: 0 }) } },
          ["created", "byStatus"],
          { description: "Intents the key created in the window, by current status." },
        ),
        contracts: obj(
          {
            registered: int({ minimum: 0 }),
            suspended: int({ minimum: 0 }),
            preparedToday: int({ minimum: 0, description: "Priced custom contract steps prepared today (UTC)." }),
            notionalTodayUsd: num({ minimum: 0, description: "Their notional, counted against the key's daily cap." }),
          },
          ["registered", "suspended", "preparedToday", "notionalTodayUsd"],
          { description: "The key's contract registrations and today's custom contract activity." },
        ),
        receipts: obj(
          { issued: int({ minimum: 0 }), pending: int({ minimum: 0 }), sharesActive: int({ minimum: 0 }) },
          ["issued", "pending", "sharesActive"],
          { description: "Receipts of the key's intents issued in the window, intents waiting for one, and active shares." },
        ),
        subtree: obj(
          {
            keys: arrayOf(
              obj(
                {
                  keyId: str(),
                  name: str(),
                  kind: str({ enum: ["project", "agent"] }),
                  parentId: { type: ["string", "null"] },
                  revokedAt: { type: ["string", "null"], format: "date-time" },
                  requests: int({ minimum: 0 }),
                  intents: obj({ created: int({ minimum: 0 }), byStatus: { type: "object", additionalProperties: int({ minimum: 0 }) } }, ["created", "byStatus"]),
                  notional: obj({ dayUsd: str(), weekUsd: str() }, ["dayUsd", "weekUsd"], { description: "Rolling 24 h / 7 d USD counted against caps." }),
                },
                ["keyId", "name", "kind", "parentId", "revokedAt", "requests", "intents", "notional"],
              ),
              { description: "Newest keys first, at most 100." },
            ),
            truncated: bool(),
          },
          ["keys", "truncated"],
          { description: "With scope=subtree only." },
        ),
      },
      ["keyId", "tier", "window", "since", "generatedAt", "rateLimit", "totals", "byRoute", "series", "intents", "contracts", "receipts"],
    ),
    ShieldsBadge: obj(
      {
        schemaVersion: int({ const: 1 }),
        label: str(),
        message: str({ enum: ["operational", "degraded", "down"] }),
        color: str(),
        cacheSeconds: int(),
      },
      ["schemaVersion", "label", "message", "color"],
    ),
    JsonRpcRequest: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer"] },
        method: str({ examples: ["server/discover", "tools/list", "tools/call", "initialize"] }),
        params: { type: "object" },
      },
      ["jsonrpc", "method"],
      { description: "One MCP JSON-RPC message (batches are refused)." },
    ),
    JsonRpcResponse: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer", "null"] },
        result: { type: "object" },
        error: obj({ code: int(), message: str(), data: {} }, ["code", "message"]),
      },
      ["jsonrpc"],
    ),
    JsonRpcErrorResponse: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer", "null"] },
        error: obj({ code: int({ examples: [-32600] }), message: str(), data: {} }, ["code", "message"]),
      },
      ["jsonrpc", "error", "id"],
      { description: "A JSON-RPC error sent with a non-2xx status by the MCP server: the code is a JSON-RPC integer and there is no `requestId` (read the X-Request-Id header)." },
    ),
    SubmitRequest: obj(
      {
        references: arrayOf(str({ maxLength: MAX_REFERENCE_LENGTH }), {
          minItems: 1,
          maxItems: MAX_REFERENCES,
          description: "One transaction hash (EVM) or signature (Solana) per prepared transaction, in order.",
        }),
      },
      ["references"],
    ),

    ...contractSchemas(),
    ...previewSchemas(),
    ...receiptSchemas(),
    ...policySchemas(),
    ...linkSchemas(),

    IntentResponse: obj({ intent: ref("IntentGraph") }, ["intent"]),
    IntentCreateResponse: obj(
      { intent: ref("IntentGraph"), preview: { ...ref("IntentPreview"), description: "With `preview=true`: the plan-stage asset-change preview (stage `plan`)." } },
      ["intent"],
    ),
    IntentListResponse: obj({ intents: arrayOf(ref("IntentGraph")) }, ["intents"]),
    PreparedStepResponse: obj(
      {
        payload: ref("StepExecutionPayload"),
        intent: ref("IntentGraph"),
        preview: { ...ref("IntentPreview"), description: "The whole intent with this step freshly simulated (stage `prepare`)." },
        previewAck: str({ enum: ["matched", "unknown"], description: "Present when `acknowledgedPreview` was sent (also in the response header)." }),
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

const REQUEST_ID_HEADER: JsonObject = { $ref: "#/components/headers/X-Request-Id" };

function ok(schema: string, description: string, extraHeaders: JsonObject = {}): JsonObject {
  return {
    description,
    headers: {
      "X-Request-Id": REQUEST_ID_HEADER,
      RateLimit: { $ref: "#/components/headers/RateLimit" },
      "RateLimit-Policy": { $ref: "#/components/headers/RateLimit-Policy" },
      ...extraHeaders,
    },
    content: { "application/json": { schema: ref(schema) } },
  };
}

const ERROR_RESPONSES: Readonly<Record<string, string>> = {
  "400": "BadRequest",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "NotFound",
  "409": "Conflict",
  "410": "Gone",
  "413": "PayloadTooLarge",
  "415": "UnsupportedMediaType",
  "422": "Unprocessable",
  "429": "TooManyRequests",
  "500": "InternalError",
  "502": "BadGateway",
  "503": "Unavailable",
  "504": "GatewayTimeout",
};

/**
 * Error responses of one operation. Every operation may be called with a key
 * (authentication is optional everywhere), so 401 for a key that fails and 503
 * when key verification is unavailable are always possible.
 */
function errors(...statuses: string[]): JsonObject {
  const out: JsonObject = {};
  for (const status of ["400", "401", "429", "500", "503", ...statuses]) {
    const name = ERROR_RESPONSES[status];
    if (name) out[status] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

function jsonBody(schema: string, required = true): JsonObject {
  return { required, content: { "application/json": { schema: ref(schema) } } };
}

const KEY_REQUIRED: Json = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
const intentIdParam: JsonObject = { $ref: "#/components/parameters/IntentId" };
const stepIdParam: JsonObject = { $ref: "#/components/parameters/StepId" };
const idempotencyKeyParam: JsonObject = { $ref: "#/components/parameters/IdempotencyKey" };
const webhookIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: WEBHOOK_ID_PATTERN.source }) };
const keyIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: API_KEY_ID_PATTERN.source }) };
const contractIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: CONTRACT_ID_PATTERN.source }) };
const sessionIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: SESSION_ID_PATTERN.source }) };
const REPLAYED_HEADER: JsonObject = { "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" } };
const IDEMPOTENCY_NOTE =
  " Honours `Idempotency-Key` (with an API key): a retry with the same key and request replays the stored response with `Idempotent-Replayed: true`.";

function paths(): JsonObject {
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
    "/v1/portfolio/{accountId}": {
      get: {
        operationId: "getPortfolio",
        tags: ["Portfolio"],
        summary: "Balances for one CAIP-10 account",
        parameters: [{ name: "accountId", in: "path", required: true, schema: ref("AccountId") }],
        responses: { "200": ok("Portfolio", "Portfolio."), ...errors("422", "502", "504") },
      },
    },
    "/v1/intents": {
      post: {
        operationId: "createIntent",
        tags: ["Intents"],
        summary: "Plan an intent into an IntentGraph",
        description:
          "Natural-language `text` is compiled by a deterministic grammar; unsupported wording returns 422 INTENT_UNSUPPORTED with example phrases in `error.hints`. With `dryRun=true` the plan is quoted but not stored (200; Idempotency-Key is ignored). A repeated `clientReference` from the same API key returns the original intent (200)." +
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
          idempotencyKeyParam,
        ],
        requestBody: jsonBody("IntentRequest"),
        responses: {
          "201": ok("IntentCreateResponse", "Intent planned and stored.", REPLAYED_HEADER),
          "200": ok("IntentCreateResponse", "Dry run, or idempotent replay of an existing intent.", REPLAYED_HEADER),
          ...errors("409", "413", "415", "422", "502", "504"),
        },
      },
      get: {
        operationId: "listIntents",
        tags: ["Intents"],
        summary: "List intents created with the caller's key",
        security: KEY_REQUIRED,
        parameters: [{ name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) }],
        responses: { "200": ok("IntentListResponse", "Most recent first."), ...errors() },
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
        parameters: [intentIdParam, stepIdParam],
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
    ...previewPaths(),
    ...receiptPaths(),
    ...policyPaths(),
    ...linkPaths(),
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
        description: `The key is shown once and stored only as a SHA-256 hash. Without a key this starts a new project; with a developer key the new key joins the caller's project (at most ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys, else 409 KEY_LIMIT_REACHED). Limited to ${KEY_ISSUANCE_LIMIT_PER_HOUR} keys per hour per IP.${IDEMPOTENCY_NOTE} The stored response is encrypted at rest.`,
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
        description: `EVM (\`network\` + \`address\`): deployment, EIP-7702 delegation, deny-list reason, pins with proxy detection, Sourcify status and ABI, and every function marked allowed or forbidden with the reason. Solana (\`network\` + \`programs\`, comma separated): program pins, deny-list reasons and OtterSec status. Nothing is stored. Shares ${CONTRACT_TESTS_PER_MINUTE} calls per minute per key with the test endpoint.`,
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
        description: `A fixed template of structured actions (custom contract steps of the caller's registrations included), the origins allowed to embed it, an optional visitor-chosen amount within bounds, a TTL and a use count. The template is planned once as a dry run, so a broken template fails here. The response's \`embedUrl\` carries the id in the URL fragment. At most ${CONTRACT_LIMITS.activeSessionsPerKey} active sessions per key (429 RATE_LIMITED beyond).${IDEMPOTENCY_NOTE}`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("SessionCreateRequest"),
        responses: { "201": ok("SessionResponse", "The session.", REPLAYED_HEADER), ...errors("409", "413", "415", "422", "502", "504") },
      },
    },
    "/v1/sessions/{id}": {
      get: {
        operationId: "getSession",
        tags: ["Sessions"],
        summary: "Session view for the embed (public; the id is the capability)",
        description: "Integrator identity, allowed origins, action labels, amount bounds, status and expiry. Never the key or the project.",
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

function errorResponse(description: string): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: ref("Error") } },
  };
}

/** An error of POST /v1/mcp: a JSON-RPC error body, or (`orPlatform`) also the platform envelope from the router. */
function mcpErrorResponse(description: string, orPlatform = false): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: orPlatform ? { oneOf: [ref("JsonRpcErrorResponse"), ref("Error")] } : ref("JsonRpcErrorResponse") } },
  };
}

export function buildOpenApiDocument(): JsonObject {
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    info: {
      title: "Kletia Platform API",
      version: PLATFORM_API_VERSION,
      summary: "Non-custodial, chain-agnostic intents for EVM networks and Solana.",
      description:
        "Plan cross-network intents into a DAG of network-bound steps, get unsigned wallet-ready transactions, and verify execution from on-chain evidence. Kletia never holds keys. Networks are CAIP-2 ids, accounts CAIP-10, assets CAIP-19, amounts base-unit strings.\n\n" +
        `Tiers: public ${TIER_LIMITS.public}/min per IP, developer ${TIER_LIMITS.developer}/min per key, operator ${TIER_LIMITS.operator}/min per key. Errors are \`{ "error": { "code", "message", "issues"?, "hints"?, "docs"? }, "requestId" }\` with codes from the catalog at GET /v1/errors; every response carries X-Request-Id. Keyed POSTs that create or change state accept \`Idempotency-Key\`. Agents can use the MCP server at /v1/mcp (read-only tools, plus keyed creation of intents and links; nothing is ever signed). Agent keys (\`kl_agt_\`) are bound by their rule book chain.`,
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "Kletia", url: "https://kletiaai.xyz" },
    },
    servers: [
      { url: "https://api.kletiaai.xyz", description: "Production" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "System", description: "Health, the error catalog, the status badge and this document." },
      { name: "Registry", description: "Networks, protocols and assets, derived from the engine's live adapters." },
      { name: "Quotes", description: "Advisory route quotes; nothing is stored." },
      { name: "Portfolio", description: "Balances of one CAIP-10 account." },
      { name: "Intents", description: "Plan, prepare, submit, verify and cancel intents." },
      { name: "Events", description: "Server-Sent Events per intent." },
      { name: "Receipts", description: "Signed, privacy-preserving receipts of finished intents, verifiable offline and re-checkable on-chain; shares, keys and the transparency log." },
      { name: "Webhooks", description: "Signed event deliveries to your HTTPS endpoints, test deliveries and delivery logs." },
      { name: "Keys", description: "Issue, list, rotate and revoke the API keys of your project." },
      { name: "Usage", description: "Per-key request counts and rate-limit state." },
      { name: "Contracts", description: "Register your own EVM contracts and Solana Actions so your key's intents can call them: pinned, simulated, verified, never audited by Kletia." },
      { name: "Sessions", description: "Short-lived templates your backend creates so the embed can run your fixed actions for a visitor's wallet." },
      { name: "Rule Book", description: "Rule books of keys and of the project (tighten now, loosen later), the simulator, the hash-chained decision log, spend windows and approvals." },
      { name: "Links", description: "Intent links: public pages whose destination the publisher fixes and whose funding the visitor chooses; quotes, intents, counters, share cards." },
      { name: "Blinks", description: "Solana Actions for eligible links (actions.json is served by the web origin)." },
      { name: "MCP", description: "Model Context Protocol server for agents: read-only tools, plus keyed creation of intents and links for a human to sign." },
    ],
    paths: paths(),
    webhooks: {
      intentEvent: {
        post: {
          operationId: "receiveIntentEvent",
          summary: "Intent event delivery",
          description:
            "Sent for intents created with your API key to each matching webhook. Respond 2xx within 5 seconds; redirects are not followed. Failed deliveries are retried up to 3 times (after 1 s, 5 s and 25 s). Each key's deliveries are queued separately (at most 200 waiting; the oldest is dropped beyond that) and a webhook receives one delivery at a time. A webhook whose last 5 attempts failed is paused for 30 s, doubling up to 5 minutes while it keeps failing; its deliveries wait meanwhile. `intent.receipt_issued` is sent once a receipt is issued (after every reference is finalized; ids and digest only); webhooks created before it existed do not receive it unless re-created.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith("intent.")) }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("KletiaEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      contractEvent: {
        post: {
          operationId: "receiveContractEvent",
          summary: "Contract registration event delivery",
          description:
            "Sent to the webhooks of the registration's own key that subscribe to the type: contract.registered (a registration or a new revision; on mainnet it activates after the delay), contract.activated, contract.suspended (pins changed, outcome mismatch, program changed, domain no longer verified, operator) and contract.reactivated. Same signing, retries and queueing as intent events. Webhooks created before these types existed do not receive them unless re-created.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...CONTRACT_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("ContractEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      linkEvent: {
        post: {
          operationId: "receiveLinkEvent",
          summary: "Intent link event delivery",
          description:
            "Sent to the webhooks of the link's owning key that subscribe to the type (and to `scope: \"subtree\"` webhooks of its ancestors): link.created, link.activated, link.updated (tightened, domain verified or not, blink approval), link.paused (by the publisher, or itself when a pinned name or contract changed), link.suspended, link.exhausted, link.expired, link.deleted. Same signing, retries and queueing as intent events.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...LINK_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("LinkEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      policyEvent: {
        post: {
          operationId: "receivePolicyEvent",
          summary: "Rule Book and key event delivery",
          description:
            "Sent to the subject key's webhooks, to `scope: \"subtree\"` webhooks of its ancestors and to `scope: \"subtree\"` webhooks of the project's project keys: policy.violation, policy.approval_requested, policy.approval_decided, policy.amendment_pending, policy.amended, policy.spend_threshold (80 % and 95 % of a window), key.created and key.revoked (with the cascade).",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...POLICY_EVENT_TYPES, ...KEY_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [ref("PolicyEvent"), ref("KeyEvent")] } } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      webhookTest: {
        post: {
          operationId: "receiveWebhookTest",
          summary: "Test delivery",
          description: "Sent once by POST /v1/webhooks/{id}/test, signed like every delivery. Never retried. Acknowledge with any 2xx.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ const: "webhook.test" }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ const: "1" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookTestEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "kl_dev_<32 base62>", description: "Developer or operator API key." },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-Kletia-Key", description: "Alternative to the Authorization header." },
      },
      parameters: {
        IntentId: { name: "id", in: "path", required: true, schema: ref("IntentId") },
        StepId: { name: "stepId", in: "path", required: true, schema: ref("StepId") },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: `Makes a retry safe: the first response with this key (per API key) is stored for ${IDEMPOTENCY_TTL_MS / 3_600_000} hours and replayed for the same request. The same key with a different request → 422 IDEMPOTENCY_KEY_REUSED; while the first request runs → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (Retry-After: 1; an abandoned reservation is taken over after ${IDEMPOTENCY_LOCK_MS / 1000} s). 5xx, 429 and retryable errors are never stored. Requires an API key (400 IDEMPOTENCY_KEY_REQUIRES_API_KEY).`,
          schema: str({ pattern: "^\"?[A-Za-z0-9_.:-]{1,128}\"?$", examples: ["7f6c1d0e-3b8a-4c2e-9a51-0d2f5b8e6a14"] }),
        },
      },
      headers: {
        "X-Request-Id": { description: "Request id (echoes a valid incoming UUID).", schema: str({ format: "uuid" }) },
        RateLimit: { description: "IETF draft-8 rate limit state.", schema: str() },
        "RateLimit-Policy": { description: "IETF draft-8 rate limit policy.", schema: str() },
        "Retry-After": { description: "Seconds until a retry may succeed.", schema: int() },
        "Idempotent-Replayed": { description: "`true` when the response replays an earlier request (Idempotency-Key or clientReference).", schema: str({ const: "true" }) },
      },
      responses: {
        BadRequest: errorResponse("Invalid input (INVALID_REQUEST, INVALID_JSON, POLICY_INVALID, LINK_DEFINITION_INVALID, REFERENCES_INVALID, REFERENCE_INVALID, REFERENCE_COUNT_MISMATCH, IDEMPOTENCY_KEY_INVALID, IDEMPOTENCY_KEY_REQUIRES_API_KEY, IDEMPOTENCY_NOT_SUPPORTED, ...)."),
        Unauthorized: errorResponse("Missing or invalid API key (API_KEY_REQUIRED, INVALID_API_KEY, INVALID_AUTHORIZATION)."),
        Forbidden: errorResponse("Not allowed (KEY_SECRET_ROTATED, MCP_ORIGIN_FORBIDDEN, SESSION_ORIGIN_FORBIDDEN, POLICY_VIOLATION, POLICY_SPEND_LIMIT, POLICY_SCHEDULE_CLOSED, POLICY_OWNER_REVOKED, POLICY_APPROVAL_REQUIRED, POLICY_APPROVAL_REJECTED, AGENT_KEY_FORBIDDEN, APPROVAL_SIGNATURE_INVALID, APPROVER_NOT_ALLOWED; Rule Book refusals carry error.policy)."),
        NotFound: errorResponse("Unknown resource or route (INTENT_NOT_FOUND, STEP_NOT_FOUND, WEBHOOK_NOT_FOUND, KEY_NOT_FOUND, CONTRACT_NOT_FOUND, SESSION_NOT_FOUND, PREVIEW_NOT_FOUND, RECEIPT_NOT_FOUND, RECEIPT_SHARE_NOT_FOUND, RECEIPT_LOG_NOT_FOUND, POLICY_NOT_FOUND, APPROVAL_NOT_FOUND, LINK_NOT_FOUND, NOT_FOUND)."),
        Conflict: errorResponse("State conflict (STEP_NOT_READY, STEP_NOT_AWAITING_SIGNATURE, QUOTE_MOVED, INTENT_CONFLICT, INTENT_NOT_CANCELLABLE, WEBHOOK_EXISTS, KEY_NOT_MANAGEABLE, KEY_LIMIT_REACHED, IDEMPOTENCY_REQUEST_IN_PROGRESS, CONTRACT_EXISTS, CONTRACT_LIMIT_REACHED, CONTRACT_PENDING, CONTRACT_SUSPENDED, CONTRACT_CHANGED, SESSION_USED, PREVIEW_CHANGED, RECEIPT_NOT_READY, RECEIPT_NOT_APPLICABLE, RECEIPT_SHARE_LIMIT, RECEIPT_ANCHOR_EXISTS, POLICY_CONFLICT, POLICY_AMENDMENT_PENDING, POLICY_APPROVAL_STALE, AGENT_KEY_LIMIT_REACHED, KEY_DEPTH_EXCEEDED, APPROVAL_DECIDED, LINK_LIMIT_REACHED, LINK_PENDING, LINK_PAUSED, LINK_SUSPENDED, LINK_EXHAUSTED, LINK_ACCOUNT_LIMIT, LINK_RECIPIENT_CHANGED, LINK_CONTRACT_CHANGED, ...)."),
        Gone: errorResponse("Expired (INTENT_EXPIRED, DEADLINE_PASSED, SESSION_EXPIRED, RECEIPT_SHARE_EXPIRED, RECEIPT_DISCLOSURES_WITHDRAWN, POLICY_APPROVAL_EXPIRED, LINK_EXPIRED)."),
        PayloadTooLarge: errorResponse("Request body larger than 64 KB."),
        UnsupportedMediaType: errorResponse("Request body is not application/json."),
        Unprocessable: errorResponse(`Understood but not executable (INTENT_UNSUPPORTED, ROUTE_UNSUPPORTED, CAPITAL_LANE_MIXED, SELF_TRANSFER, FEE_LIMIT_EXCEEDED, INSUFFICIENT_BALANCE, WEBHOOK_URL_FORBIDDEN, IDEMPOTENCY_KEY_REUSED, CONTRACT_UNKNOWN, CONTRACT_DENIED, CONTRACT_FUNCTION_FORBIDDEN, CONTRACT_NOT_DEPLOYED, SIMULATION_ASSET_CHANGE_REFUSED, ACTION_TRANSACTION_REJECTED, RECEIPT_ANCHOR_INVALID, LINK_POLICY_CONFLICT, LINK_IMMUTABLE_FIELD, LINK_INPUT_OUT_OF_BOUNDS, LINK_SOURCE_NOT_ALLOWED, LINK_ACCOUNTS_REQUIRED, LINK_PUBLISHER_MISMATCH, LINK_NOT_BLINK_ELIGIBLE, ${[...REJECTION_CODES].join(", ")}, ...).`),
        TooManyRequests: {
          ...errorResponse("Rate limit exceeded (RATE_LIMITED, also for too many unrecognised API keys from one IP; TOO_MANY_STREAMS)."),
          headers: { "X-Request-Id": REQUEST_ID_HEADER, "Retry-After": { $ref: "#/components/headers/Retry-After" } },
        },
        InternalError: errorResponse("Unexpected error (INTERNAL_ERROR, LINK_PLAN_OUT_OF_BOUNDS)."),
        BadGateway: errorResponse("An upstream provider or RPC failed (PROVIDER_UNAVAILABLE, RPC_UNAVAILABLE, ACTION_ENDPOINT_UNAVAILABLE, LINK_DELIVERY_UNQUOTABLE)."),
        Unavailable: errorResponse("Storage or a feature is unavailable (STORE_UNAVAILABLE, also when a presented API key cannot be verified; WEBHOOKS_NOT_CONFIGURED, CONTRACTS_DISABLED, SIMULATION_UNAVAILABLE, RECEIPTS_DISABLED, POLICY_PRICE_UNAVAILABLE, LINKS_DISABLED, LINK_PAGE_UNAVAILABLE)."),
        GatewayTimeout: errorResponse("An upstream provider timed out (UPSTREAM_TIMEOUT, RPC_TIMEOUT)."),
      },
      schemas: schemas(),
    },
  };
}

let serialized: string | null = null;

/** The document as JSON (built once per process). */
export function openApiJson(): string {
  serialized ??= JSON.stringify(buildOpenApiDocument());
  return serialized;
}
