import type { ProjectView } from "@kletia/sdk";
import { ArrowRight, Check, Plus, RefreshCw, Save, X } from "lucide-react";
import React, { useId, useState } from "react";

import { sdkSignal, toPlatformError, type PlatformError } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CopyButton } from "../../../site/ui/CopyButton";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { utcStamp } from "../webhooks/webhookModel";
import { FlowEditor, type PatchResult } from "./FlowEditor";
import { LogoUpload } from "./LogoUpload";
import {
  appearanceIssue,
  changedFields,
  checkOrigin,
  domainStatus,
  draftFromSettings,
  draftPatch,
  fieldOfPath,
  networksByLane,
  rebaseDraft,
  settingsDiff,
  toggleAction,
  toggleNetwork,
  withLane,
  type DraftField,
  type DraftIssue,
  type ProjectDraft,
  type SettingsChange,
} from "./projectModel";
import { PublishableKeys } from "./PublishableKeys";

const ACTIONS = ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] as const;
const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);
const CHIP = "inline-flex min-h-11 items-center gap-1.5 border-2 px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50";

interface Conflict {
  /** The version the edits were made on. */
  readonly from: number;
  readonly latest: ProjectView;
  readonly changes: readonly SettingsChange[];
}

function Region({ id, title, intro, children }: { readonly id: string; readonly title: string; readonly intro?: React.ReactNode; readonly children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-col gap-1">
        <h2 id={id} className="font-display text-title font-bold">
          {title}
        </h2>
        {intro ? <p className={cx("max-w-3xl text-body-s", TEXT_MUTED)}>{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function FieldErrors({ issues }: { readonly issues: readonly DraftIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`} className="text-xs font-bold text-danger">
          <code className="font-code">{issue.path}</code>: {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** A toggle chip (network or action): a button with aria-pressed, 44 px tall. */
function Chip({ pressed, disabled, title, onClick, children }: { readonly pressed: boolean; readonly disabled?: boolean; readonly title?: string; readonly onClick: () => void; readonly children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        CHIP,
        FOCUS_RING,
        pressed ? "border-[#1A1A1A] bg-[#1A1A1A] text-white dark:border-[#FFD60A] dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "border-control bg-surface text-fg",
      )}
    >
      {pressed ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

function Brand({
  view,
  draft,
  issues,
  readOnly,
  dirtyWebsite,
  onDraft,
  onView,
  apiKey,
}: {
  readonly view: ProjectView;
  readonly draft: ProjectDraft;
  readonly issues: readonly DraftIssue[];
  readonly readOnly: boolean;
  readonly dirtyWebsite: boolean;
  readonly onDraft: (draft: ProjectDraft) => void;
  readonly onView: (view: ProjectView) => void;
  readonly apiKey: string;
}) {
  const domain = domainStatus(view, (iso) => utcStamp(iso));
  const verify = useApiAction((_client, signal, withKey: string) => keyedClient(withKey).projects.verifyDomain({ signal: sdkSignal(signal) }));
  const [checked, setChecked] = useState(false);
  const of = (field: DraftField) => issues.filter((issue) => issue.field === field);
  const check = async () => {
    setChecked(false);
    const next = await verify.run(apiKey);
    if (next) {
      setChecked(true);
      onView(next);
    }
  };
  return (
    <Region id="project-brand" title="Brand" intro="Your brand name and header show in the widget only after the website's domain is verified.">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <TextField
          label="Name"
          value={draft.brandName}
          maxLength={40}
          placeholder="Acme Store"
          onChange={(event) => onDraft({ ...draft, brandName: event.target.value })}
          error={of("brandName")[0]?.message}
          hint="2-40 characters. Reserved names (Kletia, venues, bridges) only with their own website."
        />
        <TextField
          label="Website"
          value={draft.website}
          mono
          placeholder="https://acme.example"
          onChange={(event) => onDraft({ ...draft, website: event.target.value })}
          error={of("website")[0]?.message}
          hint="An https origin, no port or path. A new website starts unverified."
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3 border-t-2 border-[#1A1A1A]/10 pt-4 dark:border-white/10">
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Domain</span>
          <StatusEntryPill entry={domain.status} />
          {domain.state === "verified" && view.domain.host ? <span className="font-code text-sm">{view.domain.host}</span> : null}
        </div>
        <p className="max-w-3xl text-sm">{domain.message}</p>
        {domain.fileUrl ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm">
              Publish at <code className="break-all font-code text-xs">{domain.fileUrl}</code>:
            </p>
            <div className="flex min-w-0 flex-col gap-2 border-2 border-control bg-white p-3 dark:bg-[#0B1120] sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all font-code text-sm">{domain.file}</code>
              <CopyButton text={domain.file} label="Copy the domain file" />
            </div>
          </div>
        ) : null}
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void check()} loading={verify.status === "loading"} disabled={!domain.fileUrl || dirtyWebsite}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Check now
            </Button>
            {dirtyWebsite ? <span className={cx("text-xs", TEXT_MUTED)}>Save the new website first.</span> : null}
          </div>
        ) : null}
        <div aria-live="polite" className="flex flex-col gap-2">
          {verify.status === "loading" && domain.fileUrl ? <p className={cx("text-sm", TEXT_MUTED)}>Checking {domain.fileUrl}…</p> : null}
          {checked && verify.status === "success" ? (
            <p className={cx("text-sm font-bold", view.domain.verified ? "text-success" : "text-warning")}>
              {view.domain.verified ? "Verified: the domain file lists this project." : "Not verified yet: see why above."}
            </p>
          ) : null}
          {verify.status === "error" && verify.error ? <ApiErrorPanel error={verify.error} title="The domain check did not run" /> : null}
        </div>
      </div>
    </Region>
  );
}

function Origins({ draft, issues, readOnly, onDraft }: { readonly draft: ProjectDraft; readonly issues: readonly DraftIssue[]; readonly readOnly: boolean; readonly onDraft: (draft: ProjectDraft) => void }) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const result = checkOrigin(value, draft.origins);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setValue("");
    onDraft({ ...draft, origins: [...draft.origins, result.origin] });
  };
  return (
    <Region
      id="project-origins"
      title="Allowed origins"
      intro="Pages that may use your publishable keys and run your flows: https origins, and http://localhost:<port> while you develop. Requests from anywhere else are refused before anything is planned."
    >
      {draft.origins.length === 0 ? (
        <p className={cx("text-sm", TEXT_MUTED)}>No origins yet: publishable keys work nowhere until you add one.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Allowed origins">
          {draft.origins.map((origin) => (
            <li key={origin} className="inline-flex min-h-11 items-center gap-1 border-2 border-control bg-surface pl-3 font-code text-sm">
              {origin}
              {!readOnly ? (
                <button
                  type="button"
                  onClick={() => onDraft({ ...draft, origins: draft.origins.filter((item) => item !== origin) })}
                  aria-label={`Remove ${origin}`}
                  className={cx("inline-flex h-10 w-10 items-center justify-center", FOCUS_RING)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : (
                <span className="w-3" />
              )}
            </li>
          ))}
        </ul>
      )}
      <FieldErrors issues={issues.filter((issue) => issue.field === "origins")} />
      {!readOnly ? (
        <form onSubmit={add} noValidate className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
          <TextField
            id={inputId}
            label="Add an origin"
            mono
            value={value}
            placeholder="https://shop.acme.example"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
            error={error ?? undefined}
            containerClassName="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" className="sm:mt-8">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add origin
          </Button>
        </form>
      ) : null}
    </Region>
  );
}

function Defaults({ draft, issues, onDraft }: { readonly draft: ProjectDraft; readonly issues: readonly DraftIssue[]; readonly onDraft: (draft: ProjectDraft) => void }) {
  const laneName = useId();
  const of = (field: DraftField) => issues.filter((issue) => issue.field === field);
  const appearanceProblem = appearanceIssue(draft.appearance);
  const groups = networksByLane();
  const chosen = groups.flatMap((group) => group.networks).filter((network) => draft.networks.includes(network.key));
  return (
    <Region
      id="project-defaults"
      title="Defaults"
      intro="What the widget offers when a page sets nothing itself, and the first rule book of every new publishable key."
    >
      <fieldset className="flex flex-col gap-2">
        <legend className={cx(LABEL, "mb-1")}>Lane</legend>
        <div className="flex flex-wrap gap-x-5">
          {(
            [
              ["", "Both lanes"],
              ["production", "Live (mainnets)"],
              ["testnet", "Sandbox (testnets)"],
            ] as const
          ).map(([value, label]) => (
            <label key={value || "both"} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name={laneName} checked={draft.lane === value} onChange={() => onDraft(withLane(draft, value))} className="h-4 w-4 accent-[#0052FF]" />
              {label}
            </label>
          ))}
        </div>
        <FieldErrors issues={of("lane")} />
      </fieldset>
      {groups.map((group) => (
        <fieldset key={group.lane} className="flex flex-col gap-2">
          <legend className={cx(LABEL, "mb-1")}>Networks · {group.label}</legend>
          <div className="flex flex-wrap gap-2">
            {group.networks.map((network) => {
              const off = Boolean(draft.lane) && draft.lane !== network.lane;
              return (
                <Chip
                  key={network.key}
                  pressed={draft.networks.includes(network.key)}
                  disabled={off}
                  title={off ? `Not on the ${draft.lane} lane` : undefined}
                  onClick={() => onDraft(toggleNetwork(draft, network.key))}
                >
                  {network.name}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      ))}
      <p className={cx("-mt-2 text-xs", TEXT_MUTED)}>
        {draft.networks.length === 0
          ? `None picked: the widget offers every network${draft.lane ? ` of the ${draft.lane} lane` : ""}.`
          : `${draft.networks.length} picked.`}
      </p>
      <FieldErrors issues={of("networks")} />
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SelectField
          label="Start on"
          value={draft.sourceNetwork}
          onChange={(event) => onDraft({ ...draft, sourceNetwork: event.target.value })}
          error={of("sourceNetwork")[0]?.message}
          hint="Where the money starts by default. Auto lets Kletia pick from the visitor's balances."
          options={[
            { value: "", label: "Not set" },
            { value: "auto", label: "Auto" },
            ...(chosen.length > 0 ? chosen : groups.flatMap((group) => group.networks).filter((network) => !draft.lane || network.lane === draft.lane)).map((network) => ({
              value: network.key,
              label: network.name,
            })),
          ]}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className={cx(LABEL, "mb-1")}>Actions</legend>
          <div className="flex flex-wrap gap-2">
            {ACTIONS.map((action) => (
              <Chip key={action} pressed={draft.actions.includes(action)} onClick={() => onDraft(toggleAction(draft, action))}>
                {action}
              </Chip>
            ))}
          </div>
          <FieldErrors issues={of("actions")} />
        </fieldset>
      </div>
      <TextAreaField
        label="Examples"
        rows={3}
        value={draft.examples}
        onChange={(event) => onDraft({ ...draft, examples: event.target.value })}
        error={of("examples")[0]?.message}
        hint="One per line, at most 6 of 120 characters: the prompts the widget suggests."
      />
      <div className="flex min-w-0 flex-col gap-2">
        <TextAreaField
          label="Appearance"
          mono
          rows={5}
          value={draft.appearance}
          placeholder='{ "light": { "accent": "#0E7C66" }, "radius": 10 }'
          onChange={(event) => onDraft({ ...draft, appearance: event.target.value })}
          error={of("appearance")[0]?.message ?? appearanceProblem ?? undefined}
          hint="Appearance tokens as JSON (docs: theming). Element attributes on a page still win."
        />
        <Link to="/developers/embed" className={cx("inline-flex min-h-10 items-center gap-1.5 self-start text-sm", LINK)}>
          Design it in the Embed builder
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </Region>
  );
}

function ConflictNotice({ conflict, onKeep, onDiscard }: { readonly conflict: Conflict; readonly onKeep: () => void; readonly onDiscard: () => void }) {
  return (
    <section role="alert" aria-labelledby="project-conflict" className="kl-rise flex min-w-0 flex-col gap-3 border-[3px] border-[#B45309] bg-warning-bg p-4 text-fg sm:p-5">
      <h2 id="project-conflict" className="font-display text-title font-bold">
        The project changed while you edited it
      </h2>
      <p className="text-sm">
        You started from version {conflict.from}; it is now version {conflict.latest.version}, saved {utcStamp(conflict.latest.updatedAt)} by{" "}
        <code className="font-code text-xs">{conflict.latest.updatedBy}</code>. Nothing of yours was saved. What changed:
      </p>
      {conflict.changes.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <caption className="sr-only">Changes since version {conflict.from}</caption>
            <thead>
              <tr className="border-b-2 border-[#1A1A1A]/10 dark:border-white/10">
                <th scope="col" className={cx(LABEL, "py-1.5 pr-3")}>
                  Field
                </th>
                <th scope="col" className={cx(LABEL, "py-1.5 pr-3")}>
                  Was
                </th>
                <th scope="col" className={cx(LABEL, "py-1.5")}>
                  Now
                </th>
              </tr>
            </thead>
            <tbody>
              {conflict.changes.map((change) => (
                <tr key={change.path} className="align-top">
                  <th scope="row" className="py-1.5 pr-3 font-code text-xs font-bold">
                    {change.path}
                  </th>
                  <td className="break-all py-1.5 pr-3 font-code text-xs">{change.before}</td>
                  <td className="break-all py-1.5 font-code text-xs">{change.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm">Only the version moved (the same settings were saved again).</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onKeep}>Keep my edits on version {conflict.latest.version}</Button>
        <Button variant="secondary" onClick={onDiscard}>
          Discard my edits
        </Button>
      </div>
    </section>
  );
}

/**
 * The Project page body: brand and domain proof, allowed origins and
 * defaults (one draft, saved as a JSON merge patch under If-Match),
 * publishable keys, stored flows and the logo. A stale If-Match shows
 * what changed and lets you reapply or discard; agent keys get the same
 * page read-only.
 */
export function ProjectPanel() {
  const { key } = useSessionKey();
  const readOnly = portalKeyKind(key) !== "developer";
  const resource = useApiResource<ProjectView>(`project:${maskKey(key)}`, (_client, signal) => keyedClient(key).projects.get({ signal: sdkSignal(signal) }));
  const [view, setView] = useState<ProjectView | null>(null);
  const [draft, setDraft] = useState<ProjectDraft>(() => draftFromSettings(null));
  const [issues, setIssues] = useState<readonly DraftIssue[]>([]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PlatformError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<ProjectView | null>(null);

  // A (re)load replaces the view and the draft (adjusted while rendering, not in an effect): nothing unsaved survives a key change or Reload.
  if (resource.data && resource.data !== loaded) {
    setLoaded(resource.data);
    setView(resource.data);
    setDraft(draftFromSettings(resource.data.settings));
    setIssues([]);
    setConflict(null);
  }

  if (!view) {
    if (resource.status === "error" && resource.error) return <ApiErrorPanel error={resource.error} title="Could not read the project" onRetry={resource.reload} />;
    return (
      <SkeletonGroup label="Loading the project" className="flex flex-col gap-4">
        <Skeleton surface="card" className="h-40" />
        <Skeleton surface="card" className="h-28" />
        <Skeleton surface="card" className="h-40" />
      </SkeletonGroup>
    );
  }

  const changed = changedFields(view.settings, draft);
  const lane = view.settings.defaults?.lane;

  /** One PATCH under the current hash; a stale hash reads the project again and shows the diff. */
  const applyPatch = async (patch: Record<string, unknown>): Promise<PatchResult> => {
    setNotice(null);
    try {
      const next = await keyedClient(key).projects.update(patch, { ifMatch: view.hash });
      setView(next);
      setConflict(null);
      return { ok: true, view: next };
    } catch (error) {
      const failed = toPlatformError(error);
      if (failed.code === "PROJECT_CONFLICT") {
        try {
          const latest = await keyedClient(key).projects.get();
          setConflict({ from: view.version, latest, changes: settingsDiff(view.settings, latest.settings) });
        } catch {
          // The conflict itself is still reported below.
        }
      }
      return { ok: false, error: failed };
    }
  };

  const save = async () => {
    setFailure(null);
    const result = draftPatch(view.settings, draft);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    if (Object.keys(result.patch).length === 0) return;
    setSaving(true);
    const outcome = await applyPatch(result.patch);
    setSaving(false);
    if (outcome.ok) {
      setDraft(draftFromSettings(outcome.view.settings));
      setNotice(`Saved as version ${outcome.view.version}.`);
      return;
    }
    setFailure(outcome.error);
    setIssues(outcome.error.issues.map((issue) => ({ field: fieldOfPath(issue.path), path: issue.path, message: issue.message })));
  };

  const formIssues = issues.filter((issue) => issue.field === "form" || issue.field === "flows");

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className={LABEL}>Project</span>
          <code className="break-all font-code text-xs">{view.id}</code>
          {lane === "testnet" ? <Badge tone="yellow">Sandbox</Badge> : lane === "production" ? <Badge tone="green">Live</Badge> : null}
          <span className={TEXT_MUTED}>
            {view.version === 0 ? "· nothing saved yet" : `· version ${view.version}, saved ${utcStamp(view.updatedAt)}`}
          </span>
        </p>
        <Button size="sm" variant="ghost" onClick={resource.reload} aria-label="Reload the project">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </Button>
      </div>
      {readOnly ? (
        <p className="border-l-[6px] border-[#0052FF] bg-info-bg px-3 py-2 text-sm text-fg">
          You are reading with an agent key: agent keys see the project settings but never change them. Load a developer key of the project to edit.
        </p>
      ) : null}
      {conflict ? (
        <ConflictNotice
          conflict={conflict}
          onKeep={() => {
            setDraft(rebaseDraft(view.settings, conflict.latest.settings, draft));
            setView(conflict.latest);
            setConflict(null);
            setNotice(`Your edits now sit on version ${conflict.latest.version}. Review them and save again.`);
          }}
          onDiscard={() => {
            setView(conflict.latest);
            setDraft(draftFromSettings(conflict.latest.settings));
            setConflict(null);
            setIssues([]);
          }}
        />
      ) : null}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-10">
        <legend className="sr-only">Brand, allowed origins and defaults</legend>
        <Brand
          view={view}
          draft={draft}
          issues={issues}
          readOnly={readOnly}
          dirtyWebsite={changed.includes("website")}
          onDraft={setDraft}
          onView={setView}
          apiKey={key}
        />
        <Origins draft={draft} issues={issues} readOnly={readOnly} onDraft={setDraft} />
        <Defaults draft={draft} issues={issues} onDraft={setDraft} />
      </fieldset>
      {!readOnly ? (
        <div
          className={cx(
            "sticky bottom-0 z-10 -mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-[3px] border-[#1A1A1A] bg-paper p-3 dark:border-[#4B5563] sm:p-4",
            changed.length === 0 && "static",
          )}
        >
          <div aria-live="polite" className="min-w-0 text-sm">
            {notice ? (
              <span className="font-bold text-success">{notice}</span>
            ) : changed.length > 0 ? (
              <span className="font-bold">
                {changed.length} unsaved {changed.length === 1 ? "change" : "changes"}
              </span>
            ) : (
              <span className={TEXT_MUTED}>Brand, origins and defaults are saved.</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {changed.length > 0 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(draftFromSettings(view.settings));
                  setIssues([]);
                  setFailure(null);
                }}
              >
                Discard
              </Button>
            ) : null}
            <Button onClick={() => void save()} loading={saving} disabled={changed.length === 0 || Boolean(conflict)}>
              <Save className="h-4 w-4" aria-hidden="true" />
              Save · v{view.version + 1}
            </Button>
          </div>
        </div>
      ) : null}
      <div aria-live="polite" className="-mt-6 flex flex-col gap-2">
        {failure && !(conflict && failure.code === "PROJECT_CONFLICT") ? <ApiErrorPanel error={failure} title="Kletia did not save the settings" /> : null}
        <FieldErrors issues={formIssues} />
      </div>
      <Region
        id="project-publishable"
        title="Publishable keys"
        intro={
          <>
            Browser-safe <code className="font-code">kl_pub_</code> keys for the widget, the embed and the SDK on your pages. They work only from the
            allowed origins, never call your contracts by themselves, and count against their own rule book.
          </>
        }
      >
        <PublishableKeys apiKey={key} view={view} readOnly={readOnly} />
      </Region>
      <Region id="project-flows" title="Flows" intro="Stored session templates a publishable key starts from your page: your own contract, a fixed entry, bounds on the amount.">
        <FlowEditor apiKey={key} view={view} readOnly={readOnly} onPatch={applyPatch} />
      </Region>
      <Region id="project-logo" title="Logo">
        <LogoUpload apiKey={key} view={view} readOnly={readOnly} onView={setView} />
      </Region>
    </div>
  );
}
