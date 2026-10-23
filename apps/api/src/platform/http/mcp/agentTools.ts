/**
 * MCP tools of sub-agents (docs/platform/subagents.md). A main agent (agent
 * key with `permissions.createChildKeys`) connects with its own key:
 *
 * - `request_subagent`: files a request under itself; a human approves it in
 *   the portal (owner wallet or project key). Returns the claim token once;
 * - `list_subagents` (read-only): its requests and sub-agents with caps and use;
 * - `claim_subagent`: the approved sub-agent's key, once, within 15 minutes
 *   of the approval: hand it to the sub-agent's own process;
 * - `revoke_subagent`: revokes a sub-agent of its subtree with its descendants.
 *
 * Nothing here signs or moves funds; a sub-agent is bounded by its whole chain.
 */
import { API_KEY_ID_PATTERN, SUBAGENT_CLAIM_TOKEN_PATTERN, SUBAGENT_LIMITS, SUBAGENT_REQUEST_ID_PATTERN, type PolicyTemplateId } from "@kletia/core";
import { agentForbidden } from "../policies/agentGuard.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { claimSubagent, listSubagents, parseSubagentRequest, requestSubagent, revokeSubagent, type AgentTreeNode, type SubagentRequestView } from "../agents/service.js";
import { toolAuth } from "./policyTools.js";
import type { KletiaTool, ToolAnnotations } from "./tools.js";

function annotations(title: string, readOnly: boolean, idempotent: boolean, destructive = false): ToolAnnotations {
  return { title, readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

/** What an agent needs of a request: status, what the human sees, and when it may claim. */
function requestSummary(request: SubagentRequestView): Record<string, unknown> {
  return {
    requestId: request.id,
    status: request.status,
    name: request.name,
    policyHash: request.policyHash,
    keyExpiresAt: request.keyExpiresAt,
    expiresAt: request.expiresAt,
    ...(request.claimBy ? { claimBy: request.claimBy } : {}),
    ...(request.childKeyId ? { childKeyId: request.childKeyId } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    grant: request.grant.map((line) => `${line.label}: ${line.child}${line.same ? "" : ` (yours: ${line.parent})`}`),
  };
}

function nodeSummary(node: AgentTreeNode): Record<string, unknown> {
  return {
    keyId: node.id,
    name: node.name,
    mode: node.chainMode,
    expiresAt: node.expiresAt,
    caps: node.caps ?? {},
    used: { last24h: `$${node.usage.dayUsd}`, last7d: `$${node.usage.weekUsd}` },
    ...(node.children.length > 0 ? { subagents: node.children.map(nodeSummary) } : {}),
  };
}

async function agentAuth(caller: Parameters<KletiaTool["run"]>[1]) {
  const auth = await toolAuth(caller);
  if (auth.keyKind !== "agent" || !auth.keyId) throw agentForbidden("Sub-agent tools are for agent keys; project keys manage agents in the portal or with /v1/keys.");
  return auth;
}

export const REQUEST_SUBAGENT_TOOL: KletiaTool = {
  name: "request_subagent",
  description:
    "Ask for a sub-agent: a new agent key below the connecting agent key, with a rule book that must be inside yours (networks, assets, venues, recipients, caps, timetable; no management permissions). Nothing is granted until the project's owner approves with a wallet signature or a project key holder approves in the portal. Returns the request id and a claim token shown only once: keep it to claim the key after approval.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.nameLength },
      purpose: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.purposeLength, description: "What the sub-agent is for, shown to the approver." },
      policy: { type: "object", description: "A kletia.policy/v1 rule book (get_policy shows yours). Absent: the observer (dry runs only)." },
      template: { type: "string", enum: ["observer", "payments-agent", "treasury-rebalancer", "contract-operator"] satisfies PolicyTemplateId[] },
      fill: { type: "object" },
      expiresInSeconds: { type: "integer", minimum: 3_600, maximum: 31_536_000, description: "Default 7 days; never past your own expiry." },
    },
    required: ["name", "purpose"],
    additionalProperties: false,
  },
  annotations: annotations("Request a sub-agent (a human approves)", false, false),
  async run(args, caller) {
    const auth = await agentAuth(caller);
    const filed = await requestSubagent(auth, auth.keyId as string, parseSubagentRequest(args));
    return {
      ...requestSummary(filed.request),
      claimToken: filed.claimToken,
      approval: { url: `${kletiaWebOrigin()}/developers/agent-tree`, note: "Give this link to the project's owner. Poll list_subagents; once approved, call claim_subagent within 15 minutes." },
    };
  },
};

export const LIST_SUBAGENTS_TOOL: KletiaTool = {
  name: "list_subagents",
  description: "List the connecting agent key's sub-agent requests (pending, approved, claimed, denied, expired, cancelled) and its sub-agents with their mode, caps and what they used in the last 24 h and 7 days.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: annotations("List my sub-agents", true, true),
  async run(_args, caller) {
    const auth = await agentAuth(caller);
    const { requests, children } = await listSubagents(auth, auth.keyId as string);
    return { requests: requests.map(requestSummary), subagents: children.map(nodeSummary) };
  },
};

export const CLAIM_SUBAGENT_TOOL: KletiaTool = {
  name: "claim_subagent",
  description:
    "Claim an approved sub-agent: returns its API key once (kl_agt_…). Works once, only for the agent that asked, and only within 15 minutes of the approval; a late claim revokes the key. Hand the key to the sub-agent's own process and never print it.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", pattern: SUBAGENT_REQUEST_ID_PATTERN.source },
      claimToken: { type: "string", pattern: SUBAGENT_CLAIM_TOKEN_PATTERN.source },
    },
    required: ["requestId", "claimToken"],
    additionalProperties: false,
  },
  annotations: annotations("Claim an approved sub-agent's key", false, false),
  async run(args, caller) {
    const auth = await agentAuth(caller);
    const claimed = await claimSubagent(auth, String(args.requestId ?? ""), { claimToken: args.claimToken });
    return { keyId: claimed.key.id, key: claimed.key.key, expiresAt: claimed.key.expiresAt, policyHash: claimed.policy.hash, note: "Shown once. The sub-agent connects to MCP with this key; get_policy shows its rule book." };
  },
  // The key never goes into the text part, only the structured result.
  render: (value) => `Claimed sub-agent ${String(value.keyId)}; its key is in the structured result (shown once).`,
};

export const REVOKE_SUBAGENT_TOOL: KletiaTool = {
  name: "revoke_subagent",
  description: "Revoke one of your sub-agents (any key below the connecting agent key) together with everything below it. It stops at once; intents it created are no longer prepared.",
  inputSchema: {
    type: "object",
    properties: { keyId: { type: "string", pattern: API_KEY_ID_PATTERN.source } },
    required: ["keyId"],
    additionalProperties: false,
  },
  annotations: annotations("Revoke a sub-agent", false, true, true),
  async run(args, caller) {
    const auth = await agentAuth(caller);
    return revokeSubagent(auth, String(args.keyId ?? ""));
  },
};

export const AGENT_TOOLS: readonly KletiaTool[] = [REQUEST_SUBAGENT_TOOL, LIST_SUBAGENTS_TOOL, CLAIM_SUBAGENT_TOOL, REVOKE_SUBAGENT_TOOL];
