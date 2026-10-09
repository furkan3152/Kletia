import type { ApiKeyRecord, ApiKeySummary, RotatedApiKey } from "@kletia/sdk";
import { KeyRound, Plus, RefreshCw, RotateCw, ShieldAlert, ShieldX, Trash2 } from "lucide-react";
import React, { useId, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { SelectField, TextField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, HARD_SHADOW, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { ApiKeyField } from "./ApiKeyField";
import { formatTimestamp, GRACE_OPTIONS, keyedClient } from "./keyClient";
import { DEV_KEY_PATTERN, maskKey, useSessionKey } from "./sessionKey";
import { UsagePanel } from "./UsagePanel";

const NAME_PATTERN = /^[\w .:-]{1,64}$/u;

interface Secret {
  readonly kind: "issued" | "rotated";
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly previousExpiresAt?: string | null;
  /** True when the session key was replaced by this secret. */
  readonly swapped?: boolean;
}

function SecretReveal({ secret, onUse, onDone }: { secret: Secret; onUse?: () => void; onDone: () => void }) {
  const { key: sessionKey } = useSessionKey();
  const inUse = sessionKey === secret.key;
  return (
    <div
      role="status"
      className="kl-drop flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569] sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className={LABEL}>{secret.kind === "issued" ? "Key issued" : "Key rotated"}</p>
        <Badge tone="ink">{secret.name}</Badge>
      </div>
      <p className="flex items-start gap-2 text-sm font-bold">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Copy it now into your server&apos;s secret store. This is the only time Kletia shows this secret.
      </p>
      <div className="flex flex-col gap-2 border-[3px] border-[#1A1A1A] bg-white p-3 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all font-code text-sm">{secret.key}</code>
        <CopyButton text={secret.key} label="Copy the new secret" appearance="light" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-code text-xs">
        <dt className="font-bold">id</dt>
        <dd className="break-all">{secret.id}</dd>
        {secret.kind === "rotated" ? (
          <>
            <dt className="font-bold">old secret</dt>
            <dd>{secret.previousExpiresAt ? `works until ${formatTimestamp(secret.previousExpiresAt)}` : "stopped working now"}</dd>
          </>
        ) : null}
      </dl>
      {secret.swapped ? (
        <p className="text-xs font-bold">
          The key in memory was this one, so it now holds the new secret: the old secret can no longer manage keys.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onUse && !inUse ? (
          <Button size="sm" variant="secondary" onClick={onUse}>
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            Use it in this tab
          </Button>
        ) : null}
        <Button size="sm" variant="ink" onClick={onDone}>
          I stored it, hide the secret
        </Button>
      </div>
    </div>
  );
}

function IssueKeyCard() {
  const { key, setKey } = useSessionKey();
  const nameId = useId();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [sibling, setSibling] = useState(true);
  const [secret, setSecret] = useState<Secret | null>(null);
  const loaded = DEV_KEY_PATTERN.test(key);
  const joinProject = loaded && sibling;
  const action = useApiAction((_client, signal, keyName: string, withKey: string) =>
    keyedClient(withKey).keys.create(keyName, { signal: sdkSignal(signal) }),
  );
  const trimmed = name.trim();
  const invalid = touched && !NAME_PATTERN.test(trimmed);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!NAME_PATTERN.test(trimmed)) return;
    setSecret(null);
    const record: ApiKeyRecord | undefined = await action.run(trimmed, joinProject ? key : "");
    if (record?.key) setSecret({ kind: "issued", id: record.id, name: record.name, key: record.key });
  };

  return (
    <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4" aria-hidden="true" />
        <h3 className="font-display text-xl font-bold">Issue a key</h3>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Key name"
          name={nameId}
          value={name}
          maxLength={64}
          autoComplete="off"
          placeholder="acme-checkout-staging"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          hint="One key per environment: intents, webhooks and usage belong to the key. Never put secrets in the name."
          error={invalid ? "Use 1-64 letters, numbers, spaces, dots, colons, dashes or underscores." : undefined}
          required
        />
        {loaded ? (
          <fieldset className="flex flex-col gap-1.5 text-sm">
            <legend className={cx(LABEL, "mb-1.5")}>Project</legend>
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
              <input type="radio" name={`${nameId}-project`} checked={sibling} onChange={() => setSibling(true)} className="accent-[#0052FF]" />
              Add to the project of <code className="font-code text-xs">{maskKey(key)}</code>
            </label>
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
              <input type="radio" name={`${nameId}-project`} checked={!sibling} onChange={() => setSibling(false)} className="accent-[#0052FF]" />
              Start a new project
            </label>
          </fieldset>
        ) : null}
        <Button type="submit" loading={action.status === "loading"} className="self-start">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {joinProject ? "Add a key" : "Get a developer key"}
        </Button>
        <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
          Calls <code className="font-code">POST /v1/keys</code>. A project holds up to 5 active keys; the key is stored only as a
          SHA-256 hash and raises your limit to 300 requests/min.
        </p>
      </form>
      <div aria-live="polite">
        {secret ? (
          <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} />
        ) : action.status === "error" && action.error ? (
          <ApiErrorPanel error={action.error} title="Could not issue a key" />
        ) : null}
      </div>
    </div>
  );
}

function keyStatus(item: ApiKeySummary): { label: string; tone: "green" | "red" | "yellow" } {
  if (item.revokedAt) return { label: "Revoked", tone: "red" };
  if (item.previousExpiresAt) return { label: "Rotating", tone: "yellow" };
  return { label: "Active", tone: "green" };
}

type PendingAction = { readonly id: string; readonly kind: "rotate" | "revoke" } | null;

function KeyRow({
  item,
  pending,
  busy,
  grace,
  onGrace,
  onAsk,
  onCancel,
  onRotate,
  onRevoke,
}: {
  item: ApiKeySummary;
  pending: PendingAction;
  busy: boolean;
  grace: string;
  onGrace: (value: string) => void;
  onAsk: (kind: "rotate" | "revoke") => void;
  onCancel: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const status = keyStatus(item);
  const asking = pending?.id === item.id ? pending.kind : null;
  return (
    <li className={cx("flex min-w-0 flex-col gap-3 p-3 sm:p-4", item.current && "bg-[#FFF7CC]/60 dark:bg-[#22345A]/40")}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex min-w-0 flex-wrap items-center gap-2 font-bold">
            <span className="min-w-0 break-words">{item.name}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {item.current ? <Badge tone="ink">In memory</Badge> : null}
          </p>
          <p className={cx("break-all font-code text-[11px]", TEXT_MUTED)}>
            {item.id} · secret ••••{item.last4 ?? "????"}
          </p>
        </div>
        {!item.revokedAt && !asking ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => onAsk("rotate")} aria-label={`Rotate ${item.name}`}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              Rotate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAsk("revoke")} aria-label={`Revoke ${item.name}`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Revoke
            </Button>
          </div>
        ) : null}
      </div>
      <dl className={cx("grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4", TEXT_MUTED)}>
        <div>
          <dt className="font-bold text-[#1A1A1A] dark:text-white">Created</dt>
          <dd>{formatTimestamp(item.createdAt)}</dd>
        </div>
        <div>
          <dt className="font-bold text-[#1A1A1A] dark:text-white">Last used</dt>
          <dd>{formatTimestamp(item.lastUsedAt)}</dd>
        </div>
        <div>
          <dt className="font-bold text-[#1A1A1A] dark:text-white">Rotated</dt>
          <dd>{formatTimestamp(item.rotatedAt)}</dd>
        </div>
        <div>
          <dt className="font-bold text-[#1A1A1A] dark:text-white">{item.revokedAt ? "Revoked" : "Old secret until"}</dt>
          <dd>{formatTimestamp(item.revokedAt ?? item.previousExpiresAt)}</dd>
        </div>
      </dl>
      {asking === "rotate" ? (
        <div className={cx("kl-rise flex flex-col gap-3 p-3", INK_BORDER_THIN)}>
          <SelectField label="Grace window for the old secret" value={grace} onChange={(event) => onGrace(event.target.value)} options={GRACE_OPTIONS} />
          <p className={cx("text-xs", TEXT_MUTED)}>
            Same key id, new secret. During the grace window the old secret still authenticates but cannot manage keys, so a
            leaked secret cannot take the key over.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy} onClick={onRotate}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              Rotate now
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {asking === "revoke" ? (
        <div className="kl-rise flex flex-col gap-3 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
          <p className="flex items-start gap-2 text-sm font-bold">
            <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Revoke {item.name}? Requests with it fail at once here and within 15 seconds everywhere. This cannot be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ink" loading={busy} onClick={onRevoke}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Revoke key
            </Button>
            <Button size="sm" variant="secondary" onClick={onCancel}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ManageKeysCard() {
  const { key, setKey, clear } = useSessionKey();
  const loaded = DEV_KEY_PATTERN.test(key);
  const list = useApiResource<ApiKeySummary[]>(loaded ? `keys:${maskKey(key)}` : null, (_client, signal) =>
    keyedClient(key).keys.list({ signal: sdkSignal(signal) }),
  );
  const [pending, setPending] = useState<PendingAction>(null);
  const [grace, setGrace] = useState("86400");
  const [secret, setSecret] = useState<Secret | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rotate = useApiAction((_client, signal, apiKey: string, id: string, graceSeconds: number) =>
    keyedClient(apiKey).keys.rotate(id, { graceSeconds, signal: sdkSignal(signal) }),
  );
  const revoke = useApiAction((_client, signal, apiKey: string, id: string) =>
    keyedClient(apiKey).keys.revoke(id, { signal: sdkSignal(signal) }).then(() => id),
  );

  const doRotate = async (item: ApiKeySummary) => {
    setNotice(null);
    const rotated: RotatedApiKey | undefined = await rotate.run(key, item.id, Number.parseInt(grace, 10));
    if (!rotated) return;
    setPending(null);
    setSecret({
      kind: "rotated",
      id: rotated.id,
      name: rotated.name,
      key: rotated.key,
      previousExpiresAt: rotated.previousExpiresAt,
      swapped: item.current,
    });
    if (item.current) setKey(rotated.key);
    else list.reload();
  };

  const doRevoke = async (item: ApiKeySummary) => {
    setNotice(null);
    const done = await revoke.run(key, item.id);
    if (!done) return;
    setPending(null);
    if (item.current) {
      clear();
      setNotice(`${item.name} was revoked. It was the key in memory, so the panel forgot it.`);
    } else {
      setNotice(`${item.name} was revoked.`);
      list.reload();
    }
  };

  const failure = rotate.status === "error" ? rotate.error : revoke.status === "error" ? revoke.error : null;
  const keys = list.data ?? [];

  return (
    <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          <h3 className="font-display text-xl font-bold">Manage your keys</h3>
        </div>
        {loaded ? (
          <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload keys">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </Button>
        ) : null}
      </div>
      <ApiKeyField label="Key to manage with" />
      <div aria-live="polite" className="flex flex-col gap-3">
        {notice ? <p className="border-l-[6px] border-[#14F195] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">{notice}</p> : null}
        {secret ? <SecretReveal secret={secret} onDone={() => setSecret(null)} /> : null}
        {failure ? <ApiErrorPanel error={failure} title="The key action failed" /> : null}
      </div>
      {!loaded ? (
        <p className={cx("border-[3px] border-dashed border-[#1A1A1A]/30 p-4 text-sm dark:border-white/15", TEXT_MUTED)}>
          {key
            ? "That is not a complete developer key (kl_dev_ followed by 32 letters and digits). Operator keys are configuration and cannot be managed here."
            : "Paste a developer key above, or issue one, to list, rotate and revoke the keys of its project."}
        </p>
      ) : list.status === "loading" ? (
        <SkeletonGroup label="Loading keys" className="flex flex-col gap-2">
          <Skeleton surface="card" className="h-16" />
          <Skeleton surface="card" className="h-16" />
        </SkeletonGroup>
      ) : list.status === "error" && list.error ? (
        <ApiErrorPanel error={list.error} title="Could not list keys" onRetry={list.reload} />
      ) : (
        <ul className={cx("divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER_THIN)} aria-label="Keys in this project">
          {keys.map((item) => (
            <KeyRow
              key={item.id}
              item={item}
              pending={pending}
              busy={rotate.status === "loading" || revoke.status === "loading"}
              grace={grace}
              onGrace={setGrace}
              onAsk={(kind) => {
                rotate.reset();
                revoke.reset();
                setPending({ id: item.id, kind });
              }}
              onCancel={() => setPending(null)}
              onRotate={() => void doRotate(item)}
              onRevoke={() => void doRevoke(item)}
            />
          ))}
          {keys.length === 0 ? <li className={cx("p-4 text-sm", TEXT_MUTED)}>No keys listed.</li> : null}
        </ul>
      )}
    </div>
  );
}

/** Key self-service: issue, then list, rotate and revoke with a key held in memory only, plus usage. */
export function KeyManager() {
  const { key } = useSessionKey();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-start gap-3 border-[3px] border-[#1A1A1A] bg-[#1A1A1A] p-4 text-white dark:border-[#4B5563] dark:bg-[#060A14]">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#FFD60A]" aria-hidden="true" />
        <div className="flex flex-col gap-1 text-sm leading-relaxed">
          <p className="font-bold">Keys belong on servers.</p>
          <p className="text-white/80">
            A <code className="font-code">kl_dev_</code> key lists your intents and manages your webhooks and keys. Keep it in your
            server&apos;s secret store and never ship it in browser code: browsers use the public tier or a proxy route on your
            server. This page holds a key only in this tab&apos;s memory, so you can manage it; reloading forgets it.
          </p>
        </div>
      </div>
      <div className="grid min-w-0 gap-6 xl:grid-cols-2 xl:items-start">
        <IssueKeyCard />
        <ManageKeysCard />
      </div>
      {DEV_KEY_PATTERN.test(key) ? <UsagePanel /> : null}
    </div>
  );
}

