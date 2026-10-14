import type { WebhookRecord } from "@kletia/sdk";
import { RefreshCw } from "lucide-react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { WEBHOOK_REGISTER, WEBHOOK_VERIFY } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { DataTable } from "../../../site/ui/DataTable";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** A webhook as the API lists it (`scope` arrived with agent keys; older APIs leave it out). */
type ListedWebhook = WebhookRecord & { readonly scope?: string };

/** `14 Oct 2026, 13:57 UTC`: the portal's table time (copy rules, portal design 5.6). */
function utcStamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  const text = date.toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${text} UTC`;
}

function eventsText(events: readonly string[]): string {
  if (events.length === 0) return "–";
  if (events.length <= 2) return events.join(", ");
  return `${events.slice(0, 2).join(", ")} and ${events.length - 2} more`;
}

function WebhookList() {
  const { key } = useSessionKey();
  const list = useApiResource<ListedWebhook[]>(`portal-webhooks:${maskKey(key)}`, (_client, signal) =>
    keyedClient(key).webhooks.list({ signal: sdkSignal(signal) }),
  );
  const agent = portalKeyKind(key) === "agent";
  const webhooks = list.data ?? [];
  return (
    <section aria-labelledby="webhooks-list" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="webhooks-list" className="font-display text-title font-bold">
          Your endpoints
        </h2>
        <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload webhooks">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {agent ? (
        <p className={cx("text-sm", TEXT_MUTED)}>An agent key reads the webhooks of its own subtree; only developer keys add or delete them.</p>
      ) : null}
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
          empty={
            <p className={cx("border-[3px] border-dashed border-[#1A1A1A]/30 p-5 text-sm dark:border-white/15", TEXT_MUTED)}>
              No webhooks yet. Register one from your server with the snippet below; it is signed and retried for you.
            </p>
          }
          columns={[
            { key: "url", header: "Endpoint", phone: "primary", cell: (webhook) => <span className="break-all font-code text-[13px] font-bold">{webhook.url}</span> },
            { key: "events", header: "Events", cell: (webhook) => <span title={webhook.events.join(", ")}>{eventsText(webhook.events)}</span> },
            { key: "scope", header: "Scope", cell: (webhook) => (webhook.scope === "subtree" ? "Key and its agent keys" : "This key") },
            { key: "created", header: "Created", cell: (webhook) => <span className="whitespace-nowrap">{utcStamp(webhook.createdAt)}</span> },
          ]}
        />
      )}
    </section>
  );
}

/** Webhooks (`/developers/webhooks`): your endpoints through the SDK, and how to register and verify one. */
export default function WebhooksPage() {
  return (
    <>
      <PortalPageHeader
        title="Webhooks"
        intro="Signed POSTs to your server when intents, keys, contracts, links and rule books change. Kletia retries failed deliveries and keeps a delivery log per endpoint."
      />
      <KeyGate purpose="see the webhook endpoints of your key" agentKeys>
        <WebhookList />
      </KeyGate>
      <section aria-labelledby="webhooks-setup" className="flex min-w-0 flex-col gap-4 pt-12">
        <h2 id="webhooks-setup" className="font-display text-display-s font-bold">
          Set one up
        </h2>
        <p className={cx("max-w-3xl text-body", TEXT_MUTED)}>
          Register from your server (the secret is shown once), send a signed test, and verify every delivery before you trust it. Event
          types, headers and retries are on{" "}
          <Link to="/developers/events" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            Events
          </Link>
          .
        </p>
        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <CodeBlock code={WEBHOOK_REGISTER} language="ts" label="Register and test a webhook" filename="webhooks.ts" />
          <CodeBlock code={WEBHOOK_VERIFY} language="ts" label="Verify a webhook" filename="app/api/kletia/webhook/route.ts" />
        </div>
        <p className={cx("text-sm", TEXT_MUTED)}>
          Developing locally? <code className="font-code">kletia webhooks forward</code> signs an intent&apos;s events for your localhost
          receiver.
        </p>
      </section>
    </>
  );
}
