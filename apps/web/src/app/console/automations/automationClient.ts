/**
 * Calls of /v1/automations with the wallet's account session (the same
 * session as developer accounts). Failures are PlatformErrors.
 */
import type { AutomationView, ValidatedAutomationDraft } from "@kletia/core";

import { accountRequest } from "../../pages/developers/keys/accountClient";
import type { InboxRun } from "./automationModel";

const path = (id: string, suffix = "") => `/automations/${encodeURIComponent(id)}${suffix}`;

export const automationApi = {
  list: (token: string, signal?: AbortSignal) =>
    accountRequest<{ automations: AutomationView[] }>("/automations", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.automations),
  inbox: (token: string, signal?: AbortSignal) =>
    accountRequest<{ runs: InboxRun[] }>("/automations/inbox", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.runs),
  create: (token: string, draft: ValidatedAutomationDraft) =>
    accountRequest<{ automation: AutomationView }>("/automations", { method: "POST", token, body: draft }).then((reply) => reply.automation),
  pause: (token: string, id: string) => accountRequest<{ automation: AutomationView }>(path(id, "/pause"), { method: "POST", token }).then((reply) => reply.automation),
  resume: (token: string, id: string) => accountRequest<{ automation: AutomationView }>(path(id, "/resume"), { method: "POST", token }).then((reply) => reply.automation),
  remove: (token: string, id: string) => accountRequest<void>(path(id), { method: "DELETE", token }),
};
