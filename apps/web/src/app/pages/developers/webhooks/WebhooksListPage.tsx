import type { WebhookDelivery } from "@kletia/sdk";
import { Plus, RefreshCw } from "lucide-react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { WEBHOOK_REGISTER, WEBHOOK_VERIFY } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { useWebhookGrant, useWebhookList, type ListedWebhook } from "./webhookData";
import { eventsSummary, lastDeliverySummary, scopeLabel, utcStamp, WEBHOOK_LIMIT_PER_KEY, webhookPermissions } from "./webhookModel";

const INTRO = "Signed POSTs to your server when intents, keys, contracts, links and rule books change. Kletia retries failed deliveries and keeps a delivery log per endpoint.";

/** The newest delivery of each endpoint (one small read per endpoint, at most 10). */
function useLastDeliveries(apiKey: string, webhooks: readonly ListedWebhook[] | undefined) {
  const ids = (webhooks ?? []).map((webhook) => webhook.id).join(",");
  return useApiResource<Map<string, WebhookDelivery[]>>(apiKey && ids ? `portal-webhook-last:${maskKey(apiKey)}:${ids}` : null, async (_client, signal) => {
    const client = keyedClient(apiKey);
    const entries = await Promise.all(
      (webhooks ?? []).map(async (webhook) => {
        try {
          return [webhook.id, await client.webhooks.deliveries(webhook.id, { limit: 1, signal: sdkSignal(signal) })] as const;
        } catch {
          // An unreadable log shows "–" for that row, never a made-up state.
          return [webhook.id, null] as const;
        }
      }),
    );
    return new Map(entries.filter((entry): entry is readonly [string, WebhookDelivery[]] => entry[1] !== null));
  });
}

function WebhookList() {
  const { key } = useSessionKey();
  const permissions = webhookPermissions(portalKeyKind(key), useWebhookGrant(key));
  const list = useWebhookList(key);
  const last = useLastDeliveries(key, list.data);
  const webhooks = list.data ?? [];

  return (
    <section aria-labelledby="webhooks-list" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="webhooks-list" className={cx(LABEL, TEXT_MUTED)}>
          {list.data ? `${webhooks.length} of ${WEBHOOK_LIMIT_PER_KEY} endpoints for ` : "Endpoints of "}
          <span className="font-code normal-case tracking-normal">{maskKey(key)}</span>
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            list.reload();
            last.reload();
          }}
          aria-label="Reload webhooks"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {!permissions.create ? <p className={cx("text-sm", TEXT_MUTED)}>{permissions.summary}</p> : null}
      {list.status === "loading" && !list.data ? (
        <SkeletonGroup label="Loading webhooks" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-12" />
          <Skeleton surface="card" className="h-12" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list webhooks" onRetry={list.reload} />
      ) : (
        <DataTable
          caption="Webhook endpoints of this key"
          rows={webhooks}
          rowKey={(webhook) => webhook.id}
          rowHref={(webhook) => `/developers/webhooks/${webhook.id}`}
          rowLabel={(webhook) => `Open webhook ${webhook.url}`}
          empty={
            <div className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
              <Icon name="webhook" size={32} />
              <p className="font-display text-title font-bold">No webhooks yet.</p>
              <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
                Add an endpoint and Kletia signs and retries every event for you. You see each attempt in its delivery log.
              </p>
              {permissions.create ? (
                <ButtonLink to="/developers/webhooks/new" size="sm">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add endpoint
                </ButtonLink>
              ) : null}
            </div>
          }
          columns={[
            {
              key: "url",
              header: "Endpoint",
              phone: "primary",
              cell: (webhook) => (
                <Link to={`/developers/webhooks/${webhook.id}`} className={cx("break-all font-code text-[13px] font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  {webhook.url}
                </Link>
              ),
            },
            { key: "events", header: "Events", cell: (webhook) => <span title={webhook.events.join(", ")}>{eventsSummary(webhook.events)}</span> },
            { key: "scope", header: "Scope", cell: (webhook) => scopeLabel(webhook.scope) },
            {
              key: "last",
              header: "Last delivery",
              cell: (webhook) => {
                const summary = last.data ? lastDeliverySummary(last.data.get(webhook.id)) : null;
                if (!summary) return <span className={TEXT_MUTED}>{last.data?.has(webhook.id) ? "None yet" : "–"}</span>;
                return (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <StatusEntryPill entry={summary.status} />
                    <span className="whitespace-nowrap font-code text-[12px]">{summary.text}</span>
                  </span>
                );
              },
            },
            { key: "created", header: "Created", cell: (webhook) => <span className="whitespace-nowrap">{utcStamp(webhook.createdAt)}</span> },
          ]}
        />
      )}
    </section>
  );
}

/** Webhooks (`/developers/webhooks`): the key's endpoints with their last delivery, and how to verify deliveries. */
export function WebhooksListPage() {
  const { key } = useSessionKey();
  const canCreate = webhookPermissions(portalKeyKind(key), useWebhookGrant(key)).create;
  return (
    <>
      <PortalPageHeader
        title="Webhooks"
        intro={INTRO}
        actions={
          canCreate ? (
            <ButtonLink to="/developers/webhooks/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add endpoint
            </ButtonLink>
          ) : null
        }
      />
      <KeyGate purpose="add, test and delete webhook endpoints and read their delivery logs" agentKeys>
        <WebhookList />
      </KeyGate>
      <p className={cx("pt-6 text-sm", TEXT_MUTED)}>
        Developing locally? <code className="font-code">kletia webhooks forward --intent &lt;id&gt;</code> signs one intent&apos;s events for your
        localhost receiver.
      </p>
      <section aria-labelledby="webhooks-setup" className="flex min-w-0 flex-col gap-4 pt-10">
        <h2 id="webhooks-setup" className="font-display text-title font-bold">
          From your server
        </h2>
        <p className={cx("max-w-3xl text-body", TEXT_MUTED)}>
          The same calls through the SDK, and the handler that verifies every delivery before you trust it. Event types, headers and retries
          are on{" "}
          <Link to="/developers/events" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            Events
          </Link>
          .
        </p>
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <CodeBlock code={WEBHOOK_REGISTER} language="ts" label="Register and test a webhook" filename="webhooks.ts" />
          <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/webhook/route.ts" />
        </div>
      </section>
    </>
  );
}
