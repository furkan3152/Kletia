import { KeyRound, ShieldAlert } from "lucide-react";
import React, { useState } from "react";

import { createDeveloperKey } from "../../../shared/platform/platformApi";
import { useApiAction } from "../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { CopyButton } from "../../site/ui/CopyButton";
import { TextField } from "../../site/ui/Field";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

const NAME_PATTERN = /^[\w .-]{2,64}$/u;

/** Issues a developer key through `POST /v1/keys`; the raw key is shown once. */
export function KeyRequestForm() {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const action = useApiAction((client, signal, keyName: string) => createDeveloperKey(client, signal, keyName));
  const trimmed = name.trim();
  const validationError =
    touched && !NAME_PATTERN.test(trimmed)
      ? "Use 2-64 characters: letters, numbers, spaces, dots, dashes or underscores."
      : undefined;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (!NAME_PATTERN.test(trimmed)) return;
    setAcknowledged(false);
    await action.run(trimmed);
  };

  const issued = action.status === "success" && action.data && !acknowledged ? action.data : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <form onSubmit={onSubmit} noValidate className={cx("flex flex-col gap-5 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <TextField
          label="Key name"
          name="keyName"
          value={name}
          maxLength={64}
          autoComplete="off"
          placeholder="acme-checkout-staging"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          hint="Identifies the key in your logs. Never put secrets in the name."
          error={validationError}
          required
        />
        <Button type="submit" size="lg" disabled={action.status === "loading"} className="w-full sm:w-auto sm:self-start">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {action.status === "loading" ? "Issuing key…" : "Get a developer key"}
        </Button>
        <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
          Developer keys raise your limit to 300 requests/min and unlock intent listing and webhooks. Issuing is
          rate-limited per IP. The key is stored only as a SHA-256 hash.
        </p>
      </form>

      <div aria-live="polite" className="min-w-0">
        {issued ? (
          <div className="flex h-full flex-col gap-4 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-5 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569] sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <p className={LABEL}>Key issued</p>
              <Badge tone="ink">{issued.tier}</Badge>
            </div>
            <p className="flex items-start gap-2 text-sm font-bold">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Copy it now. This is the only time the key is shown; Kletia cannot recover it.
            </p>
            {issued.key ? (
              <div className="flex flex-col gap-2 border-[3px] border-[#1A1A1A] bg-white p-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all font-code text-sm">{issued.key}</code>
                <CopyButton text={issued.key} label="Copy developer key" appearance="light" />
              </div>
            ) : (
              <p className="text-sm">The API did not return a raw key value. Issue a new key and try again.</p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-code text-xs">
              <dt className="font-bold">id</dt>
              <dd className="break-all">{issued.id}</dd>
              <dt className="font-bold">name</dt>
              <dd className="break-all">{issued.name}</dd>
            </dl>
            <Button variant="ink" size="sm" className="self-start" onClick={() => setAcknowledged(true)}>
              I stored it — hide the key
            </Button>
          </div>
        ) : action.status === "error" && action.error ? (
          <ApiErrorPanel error={action.error} title="Could not issue a key" />
        ) : (
          <div className={cx("flex h-full flex-col justify-center gap-3 border-[3px] border-dashed border-[#1A1A1A]/40 p-6 dark:border-white/20")}>
            <p className={cx(LABEL, TEXT_MUTED)}>Use it</p>
            <pre className="overflow-x-auto font-code text-[13px] leading-6">
              <code>{`const kletia = new KletiaClient({\n  apiKey: process.env.KLETIA_API_KEY,\n});`}</code>
            </pre>
            <p className={cx("text-sm", TEXT_MUTED)}>
              Keep keys on your server. Browser apps can use the public tier without a key.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
