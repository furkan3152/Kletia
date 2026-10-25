/**
 * The one-time secret reveal shared by every place that issues or rotates a
 * key (Keys page, Start here, agent keys, publishable keys): the yellow card
 * with the secret, a copy button and "I stored it". The Keys page itself is
 * KeysPage (list, issue sheet, usage, authentication).
 */
import { KeyRound, ShieldAlert } from "lucide-react";

import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { LABEL } from "../../../site/ui/styles";
import { formatTimestamp } from "./keyClient";
import { useSessionKey } from "./sessionKey";

/** Key names: what POST /v1/keys and agent keys accept. */
export const KEY_NAME_PATTERN = /^[\w .:-]{1,64}$/u;

export interface Secret {
  readonly kind: "issued" | "rotated" | "agent" | "publishable";
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly previousExpiresAt?: string | null;
  /** Agent keys: when the key stops authenticating. */
  readonly expiresAt?: string | null;
  /** True when the session key was replaced by this secret. */
  readonly swapped?: boolean;
}

export function SecretReveal({ secret, onUse, onDone }: { secret: Secret; onUse?: () => void; onDone: () => void }) {
  const { key: sessionKey } = useSessionKey();
  const inUse = sessionKey === secret.key;
  return (
    <div
      role="status"
      className="kl-drop flex flex-col gap-3 border-[3px] border-[#121212] bg-[#C6FF3A] p-4 text-[#121212] shadow-[4px_4px_0_#121212] dark:border-[#4A4A52] dark:shadow-[4px_4px_0_#2A2A30] sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className={LABEL}>
          {secret.kind === "issued" ? "Key issued" : secret.kind === "agent" ? "Agent key issued" : secret.kind === "publishable" ? "Publishable key issued" : "Key rotated"}
        </p>
        <Badge tone="ink">{secret.name}</Badge>
      </div>
      <p className="flex items-start gap-2 text-sm font-bold">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {secret.kind === "agent"
          ? "Copy it now into the agent's secret store (its MCP client or signer configuration). This is the only time Kletia shows this secret."
          : secret.kind === "publishable"
            ? "Copy it now into your page's code or build settings. It is safe in browsers (it works only from your allowed origins), but this is the only time Kletia shows it."
            : "Copy it now into your server's secret store. This is the only time Kletia shows this secret."}
      </p>
      <div className="flex flex-col gap-2 border-[3px] border-[#121212] bg-[#FBFAF6] p-3 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 break-all font-code text-sm">{secret.key}</code>
        <CopyButton text={secret.key} label={secret.kind === "publishable" ? "Copy the publishable key" : "Copy the new secret"} appearance="light" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-code text-xs">
        <dt className="font-bold">id</dt>
        <dd className="break-all">{secret.id}</dd>
        {secret.kind === "agent" && secret.expiresAt ? (
          <>
            <dt className="font-bold">expires</dt>
            <dd>{formatTimestamp(secret.expiresAt)}</dd>
          </>
        ) : null}
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
        {onUse && !inUse && secret.kind !== "publishable" ? (
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
