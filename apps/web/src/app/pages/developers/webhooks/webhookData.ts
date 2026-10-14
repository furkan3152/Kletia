/**
 * The Webhooks pages' data: the key's endpoints (one list read, shared by
 * the list and the detail page; the API has no single-webhook read) and the
 * one-time hand-off of a new endpoint's signing secret from the "new" page
 * to its detail page.
 *
 * The secret is held in this module's memory only until the detail page
 * has it in its own state: never in storage, the URL or history state, and gone on
 * reload, as the API returns it only once.
 */
import { effectivePermissions } from "@kletia/core";
import type { ApiKeySummary, PolicyReadResponse, WebhookRecord } from "@kletia/sdk";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource, type ApiResource } from "../../../../shared/platform/useApiResource";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind } from "../keys/sessionKey";

/** A webhook as the API lists it (`scope` arrived with agent keys; older APIs leave it out). */
export type ListedWebhook = WebhookRecord & { readonly scope?: string };

export function useWebhookList(apiKey: string, generation = 0): ApiResource<ListedWebhook[]> {
  return useApiResource<ListedWebhook[]>(apiKey ? `portal-webhooks:${maskKey(apiKey)}:${generation}` : null, (_client, signal) =>
    keyedClient(apiKey).webhooks.list({ signal: sdkSignal(signal) }),
  );
}

/**
 * Whether an agent key's rule book chain grants `permissions.webhooks`
 * (true or false), or null while unknown or for developer keys. Read from
 * the key's effective chain, the same chain the API checks.
 */
export function useWebhookGrant(apiKey: string): boolean | null {
  const agent = portalKeyKind(apiKey) === "agent";
  const tag = agent ? maskKey(apiKey) : null;
  const keys = useApiResource<ApiKeySummary[]>(tag ? `webhook-grant-keys:${tag}` : null, (_client, signal) => keyedClient(apiKey).keys.list({ signal: sdkSignal(signal) }));
  const currentId = keys.data?.find((item) => item.current)?.id ?? null;
  const policy = useApiResource<PolicyReadResponse>(tag && currentId ? `webhook-grant-policy:${tag}:${currentId}` : null, (_client, signal) =>
    keyedClient(apiKey).policies.get(currentId!, { signal: sdkSignal(signal) }),
  );
  const levels = policy.data?.effective?.levels;
  if (!agent || !levels || policy.status === "error") return null;
  return effectivePermissions(levels.map((level) => ({ policy: level.document, defaults: level.defaults }))).webhooks;
}

let handoff: { readonly webhookId: string; readonly secret: string } | null = null;

/** Keeps a just-created endpoint's secret for its detail page (replaces any earlier one). */
export function holdWebhookSecret(webhookId: string, secret: string): void {
  handoff = { webhookId, secret };
}

/** The held secret of this endpoint, or null (the detail page copies it into its state, then forgets the hold). */
export function peekWebhookSecret(webhookId: string): string | null {
  return handoff && handoff.webhookId === webhookId ? handoff.secret : null;
}

/** Drops the held secret (the detail page calls it as soon as it holds the secret itself). */
export function forgetWebhookSecret(): void {
  handoff = null;
}
