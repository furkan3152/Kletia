/**
 * Sub-agent routes (docs/platform/subagents.md): requests by main agents,
 * the agent tree, owner-wallet challenges and decisions, the one-time claim,
 * revoke and pause. Responses that carry a secret (the claim token, the
 * claimed key) honour Idempotency-Key only sealed.
 */
import type { RequestHandler } from "express";
import { requireApiKey } from "../auth.js";
import { authOf, handle, pathParam, queryParam } from "../context.js";
import { idempotent } from "../idempotency.js";
import {
  agentTree,
  claimSubagent,
  decideSubagentRequest,
  getSubagentRequest,
  issueChallenge,
  listSubagents,
  parseSubagentRequest,
  pauseAgent,
  pendingForAccount,
  requestSubagent,
  revokeSubagent,
} from "./service.js";

export function agentHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /agents/:id/subagents": [
      requireApiKey,
      idempotent({ route: "POST /agents/:id/subagents", secret: true }),
      handle(async (req, res) => {
        res.status(201).json(await requestSubagent(authOf(req), pathParam(req, "id"), parseSubagentRequest(req.body)));
      }),
    ],
    "get /agents/:id/subagents": [
      requireApiKey,
      handle(async (req, res) => {
        res.status(200).json(await listSubagents(authOf(req), pathParam(req, "id")));
      }),
    ],
    "get /agents/tree": [
      requireApiKey,
      handle(async (req, res) => {
        res.status(200).json(await agentTree(authOf(req)));
      }),
    ],
    "get /agents/pending": [
      handle(async (req, res) => {
        res.status(200).json(await pendingForAccount(queryParam(req, "account", 160)));
      }),
    ],
    "get /agents/requests/:id": [
      requireApiKey,
      handle(async (req, res) => {
        res.status(200).json({ request: await getSubagentRequest(authOf(req), pathParam(req, "id")) });
      }),
    ],
    "post /agents/requests/:id/challenge": [
      handle(async (req, res) => {
        res.status(200).json(await issueChallenge(req.get("origin"), pathParam(req, "id"), req.body));
      }),
    ],
    "post /agents/requests/:id/approve": [
      handle(async (req, res) => {
        res.status(200).json({ request: await decideSubagentRequest(pathParam(req, "id"), "approve", authOf(req), req.body, req.get("origin")) });
      }),
    ],
    "post /agents/requests/:id/deny": [
      handle(async (req, res) => {
        res.status(200).json({ request: await decideSubagentRequest(pathParam(req, "id"), "deny", authOf(req), req.body, req.get("origin")) });
      }),
    ],
    "post /agents/requests/:id/claim": [
      requireApiKey,
      idempotent({ route: "POST /agents/requests/:id/claim", secret: true }),
      handle(async (req, res) => {
        res.status(200).json(await claimSubagent(authOf(req), pathParam(req, "id"), req.body));
      }),
    ],
    "post /agents/:id/revoke": [
      requireApiKey,
      handle(async (req, res) => {
        res.status(200).json(await revokeSubagent(authOf(req), pathParam(req, "id")));
      }),
    ],
    "post /agents/:id/pause": [
      requireApiKey,
      handle(async (req, res) => {
        res.status(200).json(await pauseAgent(authOf(req), pathParam(req, "id")));
      }),
    ],
  };
}
