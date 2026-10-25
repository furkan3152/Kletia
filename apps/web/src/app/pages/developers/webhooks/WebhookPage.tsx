import type { WebhookDelivery } from "@kletia/sdk";
import { RefreshCw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { navigate } from "../../../routes/history";
import { WEBHOOK_VERIFY } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { CopyButton } from "../../../site/ui/CopyButton";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { PortalTabs } from "../portal/PortalTabs";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { DeliveriesTable } from "./DeliveriesTable";
import { forgetWebhookSecret, peekWebhookSecret, useWebhookGrant, useWebhookList } from "./webhookData";
import { deliveryRowModel, filterDeliveries, scopeLabel, utcStamp, webhookPermissions, webhooksNotConfigured, type DeliveryFilter } from "./webhookModel";
import { WebhooksNotConfigured } from "./WebhooksNotConfigured";

/** The new endpoint's signing secret, shown once (it is never readable again). */
function SecretOnce({ secret, onDone }: { readonly secret: string; readonly onDone: () => void }) {
  return (
    <div role="status" className="flex flex-col gap-3 border-[3px] border-[#121212] bg-[#C6FF3A] p-4 text-[#121212] dark:border-[#4A4A52] sm:p-5">
      <p className={LABEL}>Signing secret</p>
      <p className="flex items-start gap-2 text-sm font-bold">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Copy it now into your server&apos;s secret store (KLETIA_WEBHOOK_SECRET). This is the only time Kletia shows it.
      </p>
      <div className="flex flex-col gap-2 border-[3px] border-[#121212] bg-[#FBFAF6] p-3 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all font-code text-sm">{secret}</code>
        <CopyButton text={secret} label="Copy the signing secret" appearance="light" />
      </div>
      <Button size="sm" variant="ink" className="self-start" onClick={onDone}>
        I stored it, hide the secret
      </Button>
    </div>
  );
}

function WebhookDetail({ webhookId }: { readonly webhookId: string }) {
  const { key } = useSessionKey();
  const permissions = webhookPermissions(portalKeyKind(key), useWebhookGrant(key));
  const list = useWebhookList(key);
  const webhook = list.data?.find((item) => item.id === webhookId) ?? null;
  const [generation, setGeneration] = useState(0);
  const [filter, setFilter] = useState<DeliveryFilter>("all");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeFailed, setNoticeFailed] = useState(false);
  // The secret the "new" page handed over: copied into this page's state once, then dropped from the module.
  const [secret, setSecret] = useState<string | null>(() => peekWebhookSecret(webhookId));
  useEffect(() => forgetWebhookSecret(), []);

  const deliveries = useApiResource<WebhookDelivery[]>(webhook ? `portal-webhook-deliveries:${maskKey(key)}:${webhookId}:${generation}` : null, (_client, signal) =>
    keyedClient(key).webhooks.deliveries(webhookId, { limit: 50, signal: sdkSignal(signal) }),
  );
  const sendTest = useApiAction((_client, signal, id: string) => keyedClient(key).webhooks.test(id, { signal: sdkSignal(signal) }));
  const remove = useApiAction((_client, signal, id: string) => keyedClient(key).webhooks.delete(id, { signal: sdkSignal(signal) }).then(() => id));
  const rows = useMemo(() => (deliveries.data ?? []).map((delivery) => deliveryRowModel(delivery)), [deliveries.data]);
  const shown = filterDeliveries(rows, filter);

  if (list.status === "loading" && !list.data) {
    return (
      <>
        <PortalPageHeader title="Webhook" back={{ label: "Webhooks", to: "/developers/webhooks" }} />
        <SkeletonGroup label="Loading the webhook" className="flex flex-col gap-3">
          <Skeleton surface="card" className="h-40" />
        </SkeletonGroup>
      </>
    );
  }
  if (list.status === "error" && list.error) {
    return (
      <>
        <PortalPageHeader title="Webhook" back={{ label: "Webhooks", to: "/developers/webhooks" }} />
        {webhooksNotConfigured(list.error) ? (
          <WebhooksNotConfigured onRetry={list.reload} />
        ) : (
          <ApiErrorPanel error={list.error} title="Could not read the webhooks of this key" onRetry={list.reload} />
        )}
      </>
    );
  }
  if (!webhook) {
    return (
      <>
        <PortalPageHeader title="No webhook here" back={{ label: "Webhooks", to: "/developers/webhooks" }} />
        <div className={cx("flex flex-col items-start gap-3 p-5", INK_BORDER, SURFACE)}>
          <p className="text-sm">
            The key in this tab has no endpoint <code className="font-code">{webhookId}</code>. It may have been deleted, or it belongs to another key.
          </p>
          <ButtonLink to="/developers/webhooks" size="sm" variant="secondary">
            Back to the endpoints
          </ButtonLink>
        </div>
      </>
    );
  }

  const doTest = async () => {
    const delivery = await sendTest.run(webhook.id);
    if (!delivery) return;
    const row = deliveryRowModel(delivery);
    setNoticeFailed(row.failed);
    setNotice(`Test event sent: ${row.status.label.toLowerCase()}${row.http !== "–" ? `, HTTP ${row.http}` : ""}${row.duration !== "–" ? ` in ${row.duration}` : ""}.`);
    setGeneration((value) => value + 1);
  };
  const doDelete = async () => {
    const id = await remove.run(webhook.id);
    if (!id) return;
    list.reload();
    navigate("/developers/webhooks");
  };
  const failure = sendTest.status === "error" ? sendTest.error : remove.status === "error" ? remove.error : null;
  const failedCount = rows.filter((row) => row.failed).length;

  return (
    <>
      <PortalPageHeader
        title={<span className="break-all font-code text-[0.7em]">{webhook.url}</span>}
        back={{ label: "Webhooks", to: "/developers/webhooks" }}
        actions={
          permissions.test || permissions.remove ? (
            <>
              {permissions.test ? (
                <Button loading={sendTest.status === "loading"} onClick={() => void doTest()}>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Send test event
                </Button>
              ) : null}
              {permissions.remove && !confirmDelete ? (
                <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </Button>
              ) : null}
            </>
          ) : null
        }
        meta={
          <>
            <span className="font-bold">{scopeLabel(webhook.scope)}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 break-words font-code text-[12px]">{webhook.events.join(", ")}</span>
            <span aria-hidden="true">·</span>
            <span>created {utcStamp(webhook.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <code className="font-code text-[12px]">{webhook.id}</code>
          </>
        }
      />

      <div className="flex min-w-0 flex-col gap-6">
        {secret ? <SecretOnce secret={secret} onDone={() => setSecret(null)} /> : null}
        {!permissions.test ? <p className={cx("text-sm", TEXT_MUTED)}>{permissions.summary}</p> : null}
        {confirmDelete ? (
          <div className="flex flex-col gap-3 border-[3px] border-danger bg-danger-bg p-4 text-fg">
            <p className="text-sm font-bold">Delete this endpoint and its delivery log? Events stop arriving at once; this cannot be undone.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void doDelete()}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete endpoint
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
        <div aria-live="polite" className="flex min-w-0 flex-col gap-3">
          {notice ? (
            <p className={cx("border-l-[6px] px-3 py-2 text-sm text-fg", noticeFailed ? "border-danger bg-danger-bg" : "border-success bg-success-bg")}>{notice}</p>
          ) : null}
          {failure ? <ApiErrorPanel error={failure} title={sendTest.status === "error" ? "The test event was not sent" : "The endpoint was not deleted"} /> : null}
        </div>

        <section aria-labelledby="webhook-deliveries" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="webhook-deliveries" className="font-display text-title font-bold">
              Deliveries
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setGeneration((value) => value + 1)} aria-label="Reload deliveries">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reload
            </Button>
          </div>
          <PortalTabs
            label="Deliveries to show"
            active={filter}
            onChange={setFilter}
            tabs={[
              { id: "all", label: "All", note: deliveries.data ? String(rows.length) : undefined },
              { id: "failed", label: "Not delivered", note: deliveries.data ? String(failedCount) : undefined },
            ]}
          >
            <div className="pt-4">
              {deliveries.status === "loading" && !deliveries.data ? (
                <SkeletonGroup label="Loading deliveries" className="flex flex-col gap-2">
                  <Skeleton surface="card" className="h-12" />
                  <Skeleton surface="card" className="h-12" />
                </SkeletonGroup>
              ) : deliveries.status === "error" && deliveries.error ? (
                <ApiErrorPanel error={deliveries.error} title="Could not read the delivery log" onRetry={deliveries.reload} />
              ) : shown.length === 0 ? (
                <p className={cx("border-[3px] border-dashed border-[#121212]/30 p-5 text-sm dark:border-white/15", TEXT_MUTED)}>
                  {filter === "failed" && rows.length > 0
                    ? "Every attempt in the log was delivered."
                    : permissions.test
                      ? "No deliveries yet. Send a test event to see what your endpoint answers."
                      : "No deliveries yet."}
                </p>
              ) : (
                <DeliveriesTable rows={shown} />
              )}
            </div>
          </PortalTabs>
          <p className={cx("text-xs", TEXT_MUTED)}>
            Newest first, the latest 50 attempts. Failed attempts are retried after 1 s, 5 s and 25 s; after the fourth the dispatcher gives up.
            Payloads are never stored.
          </p>
        </section>

        <section aria-labelledby="webhook-verify" className="flex min-w-0 flex-col gap-3">
          <h2 id="webhook-verify" className="font-display text-title font-bold">
            Verify the signature
          </h2>
          <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
            Every delivery carries Kletia-Signature (an HMAC of the raw body with this endpoint&apos;s secret) and Kletia-Event-Id. Check both
            before you act on an event.
          </p>
          <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/webhook/route.ts" />
        </section>
      </div>
    </>
  );
}

/** One webhook (`/developers/webhooks/:webhookId`): send a test event, read the deliveries, delete. */
export function WebhookPage({ webhookId }: { readonly webhookId: string }) {
  const { key } = useSessionKey();
  if (portalKeyKind(key)) return <WebhookDetail webhookId={webhookId} />;
  return (
    <>
      <PortalPageHeader title="Webhook" back={{ label: "Webhooks", to: "/developers/webhooks" }} />
      <KeyGate purpose="test this endpoint, read its deliveries and delete it" agentKeys>
        {null}
      </KeyGate>
    </>
  );
}
