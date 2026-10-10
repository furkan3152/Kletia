import {
  comparePolicies,
  POLICY_TEMPLATES,
  validatePolicy,
  type ContractView,
  type PolicyComparison,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyTemplateId,
} from "@kletia/core";
import type { ApiKeySummary, PolicyReadResponse, PolicySpendReport, PolicyWriteResponse } from "@kletia/sdk";
import { BookOpen, Braces, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { LazyBoundary } from "../../../../shared/components/LazyBoundary";
import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextAreaField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { durationText, formatWhen } from "../portal/portalFormat";
import { AmendmentNotice } from "./AmendmentNotice";
import { RuleBookArticles, type ArticleContext } from "./articles";
import { ARTICLES, articleOf, articleSummary, documentKey, emptyPolicy, setIn } from "./policyModel";

export type BookScope = { readonly kind: "project" } | { readonly kind: "key"; readonly key: ApiKeySummary };

function scopeId(scope: BookScope): string {
  return scope.kind === "project" ? "project" : scope.key.id;
}

export interface RuleBookEditorProps {
  readonly scope: BookScope;
  readonly apiKey: string;
  /** Agent keys read rule books but never write them. */
  readonly canWrite: boolean;
  readonly contracts: readonly ContractView[] | null;
  readonly projectKeys: readonly { readonly id: string; readonly name: string }[];
  readonly now: number;
  /** The draft, for the inspection desk's "use the draft" switch (null when it equals the book in force). */
  readonly onDraft: (draft: PolicyDocument | null) => void;
  readonly onSaved: (message: string) => void;
}

/** "Draft: 1 clause tightens (in force on save) and 2 loosen (in force after 1 hour)." */
function draftSummary(tightened: number, loosened: number, delayText: string): string {
  const parts: string[] = [];
  if (tightened > 0) parts.push(`${tightened} ${tightened === 1 ? "clause tightens" : "clauses tighten"} (in force on save)`);
  if (loosened > 0) parts.push(`${loosened} ${loosened === 1 ? (tightened > 0 ? "loosens" : "clause loosens") : tightened > 0 ? "loosen" : "clauses loosen"} (in force ${delayText})`);
  if (parts.length === 0) return "Draft: the change neither tightens nor loosens a clause (in force on save).";
  return `Draft: ${parts.join(" and ")}.`;
}

const NOT_COMPARED: PolicyComparison = { tightened: [], loosened: [] };

function matchesPath(path: string, field: string): boolean {
  return path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`);
}

/** The rule book of one key (or the project) as a printed booklet with 13 articles; edits are a draft until saved. */
export function RuleBookEditor({ scope, apiKey, canWrite, contracts, projectKeys, now, onDraft, onSaved }: RuleBookEditorProps) {
  const id = scopeId(scope);
  const defaults: PolicyDefaults = scope.kind === "key" && scope.key.kind === "agent" ? "agent" : "project";
  const book = useApiResource<PolicyReadResponse>(`policy:${id}`, (_client, signal) =>
    scope.kind === "project" ? keyedClient(apiKey).policies.project.get({ signal: sdkSignal(signal) }) : keyedClient(apiKey).policies.get(id, { signal: sdkSignal(signal) }),
  );
  const spend = useApiResource<PolicySpendReport>(`spend:${id}`, (_client, signal) =>
    keyedClient(apiKey).policies.spend(scope.kind === "key" ? id : undefined, { signal: sdkSignal(signal) }),
  );
  const head = book.data?.policy ?? null;
  const active: PolicyDocument | null = head && head.status !== "none" ? head.document : null;
  const [draft, setDraft] = useState<PolicyDocument>(() => active ?? emptyPolicy());
  const [loadedHash, setLoadedHash] = useState<string | null>(null);
  const [view, setView] = useState<"articles" | "json">("articles");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<PolicyWriteResponse | null>(null);
  const [openArticles, setOpenArticles] = useState<ReadonlySet<number>>(() => new Set([1]));
  const save = useApiAction((_client, signal, document: PolicyDocument, ifMatch: string) =>
    scope.kind === "project"
      ? keyedClient(apiKey).policies.project.put(document, { ifMatch, signal: sdkSignal(signal) })
      : keyedClient(apiKey).policies.put(id, document, { ifMatch, signal: sdkSignal(signal) }),
  );
  const remove = useApiAction((_client, signal, ifMatch: string) =>
    scope.kind === "project" ? keyedClient(apiKey).policies.project.delete({ ifMatch, signal: sdkSignal(signal) }) : keyedClient(apiKey).policies.delete(id, { ifMatch, signal: sdkSignal(signal) }),
  );
  const cancel = useApiAction((_client, signal) =>
    scope.kind === "project" ? keyedClient(apiKey).policies.project.cancelPending({ signal: sdkSignal(signal) }) : keyedClient(apiKey).policies.cancelPending(id, { signal: sdkSignal(signal) }),
  );

  // A freshly loaded edition (or a new or cancelled pending amendment) replaces the draft:
  // after a save, a reload or switching keys the draft starts again from the edition in force.
  const headHash = head && head.status !== "none" ? head.hash : "none";
  const loadedKey = `${id}:${headHash}:${head?.pending ? `${head.pending.version}` : "-"}`;
  if (book.data && loadedHash !== loadedKey) {
    setLoadedHash(loadedKey);
    setDraft(active ?? emptyPolicy());
    setJsonText(JSON.stringify(active ?? emptyPolicy(), null, 2));
    setJsonError(null);
  }

  const dirty = documentKey(draft) !== documentKey(active ?? emptyPolicy());
  const validation = useMemo(() => validatePolicy(draft, { defaults }), [draft, defaults]);
  // comparePolicies reads amounts and windows, so it only runs on a draft that validates.
  const comparison = useMemo<PolicyComparison>(() => (validation.ok ? comparePolicies(active, validation.value, { defaults }) : NOT_COMPARED), [active, validation, defaults]);
  // The inspection desk may run the draft, but only one the API would accept.
  const deskDraft = dirty && validation.ok ? validation.value : null;
  useEffect(() => {
    onDraft(deskDraft);
  }, [deskDraft, onDraft]);
  const delaySeconds = active?.amendments?.delaySeconds ?? 0;
  const delayText = delaySeconds > 0 ? `after ${durationText(delaySeconds)}` : "on save (no delay in force)";
  const loosens = comparison.loosened.length > 0;

  const ctx: ArticleContext = {
    defaults,
    isProject: scope.kind === "project",
    keyExpiresAt: scope.kind === "key" ? scope.key.expiresAt : null,
    contracts,
    projectKeys,
    spend: spend.data?.scopes.find((entry) => (scope.kind === "project" ? entry.kind === "project" : entry.scope === id)) ?? null,
    now,
    issuesFor: (field) => validation.issues.filter((issue) => matchesPath(issue.path, field)).map((issue) => issue.message),
    warningsFor: (field) => validation.warnings.filter((warning) => matchesPath(warning.path, field)).map((warning) => warning.message),
    changeOf: (field) => (dirty ? (comparison.loosened.some((path) => matchesPath(path, field)) ? "loosened" : comparison.tightened.some((path) => matchesPath(path, field)) ? "tightened" : null) : null),
    delayText,
    disabled: !canWrite,
    isOpen: (article) => openArticles.has(article),
    toggle: (article) =>
      setOpenArticles((current) => {
        const next = new Set(current);
        if (next.has(article)) next.delete(article);
        else next.add(article);
        return next;
      }),
    summary: (article) => articleSummary(article, draft, defaults),
    marks: (article) => ({
      issues: validation.issues.filter((issue) => articleOf(issue.path) === article).length,
      changed: dirty && [...comparison.tightened, ...comparison.loosened].some((path) => articleOf(path) === article),
    }),
  };
  const set = (path: readonly string[], value: unknown) => {
    setResult(null);
    setDraft((current) => setIn(current, path, value));
  };

  const openJson = () => {
    setJsonText(JSON.stringify(draft, null, 2));
    setJsonError(null);
    setView("json");
  };
  const doSave = async () => {
    if (!validation.ok) return;
    const written = await save.run(validation.value, head && head.status !== "none" && head.hash ? head.hash : "none");
    if (written) {
      setResult(written);
      onSaved(written.applied === "now" ? `Edition ${written.policy.version} is in force.` : `Edition ${written.policy.version} waits until ${formatWhen(written.policy.activatesAt)}.`);
      book.reload();
    }
  };
  const doRemove = async () => {
    const written = await remove.run(head && head.status !== "none" && head.hash ? head.hash : "none");
    if (written) {
      setConfirmRemove(false);
      setResult(written);
      onSaved(written.applied === "now" ? "The rule book was removed." : `The removal waits until ${formatWhen(written.policy.activatesAt)}.`);
      book.reload();
    }
  };
  const doCancel = async () => {
    const done = await cancel.run();
    if (done) {
      setResult(null);
      onSaved("The pending amendment was cancelled.");
      book.reload();
    }
  };

  if (book.status === "loading" && !book.data) {
    return (
      <SkeletonGroup label="Loading the rule book" className="flex flex-col gap-3">
        <Skeleton surface="card" className="h-32" />
        <Skeleton surface="card" className="h-48" />
      </SkeletonGroup>
    );
  }
  if (book.status === "error" && book.error) return <ApiErrorPanel error={book.error} title="Could not read the rule book" onRetry={book.reload} />;

  const keyName = scope.kind === "project" ? "The project" : scope.key.name;
  const failure = save.status === "error" ? save.error : remove.status === "error" ? remove.error : cancel.status === "error" ? cancel.error : null;
  const issueArticles = [...new Set(validation.issues.map((issue) => articleOf(issue.path)))].filter((n) => n > 0).sort((a, b) => a - b);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="kl-rb-cover flex min-w-0 flex-col gap-3 py-5 pl-9 pr-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className={cx(LABEL, "flex items-center gap-2")}>
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Rule book · {defaults === "agent" ? "agent key" : scope.kind === "project" ? "project" : "project key"}
          </p>
          <h4 className="mt-2 break-words font-display text-3xl font-bold tracking-[-0.03em]">{keyName}</h4>
          <p className="mt-1 text-sm font-semibold">
            {head && head.status !== "none" ? `Edition ${head.version}${active?.label ? ` · ${active.label}` : ""}` : "No rule book yet: nothing is restricted beyond the levels above."}
          </p>
          {head && head.status !== "none" && head.hash ? <p className="mt-1 break-all font-code text-[11px]">{head.hash}</p> : null}
          {head && head.status !== "none" && "createdAt" in head ? <p className="mt-1 text-xs">In force since {formatWhen(head.createdAt)}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant={view === "articles" ? "ink" : "secondary"} onClick={() => setView("articles")} aria-pressed={view === "articles"}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            Articles
          </Button>
          <Button
            size="sm"
            variant={view === "json" ? "ink" : "secondary"}
            aria-pressed={view === "json"}
            onClick={openJson}
          >
            <Braces className="h-3.5 w-3.5" aria-hidden="true" />
            JSON
          </Button>
        </div>
      </div>

      {!canWrite ? (
        <p className="border-l-[6px] border-[#0052FF] bg-[#EAF0FF] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#1A2841] dark:text-[#E2E8F0]">
          An agent key reads its rule book but never writes one. Load a project key (kl_dev_) to change it.
        </p>
      ) : null}

      {head && "pending" in head && head.pending ? <AmendmentNotice pending={head.pending} now={now} onCancel={canWrite ? () => void doCancel() : undefined} busy={cancel.status === "loading"} /> : null}

      {canWrite ? (
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <SelectField
            label="Start from a template"
            value=""
            containerClassName="max-w-sm"
            onChange={(event) => {
              const template = POLICY_TEMPLATES[event.target.value as PolicyTemplateId];
              if (template) {
                setResult(null);
                setDraft(template.document);
                setJsonText(JSON.stringify(template.document, null, 2));
              }
            }}
            options={[{ value: "", label: "Choose a template…" }, ...Object.values(POLICY_TEMPLATES).map((template) => ({ value: template.id, label: template.title }))]}
            hint="Replaces the draft; nothing is saved until you press Save."
          />
        </div>
      ) : null}

      {view === "articles" ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={cx(LABEL, TEXT_MUTED)}>13 articles · each tab says what it holds now</p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpenArticles(new Set(ARTICLES.map((article) => article.n)))}>
                Open all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpenArticles(new Set())}>
                Close all
              </Button>
            </div>
          </div>
          <LazyBoundary
            resetKey={documentKey(draft)}
            fallback={() => (
              <div role="alert" className="flex flex-col items-start gap-3 border-l-[6px] border-[#B91C1C] bg-[#FFF1F1] px-4 py-3 text-sm text-[#1A1A1A] dark:bg-[#2A1215] dark:text-[#FECACA]">
                <p>This draft has a shape the articles cannot show. Fix it in the JSON view (the issues are listed below), or discard the draft.</p>
                <Button size="sm" variant="secondary" onClick={() => openJson()}>
                  <Braces className="h-3.5 w-3.5" aria-hidden="true" />
                  Open the JSON view
                </Button>
              </div>
            )}
          >
            <RuleBookArticles draft={draft} set={set} ctx={ctx} />
          </LazyBoundary>
        </div>
      ) : (
        <TextAreaField
          label="Rule book document (kletia.policy/v1)"
          mono
          rows={18}
          value={jsonText}
          readOnly={!canWrite}
          onChange={(event) => {
            setJsonText(event.target.value);
            try {
              const parsed: unknown = JSON.parse(event.target.value);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                setJsonError("A rule book is a JSON object: the draft keeps the last object.");
                return;
              }
              setResult(null);
              setDraft(parsed as PolicyDocument);
              setJsonError(null);
            } catch {
              setJsonError("Not valid JSON yet: the draft keeps the last valid version.");
            }
          }}
          error={jsonError ?? undefined}
          spellCheck={false}
        />
      )}

      <footer className={cx("z-10 flex min-w-0 flex-col gap-3 bg-white p-4 shadow-[4px_4px_0_#1A1A1A] dark:bg-[#131E32] dark:shadow-[4px_4px_0_#475569]", dirty && "sticky bottom-3", INK_BORDER_THIN, "border-[3px]")}>
        <div aria-live="polite" className="flex min-w-0 flex-col gap-2">
          {result ? (
            <p className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">
              {result.applied === "now" ? `Saved: edition ${result.policy.version} is in force now.` : `Saved: edition ${result.policy.version} loosens ${result.loosened.join(", ")} and is in force ${formatWhen(result.policy.activatesAt)}.`}
              {result.supersededPending ? ` It replaced the pending edition ${result.supersededPending.version}.` : ""}
            </p>
          ) : !dirty ? (
            <p className={cx("text-sm", TEXT_MUTED)}>No changes. Edit a clause to start a draft.</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <p className="font-bold">
                {validation.ok
                  ? draftSummary(comparison.tightened.length, comparison.loosened.length, delayText)
                  : `Draft: ${validation.issues.length} ${validation.issues.length === 1 ? "issue" : "issues"} to fix before it can be compared and saved.`}
              </p>
              {loosens ? (
                <p className={TEXT_MUTED}>
                  Loosened: <span className="font-code text-[12px]">{comparison.loosened.join(", ")}</span>. Saving posts a notice your webhooks receive
                  (policy.amendment_pending); it can be cancelled until then.
                </p>
              ) : null}
            </div>
          )}
          {!validation.ok && issueArticles.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              onClick={() => {
                setView("articles");
                setOpenArticles((current) => new Set([...current, ...issueArticles]));
                window.requestAnimationFrame(() => document.getElementById(`rb-article-${issueArticles[0]}`)?.scrollIntoView({ block: "start" }));
              }}
            >
              Show the issues
            </Button>
          ) : null}
          {!validation.ok ? (
            <p className="text-sm font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
              {validation.issues.length} {validation.issues.length === 1 ? "issue" : "issues"} to fix
              {issueArticles.length > 0 ? ` in article ${issueArticles.join(", ")}` : ""}
              {validation.issues.some((issue) => articleOf(issue.path) === 0) ? `: ${validation.issues.filter((issue) => articleOf(issue.path) === 0).map((issue) => issue.message).join(" ")}` : "."}
            </p>
          ) : null}
          {failure ? (
            <ApiErrorPanel
              error={failure}
              title={failure.code === "POLICY_CONFLICT" ? "Someone changed this rule book meanwhile" : "The rule book was not saved"}
              message={failure.code === "POLICY_CONFLICT" ? "Another write landed since this edition loaded. Reload it, then make your change again." : undefined}
            />
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Button loading={save.status === "loading"} disabled={!dirty || !validation.ok} onClick={() => void doSave()}>
              <Save className="h-4 w-4" aria-hidden="true" />
              {loosens ? "Save and post the notice" : "Save"}
            </Button>
            <Button
              variant="secondary"
              disabled={!dirty}
              onClick={() => {
                setDraft(active ?? emptyPolicy());
                setJsonText(JSON.stringify(active ?? emptyPolicy(), null, 2));
                setResult(null);
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Discard draft
            </Button>
            {failure?.code === "POLICY_CONFLICT" ? (
              <Button variant="ghost" onClick={book.reload}>
                Reload the rule book
              </Button>
            ) : null}
            {active && !confirmRemove ? (
              <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
        {confirmRemove ? (
          <div className="flex flex-col gap-2 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-sm text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
            <p className="font-bold">
              Remove {keyName}&apos;s rule book? Removal loosens every clause, so it waits {delaySeconds > 0 ? durationText(delaySeconds) : "no time (no delay in force)"}.
              {defaults === "agent" ? " The agent falls back to the safe agent defaults, not to nothing." : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void doRemove()}>
                Remove the rule book
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
      </footer>
    </div>
  );
}
