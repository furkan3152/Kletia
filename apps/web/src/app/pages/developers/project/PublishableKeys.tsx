import type { ApiKeySummary, PolicyReadResponse, ProjectView } from "@kletia/sdk";
import { BookOpen, Plus, ShieldX, Trash2, TriangleAlert } from "lucide-react";
import React, { useId, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { TextField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER_THIN, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { SecretReveal, type Secret } from "../keys/KeyManager";
import { keyRowModel } from "../keys/keyRows";
import { maskKey } from "../keys/sessionKey";
import { useNow } from "../portal/useNow";
import { publishableWarnings, type NetworkRules } from "./projectModel";

/** Active publishable keys per project (the API answers 409 KEY_LIMIT_REACHED past it). */
const PUBLISHABLE_LIMIT = 5;
const LABEL_PATTERN = /^[^\p{Cc}\p{Cf}]{1,80}$/u;

/** Each listed key's rule book chain (its levels' documents): one read per active key. */
function useChains(apiKey: string, ids: readonly string[]) {
  return useApiResource<Map<string, readonly NetworkRules[]>>(ids.length > 0 ? `publishable-chains:${maskKey(apiKey)}:${ids.join(",")}` : null, async (_client, signal) => {
    const client = keyedClient(apiKey);
    const entries: (readonly [string, readonly NetworkRules[]] | null)[] = await Promise.all(
      ids.map(async (id) => {
        try {
          const read: PolicyReadResponse = await client.policies.get(id, { signal: sdkSignal(signal) });
          const levels: readonly NetworkRules[] = (read.effective?.levels ?? []).map((level) => (level.document ?? {}) as NetworkRules);
          return [id, levels] as const;
        } catch {
          // An unreadable chain shows no warning rather than a made-up one.
          return null;
        }
      }),
    );
    return new Map(entries.filter((entry): entry is readonly [string, readonly NetworkRules[]] => entry !== null));
  });
}

/**
 * Publishable keys (integrator design 4.8): browser-safe `kl_pub_` keys of
 * the project, shown once at issuance, revocable, each with a link to its
 * rule book and a warning when that rule book refuses a network the widget
 * offers (or a stored flow runs on).
 */
export function PublishableKeys({ apiKey, view, readOnly }: { readonly apiKey: string; readonly view: ProjectView; readonly readOnly: boolean }) {
  const labelId = useId();
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useApiResource<ApiKeySummary[]>(`publishable:${maskKey(apiKey)}`, (_client, signal) => keyedClient(apiKey).keys.list({ signal: sdkSignal(signal) }));
  const keys = (list.data ?? []).filter((item) => item.kind === "publishable");
  const active = keys.filter((item) => !item.revokedAt);
  const chains = useChains(apiKey, active.map((item) => item.id));
  const create = useApiAction((_client, signal, withKey: string, keyLabel: string) =>
    keyedClient(withKey).projects.createPublishableKey({ label: keyLabel }, { signal: sdkSignal(signal) }),
  );
  const revoke = useApiAction((_client, signal, withKey: string, id: string) => keyedClient(withKey).keys.revoke(id, { signal: sdkSignal(signal) }).then(() => id));
  const trimmed = label.trim();
  const invalid = touched && !LABEL_PATTERN.test(trimmed);
  const now = useNow(60_000);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    setNotice(null);
    if (!LABEL_PATTERN.test(trimmed)) return;
    const record = await create.run(apiKey, trimmed);
    if (!record) return;
    setSecret({ kind: "publishable", id: record.id, name: record.label, key: record.key });
    setLabel("");
    setTouched(false);
    list.reload();
  };

  const doRevoke = async (item: ApiKeySummary) => {
    const done = await revoke.run(apiKey, item.id);
    if (!done) return;
    setRevoking(null);
    setNotice(`${item.name} was revoked. Pages that use it stop working within 15 seconds.`);
    list.reload();
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {list.status === "loading" && !list.data ? (
        <SkeletonGroup label="Loading publishable keys" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-12" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list the publishable keys" onRetry={list.reload} />
      ) : keys.length === 0 ? (
        <p className={cx("text-sm", TEXT_MUTED)}>
          {readOnly
            ? "An agent key lists only the keys issued under it: load a developer key to see the project's publishable keys."
            : "No publishable keys yet. Issue one for each site that embeds the widget."}
        </p>
      ) : (
        <ul className={cx("divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER_THIN)} aria-label="Publishable keys">
          {keys.map((item) => {
            const row = keyRowModel(item, now);
            const warnings = !row.ended ? publishableWarnings(view.settings, chains.data?.get(item.id) ?? []) : [];
            return (
              <li key={item.id} className="flex min-w-0 flex-col gap-2 p-3 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <code className="font-code text-sm font-bold">kl_pub_…{item.last4 ?? "????"}</code>
                    <span className="min-w-0 break-words">&ldquo;{item.name}&rdquo;</span>
                    <StatusEntryPill entry={row.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Link
                      to={`/developers/rule-book?key=${encodeURIComponent(item.id)}`}
                      className={cx("inline-flex min-h-10 items-center gap-1.5 px-2 text-sm font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
                    >
                      <BookOpen className="h-4 w-4" aria-hidden="true" />
                      Rule book<span className="sr-only"> of {item.name}</span>
                    </Link>
                    {!row.ended && !readOnly ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(item.id)} aria-label={`Revoke ${item.name}`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className={cx("text-xs", TEXT_MUTED)}>
                  created {row.created} · last used {row.lastUsed}
                  {row.statusDetail && row.ended ? ` · ${row.statusDetail}` : ""}
                </p>
                {warnings.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {warnings.map((warning) => (
                      <li key={warning} className="flex items-start gap-2 border-l-[6px] border-[#B45309] bg-warning-bg px-3 py-1.5 text-sm text-fg">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                        <span>{warning}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {revoking === item.id ? (
                  <div className="kl-rise flex flex-col gap-3 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
                    <p className="flex items-start gap-2 text-sm font-bold">
                      <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      Revoke {item.name}? Every page that uses it stops working. This cannot be undone.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="ink" loading={revoke.status === "loading"} onClick={() => void doRevoke(item)}>
                        Revoke key
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setRevoking(null)}>
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite" className="flex flex-col gap-3">
        {notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-success-bg px-3 py-2 text-sm text-fg">{notice}</p> : null}
        {secret ? <SecretReveal secret={secret} onDone={() => setSecret(null)} /> : null}
        {create.status === "error" && create.error ? <ApiErrorPanel error={create.error} title="Could not issue a publishable key" /> : null}
        {revoke.status === "error" && revoke.error ? <ApiErrorPanel error={revoke.error} title="Could not revoke the key" /> : null}
      </div>
      {readOnly ? null : active.length >= PUBLISHABLE_LIMIT ? (
        <p className={cx("text-sm", TEXT_MUTED)}>The project has {PUBLISHABLE_LIMIT} active publishable keys, the most it can hold. Revoke one to issue another.</p>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
          <TextField
            id={labelId}
            label="Label"
            value={label}
            maxLength={80}
            autoComplete="off"
            placeholder="website"
            onChange={(event) => setLabel(event.target.value)}
            onBlur={() => setTouched(Boolean(label))}
            error={invalid ? "Use 1-80 printable characters." : undefined}
            hint="Its first rule book comes from the defaults and flows saved now; later flows need a rule book update."
            containerClassName="min-w-0 flex-1"
          />
          <Button type="submit" loading={create.status === "loading"} className="sm:mt-8">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New publishable key
          </Button>
        </form>
      )}
    </div>
  );
}
