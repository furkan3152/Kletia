/**
 * OpenAPI fragments of the Rule Book (policy design §11): the rule book
 * document, versions and amendments, the simulator, the decision log, spend
 * windows, approvals, agent keys (children) and key expiry, the policy
 * stamps on intents and payloads, and the `policy.*` / `key.*` events.
 * Merged by openapi.ts.
 */
import {
  AGENT_KEY_PATTERN,
  APPROVAL_ID_PATTERN,
  ASSET_CATEGORIES,
  CONFIRM_TRIGGERS,
  KEY_EVENT_TYPES,
  NETWORK_KEYS,
  POLICY_DECISION_ID_PATTERN,
  POLICY_EVENT_TYPES,
  POLICY_LANES,
  POLICY_LIMITS,
  POLICY_MODES,
  POLICY_PERMISSIONS,
  POLICY_SCHEMA,
  POLICY_TEMPLATES,
  POLICY_USD_PATTERN,
  RECIPIENT_MODES,
  RECIPIENT_NAME_RULES,
  WEEKDAYS,
} from "@kletia/core";
import { API_KEY_ID_PATTERN } from "../keys.js";
import { arrayOf, bool, errors, idempotencyKeyParameter, int, jsonBody, KEY_REQUIRED, nullable, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";
import { POLICY_EVALUATIONS_PER_MINUTE } from "./handlers.js";

const USD = str({ pattern: POLICY_USD_PATTERN.source, description: "US dollars, up to 2 decimals." });
const HASH = str({ pattern: "^sha256:[0-9a-f]{64}$" });
const KEY_ID = str({ pattern: API_KEY_ID_PATTERN.source });
const SCOPE_ID = str({ description: "A key id, or `prj_<project>` for the project rule book." });
const ISO = str({ format: "date-time" });
const NULLABLE_ISO: JsonObject = { type: ["string", "null"], format: "date-time" };
const NETWORK_LIST = arrayOf(str({ enum: [...NETWORK_KEYS] }), { uniqueItems: true });
const OUTCOMES = ["allow", "confirm", "deny", "approved", "rejected", "observed"];
const STAGES = ["plan", "prepare", "submit", "evaluate", "approval", "amendment", "key"];
const IF_MATCH: JsonObject = {
  name: "If-Match",
  in: "header",
  required: false,
  description: "The current rule book hash (`\"sha256:…\"`, as the ETag), or `none` when there is none. A mismatch is refused with 409 POLICY_CONFLICT. Absent: unconditional.",
  schema: str({ pattern: "^(W/)?\"?(sha256:[0-9a-f]{64}|none)\"?$" }),
};
const keyIdPath: JsonObject = { name: "id", in: "path", required: true, schema: KEY_ID };
const approvalIdPath: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: APPROVAL_ID_PATTERN.source }) };
const ETAG: JsonObject = { ETag: { description: "The new rule book hash (`\"sha256:…\"`) for If-Match.", schema: str() } };

export function policySchemas(): JsonObject {
  return {
    PolicyDocument: obj(
      {
        schema: str({ const: POLICY_SCHEMA }),
        label: str({ maxLength: POLICY_LIMITS.labelLength }),
        mode: str({ enum: [...POLICY_MODES], description: "`dry-run`: plans and dry runs only; `paused`: nothing new is planned or prepared." }),
        networks: obj({ allow: { ...NETWORK_LIST, maxItems: POLICY_LIMITS.networks }, lanes: arrayOf(str({ enum: [...POLICY_LANES] }), { uniqueItems: true }) }),
        kinds: obj({ allow: arrayOf(str(), { uniqueItems: true }) }),
        protocols: obj({ allow: arrayOf(str(), { maxItems: POLICY_LIMITS.protocols }), deny: arrayOf(str(), { maxItems: POLICY_LIMITS.protocols }) }),
        contracts: obj({
          allow: arrayOf(obj({ id: str(), entries: arrayOf(str(), { maxItems: POLICY_LIMITS.contractEntries }) }, ["id"]), { maxItems: POLICY_LIMITS.contracts }),
        }, [], { description: "BYOC registrations (and entries) the key may call. Absent on an agent key: none." }),
        assets: obj({
          allow: arrayOf(str(), { maxItems: POLICY_LIMITS.assets, description: "`SYMBOL`, `SYMBOL@network`, `group:USDC` or a CAIP-19 id." }),
          categories: arrayOf(str({ enum: [...ASSET_CATEGORIES] }), { uniqueItems: true }),
          unlisted: str({ enum: ["deny", "allow"] }),
        }),
        accounts: obj({ allow: arrayOf(str(), { maxItems: POLICY_LIMITS.accounts, description: "CAIP-10 accounts, or `eip155:*:<address>` / `solana:*:<address>`." }) }),
        recipients: obj({
          mode: str({ enum: [...RECIPIENT_MODES], description: "`own`: only the intent's own accounts (agent default)." }),
          allow: arrayOf(str(), { maxItems: POLICY_LIMITS.recipients }),
          deny: arrayOf(str(), { maxItems: POLICY_LIMITS.recipients, description: "Deny always wins." }),
          names: str({ enum: [...RECIPIENT_NAME_RULES] }),
        }),
        limits: obj({
          maxSteps: int({ minimum: POLICY_LIMITS.minSteps, maximum: POLICY_LIMITS.maxSteps }),
          maxSlippageBps: int({ minimum: POLICY_LIMITS.minSlippageBps, maximum: POLICY_LIMITS.maxSlippageBps }),
          maxExtraCostUsd: USD,
          maxFeeUsd: USD,
          maxSeconds: int({ minimum: POLICY_LIMITS.minSeconds, maximum: POLICY_LIMITS.maxSeconds }),
        }),
        caps: obj({ perStepUsd: USD, perIntentUsd: USD, dailyUsd: USD, weeklyUsd: USD }, [], { description: "Rolling 24 h / 7 d windows count prepared exposures (released when a step never ran)." }),
        schedule: obj(
          {
            timezone: str({ description: "IANA time zone." }),
            windows: arrayOf(obj({ days: arrayOf(str({ enum: [...WEEKDAYS] })), from: str({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" }), to: str({ pattern: "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$" }) }, ["days", "from", "to"]), { maxItems: POLICY_LIMITS.windows }),
          },
          ["timezone", "windows"],
        ),
        confirm: obj({
          aboveUsd: USD,
          when: arrayOf(str({ enum: [...CONFIRM_TRIGGERS] }), { uniqueItems: true }),
          approvers: obj({
            keys: arrayOf(KEY_ID, { maxItems: POLICY_LIMITS.approverKeys, description: "Project keys allowed to approve (empty: any active project key outside the requester's subtree)." }),
            wallets: arrayOf(str(), { maxItems: POLICY_LIMITS.approverWallets, description: "CAIP-10 approver wallets (EIP-712, ERC-1271/6492 or a Solana message signature)." }),
            requireWallet: bool(),
          }),
          ttlSeconds: int({ minimum: POLICY_LIMITS.minConfirmTtlSeconds, maximum: POLICY_LIMITS.maxConfirmTtlSeconds, default: POLICY_LIMITS.defaultConfirmTtlSeconds }),
        }),
        permissions: obj(Object.fromEntries(POLICY_PERMISSIONS.map((permission) => [permission, bool()])), [], { description: "API rights of an agent key (ignored on project keys); all false by default." }),
        execution: obj({ pinNonce: bool({ description: "EVM payloads pin the account nonce, so two payloads cannot both land." }) }),
        amendments: obj({ delaySeconds: int({ minimum: 0, maximum: POLICY_LIMITS.maxAmendmentDelaySeconds, description: "Loosening changes wait this long (tightening applies at once)." }) }),
      },
      ["schema"],
      { additionalProperties: false, description: `A rule book (\`${POLICY_SCHEMA}\`, at most ${POLICY_LIMITS.documentBytes} bytes of canonical JSON). validatePolicy in @kletia/core checks it locally. Every level of a key's chain (project, ancestors, the key) applies: a request passes only if every level allows it.` },
    ),
    PolicyChainLink: obj({ scope: str({ enum: ["project", "key"] }), id: SCOPE_ID, version: int({ minimum: 1 }), hash: HASH }, ["scope", "id", "version", "hash"]),
    PolicyViolation: obj(
      { rule: str({ examples: ["caps.dailyUsd"] }), scope: str({ enum: ["project", "key"] }), keyId: str(), path: str(), message: str(), observed: str(), limit: str() },
      ["rule", "scope", "message"],
    ),
    PolicyRuleResult: obj(
      { rule: str(), scope: str({ enum: ["project", "key"] }), keyId: str(), status: str({ enum: ["pass", "fail", "trigger", "warn"] }), path: str(), observed: str(), limit: str(), message: str() },
      ["rule", "scope", "status"],
    ),
    PolicyErrorDetails: obj(
      {
        decisionId: { type: ["string", "null"], pattern: POLICY_DECISION_ID_PATTERN.source },
        stage: str({ enum: ["plan", "prepare", "evaluate"] }),
        outcome: str({ const: "deny" }),
        keyId: { type: ["string", "null"], description: "The key (or `prj_…`) whose rule book refused first." },
        violations: arrayOf(ref("PolicyViolation"), { maxItems: POLICY_LIMITS.violationsReturned }),
        retryAt: NULLABLE_ISO,
        approval: obj({ id: str({ pattern: APPROVAL_ID_PATTERN.source }), url: str({ format: "uri" }), expiresAt: ISO }, ["id", "url"]),
      },
      ["decisionId", "stage", "outcome", "keyId", "violations", "retryAt"],
      { description: "`error.policy` of a Rule Book refusal (POLICY_* codes, AGENT_KEY_FORBIDDEN)." },
    ),
    IntentPolicyStamp: obj(
      {
        decisionId: str({ pattern: POLICY_DECISION_ID_PATTERN.source }),
        outcome: str({ enum: ["allow", "confirm"] }),
        keyId: KEY_ID,
        chain: arrayOf(ref("PolicyChainLink")),
        notionalUsd: { type: ["string", "null"] },
        evaluatedAt: ISO,
        approval: obj(
          { id: str({ pattern: APPROVAL_ID_PATTERN.source }), url: str({ format: "uri", description: "`<web>/approve#apr_…`: safe to hand to the agent (reading is not approving)." }), expiresAt: ISO, ceilingUsd: str(), triggers: arrayOf(str()) },
          ["id", "url", "expiresAt", "ceilingUsd", "triggers"],
        ),
      },
      ["decisionId", "outcome", "keyId", "chain", "notionalUsd", "evaluatedAt"],
      { description: "Plan-time Rule Book stamp (keys with a rule book chain). `confirm` intents are held until an approver approves." },
    ),
    StepPolicyClearance: obj(
      { decisionId: str({ pattern: POLICY_DECISION_ID_PATTERN.source }), exposureId: str(), notionalUsd: { type: ["string", "null"] }, chainHashes: arrayOf(HASH) },
      ["decisionId", "exposureId", "notionalUsd", "chainHashes"],
      { description: "The decision that cleared this payload and the exposure counted against caps." },
    ),
    PolicyVersion: obj(
      {
        scope: str({ enum: ["project", "key"] }),
        keyId: KEY_ID,
        projectId: str({ pattern: "^prj_" }),
        version: int({ minimum: 1 }),
        hash: { type: ["string", "null"], description: "null for a removal." },
        status: str({ enum: ["active", "pending", "superseded", "cancelled", "removed"], description: "`removed`: the rule book was removed (document null)." }),
        document: nullable(ref("PolicyDocument")),
        activatesAt: NULLABLE_ISO,
        loosened: arrayOf(str(), { description: "Field paths this version loosens (it waits for the amendment delay)." }),
        tightened: arrayOf(str()),
        createdAt: ISO,
        createdBy: KEY_ID,
      },
      ["scope", "version", "hash", "status", "document", "activatesAt", "loosened", "tightened", "createdAt", "createdBy"],
    ),
    PolicyHead: {
      oneOf: [
        { type: "null" },
        {
          allOf: [
            ref("PolicyVersion"),
            obj({
              pending: nullable(
                obj(
                  { version: int(), hash: { type: ["string", "null"] }, activatesAt: NULLABLE_ISO, loosened: arrayOf(str()), createdBy: KEY_ID, removal: bool() },
                  ["version", "hash", "activatesAt", "loosened", "createdBy", "removal"],
                ),
              ),
            }),
          ],
        },
      ],
      description: "The active version (status `none` when only an amendment is pending) and the pending amendment; null when there is no rule book.",
    },
    PolicyResponse: obj(
      {
        policy: ref("PolicyHead"),
        effective: obj(
          {
            keyActive: bool(),
            chain: arrayOf(ref("PolicyChainLink")),
            defaults: str({ enum: ["project", "agent"] }),
            levels: arrayOf(
              obj(
                { scope: str({ enum: ["project", "key"] }), id: SCOPE_ID, version: { type: ["integer", "null"] }, hash: { type: ["string", "null"] }, defaults: str({ enum: ["project", "agent"] }), document: nullable(ref("PolicyDocument")) },
                ["scope", "id", "version", "hash", "defaults", "document"],
              ),
              { description: "Root first; each level's document as evaluated (defaults filled; agent keys without a rule book are observers)." },
            ),
          },
          ["keyActive", "chain", "defaults", "levels"],
          { description: "Key rule books only: the chain every request of this key is evaluated against." },
        ),
      },
      ["policy"],
    ),
    PolicyWriteRequest: {
      oneOf: [ref("PolicyDocument"), obj({ policy: ref("PolicyDocument") }, ["policy"])],
      description: "The rule book, bare or as `{ policy }`.",
    },
    PolicyWriteResponse: obj(
      {
        policy: ref("PolicyVersion"),
        applied: str({ enum: ["now", "pending", "unchanged"], description: "`now`: tightening or first version; `pending`: a loosening waits for `activatesAt` (amendments.delaySeconds)." }),
        tightened: arrayOf(str()),
        loosened: arrayOf(str()),
        supersededPending: nullable(obj({ version: int(), hash: { type: ["string", "null"] } }, ["version", "hash"])),
        warnings: arrayOf(obj({ code: str(), path: str(), message: str() }, ["code", "path", "message"])),
      },
      ["policy", "applied", "tightened", "loosened", "supersededPending", "warnings"],
    ),
    PolicyVersionResponse: obj({ policy: ref("PolicyVersion") }, ["policy"]),
    PolicyVersionListResponse: obj({ versions: arrayOf(ref("PolicyVersion"), { description: "Newest first." }) }, ["versions"]),
    PolicyValidateRequest: obj(
      { policy: ref("PolicyDocument"), against: nullable(ref("PolicyDocument")), defaults: str({ enum: ["project", "agent"], default: "project" }) },
      ["policy"],
    ),
    PolicyValidateResponse: obj(
      {
        valid: bool(),
        issues: arrayOf(obj({ path: str(), message: str() }, ["path", "message"])),
        warnings: arrayOf(obj({ code: str(), path: str(), message: str() }, ["code", "path", "message"])),
        document: ref("PolicyDocument"),
        hash: HASH,
        comparison: obj({ tightened: arrayOf(str()), loosened: arrayOf(str()) }, [], { description: "With `against`: what the change tightens and loosens." }),
        against: obj({ valid: bool(), issues: arrayOf(obj({ path: str(), message: str() })) }),
      },
      ["valid", "issues", "warnings"],
    ),
    PolicyEvaluateRequest: obj(
      {
        request: ref("IntentRequest"),
        keyId: { ...KEY_ID, description: "Key whose chain to evaluate (default: the caller); must be in the caller's subtree." },
        policy: nullable(ref("PolicyDocument")),
        stage: str({ enum: ["plan", "prepare"], default: "plan" }),
        at: str({ format: "date-time", description: "What-if clock for the timetable." }),
      },
      ["request"],
      { additionalProperties: false },
    ),
    PolicyEvaluateResponse: obj(
      {
        evaluation: obj(
          {
            keyId: KEY_ID,
            decisionId: str({ pattern: POLICY_DECISION_ID_PATTERN.source }),
            outcome: str({ enum: ["allow", "confirm", "deny"] }),
            notionalUsd: { type: ["string", "null"] },
            rules: arrayOf(ref("PolicyRuleResult")),
            violations: arrayOf(ref("PolicyViolation")),
            triggers: arrayOf(ref("PolicyViolation")),
            warnings: arrayOf(str()),
            code: { type: ["string", "null"], description: "The error code a real request would get." },
            complete: bool({ description: "False when planning failed (see planError): only request-level rules were evaluated, so `allow` is not a full pass." }),
            effectiveConstraints: { type: "object" },
            usage: arrayOf(obj({ scope: SCOPE_ID, window: str({ enum: ["24h", "7d"] }), usedUsd: str(), capUsd: str() }, ["scope", "window", "usedUsd", "capUsd"])),
            schedule: arrayOf(obj({ scope: SCOPE_ID, open: bool(), nextChange: NULLABLE_ISO, timezone: { type: ["string", "null"] } }, ["scope", "open", "nextChange", "timezone"])),
          },
          ["keyId", "decisionId", "outcome", "notionalUsd", "rules", "violations", "triggers", "warnings", "code", "complete", "usage", "schedule"],
        ),
        intent: nullable(ref("IntentGraph")),
        planError: nullable(obj({ code: str(), message: str() }, ["code", "message"])),
      },
      ["evaluation", "intent", "planError"],
    ),
    PolicyDecision: obj(
      {
        id: str({ pattern: POLICY_DECISION_ID_PATTERN.source }),
        seq: int({ minimum: 1, description: "Gapless per project." }),
        prevHash: str({ pattern: "^0x[0-9a-f]{64}$" }),
        chainHash: str({ pattern: "^0x[0-9a-f]{64}$", description: "0x + sha256(prevHash + \"\\n\" + canonical JSON of the record without seq, prevHash and chainHash); verifyDecisionChain in @kletia/core." }),
        at: ISO,
        stage: str({ enum: STAGES }),
        outcome: str({ enum: OUTCOMES }),
        projectId: str(),
        keyId: { type: ["string", "null"] },
        actorKeyId: { type: ["string", "null"] },
        intentId: ref("IntentId"),
        stepId: str(),
        dryRun: bool(),
        chain: arrayOf(ref("PolicyChainLink")),
        notionalUsd: str(),
        usage: arrayOf(obj({ scope: SCOPE_ID, window: str({ enum: ["24h", "7d"] }), usedUsd: str(), capUsd: str() })),
        violations: arrayOf(ref("PolicyViolation")),
        triggers: arrayOf(ref("PolicyViolation")),
        warnings: arrayOf(str()),
        requestDigest: str({ description: "sha256 of the canonical request (the request itself is not stored)." }),
        title: str(),
        exposureId: str(),
        approvalId: str({ pattern: APPROVAL_ID_PATTERN.source }),
      },
      ["id", "seq", "prevHash", "chainHash", "at", "stage", "outcome", "projectId", "keyId", "actorKeyId", "dryRun", "chain", "violations", "triggers", "warnings", "requestDigest"],
    ),
    PolicyDecisionListResponse: obj(
      {
        decisions: arrayOf(ref("PolicyDecision"), { description: "Newest first." }),
        head: nullable(obj({ seq: int(), chainHash: str() }, ["seq", "chainHash"], { description: "The project's latest decision (to verify the chain up to it)." })),
      },
      ["decisions", "head"],
    ),
    PolicyDecisionResponse: obj({ decision: ref("PolicyDecision") }, ["decision"]),
    PolicySpendResponse: obj(
      {
        spend: obj(
          {
            keyId: KEY_ID,
            at: ISO,
            scopes: arrayOf(
              obj(
                {
                  scope: SCOPE_ID,
                  kind: str({ enum: ["project", "key"] }),
                  capDailyUsd: { type: ["string", "null"] },
                  usedDailyUsd: str(),
                  remainingDailyUsd: { type: ["string", "null"] },
                  capWeeklyUsd: { type: ["string", "null"] },
                  usedWeeklyUsd: str(),
                  remainingWeeklyUsd: { type: ["string", "null"] },
                  perStepUsd: { type: ["string", "null"] },
                  perIntentUsd: { type: ["string", "null"] },
                },
                ["scope", "kind", "capDailyUsd", "usedDailyUsd", "remainingDailyUsd", "capWeeklyUsd", "usedWeeklyUsd", "remainingWeeklyUsd", "perStepUsd", "perIntentUsd"],
              ),
              { description: "Every level of the key's chain, root first." },
            ),
          },
          ["keyId", "at", "scopes"],
        ),
      },
      ["spend"],
    ),
    PolicyApproval: obj(
      {
        id: str({ pattern: APPROVAL_ID_PATTERN.source }),
        status: str({ enum: ["pending", "approved", "rejected", "expired"] }),
        intentId: ref("IntentId"),
        keyId: KEY_ID,
        title: { type: ["string", "null"] },
        steps: arrayOf(obj({ id: str(), kind: str(), network: str(), destinationNetwork: str(), protocol: str(), input: str(), output: str(), recipient: str(), recipientName: str() }, ["id", "kind", "network", "protocol", "recipient"])),
        recipients: arrayOf(str()),
        notionalUsd: str(),
        ceilingUsd: str({ description: "The approval covers the intent while its fresh value stays at or below this." }),
        triggers: arrayOf(str()),
        digest: str({ pattern: "^0x[0-9a-f]{64}$" }),
        expiresAt: ISO,
        createdAt: ISO,
        decidedAt: NULLABLE_ISO,
        decidedBy: nullable(obj({ kind: str({ enum: ["key", "wallet"] }), id: str({ description: "Key id, or the masked wallet." }) }, ["kind", "id"])),
        approvers: obj({ requireWallet: bool(), wallets: arrayOf(str(), { description: "Masked." }), keys: int({ minimum: 0 }) }, ["requireWallet", "wallets", "keys"]),
        signing: obj(
          { approvalId: str(), intentId: ref("IntentId"), digest: str(), ceilingUsdCents: str(), maxExpiresAt: int({ description: "Unix seconds: a wallet signature's expiresAt must not exceed it." }) },
          ["approvalId", "intentId", "digest", "ceilingUsdCents", "maxExpiresAt"],
          { description: "Inputs of approvalTypedData (EIP-712 \"Kletia Approvals\") and approvalMessageText (Solana) in @kletia/core." },
        ),
      },
      ["id", "status", "intentId", "keyId", "title", "steps", "recipients", "notionalUsd", "ceilingUsd", "triggers", "digest", "expiresAt", "createdAt", "decidedAt", "decidedBy", "approvers", "signing"],
    ),
    PolicyApprovalResponse: obj({ approval: ref("PolicyApproval") }, ["approval"]),
    PolicyApprovalListResponse: obj({ approvals: arrayOf(ref("PolicyApproval")) }, ["approvals"]),
    PolicyApprovalDecisionRequest: {
      oneOf: [
        obj({}, [], { additionalProperties: false, description: "Empty: decide with the API key of the request (a project key outside the requester's subtree)." }),
        obj(
          {
            account: str({ description: "The approver wallet's CAIP-10 account." }),
            signature: str({ minLength: 64, maxLength: 4096, description: "EIP-712 signature (EOA, ERC-1271 or ERC-6492) or the Solana ed25519 signature (base58 or base64) of approvalMessageText." }),
            expiresAt: { type: ["integer", "string"], description: "The unix seconds (or ISO time) signed." },
          },
          ["account", "signature", "expiresAt"],
          { additionalProperties: false },
        ),
      ],
    },
    ChildKeyRequest: obj(
      {
        name: str({ minLength: 1, maxLength: 64 }),
        expiresInSeconds: int({ minimum: POLICY_LIMITS.agentMinTtlSeconds, maximum: POLICY_LIMITS.agentMaxTtlSeconds, default: POLICY_LIMITS.agentDefaultTtlSeconds, description: "Never later than the parent's expiry." }),
        policy: ref("PolicyDocument"),
        template: str({ enum: Object.keys(POLICY_TEMPLATES) }),
        fill: obj({ accounts: arrayOf(str()), recipients: arrayOf(str()), approverWallets: arrayOf(str()), contracts: arrayOf({ type: "object" }) }, [], { description: "Values a template needs." }),
      },
      ["name"],
      { additionalProperties: false, description: "Without policy or template the agent key is an observer (plans, quotes and dry runs only)." },
    ),
    ChildKeyResponse: obj(
      {
        key: obj(
          {
            id: KEY_ID,
            name: str(),
            tier: str({ const: "developer" }),
            kind: str({ const: "agent" }),
            parentId: KEY_ID,
            lineage: arrayOf(KEY_ID, { description: "Ancestors, root (the project key) first." }),
            depth: int({ minimum: 1, maximum: POLICY_LIMITS.maxAgentDepth }),
            expiresAt: ISO,
            createdAt: ISO,
            key: str({ pattern: AGENT_KEY_PATTERN.source, description: "The raw agent key. Shown once." }),
          },
          ["id", "name", "tier", "kind", "parentId", "lineage", "depth", "expiresAt", "createdAt", "key"],
        ),
        policy: obj(
          { scope: str({ const: "key" }), keyId: KEY_ID, version: int(), hash: { type: ["string", "null"] }, status: str(), warnings: arrayOf({ type: "object" }) },
          ["scope", "keyId", "version", "hash", "status", "warnings"],
        ),
      },
      ["key", "policy"],
    ),
    ApiKeyPatchRequest: obj(
      { expiresAt: { type: ["string", "null"], format: "date-time", description: "Earlier: applies at once (descendants are clamped). Later: only for keys without an amendment delay. null: project keys only." } },
      ["expiresAt"],
      { additionalProperties: false },
    ),
    ApiKeyViewResponse: obj({ key: ref("ApiKeyView") }, ["key"]),
    PolicyEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...POLICY_EVENT_TYPES] }),
        at: ISO,
        data: obj(
          {
            projectId: str(),
            keyId: { type: ["string", "null"], description: "Subject key (null for the project rule book)." },
            decisionId: str(),
            approvalId: str(),
            intentId: ref("IntentId"),
            stage: str(),
            rules: arrayOf(str()),
            scope: str(),
            version: int(),
            hash: str(),
            activatesAt: ISO,
            loosened: arrayOf(str()),
            decision: str({ enum: ["approved", "rejected", "expired"] }),
            notionalUsd: str(),
            ceilingUsd: str(),
            url: str({ format: "uri" }),
            expiresAt: ISO,
            triggers: arrayOf(str()),
            window: str({ enum: ["24h", "7d"] }),
            thresholdPct: int({ enum: [80, 95] }),
            usedUsd: str(),
            capUsd: str(),
          },
          ["projectId", "keyId"],
        ),
      },
      ["id", "type", "at", "data"],
      { description: "Rule Book events: to the subject key's webhooks, and to `scope: \"subtree\"` webhooks of its ancestors and of the project's project keys." },
    ),
    KeyEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...KEY_EVENT_TYPES] }),
        at: ISO,
        data: obj(
          {
            projectId: str(),
            keyId: KEY_ID,
            kind: str({ enum: ["project", "agent"] }),
            parentId: { type: ["string", "null"] },
            expiresAt: NULLABLE_ISO,
            cascade: arrayOf(KEY_ID, { description: "key.revoked: every key revoked with it (its subtree), the subject included." }),
          },
          ["projectId", "keyId"],
        ),
      },
      ["id", "type", "at", "data"],
    ),
  };
}

function policyPathsFor(base: string, subject: "key" | "project"): JsonObject {
  const parameters = subject === "key" ? [keyIdPath] : [];
  const what = subject === "key" ? "a key's rule book" : "the project rule book";
  const op = (name: string) => `${name}${subject === "key" ? "Key" : "Project"}Policy`;
  return {
    [base]: {
      get: {
        operationId: op("get"),
        tags: ["Rule Book"],
        summary: `Read ${what}`,
        description:
          subject === "key"
            ? "The key's own rule book (active version and pending amendment) and the effective chain it is evaluated against. Keys in the caller's subtree only (project keys: the whole project)."
            : "The project's rule book (every key of the project is evaluated against it).",
        security: KEY_REQUIRED,
        parameters,
        responses: { "200": ok("PolicyResponse", "The rule book."), ...errors("404", "409") },
      },
      put: {
        operationId: op("put"),
        tags: ["Rule Book"],
        summary: `Create or replace ${what}`,
        description:
          "Tightening applies at once; loosening waits `amendments.delaySeconds` (status `pending`, `policy.amendment_pending` webhook), and a newer write supersedes a pending one. Project keys with their current secret only; agent keys never write rule books (403 AGENT_KEY_FORBIDDEN). Invalid documents: 400 POLICY_INVALID with issues; a stale If-Match: 409 POLICY_CONFLICT. Honours `Idempotency-Key`.",
        security: KEY_REQUIRED,
        parameters: [...parameters, IF_MATCH, idempotencyKeyParameter],
        requestBody: jsonBody("PolicyWriteRequest"),
        responses: { "200": ok("PolicyWriteResponse", "The new version.", ETAG), ...errors("403", "404", "409", "413", "415", "422") },
      },
      delete: {
        operationId: op("delete"),
        tags: ["Rule Book"],
        summary: `Remove ${what}`,
        description: "Removal is a loosening: it waits for the amendment delay like any loosening (an agent key without a rule book is an observer). Returns the removal version.",
        security: KEY_REQUIRED,
        parameters: [...parameters, IF_MATCH],
        responses: { "200": ok("PolicyWriteResponse", "The removal version."), ...errors("403", "404", "409") },
      },
    },
    [`${base}/pending`]: {
      delete: {
        operationId: op("cancelPending"),
        tags: ["Rule Book"],
        summary: `Cancel the pending amendment of ${what}`,
        description: "404 POLICY_NOT_FOUND when nothing is pending.",
        security: KEY_REQUIRED,
        parameters,
        responses: { "200": ok("PolicyVersionResponse", "The cancelled version."), ...errors("403", "404", "409") },
      },
    },
  };
}

export function policyPaths(): JsonObject {
  return {
    "/v1/keys/{id}/children": {
      post: {
        operationId: "createAgentKey",
        tags: ["Keys"],
        summary: "Issue an agent key under a key (kl_agt_…, secret returned once)",
        description: `Agent keys sit at most ${POLICY_LIMITS.maxAgentDepth} levels below a project key (409 KEY_DEPTH_EXCEEDED), at most ${POLICY_LIMITS.agentKeysPerProject} active per project (409 AGENT_KEY_LIMIT_REACHED), always expire and never outlive their parent. Their rule book (policy or template) is version 1; without one they are observers. Every request of an agent key is checked against its whole chain, and revoking a key revokes its subtree. An agent key needs \`permissions.createChildKeys\` to create children of its own. Honours \`Idempotency-Key\` (the stored response is encrypted at rest).`,
        security: KEY_REQUIRED,
        parameters: [keyIdPath, idempotencyKeyParameter],
        requestBody: jsonBody("ChildKeyRequest"),
        responses: { "201": ok("ChildKeyResponse", "The agent key with its secret."), ...errors("403", "404", "409", "413", "415", "422") },
      },
    },
    ...policyPathsFor("/v1/keys/{id}/policy", "key"),
    "/v1/keys/{id}/policy/versions": {
      get: {
        operationId: "listKeyPolicyVersions",
        tags: ["Rule Book"],
        summary: "Every version of a key's rule book",
        security: KEY_REQUIRED,
        parameters: [keyIdPath, { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 100 }) }],
        responses: { "200": ok("PolicyVersionListResponse", "Versions, newest first."), ...errors("404", "409") },
      },
    },
    ...policyPathsFor("/v1/projects/current/policy", "project"),
    "/v1/policy/validate": {
      post: {
        operationId: "validatePolicy",
        tags: ["Rule Book"],
        summary: "Validate a rule book (and compare it with another)",
        description: "Public and stateless: the same checks as validatePolicy in @kletia/core, the canonical hash, warnings, and with `against` what the change tightens and loosens.",
        requestBody: jsonBody("PolicyValidateRequest"),
        responses: { "200": ok("PolicyValidateResponse", "The verdict."), ...errors("413", "415") },
      },
    },
    "/v1/policy/evaluate": {
      post: {
        operationId: "evaluatePolicy",
        tags: ["Rule Book"],
        summary: "Simulate a request against a key's chain",
        description: `Plans the request as a dry run under the effective constraints and explains every rule (pass, fail, trigger, warn), with spend usage and the timetable. Optionally replaces the key's own rule book with a draft, or moves the clock. Nothing is stored, reserved or held; the decision log records an \`evaluate\` entry. ${POLICY_EVALUATIONS_PER_MINUTE} per minute per key.`,
        security: KEY_REQUIRED,
        requestBody: jsonBody("PolicyEvaluateRequest"),
        responses: { "200": ok("PolicyEvaluateResponse", "The evaluation."), ...errors("404", "409", "413", "415", "422") },
      },
    },
    "/v1/policy/decisions": {
      get: {
        operationId: "listPolicyDecisions",
        tags: ["Rule Book"],
        summary: "The hash-chained decision log",
        description: "Every plan, prepare, submit, evaluation, approval, amendment and key decision of the caller's subtree, newest first. Records are chained per project (verifyDecisionChain in @kletia/core).",
        security: KEY_REQUIRED,
        parameters: [
          { name: "outcome", in: "query", required: false, schema: str({ enum: OUTCOMES }) },
          { name: "stage", in: "query", required: false, schema: str({ enum: STAGES }) },
          { name: "keyId", in: "query", required: false, schema: KEY_ID },
          { name: "intentId", in: "query", required: false, schema: ref("IntentId") },
          { name: "since", in: "query", required: false, schema: ISO },
          { name: "after", in: "query", required: false, description: "Page after this decision id.", schema: str({ pattern: POLICY_DECISION_ID_PATTERN.source }) },
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 200, default: 50 }) },
        ],
        responses: { "200": ok("PolicyDecisionListResponse", "Decisions."), ...errors("404", "409") },
      },
    },
    "/v1/policy/decisions/{id}": {
      get: {
        operationId: "getPolicyDecision",
        tags: ["Rule Book"],
        summary: "One decision",
        security: KEY_REQUIRED,
        parameters: [{ name: "id", in: "path", required: true, schema: str({ pattern: POLICY_DECISION_ID_PATTERN.source }) }],
        responses: { "200": ok("PolicyDecisionResponse", "The decision."), ...errors("404", "409") },
      },
    },
    "/v1/policy/spend": {
      get: {
        operationId: "getPolicySpend",
        tags: ["Rule Book"],
        summary: "Spend windows of a key's chain",
        description: "Rolling 24 h and 7 d USD usage and what remains at every level (project, ancestors, the key).",
        security: KEY_REQUIRED,
        parameters: [{ name: "keyId", in: "query", required: false, schema: KEY_ID }],
        responses: { "200": ok("PolicySpendResponse", "Spend."), ...errors("404", "409") },
      },
    },
    "/v1/policy/approvals": {
      get: {
        operationId: "listPolicyApprovals",
        tags: ["Rule Book"],
        summary: "Approvals requested by (or waiting for) the caller",
        security: KEY_REQUIRED,
        parameters: [
          { name: "role", in: "query", required: false, schema: str({ enum: ["requester", "approver"], default: "requester" }) },
          { name: "status", in: "query", required: false, schema: str({ enum: ["pending", "approved", "rejected", "expired"] }) },
          { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) },
        ],
        responses: { "200": ok("PolicyApprovalListResponse", "Approvals."), ...errors("409") },
      },
    },
    "/v1/policy/approvals/{id}": {
      get: {
        operationId: "getPolicyApproval",
        tags: ["Rule Book"],
        summary: "Read an approval (the id is the capability)",
        description: "What the held intent does (steps, recipients, value, ceiling, triggers) and what to sign. Reading is not approving. Wallets are masked.",
        parameters: [approvalIdPath],
        responses: { "200": ok("PolicyApprovalResponse", "The approval."), ...errors("404") },
      },
    },
    "/v1/policy/approvals/{id}/approve": {
      post: {
        operationId: "approvePolicyApproval",
        tags: ["Rule Book"],
        summary: "Approve a held intent",
        description:
          "With an empty body, the request's API key decides (an active project key outside the requester's subtree, listed in `confirm.approvers.keys` when the list is set; agent keys never approve). With `{ account, signature, expiresAt }`, a listed approver wallet decides (EIP-712, ERC-1271 or ERC-6492 on EVM; a signed message on Solana). A decision is final (409 APPROVAL_DECIDED).",
        parameters: [approvalIdPath],
        requestBody: { ...jsonBody("PolicyApprovalDecisionRequest", false) },
        responses: { "200": ok("PolicyApprovalResponse", "The decided approval."), ...errors("403", "404", "409", "410", "413", "415") },
      },
    },
    "/v1/policy/approvals/{id}/reject": {
      post: {
        operationId: "rejectPolicyApproval",
        tags: ["Rule Book"],
        summary: "Reject a held intent (it is cancelled)",
        description: "Same deciders as approve.",
        parameters: [approvalIdPath],
        requestBody: { ...jsonBody("PolicyApprovalDecisionRequest", false) },
        responses: { "200": ok("PolicyApprovalResponse", "The decided approval."), ...errors("403", "404", "409", "410", "413", "415") },
      },
    },
  };
}

/** PATCH /v1/keys/{id} (merged into the existing path item). */
export function keyPatchOperation(): JsonObject {
  return {
    operationId: "patchApiKey",
    tags: ["Keys"],
    summary: "Change a key's expiry",
    description:
      "Shortening applies at once (descendants never outlive it). Extending is a loosening: refused while the key's rule book has an amendment delay. Agent keys always expire; project keys may clear it with null. Managed keys only (the caller's subtree).",
    security: KEY_REQUIRED,
    parameters: [keyIdPath],
    requestBody: jsonBody("ApiKeyPatchRequest"),
    responses: { "200": ok("ApiKeyViewResponse", "The key."), ...errors("403", "404", "409", "413", "415") },
  };
}
