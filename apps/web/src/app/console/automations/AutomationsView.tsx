/**
 * Automations (/app/automations): the inbox of fired runs waiting for the
 * wallet's signature (each opens the normal review-and-sign flow as a desk
 * task), the wallet's automations with next and last run, pause, resume and
 * delete, and new automations from templates. Signs in with the same wallet
 * session as developer accounts; nothing here signs a transaction. In the Card machine each
 * automation is a printed rule card with a schedule dial (how far the current period has run),
 * the templates are blank cards to start from.
 */
import "./automations.css";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Pause, Play, Plus, Trash2, Wallet } from "lucide-react";
import type { AutomationView, IntentHandoff, ValidatedAutomationDraft } from "@kletia/core";

import { useAccountSession } from "../../pages/developers/keys/accountSession";
import { isPlatformError } from "../../pages/developers/keys/accountClient";
import { ScheduleDial } from "../../kit";
import { Button } from "../../site/ui/Button";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_LABEL, VIEW_PANEL } from "../shell/viewStyles";
import { shortSerial } from "../shell/machine/machineModel";
import { getDeskStore } from "../state/deskStore";
import { automationPrefill } from "../handoff/handoffModel";
import { HandoffNote } from "../handoff/HandoffNote";
import { useHandoff } from "../handoff/useHandoff";
import { automationApi } from "./automationClient";
import {
  AUTOMATION_COPY as copy,
  AUTOMATION_TEMPLATES,
  automationRow,
  dialCaption,
  draftFromTemplate,
  inboxTaskTitle,
  newInboxRuns,
  scheduleFraction,
  TEMPLATE_FIELD_LABELS,
  type AutomationTemplateId,
  type InboxRun,
} from "./automationModel";

const AccountSignIn = React.lazy(() => import("../../pages/developers/keys/AccountSignIn"));

const POLL_MS = 60_000;
const PANEL = VIEW_PANEL;
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
    <section aria-labelledby="desk-automations-heading" className="kau">
      <ViewHeader id="desk-automations-heading" title={copy.title} intro={copy.signatureNote} />
      <HandoffNote text={sentence ? `${sentence.summary}. ${session ? "Create it below to start it." : "Sign in to create it."}` : null} />
      {error ? (
        <ViewNote role="alert" tone="danger">
          {error}
        </ViewNote>
      ) : null}
      {!session ? (
        <>
          <div className={PANEL}>
            <p className="kv-intro">{copy.signIn}</p>
            <Suspense fallback={<ViewLoading>{copy.loadingWallets}</ViewLoading>}>
              <AccountSignIn onCancel={() => actions.openView("desk")} />
            </Suspense>
          </div>
          <section aria-labelledby="automation-templates-preview" className="kv-sec">
            <div className="kv-sec-h">
              <h3 id="automation-templates-preview">{copy.templates}</h3>
              <p>{copy.signIn.split(".")[0]}.</p>
            </div>
            <ul className="kau-grid">
              {AUTOMATION_TEMPLATES.map((entry, index) => (
                <li key={entry.id} className="kau-card" data-blank="">
                  <div className="kau-band">
                    <span>{copy.templates}</span>
                    <span className="kau-serial">#{String(index + 1).padStart(4, "0")}</span>
                  </div>
                  <div className="kau-body">
                    <ScheduleDial fraction={null} label={entry.title} caption={entry.id === "dca" ? "1 week" : entry.id === "sweep-dust" || entry.id === "pay-monthly" ? "1 month" : entry.id === "price-exit" ? "price" : "rate"} />
                    <div className="kau-text">
                      <b>{entry.title}</b>
                      <p>{entry.blurb}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <>
          <section aria-labelledby="automation-inbox" className={PANEL}>
            <div className="kau-h">
              <h3 id="automation-inbox" className={PANEL_TITLE}>
                {copy.inbox} ({inbox.length})
              </h3>
              {notificationsAvailable() && !notify ? (
                <Button size="sm" variant="ghost" onClick={() => void enableNotifications()}>
                  <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                  {copy.notify}
                </Button>
              ) : null}
              {notify ? <p className="kv-muted kau-small">{copy.notifyOn}</p> : null}
            </div>
            {inbox.length === 0 ? <ViewEmpty>{copy.inboxEmpty}</ViewEmpty> : null}
            <ul className="kau-inbox">
              {inbox.map((run) => (
                <li key={run.id}>
                  <span className="kau-lamp" aria-hidden="true" />
                  <div className="kau-text">
                    <b>{inboxTaskTitle(run)}</b>
                    <p>
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
          <section aria-labelledby="automation-list" className="kv-sec">
            <div className="kv-sec-h">
              <h3 id="automation-list">{copy.list}</h3>
            </div>
            {automations.length === 0 ? <ViewEmpty>{copy.listEmpty}</ViewEmpty> : null}
            <ul className="kau-grid">
              {automations.map((view) => {
                const row = automationRow(view, now);
                const fraction = scheduleFraction(view, now);
                return (
                  <li key={row.id} className="kau-card" data-status={row.status}>
                    <div className="kau-band">
                      <span>{row.status}</span>
                      <span className="kau-serial">#{shortSerial(row.id)}</span>
                    </div>
                    <div className="kau-body">
                      <ScheduleDial fraction={fraction} label={row.next ?? row.trigger} caption={dialCaption(view.trigger)} />
                      <div className="kau-text">
                        <b>{row.title}</b>
                        <p>
                          {row.trigger}: {row.action}
                        </p>
                      </div>
                    </div>
                    <p className="kau-meta">{[row.next, row.last, row.execution].filter(Boolean).join(" · ")}</p>
                    <div className="kau-act">
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
              <h3 id="automation-sentence" className={PANEL_TITLE}>{sentence.summary}</h3>
              <p className="kv-muted kau-small">Each run waits in the inbox for your signature.</p>
              <div className="kau-act">
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
      <h3 id="automation-create" className={PANEL_TITLE}>
        {copy.create}
      </h3>
      <fieldset className="kau-templates">
        <legend className={VIEW_LABEL}>{copy.templates}</legend>
        {AUTOMATION_TEMPLATES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="k-opt"
            aria-pressed={entry.id === templateId}
            onClick={() => {
              setTemplateId(entry.id);
              setValues(entry.defaults);
            }}
          >
            <b>{entry.title}</b>
          </button>
        ))}
      </fieldset>
      <p className="kv-intro">{template.blurb}</p>
      <form
        className="kau-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(templateId, values);
        }}
      >
        {Object.keys(template.defaults).map((field) => (
          <label key={field} className="kv-field">
            <span className={VIEW_LABEL}>{TEMPLATE_FIELD_LABELS[field] ?? field}</span>
            <input
              className={`${VIEW_FIELD} kv-num`}
              value={values[field] ?? ""}
              onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            />
          </label>
        ))}
        <div className="kau-submit">
          <Button type="submit" loading={busy}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.create}
          </Button>
        </div>
      </form>
    </section>
  );
}
