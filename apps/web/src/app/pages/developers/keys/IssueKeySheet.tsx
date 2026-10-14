import type { ApiKeyRecord } from "@kletia/sdk";
import { KeyRound } from "lucide-react";
import React, { useId, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { TextField } from "../../../site/ui/Field";
import { Sheet } from "../../../site/ui/Sheet";
import { Switch } from "../../../site/ui/Switch";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "./keyClient";
import { KEY_NAME_PATTERN, SecretReveal, type Secret } from "./KeyManager";
import { DEV_KEY_PATTERN, maskKey, useSessionKey } from "./sessionKey";

/**
 * "Issue a key": a side sheet (bottom sheet on phones) with the name,
 * Sandbox or Live, and, when a developer key is loaded, whether the new key
 * joins its project. The secret is shown once in the yellow reveal, with
 * "Use it in this tab".
 */
export function IssueKeySheet({ open, onClose, onIssued }: { readonly open: boolean; readonly onClose: () => void; readonly onIssued: () => void }) {
  const { key, setKey } = useSessionKey();
  const nameId = useId();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [sandbox, setSandbox] = useState(true);
  const [sibling, setSibling] = useState(true);
  const [secret, setSecret] = useState<Secret | null>(null);
  const loaded = DEV_KEY_PATTERN.test(key);
  const joinProject = loaded && sibling;
  const action = useApiAction((_client, signal, keyName: string, withKey: string, asSandbox: boolean) =>
    keyedClient(withKey).keys.create(keyName, { sandbox: asSandbox, signal: sdkSignal(signal) }),
  );
  const trimmed = name.trim();
  const invalid = touched && !KEY_NAME_PATTERN.test(trimmed);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!KEY_NAME_PATTERN.test(trimmed)) {
      document.getElementById(nameId)?.focus();
      return;
    }
    setSecret(null);
    const record: ApiKeyRecord | undefined = await action.run(trimmed, joinProject ? key : "", sandbox);
    if (record?.key) {
      setSecret({ kind: "issued", id: record.id, name: record.name, key: record.key });
      setName("");
      setTouched(false);
      if (joinProject) onIssued();
    }
  };

  const close = () => {
    // The secret is never kept once the sheet closes: it was shown once.
    setSecret(null);
    action.reset();
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title="Issue a key" widthClassName="md:w-[450px]">
      <div className="flex flex-col gap-5 p-4 sm:p-5">
        {secret ? (
          <div aria-live="polite">
            <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={close} />
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <TextField
              id={nameId}
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
            <Switch
              checked={sandbox}
              onChange={setSandbox}
              label="Sandbox key"
              description={
                sandbox
                  ? "Testnets only (Arc Testnet, Arbitrum Sepolia, Solana Devnet): stored intents and your own contracts work at once."
                  : "Live: mainnets too. Its rule book can still narrow it later."
              }
            />
            {loaded ? (
              <fieldset className="flex flex-col gap-1.5 text-sm">
                <legend className={cx(LABEL, "mb-1.5")}>Project</legend>
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name={`${nameId}-project`} checked={sibling} onChange={() => setSibling(true)} className="h-4 w-4 accent-[#0052FF]" />
                  <span>
                    Add to the project of <code className="font-code text-xs">{maskKey(key)}</code>
                  </span>
                </label>
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2">
                  <input type="radio" name={`${nameId}-project`} checked={!sibling} onChange={() => setSibling(false)} className="h-4 w-4 accent-[#0052FF]" />
                  Start a new project
                </label>
              </fieldset>
            ) : null}
            <Button type="submit" loading={action.status === "loading"} className="self-start">
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {joinProject ? "Add a key" : sandbox ? "Get a sandbox key" : "Get a developer key"}
            </Button>
            <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
              Calls <code className="font-code">POST /v1/keys</code>
              {sandbox ? <> with <code className="font-code">sandbox: true</code></> : null}. A project holds up to 5 active keys; the key is
              stored only as a SHA-256 hash and allows 300 requests/min.
            </p>
            <div aria-live="polite">{action.status === "error" && action.error ? <ApiErrorPanel error={action.error} title="Could not issue a key" /> : null}</div>
          </form>
        )}
      </div>
    </Sheet>
  );
}
