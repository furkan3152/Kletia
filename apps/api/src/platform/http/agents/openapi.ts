/**
 * OpenAPI fragments of sub-agents (tag *Sub-agents*): requests by main
 * agents, the agent tree, owner-wallet challenges and decisions, the
 * one-time claim, revoke and pause. Limits come from @kletia/core
 * `SUBAGENT_LIMITS`. Merged by openapi.ts.
 */
import {
  ACCOUNT_EVM_NETWORKS,
  AGENT_EVENT_TYPES,
  API_KEY_ID_PATTERN,
  CHAINS,
  POLICY_LIMITS,
  POLICY_MODES,
  POLICY_TEMPLATES,
  SUBAGENT_CLAIM_TOKEN_PATTERN,
  SUBAGENT_LIMITS,
  SUBAGENT_REQUEST_ID_PATTERN,
  SUBAGENT_REQUEST_STATUSES,
} from "@kletia/core";
import { arrayOf, errors, idempotencyKeyParameter, int, jsonBody, KEY_REQUIRED, nullable, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";

const TAGS = ["Sub-agents"];
const KEY_ID = str({ pattern: API_KEY_ID_PATTERN.source });
const REQUEST_ID = str({ pattern: SUBAGENT_REQUEST_ID_PATTERN.source, examples: [`sar_${"3f".repeat(16)}`] });
const TIME = str({ format: "date-time" });
const NULLABLE_TIME = { type: ["string", "null"], format: "date-time" };
const USD = str({ pattern: "^\\d+\\.\\d{2}$" });
const KEY_PARAM: JsonObject = { name: "id", in: "path", required: true, schema: KEY_ID };
const REQUEST_PARAM: JsonObject = { name: "id", in: "path", required: true, schema: REQUEST_ID };
const CLAIM_MINUTES = SUBAGENT_LIMITS.claimWindowSeconds / 60;

export function agentSchemas(): JsonObject {
  return {
    SubagentRequestCreate: obj(
      {
        name: str({ minLength: 1, maxLength: SUBAGENT_LIMITS.nameLength }),
        purpose: str({ minLength: 1, maxLength: SUBAGENT_LIMITS.purposeLength, description: "What the sub-agent is for, shown to the approver." }),
        policy: ref("PolicyDocument"),
        template: str({ enum: Object.keys(POLICY_TEMPLATES) }),
        fill: obj({ accounts: arrayOf(str()), recipients: arrayOf(str()), approverWallets: arrayOf(str()), contracts: arrayOf({ type: "object" }) }, [], { description: "Values a template needs." }),
        expiresInSeconds: int({ minimum: POLICY_LIMITS.agentMinTtlSeconds, maximum: POLICY_LIMITS.agentMaxTtlSeconds, default: SUBAGENT_LIMITS.defaultTtlSeconds, description: "Never later than the parent's expiry." }),
      },
      ["name", "purpose"],
      { additionalProperties: false, description: "The rule book must be a subset of the parent's chain (403 SUBAGENT_POLICY_NOT_SUBSET lists the fields). Without policy or template the sub-agent is an observer." },
    ),
    SubagentGrantLine: obj(
      { path: str(), label: str(), child: str({ description: "What the sub-agent gets." }), parent: str({ description: "What the parent's own rule book has." }), same: { type: "boolean" } },
      ["path", "label", "child", "parent", "same"],
    ),
    SubagentRequest: obj(
      {
        id: REQUEST_ID,
        status: str({ enum: [...SUBAGENT_REQUEST_STATUSES] }),
        projectId: str(),
        parentKeyId: KEY_ID,
        name: str(),
        purpose: str(),
        policy: ref("PolicyDocument"),
        policyHash: str({ pattern: "^sha256:[0-9a-f]{64}$" }),
        keyExpiresAt: TIME,
        createdAt: TIME,
        expiresAt: { ...TIME, description: "When an open request lapses." },
        decidedAt: NULLABLE_TIME,
        decidedBy: nullable(obj({ kind: str({ enum: ["wallet", "key"] }), id: str({ description: "A key id, or the masked owner wallet." }) }, ["kind", "id"])),
        childKeyId: nullable(KEY_ID),
        claimedAt: NULLABLE_TIME,
        claimBy: { ...NULLABLE_TIME, description: `Approved requests: the end of the ${CLAIM_MINUTES}-minute claim window.` },
        reason: nullable(str({ enum: ["not_decided", "parent_inactive", "claim_window", "mint_failed"] })),
        grant: arrayOf(ref("SubagentGrantLine")),
      },
      ["id", "status", "projectId", "parentKeyId", "name", "purpose", "policy", "policyHash", "keyExpiresAt", "createdAt", "expiresAt", "decidedAt", "decidedBy", "childKeyId", "claimedAt", "claimBy", "reason", "grant"],
    ),
    SubagentRequestResponse: obj({ request: ref("SubagentRequest") }, ["request"]),
    SubagentRequestCreated: obj(
      { request: ref("SubagentRequest"), claimToken: str({ pattern: SUBAGENT_CLAIM_TOKEN_PATTERN.source, description: "Shown once; only its SHA-256 is stored." }) },
      ["request", "claimToken"],
    ),
    AgentTreeNode: obj(
      {
        id: KEY_ID,
        name: str(),
        kind: str({ enum: ["project", "agent"] }),
        parentId: nullable(KEY_ID),
        depth: int({ minimum: 0, maximum: SUBAGENT_LIMITS.maxDepth }),
        expiresAt: NULLABLE_TIME,
        active: { type: "boolean" },
        mode: str({ enum: [...POLICY_MODES] }),
        chainMode: str({ enum: [...POLICY_MODES], description: "The strictest mode of the project and every ancestor: a paused parent pauses its subtree." }),
        policyVersion: { type: ["integer", "null"] },
        policyHash: { type: ["string", "null"] },
        caps: nullable(obj({ perStepUsd: str(), perIntentUsd: str(), dailyUsd: str(), weeklyUsd: str() })),
        usage: obj({ dayUsd: USD, weekUsd: USD }, ["dayUsd", "weekUsd"], { description: "Counted exposure of the key and everything below it, rolling 24 h and 7 d." }),
        children: arrayOf(ref("AgentTreeNode")),
      },
      ["id", "name", "kind", "parentId", "depth", "expiresAt", "active", "mode", "chainMode", "policyVersion", "policyHash", "caps", "usage", "children"],
    ),
    AgentTreeResponse: obj({ nodes: arrayOf(ref("AgentTreeNode")), requests: arrayOf(ref("SubagentRequest")) }, ["nodes", "requests"]),
    SubagentListResponse: obj({ requests: arrayOf(ref("SubagentRequest")), children: arrayOf(ref("AgentTreeNode")) }, ["requests", "children"]),
    SubagentChallengeRequest: obj(
      {
        decision: str({ enum: ["approve", "deny"] }),
        walletKind: str({ enum: ["evm", "solana"] }),
        address: str(),
        chainId: int({ enum: ACCOUNT_EVM_NETWORKS.map((network) => CHAINS[network].evmChainId as number), description: "EVM only; smart accounts are checked on it." }),
      },
      ["decision", "walletKind", "address"],
    ),
    SubagentChallengeResponse: obj({ message: str({ description: "The exact text to sign (EIP-191 personal_sign or Solana signMessage)." }), expiresAt: TIME }, ["message", "expiresAt"]),
    SubagentDecisionRequest: obj(
      { message: str({ maxLength: 4000 }), signature: str({ maxLength: 4000, description: "EVM: 0x hex. Solana: base58 or base64 of the 64-byte ed25519 signature." }) },
      [],
      { description: "Empty with a project key; { message, signature } from the owner wallet." },
    ),
    SubagentClaimRequest: obj({ claimToken: str({ pattern: SUBAGENT_CLAIM_TOKEN_PATTERN.source }) }, ["claimToken"]),
    SubagentClaimResponse: obj(
      {
        key: obj(
          { id: KEY_ID, name: str(), key: str({ pattern: "^kl_agt_[0-9A-Za-z]{32}$", description: "Shown once." }), parentId: KEY_ID, expiresAt: TIME, kind: str({ enum: ["agent"] }) },
          ["id", "name", "key", "parentId", "expiresAt", "kind"],
        ),
        policy: obj({ hash: str(), version: int({ enum: [1] }) }, ["hash", "version"]),
      },
      ["key", "policy"],
    ),
    SubagentRevokeResponse: obj({ keyId: KEY_ID, revoked: arrayOf(KEY_ID) }, ["keyId", "revoked"]),
    AgentPauseResponse: obj({ keyId: KEY_ID, mode: str({ enum: ["paused"] }), version: int({ minimum: 1 }) }, ["keyId", "mode", "version"]),
    AgentPendingResponse: obj({ pending: int({ minimum: 0 }) }, ["pending"]),
    AgentEvent: obj(
      {
        id: ref("EventId"),
        type: str({ enum: [...AGENT_EVENT_TYPES] }),
        at: TIME,
        data: obj(
          {
            projectId: str(),
            keyId: nullable(KEY_ID),
            requestId: REQUEST_ID,
            name: str(),
            childKeyId: KEY_ID,
            policyHash: str(),
            decidedBy: nullable(obj({ kind: str({ enum: ["wallet", "key"] }), account: str(), keyId: KEY_ID }, ["kind"])),
            cascade: arrayOf(KEY_ID),
          },
          ["projectId", "keyId", "name"],
          { description: "`keyId` is the parent (the requesting agent). Never a secret or a claim token." },
        ),
      },
      ["id", "type", "at", "data"],
      { description: "Sub-agent events, routed like key events: to the parent's webhooks and to `scope: \"subtree\"` webhooks of its ancestors and of the project's project keys." },
    ),
  };
}

export function agentPaths(): JsonObject {
  return {
    "/v1/agents/{id}/subagents": {
      post: {
        operationId: "requestSubagent",
        tags: TAGS,
        summary: "Request a sub-agent (a human approves)",
        description: `With the agent key \`{id}\` itself, whose chain grants \`permissions.createChildKeys\`. The rule book must be a subset of the parent's whole chain; sub-agents never get webhooks, registerContracts, sessions or links, and every permission not asked for is off. At most ${SUBAGENT_LIMITS.maxDepth} levels below a project key (409 KEY_DEPTH_EXCEEDED), ${SUBAGENT_LIMITS.childrenPerParent} children and open requests per parent and ${SUBAGENT_LIMITS.openRequestsPerParent} open requests (409 SUBAGENT_LIMIT_REACHED). The request stays open ${SUBAGENT_LIMITS.requestTtlSeconds / 3600} h. Emits agent.subagent_requested. Honours \`Idempotency-Key\` (stored sealed: the answer carries the claim token).`,
        security: KEY_REQUIRED,
        parameters: [KEY_PARAM, idempotencyKeyParameter],
        requestBody: jsonBody("SubagentRequestCreate"),
        responses: { "201": ok("SubagentRequestCreated", "The request and its claim token (shown once)."), ...errors("403", "404", "409", "413", "415") },
      },
      get: {
        operationId: "listSubagents",
        tags: TAGS,
        summary: "Requests and sub-agents of a key",
        description: "The key `{id}` must be the caller or in its subtree (project keys: any key of the project).",
        security: KEY_REQUIRED,
        parameters: [KEY_PARAM],
        responses: { "200": ok("SubagentListResponse", "Requests newest first, and the live children with caps and use."), ...errors("403", "404") },
      },
    },
    "/v1/agents/tree": {
      get: {
        operationId: "getAgentTree",
        tags: TAGS,
        summary: "The agent tree with caps, use and requests",
        description: "Project keys: every project and agent key of the project; agent keys: themselves and their subtree. Each node shows its mode, the strictest mode of its chain, caps and rolling 24 h / 7 d use (children's spending counts in every ancestor's windows).",
        security: KEY_REQUIRED,
        responses: { "200": ok("AgentTreeResponse", "Roots first."), ...errors("403") },
      },
    },
    "/v1/agents/pending": {
      get: {
        operationId: "countPendingSubagentRequests",
        tags: TAGS,
        summary: "Open requests for a wallet's projects (a count)",
        description: "Public. Answers only how many open sub-agent requests wait in projects the wallet owns, so the desk can tell the connected wallet; names, ids and projects are never shown here.",
        parameters: [{ name: "account", in: "query", required: true, schema: str({ maxLength: 160, description: "CAIP-10 account." }) }],
        responses: { "200": ok("AgentPendingResponse", "The count."), ...errors() },
      },
    },
    "/v1/agents/requests/{id}": {
      get: {
        operationId: "getSubagentRequest",
        tags: TAGS,
        summary: "A sub-agent request",
        description: "What is granted, line by line beside the parent's own rule book. Keys of the request's subtree and project keys read it.",
        security: KEY_REQUIRED,
        parameters: [REQUEST_PARAM],
        responses: { "200": ok("SubagentRequestResponse", "The request."), ...errors("403", "404") },
      },
    },
    "/v1/agents/requests/{id}/challenge": {
      post: {
        operationId: "createSubagentChallenge",
        tags: TAGS,
        summary: "The message the owner wallet signs",
        description: `From the Kletia developer portal (first-party Origin, else 403 ACCOUNT_ORIGIN_FORBIDDEN), for the wallet that owns the project only (403 SUBAGENT_APPROVER_NOT_ALLOWED). The message names the domain, the wallet, the decision, the request, project, parent, rule book hash, caps, networks, actions, permissions and the key's expiry, with a single-use nonce valid ${SUBAGENT_LIMITS.challengeTtlSeconds / 60} minutes. A new message replaces the previous one.`,
        parameters: [REQUEST_PARAM],
        requestBody: jsonBody("SubagentChallengeRequest"),
        responses: { "200": ok("SubagentChallengeResponse", "The message to sign."), ...errors("403", "404", "409", "410", "413", "415") },
      },
    },
    "/v1/agents/requests/{id}/approve": {
      post: {
        operationId: "approveSubagentRequest",
        tags: TAGS,
        summary: "Approve: mint the sub-agent",
        description: `With a project key of the project (empty body, current secret) or the owner wallet's \`{ message, signature }\` from the same origin as the challenge (the nonce is used up first; 403 SUBAGENT_SIGNATURE_INVALID otherwise; 502 RPC_UNAVAILABLE when a smart account cannot be checked). The parent's chain is read again (409 SUBAGENT_PARENT_INACTIVE, 403 SUBAGENT_POLICY_NOT_SUBSET). Mints the key once with a secret nobody sees; the requester claims it within ${CLAIM_MINUTES} minutes. Emits key.created and agent.subagent_approved.`,
        parameters: [REQUEST_PARAM],
        requestBody: { ...jsonBody("SubagentDecisionRequest", false) },
        responses: { "200": ok("SubagentRequestResponse", "The approved request with childKeyId and claimBy."), ...errors("403", "404", "409", "410", "413", "415", "502") },
      },
    },
    "/v1/agents/requests/{id}/deny": {
      post: {
        operationId: "denySubagentRequest",
        tags: TAGS,
        summary: "Deny a sub-agent request",
        description: "Same deciders and signature rules as approve. A decision is final (409 SUBAGENT_REQUEST_DECIDED). Emits agent.subagent_denied.",
        parameters: [REQUEST_PARAM],
        requestBody: { ...jsonBody("SubagentDecisionRequest", false) },
        responses: { "200": ok("SubagentRequestResponse", "The denied request."), ...errors("403", "404", "409", "410", "413", "415", "502") },
      },
    },
    "/v1/agents/requests/{id}/claim": {
      post: {
        operationId: "claimSubagent",
        tags: TAGS,
        summary: "Claim the approved sub-agent's key (once)",
        description: `With the requesting parent's key and the claim token (compared in constant time). Sets a fresh secret and returns it once. A wrong token, a second claim or a claim after the ${CLAIM_MINUTES}-minute window is 403 SUBAGENT_CLAIM_INVALID; a late claim revokes the unclaimed key. Honours \`Idempotency-Key\` (stored sealed).`,
        security: KEY_REQUIRED,
        parameters: [REQUEST_PARAM, idempotencyKeyParameter],
        requestBody: jsonBody("SubagentClaimRequest"),
        responses: { "200": ok("SubagentClaimResponse", "The sub-agent's key, shown once."), ...errors("403", "404", "413", "415") },
      },
    },
    "/v1/agents/{id}/revoke": {
      post: {
        operationId: "revokeSubagent",
        tags: TAGS,
        summary: "Revoke an agent and its subtree",
        description: "Project keys: any agent key of the project; agent keys: their descendants only. Everything below stops at once. Emits key.revoked and agent.subagent_revoked.",
        security: KEY_REQUIRED,
        parameters: [KEY_PARAM],
        responses: { "200": ok("SubagentRevokeResponse", "The revoked keys."), ...errors("403", "404", "409", "503") },
      },
    },
    "/v1/agents/{id}/pause": {
      post: {
        operationId: "pauseAgent",
        tags: TAGS,
        summary: "Pause an agent (and its subtree)",
        description: "Project keys only. Writes `mode: \"paused\"` into the key's rule book, a tightening that applies at once; every descendant reads its chain fresh and stops too. Resume from the Rule Book (a loosening waits the amendment delay).",
        security: KEY_REQUIRED,
        parameters: [KEY_PARAM],
        responses: { "200": ok("AgentPauseResponse", "The new rule book version."), ...errors("403", "404", "409") },
      },
    },
  };
}
