/**
 * What agent keys may do on the API itself (policy design §8.3): webhooks,
 * contract registrations, sessions, child keys and links each need the
 * matching `permissions.*` of the agent's effective chain (agent default:
 * false); key management of project keys and every rule book write are
 * never allowed. Project keys are unaffected. The chain is read fresh (a
 * pause or a permission removed by a parent applies at once).
 */
import type { RequestHandler } from "express";
import { effectivePermissions, type PolicyPermission } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { authOf, sendError, type AuthContext } from "../context.js";
import { readKeyChain } from "./chain.js";

const PERMISSION_LABELS: Readonly<Record<PolicyPermission, string>> = {
  createChildKeys: "create child keys",
  webhooks: "manage webhooks",
  registerContracts: "register or change contracts",
  sessions: "create sessions",
  storeIntents: "store intents",
  mcpCreateIntents: "create intents through MCP",
  links: "publish intent links",
};

export function agentForbidden(message: string): PlatformError {
  return new PlatformError("AGENT_KEY_FORBIDDEN", message, 403);
}

/** True when the caller authenticated with an agent key. */
export function isAgentKey(auth: AuthContext): boolean {
  return auth.keyKind === "agent";
}

/** Throws AGENT_KEY_FORBIDDEN when an agent key's chain does not grant `permission` (project keys pass). */
export async function assertAgentPermission(auth: AuthContext, permission: PolicyPermission): Promise<void> {
  if (!isAgentKey(auth) || !auth.keyId) return;
  const chain = await readKeyChain(auth.keyId);
  if (!chain || !chain.keyActive) throw agentForbidden("This agent key (or one of its ancestors) is revoked or expired.");
  const granted = effectivePermissions(chain.levels.map((level) => ({ policy: level.policy, defaults: level.defaults })));
  if (!granted[permission]) {
    throw agentForbidden(`Agent keys may ${PERMISSION_LABELS[permission]} only when their rule book grants permissions.${permission}; ask a project key to grant it.`);
  }
}

/** Route guard (mount after requireApiKey). */
export function forbidAgent(permission: PolicyPermission): RequestHandler {
  return (req, res, next) => {
    assertAgentPermission(authOf(req), permission).then(() => next(), (error: unknown) => sendError(req, res, error));
  };
}

/** Route guard: never for agent keys (project key management, rule book writes). */
export const projectKeysOnly: RequestHandler = (req, res, next) => {
  if (isAgentKey(authOf(req))) {
    sendError(req, res, agentForbidden("Agent keys never manage project keys or change rule books (their own included). Use a project key."));
    return;
  }
  next();
};
