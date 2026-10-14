import type { ApiKeySummary, RotatedApiKey } from "@kletia/sdk";
import { BookOpen, RotateCw, ShieldX, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { DataTable } from "../../../site/ui/DataTable";
import { SelectField } from "../../../site/ui/Field";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER_THIN, TEXT_MUTED } from "../../../site/ui/styles";
import { GRACE_OPTIONS, keyedClient } from "./keyClient";
import { SecretReveal, type Secret } from "./KeyManager";
import { keyRowModel, orderKeyTree, type KeyRowModel } from "./keyRows";
import { useSessionKey } from "./sessionKey";

type Pending = { readonly id: string; readonly kind: "rotate" | "revoke" } | null;

interface Row {
  readonly item: ApiKeySummary;
  readonly model: KeyRowModel;
}

/**
 * The keys of the project (portal design 4.4.2): name (indented under its
 * parent, "In this tab" for the key in memory), kind and depth, status,
 * masked secret, created, last used and lane, with Rotate, Revoke and the
 * key's rule book. Rotate and Revoke confirm inline under the table, as
 * before; the API decides what the loaded key may manage.
 */
export function KeysTable({ keys, now, onChanged }: { readonly keys: readonly ApiKeySummary[]; readonly now: number; readonly onChanged: () => void }) {
  const { key, setKey, clear } = useSessionKey();
  const [pending, setPending] = useState<Pending>(null);
  const [grace, setGrace] = useState("86400");
  const [secret, setSecret] = useState<Secret | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const rotate = useApiAction((_client, signal, apiKey: string, id: string, graceSeconds: number) =>
    keyedClient(apiKey).keys.rotate(id, { graceSeconds, signal: sdkSignal(signal) }),
  );
  const revoke = useApiAction((_client, signal, apiKey: string, id: string) => keyedClient(apiKey).keys.revoke(id, { signal: sdkSignal(signal) }).then(() => id));
  const rows: Row[] = orderKeyTree(keys).map((item) => ({ item, model: keyRowModel(item, now) }));
  const target = pending ? rows.find((row) => row.item.id === pending.id) ?? null : null;

  // The inline confirmation takes focus, so a keyboard user lands on the choice they opened.
  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  const ask = (id: string, kind: "rotate" | "revoke") => {
    rotate.reset();
    revoke.reset();
    setNotice(null);
    setPending({ id, kind });
  };

  const doRotate = async (item: ApiKeySummary) => {
    const rotated: RotatedApiKey | undefined = await rotate.run(key, item.id, Number.parseInt(grace, 10));
    if (!rotated) return;
    setPending(null);
    setSecret({ kind: "rotated", id: rotated.id, name: rotated.name, key: rotated.key, previousExpiresAt: rotated.previousExpiresAt, swapped: item.current });
    if (item.current) setKey(rotated.key);
    else onChanged();
  };

  const doRevoke = async (item: ApiKeySummary) => {
    const done = await revoke.run(key, item.id);
    if (!done) return;
    setPending(null);
    if (item.current) {
      clear();
      setNotice(`${item.name} was revoked. It was the key in this tab, so the portal forgot it.`);
    } else {
      setNotice(`${item.name} was revoked${item.descendants ? `, with the ${item.descendants === 1 ? "key" : `${item.descendants} keys`} issued under it` : ""}.`);
      onChanged();
    }
  };

  const failure = rotate.status === "error" ? rotate.error : revoke.status === "error" ? revoke.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DataTable
        caption="Keys in this project"
        rows={rows}
        rowKey={(row) => row.item.id}
        empty={<p className={cx("p-4 text-sm", INK_BORDER_THIN, TEXT_MUTED)}>No keys listed.</p>}
        columns={[
          {
            key: "name",
            header: "Name",
            phone: "primary",
            cell: ({ item, model }) => (
              <span className="inline-flex min-w-0 items-center gap-2" style={{ paddingLeft: `${Math.min(model.depth, 4) * 0.875}rem` }}>
                {model.depth > 0 ? (
                  <span aria-hidden="true" className={TEXT_MUTED}>
                    └
                  </span>
                ) : null}
                <span className="min-w-0 break-words font-bold">{item.name}</span>
                {model.current ? <Badge tone="ink">In this tab</Badge> : null}
              </span>
            ),
          },
          { key: "kind", header: "Kind", cell: ({ model }) => <span className="whitespace-nowrap">{model.kindLabel}</span> },
          {
            key: "status",
            header: "Status",
            phone: "primary",
            cell: ({ model }) => <StatusEntryPill entry={model.status} title={model.statusDetail ?? undefined} />,
          },
          { key: "secret", header: "Secret", cell: ({ model }) => <code className="whitespace-nowrap font-code text-xs">{model.secret}</code> },
          { key: "created", header: "Created", cell: ({ model }) => model.created },
          { key: "used", header: "Last used", cell: ({ model }) => model.lastUsed },
          {
            key: "lane",
            header: "Lane",
            cell: ({ model }) => (
              <span title={model.laneDetail} className="whitespace-nowrap">
                {model.lane === "Sandbox" ? <Badge tone="yellow">Sandbox</Badge> : model.lane}
              </span>
            ),
          },
          {
            key: "actions",
            header: "Actions",
            align: "end",
            cell: ({ item, model }) => (
              <span className="inline-flex justify-end gap-1">
                <Link
                  to={`/developers/rule-book?key=${encodeURIComponent(item.id)}`}
                  aria-label={`Open the rule book of ${item.name}`}
                  title="Rule book"
                  className={cx("inline-flex h-10 w-10 items-center justify-center", FOCUS_RING)}
                >
                  <BookOpen className="h-4 w-4" aria-hidden="true" />
                </Link>
                {!model.ended && model.kind !== "publishable" ? (
                  <Button size="sm" variant="ghost" onClick={() => ask(item.id, "rotate")} aria-label={`Rotate ${item.name}`} title="Rotate">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
                {!model.ended ? (
                  <Button size="sm" variant="ghost" onClick={() => ask(item.id, "revoke")} aria-label={`Revoke ${item.name}`} title="Revoke">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      <p className={cx("text-xs", TEXT_MUTED)}>
        Statuses: rotating keys accept their old secret until the grace window ends; agent keys warn a day before they expire. Publishable keys are
        managed on{" "}
        <Link to="/developers/project" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
          Project settings
        </Link>
        .
      </p>
      <div aria-live="polite" className="flex flex-col gap-3">
        {notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-success-bg px-3 py-2 text-sm text-fg">{notice}</p> : null}
        {secret ? <SecretReveal secret={secret} onDone={() => setSecret(null)} /> : null}
        {failure ? <ApiErrorPanel error={failure} title="The key action failed" /> : null}
      </div>
      {pending && target ? (
        pending.kind === "rotate" ? (
          <div ref={confirmRef} tabIndex={-1} role="group" aria-label={`Rotate ${target.item.name}`} className={cx("kl-rise flex flex-col gap-3 p-3 outline-none sm:p-4", INK_BORDER_THIN)}>
            <p className="font-bold">Rotate {target.item.name}</p>
            <SelectField label="Grace window for the old secret" value={grace} onChange={(event) => setGrace(event.target.value)} options={GRACE_OPTIONS} />
            <p className={cx("text-xs", TEXT_MUTED)}>
              Same key id, new secret. During the grace window the old secret still authenticates but cannot manage keys, so a leaked secret
              cannot take the key over.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={rotate.status === "loading"} onClick={() => void doRotate(target.item)}>
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                Rotate now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div
            ref={confirmRef}
            tabIndex={-1}
            role="group"
            aria-label={`Revoke ${target.item.name}`}
            className="kl-rise flex flex-col gap-3 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-[#1A1A1A] outline-none dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2] sm:p-4"
          >
            <p className="flex items-start gap-2 text-sm font-bold">
              <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Revoke {target.item.name}? Requests with it fail at once here and within 15 seconds everywhere.
              {target.item.descendants
                ? ` Its ${target.item.descendants === 1 ? "agent key is" : `${target.item.descendants} agent keys are`} revoked with it.`
                : ""}{" "}
              This cannot be undone.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ink" loading={revoke.status === "loading"} onClick={() => void doRevoke(target.item)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Revoke key
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPending(null)}>
                Keep it
              </Button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
