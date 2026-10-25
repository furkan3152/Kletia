/**
 * Contract and session schemas.
 */
import {
  CONTRACT_ADDRESS_LABEL_PATTERN,
  CONTRACT_ALIAS_PATTERN,
  CONTRACT_ENTRY_ID_PATTERN,
  CONTRACT_ID_PATTERN,
  CONTRACT_LIMITS,
  REBASING_TOLERANCE_UNITS,
  CONTRACT_PARAM_NAME_PATTERN,
  CONTRACT_REVIEW_NOTICE,
  CONTRACT_VERB_PATTERN,
  KLETIA_WELL_KNOWN_PATH,
  SESSION_ID_PATTERN,
} from "@kletia/core";
import {
  arrayOf,
  BASE58,
  bool,
  DECIMAL,
  EVM_ADDRESS,
  int,
  type JsonObject,
  num,
  obj,
  ref,
  str,
  WEI,
} from "./helpers.js";

/** Custom contracts (BYOC): registrations, reviews, tests, inspections and sessions. */
export function contractSchemas(): JsonObject {
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
        output: obj(
          {
            token: str({ description: "`$self`, an `addresses` label or an ERC-20 address." }),
            toleranceBps: int({ minimum: 0, maximum: CONTRACT_LIMITS.maxToleranceBps, default: CONTRACT_LIMITS.defaultToleranceBps }),
            rebasing: bool({
              default: false,
              description: `The output token's balance is index-scaled (Aave aTokens and similar): simulation and landing accept a Transfer-log amount up to ${REBASING_TOLERANCE_UNITS} base units away from the balance change (or the declared event), either way, and count the smaller amount. Part of definitionHash (a change is a new revision). Without it, amounts must match exactly.`,
            }),
          },
          ["token"],
        ),
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
        hints: obj(
          {
            erc4626: obj(
              {
                asset: str({ pattern: EVM_ADDRESS, description: "The vault's `asset()`, read with one eth_call." }),
                registrySymbol: { type: ["string", "null"], description: "Registry symbol of the asset on this network, null when Kletia does not list it." },
              },
              ["asset", "registrySymbol"],
              { description: "The verified ABI has `asset()`, `deposit(uint256,address)` and the ERC-4626 `Deposit` event. `kletia contracts init` and the portal wizard prefill the input, exact approval, output and event from it." },
            ),
          },
          [],
          { description: "Registration hints derived from the verified ABI; absent when none applies." },
        ),
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
        warnings: arrayOf(
          obj(
            {
              code: str({ const: "CONTRACT_PENDING" }),
              contract: str({ pattern: CONTRACT_ID_PATTERN.source }),
              activatesAt: str({ format: "date-time" }),
            },
            ["code", "contract", "activatesAt"],
          ),
          { description: "A registration of the template is still pending (mainnet activation delay): intents of the session are refused with 409 CONTRACT_PENDING until `activatesAt`. Absent when nothing applies." },
        ),
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
