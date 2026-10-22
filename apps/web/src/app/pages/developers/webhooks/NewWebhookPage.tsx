import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { navigate } from "../../../routes/history";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { holdWebhookSecret, useWebhookGrant, type ListedWebhook } from "./webhookData";
import { WebhooksNotConfigured } from "./WebhooksNotConfigured";
import {
  buildEvents,
  checkWebhookUrl,
  groupState,
  scopeLabel,
  toggleGroup,
  WEBHOOK_EVENT_GROUPS,
  webhookPermissions,
  webhooksNotConfigured,
  type EventMode,
  type WebhookScope,
} from "./webhookModel";

const RADIO = "h-4 w-4 shrink-0 accent-[#0052FF]";
const OPTION = "flex min-h-11 cursor-pointer items-start gap-2.5 py-1.5 text-sm";

/** One event family: a group checkbox (all, some or none) and its types. */
function EventGroupField({ group, selected, onChange }: { readonly group: (typeof WEBHOOK_EVENT_GROUPS)[number]; readonly selected: ReadonlySet<string>; readonly onChange: (next: Set<string>) => void }) {
  const state = groupState(group, selected);
  return (
    <fieldset className="min-w-0 border-t-2 border-[#1A1A1A]/10 pt-3 dark:border-white/10">
      <legend className="sr-only">{group.label}</legend>
      <label className={cx(OPTION, "font-bold")}>
        <input
          type="checkbox"
          className={cx(RADIO, "mt-0.5")}
          checked={state === "all"}
          ref={(element) => {
            if (element) element.indeterminate = state === "some";
          }}
          onChange={(event) => onChange(toggleGroup(group, selected, event.target.checked))}
        />
        <span className="min-w-0">
          {group.label}
          <span className={cx("block text-[13px] font-normal", TEXT_MUTED)}>{group.detail}</span>
        </span>
      </label>
      <div className="grid min-w-0 gap-x-4 pl-6 sm:grid-cols-2">
        {group.types.map((type) => (
          <label key={type} className={cx(OPTION, "min-h-10 items-center")}>
            <input
              type="checkbox"
              className={RADIO}
              checked={selected.has(type)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(type);
                else next.delete(type);
                onChange(next);
              }}
            />
            <code className="min-w-0 break-all font-code text-[13px]">{type}</code>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NewWebhookForm() {
  const { key } = useSessionKey();
  const permissions = webhookPermissions(portalKeyKind(key), useWebhookGrant(key));
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [mode, setMode] = useState<EventMode>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(["intent.status_changed", "intent.step_updated"]));
  const [scope, setScope] = useState<WebhookScope>("self");
  const [eventsError, setEventsError] = useState<string | null>(null);
  const create = useApiAction((_client, signal, input: { url: string; events?: readonly string[]; scope: WebhookScope }) =>
    keyedClient(key).webhooks.create(input, { signal: sdkSignal(signal) }) as Promise<ListedWebhook>,
  );

  if (!permissions.create) {
    return (
      <div className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
        <p className="font-display text-title font-bold">This key cannot add endpoints</p>
        <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>{permissions.summary}</p>
        <ButtonLink to="/developers/webhooks" variant="secondary" size="sm">
          Back to the endpoints
        </ButtonLink>
      </div>
    );
  }

  const check = checkWebhookUrl(url);
  const urlError = urlTouched && !check.ok ? check.message : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setUrlTouched(true);
    const events = buildEvents(mode, selected);
    setEventsError(events.ok ? null : events.message);
    if (!check.ok || !events.ok) return;
    // The API checks the URL again (with DNS) and is the authority on every rule.
    const webhook = await create.run({ url: check.url, ...(events.events ? { events: events.events } : {}), scope });
    if (!webhook) return;
    if (webhook.secret) holdWebhookSecret(webhook.id, webhook.secret);
    navigate(`/developers/webhooks/${webhook.id}`);
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className={cx("flex min-w-0 flex-col gap-6 p-5 sm:p-6", INK_BORDER, SURFACE)}>
      <TextField
        label="Endpoint URL"
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        mono
        placeholder="https://example.com/kletia/webhooks"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onBlur={() => setUrlTouched(url.trim().length > 0)}
        error={urlError}
        hint="Public HTTPS only, no user:password@, port 443 or 1024-65535. Kletia never follows redirects."
      />

      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className={cx(LABEL, "mb-1")}>Events</legend>
        <label className={OPTION}>
          <input type="radio" name="webhook-events" className={cx(RADIO, "mt-0.5")} checked={mode === "all"} onChange={() => setMode("all")} />
          <span>
            <span className="font-bold">Every current type</span>
            <span className={cx("block text-[13px]", TEXT_MUTED)}>Types added to Kletia later never start arriving unasked.</span>
          </span>
        </label>
        <label className={OPTION}>
          <input type="radio" name="webhook-events" className={cx(RADIO, "mt-0.5")} checked={mode === "choose"} onChange={() => setMode("choose")} />
          <span className="font-bold">Choose types</span>
        </label>
        {mode === "choose" ? (
          <div className="flex min-w-0 flex-col gap-3 pl-1">
            {WEBHOOK_EVENT_GROUPS.map((group) => (
              <EventGroupField
                key={group.id}
                group={group}
                selected={selected}
                onChange={(next) => {
                  setSelected(next);
                  setEventsError(null);
                }}
              />
            ))}
          </div>
        ) : null}
        {eventsError ? (
          <p role="alert" className="text-sm font-bold text-danger">
            {eventsError}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className={cx(LABEL, "mb-1")}>Scope</legend>
        {(["self", "subtree"] as const).map((value) => (
          <label key={value} className={OPTION}>
            <input type="radio" name="webhook-scope" className={cx(RADIO, "mt-0.5")} checked={scope === value} onChange={() => setScope(value)} />
            <span>
              <span className="font-bold">{scopeLabel(value)}</span>
              <span className={cx("block text-[13px]", TEXT_MUTED)}>
                {value === "self"
                  ? "Events of this key's own intents, links, contracts and rule book."
                  : "Also the events of every agent key under it, so you can watch your agents."}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={create.status === "loading"}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add endpoint
        </Button>
        <ButtonLink to="/developers/webhooks" variant="ghost">
          Cancel
        </ButtonLink>
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>
        The signing secret (whsec_…) is shown once, on the next page. At most 10 endpoints per key.
      </p>
      <div aria-live="polite">
        {create.status === "error" && create.error ? (
          webhooksNotConfigured(create.error) ? (
            <WebhooksNotConfigured />
          ) : (
            <ApiErrorPanel error={create.error} title="The endpoint was not added" />
          )
        ) : null}
      </div>
    </form>
  );
}

/** New webhook (`/developers/webhooks/new`): URL, events and scope; the secret is shown once on the endpoint's page. */
export function NewWebhookPage() {
  return (
    <>
      <PortalPageHeader
        title="Add an endpoint"
        back={{ label: "Webhooks", to: "/developers/webhooks" }}
        intro="Kletia signs every delivery with your endpoint's secret and retries failures three times (after 1 s, 5 s and 25 s)."
      />
      <KeyGate purpose="add webhook endpoints" agentKeys>
        <NewWebhookForm />
      </KeyGate>
    </>
  );
}
