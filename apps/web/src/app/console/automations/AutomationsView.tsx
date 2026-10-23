/**
 * Automations (/app/automations): the inbox of fired runs waiting for the
 * wallet's signature (each opens the normal review-and-sign flow as a desk
 * task), the wallet's automations with next and last run, pause, resume and
 * delete, and new automations from templates. Signs in with the same wallet
 * session as developer accounts; nothing here signs a transaction.
 */
import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Pause, Play, Plus, Trash2, Wallet } from "lucide-react";
import type { AutomationView, IntentHandoff, ValidatedAutomationDraft } from "@kletia/core";

import { useAccountSession } from "../../pages/developers/keys/accountSession";
import { isPlatformError } from "../../pages/developers/keys/accountClient";
import { Button } from "../../site/ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { useDeskActions } from "../shell/deskContext";
import { getDeskStore } from "../state/deskStore";
import { automationPrefill } from "../handoff/handoffModel";
import { HandoffNote } from "../handoff/HandoffNote";
import { useHandoff } from "../handoff/useHandoff";
import { automationApi } from "./automationClient";
import {
  AUTOMATION_COPY as copy,
  AUTOMATION_TEMPLATES,
  automationRow,
  draftFromTemplate,
  inboxTaskTitle,
  newInboxRuns,
  TEMPLATE_FIELD_LABELS,
  type AutomationTemplateId,
  type InboxRun,
} from "./automationModel";

const AccountSignIn = React.lazy(() => import("../../pages/developers/keys/AccountSignIn"));

const POLL_MS = 60_000;
const PANEL = cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, HARD_SHADOW, SURFACE);
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const failureText = (failure: unknown) => (isPlatformError(failure) ? failure.message : "Something went wrong. Try again.");

function notificationsAvailable(): boolean {
  return typeof Notification !== "undefined";
}

export default function AutomationsView() {
  const session = useAccountSession();
  const actions = useDeskActions();
  const [automations, setAutomations] = useState<readonly AutomationView[]>([]);
  const [inbox, setInbox] = useState<readonly InboxRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notify, setNotify] = useState(() => notificationsAvailable() && Notification.permission === "granted");
  const seenRef = useRef<Set<string> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const token = session?.token ?? null;
  // A sentence read as an automation: its draft waits here until the person creates it (or dismisses it).
  const [sentence, setSentence] = useState<{ readonly summary: string; readonly draft: ValidatedAutomationDraft } | null>(null);
  useHandoff("automations", useCallback((handoff: IntentHandoff) => {
    if (handoff.surface === "automations") setSentence({ summary: handoff.summary, draft: automationPrefill(handoff.input) });
  }, []));

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!token) return;
      try {
        const [list, runs] = await Promise.all([automationApi.list(token, signal), automationApi.inbox(token, signal)]);
        setAutomations(list);
        setInbox(runs);
        setNow(Date.now());
        if (notify) {
          for (const run of newInboxRuns(seenRef.current, runs)) new Notification(copy.notifyTitle, { body: inboxTaskTitle(run), tag: run.id });
        }
        seenRef.current = new Set(runs.map((run) => run.id));
        setError(null);
      } catch (failure) {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setError(failureText(failure));
      }
    },
    [notify, token],
  );

  useEffect(() => {
    const controller = new AbortController();
    // The first read right after mount, then every minute while the view is open.
    const first = window.setTimeout(() => void refresh(controller.signal), 0);
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = async (id: string, task: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await task();
      await refresh();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy(null);
    }
  };

  const openRun = (run: InboxRun) => {
    if (!run.intentId) return;
    getDeskStore().getState().adoptIntent({ intentId: run.intentId, title: inboxTaskTitle(run) });
    actions.openView("desk");
  };

  const enableNotifications = async () => {
    if (!notificationsAvailable()) return;
    setNotify((await Notification.requestPermission()) === "granted");
  };

  return (
    <section aria-labelledby="desk-automations-heading" className="flex flex-col gap-5 pb-8">
      <h2 id="desk-automations-heading" className="font-display text-2xl font-bold">
        {copy.title}
      </h2>
      <p className="border-l-4 border-[var(--kl-line)] pl-3 text-sm font-semibold">{copy.signatureNote}</p>
      <HandoffNote text={sentence ? `${sentence.summary}. ${session ? "Create it below to start it." : "Sign in to create it."}` : null} />
      {error ? (
        <p role="alert" className="border-l-4 border-[var(--kl-danger)] bg-[var(--kl-danger-bg)] px-3 py-2 text-sm font-bold text-[var(--kl-danger)]">
          {error}
        </p>
      ) : null}
      {!session ? (
        <div className={PANEL}>
          <p className="text-sm">{copy.signIn}</p>
          <Suspense fallback={<p className={cx("text-sm", TEXT_MUTED)}>Loading wallets…</p>}>
            <AccountSignIn onCancel={() => actions.openView("desk")} />
          </Suspense>
        </div>
      ) : (
        <>
          <section aria-labelledby="automation-inbox" className={PANEL}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="automation-inbox" className="font-display text-lg font-bold">
                {copy.inbox} ({inbox.length})
              </h3>
              {notificationsAvailable() && !notify ? (
                <Button size="sm" variant="ghost" onClick={() => void enableNotifications()}>
                  <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                  {copy.notify}
                </Button>
              ) : null}
              {notify ? <p className={cx("text-xs", TEXT_MUTED)}>{copy.notifyOn}</p> : null}
            </div>
            {inbox.length === 0 ? <p className={cx("text-sm", TEXT_MUTED)}>{copy.inboxEmpty}</p> : null}
            <ul className="flex flex-col gap-2">
              {inbox.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-[var(--kl-line)] pt-2">
                  <div className="min-w-0">
                    <p className="font-bold">{inboxTaskTitle(run)}</p>
                    <p className={cx("text-xs", TEXT_MUTED)}>
                      {run.automationLabel ?? ""} · {new Date(run.firedAt).toLocaleString()}
                      {run.notionalUsd ? ` · $${run.notionalUsd}` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="accent" onClick={() => openRun(run)}>
                    <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.review}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="automation-list" className={PANEL}>
            <h3 id="automation-list" className="font-display text-lg font-bold">
              {copy.list}
            </h3>
            {automations.length === 0 ? <p className={cx("text-sm", TEXT_MUTED)}>{copy.listEmpty}</p> : null}
            <ul className="flex flex-col gap-3">
              {automations.map((view) => {
                const row = automationRow(view, now);
                return (
                  <li key={row.id} className="flex flex-col gap-1 border-t-2 border-[var(--kl-line)] pt-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-bold">{row.title}</p>
                      <span className={cx(LABEL, "border-2 border-current px-1 text-xs")}>{row.status}</span>
                    </div>
                    <p className="text-sm">
                      {row.trigger}: {row.action}
                    </p>
                    <p className={cx("text-xs", TEXT_MUTED)}>
                      {[row.next, row.last, row.execution].filter(Boolean).join(" · ")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {row.canPause ? (
                        <Button size="sm" variant="secondary" loading={busy === row.id} disabled={busy !== null} onClick={() => void act(row.id, () => automationApi.pause(session.token, row.id))}>
                          <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                          {copy.pause}
                        </Button>
                      ) : null}
                      {row.canResume ? (
                        <Button size="sm" variant="secondary" loading={busy === row.id} disabled={busy !== null} onClick={() => void act(row.id, () => automationApi.resume(session.token, row.id))}>
                          <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          {copy.resume}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(row.id, () => automationApi.remove(session.token, row.id))}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {copy.remove}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          {sentence ? (
            <section aria-labelledby="automation-sentence" className={PANEL}>
              <h3 id="automation-sentence" className="font-display text-lg font-bold">{sentence.summary}</h3>
              <p className={cx("text-sm", TEXT_MUTED)}>Each run waits in the inbox for your signature.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  loading={busy === "create"}
                  onClick={() => void act("create", async () => {
                    await automationApi.create(session.token, sentence.draft);
                    setSentence(null);
                  })}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {copy.create}
                </Button>
                <Button variant="ghost" onClick={() => setSentence(null)}>Dismiss</Button>
              </div>
            </section>
          ) : null}
          <TemplateForm
            busy={busy === "create"}
            onCreate={(id, values) => {
              const draft = draftFromTemplate(id, values, { now: Date.now(), wallet: session, timezone: browserZone() });
              if (!draft.ok) {
                setError(draft.issues.map((issue) => issue.message).join(" "));
                return;
              }
              void act("create", () => automationApi.create(session.token, draft.draft));
            }}
          />
        </>
      )}
    </section>
  );
}

function TemplateForm({ busy, onCreate }: { readonly busy: boolean; readonly onCreate: (id: AutomationTemplateId, values: Readonly<Record<string, string>>) => void }) {
  const [templateId, setTemplateId] = useState<AutomationTemplateId>("dca");
  const template = AUTOMATION_TEMPLATES.find((entry) => entry.id === templateId) ?? AUTOMATION_TEMPLATES[0]!;
  const [values, setValues] = useState<Readonly<Record<string, string>>>(template.defaults);

  return (
    <section aria-labelledby="automation-create" className={PANEL}>
      <h3 id="automation-create" className="font-display text-lg font-bold">
        {copy.create}
      </h3>
      <fieldset className="flex flex-wrap gap-2">
        <legend className={cx(LABEL, "mb-2 text-xs")}>{copy.templates}</legend>
        {AUTOMATION_TEMPLATES.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={entry.id === templateId ? "accent" : "secondary"}
            aria-pressed={entry.id === templateId}
            onClick={() => {
              setTemplateId(entry.id);
              setValues(entry.defaults);
            }}
          >
            {entry.title}
          </Button>
        ))}
      </fieldset>
      <p className={cx("text-sm", TEXT_MUTED)}>{template.blurb}</p>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(templateId, values);
        }}
      >
        {Object.keys(template.defaults).map((field) => (
          <label key={field} className="flex min-w-0 flex-col gap-1 text-sm font-semibold">
            {TEMPLATE_FIELD_LABELS[field] ?? field}
            <input
              className={cx("min-h-11 px-2 font-code", INK_BORDER, SURFACE)}
              value={values[field] ?? ""}
              onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            />
          </label>
        ))}
        <div className="sm:col-span-2">
          <Button type="submit" loading={busy}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.create}
          </Button>
        </div>
      </form>
    </section>
  );
}
