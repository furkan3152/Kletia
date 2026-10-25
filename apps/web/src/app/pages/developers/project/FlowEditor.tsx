import type { ContractView, ProjectView, SessionView } from "@kletia/sdk";
import { FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import React, { useEffect, useId, useMemo, useState } from "react";

import { sdkSignal, type PlatformError } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextField } from "../../../site/ui/Field";
import { Sheet } from "../../../site/ui/Sheet";
import { Switch } from "../../../site/ui/Switch";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { BuilderPreview } from "../builder/BuilderPreview";
import { keyedClient } from "../keys/keyClient";
import { maskKey } from "../keys/sessionKey";
import {
  buildFlow,
  EMPTY_FLOW_DRAFT,
  flowDraftOf,
  flowsWith,
  flowsWithout,
  flowSources,
  flowSummary,
  suggestFlowId,
  testSessionRequest,
  type FlowDraft,
  type FlowField,
  type StoredFlow,
} from "./projectModel";

export type PatchResult = { readonly ok: true; readonly view: ProjectView } | { readonly ok: false; readonly error: PlatformError };

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

/** The form for one flow: a registration, one of its entries, the amount and, optionally, bounds the visitor picks within. */
function FlowForm({
  apiKey,
  flows,
  editing,
  initial,
  onSave,
  onCancel,
}: {
  readonly apiKey: string;
  readonly flows: readonly StoredFlow[];
  readonly editing: string | null;
  readonly initial: FlowDraft;
  readonly onSave: (flows: ReturnType<typeof flowsWith>) => Promise<PatchResult>;
  readonly onCancel: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<FlowDraft>(initial);
  const [shown, setShown] = useState<Partial<Record<FlowField | "form", string>>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PlatformError | null>(null);
  const contracts = useApiResource<ContractView[]>(`flow-contracts:${maskKey(apiKey)}`, (_client, signal) => keyedClient(apiKey).contracts.list({}, { signal: sdkSignal(signal) }));
  const sources = useMemo(() => flowSources(contracts.data ?? []), [contracts.data]);
  const source = sources.find((item) => item.id === draft.contract) ?? null;
  const set = <K extends FlowField>(field: K, value: FlowDraft[K]) => setDraft((current) => ({ ...current, [field]: value }));

  const pickContract = (id: string) => {
    const next = sources.find((item) => item.id === id) ?? null;
    const entry = next?.actions[0];
    setDraft((current) => ({
      ...current,
      contract: id,
      entry: entry?.id ?? "",
      ...(editing ? {} : { id: entry ? suggestFlowId(entry.id, flows.map((flow) => flow.id)) : current.id, label: entry?.label ?? current.label }),
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const built = buildFlow(draft, source, flows, editing);
    if (!built.ok) {
      setShown(Object.fromEntries(built.issues.map((issue) => [issue.field, issue.message])));
      // Focus the first field that reads invalid once the errors render.
      requestAnimationFrame(() => (event.target as HTMLFormElement).querySelector<HTMLElement>('[aria-invalid="true"], [data-flow-error]')?.focus());
      return;
    }
    setShown({});
    setSaving(true);
    const result = await onSave(flowsWith(flows, built.flow, editing));
    setSaving(false);
    // A refused dry run comes back as PROJECT_SETTINGS_INVALID with the API's issue list, shown as it came.
    if (!result.ok) setFailure(result.error);
  };

  return (
    <form onSubmit={submit} noValidate className={cx("kl-rise flex min-w-0 flex-col gap-4 p-4", INK_BORDER_THIN)} aria-label={editing ? `Edit flow ${editing}` : "New flow"}>
      <p className="font-bold">{editing ? `Edit flow ${editing}` : "New flow from a registration"}</p>
      {contracts.status === "error" && contracts.error ? (
        <ApiErrorPanel error={contracts.error} title="Could not list your registrations" onRetry={contracts.reload} />
      ) : contracts.data && sources.length === 0 ? (
        <p className={cx("text-sm", TEXT_MUTED)}>
          No active or pending registration yet. Flows call your own contracts:{" "}
          <Link to="/developers/contracts/new" className={LINK}>
            register one
          </Link>{" "}
          first (on a testnet it is active at once).
        </p>
      ) : null}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SelectField
          label="Registration"
          value={draft.contract}
          onChange={(event) => pickContract(event.target.value)}
          error={shown.contract}
          options={[
            { value: "", label: contracts.status === "loading" ? "Loading registrations…" : "Pick a registration" },
            ...sources.map((item) => ({ value: item.id, label: `${item.integrator.name} · ${item.network} · ${item.id.slice(0, 11)}…${item.status === "pending" ? " (pending)" : ""}` })),
          ]}
        />
        <SelectField
          label="Entry"
          value={draft.entry}
          onChange={(event) => set("entry", event.target.value)}
          error={shown.entry}
          disabled={!source}
          options={[{ value: "", label: "Pick an entry" }, ...(source?.actions ?? []).map((action) => ({ value: action.id, label: `${action.label} (${action.id})` }))]}
        />
        <TextField
          id={`${formId}-id`}
          label="Flow id"
          mono
          value={draft.id}
          maxLength={32}
          placeholder="deposit"
          onChange={(event) => set("id", event.target.value)}
          error={shown.id}
          hint="Lowercase letters, digits and dashes; the embed's flow attribute."
          disabled={Boolean(editing)}
        />
        <TextField id={`${formId}-label`} label="Label" value={draft.label} maxLength={80} onChange={(event) => set("label", event.target.value)} error={shown.label} />
        <TextField
          id={`${formId}-amount`}
          label={draft.visitorAmount ? "Default amount" : "Amount"}
          mono
          inputMode="decimal"
          value={draft.amount}
          placeholder="10"
          onChange={(event) => set("amount", event.target.value)}
          error={shown.amount}
          hint="In the entry's input asset (human units)."
        />
        <div className="flex flex-col gap-2">
          <Switch checked={draft.visitorAmount} onChange={(value) => set("visitorAmount", value)} label="The visitor picks the amount" description="Within the bounds below." />
          {draft.visitorAmount ? (
            <div className="grid grid-cols-2 gap-3">
              <TextField id={`${formId}-min`} label="Min" mono inputMode="decimal" value={draft.min} onChange={(event) => set("min", event.target.value)} error={shown.min} />
              <TextField id={`${formId}-max`} label="Max" mono inputMode="decimal" value={draft.max} onChange={(event) => set("max", event.target.value)} error={shown.max} />
            </div>
          ) : null}
        </div>
      </div>
      {shown.form ? (
        <p data-flow-error="" tabIndex={-1} className="text-sm font-bold text-danger">
          {shown.form}
        </p>
      ) : null}
      <div aria-live="polite">{failure ? <ApiErrorPanel error={failure} title="Kletia did not save the flow" /> : null}</div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={saving}>
          {editing ? "Save the flow" : "Add the flow"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>
        Saving dry-runs the flow as your key, which becomes its saver: its call steps use your registrations. Publishable keys issued before
        this flow need it in their rule book.
      </p>
    </form>
  );
}

/** "Test": a single-use session from the flow, owned by the key in this tab, run in the real frame here up to the wallet prompt. */
function FlowTest({ apiKey, flow, onClose }: { readonly apiKey: string; readonly flow: StoredFlow | null; readonly onClose: () => void }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const start = useApiAction((_client, signal, withKey: string, target: StoredFlow) =>
    keyedClient(withKey).sessions.create(testSessionRequest(target, origin), { signal: sdkSignal(signal) }),
  );
  const [created, setCreated] = useState<{ readonly flow: string; readonly session: SessionView } | null>(null);
  const run = start.run;
  const flowId = flow?.id ?? null;
  // One session per opening: created when the sheet opens for a flow, dropped when it closes.
  useEffect(() => {
    if (!flow || flowId === null) return undefined;
    let live = true;
    void run(apiKey, flow).then((session) => {
      if (live && session) setCreated({ flow: flowId, session });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the flow object is re-read only when another flow opens
  }, [apiKey, flowId, run]);
  // Only the session of the flow this sheet is open for (a previous opening's is never shown).
  const session = created && created.flow === flowId ? created.session : null;
  return (
    <Sheet
      open={Boolean(flow)}
      onClose={() => {
        setCreated(null);
        start.reset();
        onClose();
      }}
      title={flow ? `Test flow ${flow.id}` : "Test flow"}
      widthClassName="md:w-[520px]"
      phone="full"
    >
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <p className="text-sm">
          A single-use session (10 minutes) from this flow, owned by your developer key and allowed on this page only. Nothing is signed unless you
          approve it in your own wallet: declining the prompt ends the test.
        </p>
        {start.status === "error" && start.error ? <ApiErrorPanel error={start.error} title="The flow could not start" /> : null}
        {start.status === "loading" ? <p className={cx("text-sm", TEXT_MUTED)}>Starting a test session…</p> : null}
        {session ? (
          <>
            <p className={cx("font-code text-xs", TEXT_MUTED)}>session {session.id}</p>
            <BuilderPreview options={{ origin, session: session.id, height: 640 }} width="fluid" pageColor={null} height={640} />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * Stored flows: session templates a publishable key starts from the
 * browser. Each row has Test and Edit; "New flow from a registration"
 * builds a one-step flow. Saving patches `flows` under the project's
 * If-Match, and a refused dry run shows the API's issue list.
 */
export function FlowEditor({
  apiKey,
  view,
  readOnly,
  onPatch,
}: {
  readonly apiKey: string;
  readonly view: ProjectView;
  readonly readOnly: boolean;
  readonly onPatch: (patch: Record<string, unknown>) => Promise<PatchResult>;
}) {
  const flows = view.settings.flows ?? [];
  const [editing, setEditing] = useState<{ readonly id: string | null; readonly draft: FlowDraft } | null>(null);
  const [testing, setTesting] = useState<StoredFlow | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<PlatformError | null>(null);

  const save = async (next: ReturnType<typeof flowsWith>): Promise<PatchResult> => {
    const result = await onPatch({ flows: next });
    if (result.ok) setEditing(null);
    return result;
  };

  const remove = async (id: string) => {
    setFailure(null);
    const result = await onPatch({ flows: flowsWithout(flows, id) });
    if (result.ok) setRemoving(null);
    else setFailure(result.error);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {flows.length === 0 ? (
        <p className={cx("text-sm", TEXT_MUTED)}>No flows yet. A flow lets a publishable key run your own contract from a static page.</p>
      ) : (
        <ul className={cx("divide-y-2 divide-[#121212]/10 dark:divide-white/10", INK_BORDER_THIN)} aria-label="Stored flows">
          {flows.map((flow) => {
            const editable = flowDraftOf(flow);
            return (
              <li key={flow.id} className="flex min-w-0 flex-col gap-2 p-3 sm:p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-2">
                      <code className="font-code text-sm font-bold">{flow.id}</code>
                      <span className="min-w-0 break-words">&ldquo;{flow.label}&rdquo;</span>
                    </p>
                    <p className={cx("break-words text-xs", TEXT_MUTED)}>
                      {flowSummary(flow)} · saved by <code className="font-code">{flow.ownerKeyId}</code>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {!readOnly ? (
                      <Button size="sm" variant="secondary" onClick={() => setTesting(flow)} aria-label={`Test flow ${flow.id}`}>
                        <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                        Test
                      </Button>
                    ) : null}
                    {!readOnly && editable ? (
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ id: flow.id, draft: editable })} aria-label={`Edit flow ${flow.id}`}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </Button>
                    ) : null}
                    {!readOnly ? (
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(flow.id)} aria-label={`Remove flow ${flow.id}`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                {removing === flow.id ? (
                  <div className="flex flex-wrap items-center gap-2 border-l-[6px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm text-fg">
                    <span className="font-bold">Remove {flow.id}? Pages that start it get FLOW_UNKNOWN.</span>
                    <Button size="sm" variant="ink" onClick={() => void remove(flow.id)}>
                      Remove
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRemoving(null)}>
                      Keep it
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">{failure ? <ApiErrorPanel error={failure} title="Kletia did not remove the flow" /> : null}</div>
      {readOnly ? null : editing ? (
        <FlowForm key={editing.id ?? "new"} apiKey={apiKey} flows={flows} editing={editing.id} initial={editing.draft} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setEditing({ id: null, draft: EMPTY_FLOW_DRAFT })}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New flow from a registration
        </Button>
      )}
      <p className={cx("text-xs", TEXT_MUTED)}>
        Embed one with <code className="font-code">&lt;kletia-intent key=&quot;kl_pub_…&quot; flow=&quot;id&quot;&gt;</code> from the{" "}
        <Link to="/developers/embed" className={LINK}>
          Embed builder
        </Link>
        . <span className={LABEL}>{flows.length}/20</span>
      </p>
      {!readOnly ? <FlowTest apiKey={apiKey} flow={testing} onClose={() => setTesting(null)} /> : null}
    </div>
  );
}
