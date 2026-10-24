/**
 * A question typed in the composer about the person's own data ("how much did
 * I spend on fees last month?") or a portfolio request ("rebalance my
 * portfolio to 60/40 ETH/USDC"), answered in the thread by the assistant
 * (POST /v1/assistant/ask) from the signed-in wallet's data: the answer, the
 * facts it used with their sources, a small table or chart, "Ask a
 * follow-up", and for a request the sentences it computed, each planned as a
 * new task through the normal review, confirm and sign flow. Nothing here
 * plans or signs; the answer is never stored.
 */
import React, { Suspense, useEffect, useRef, useState } from "react";
import type { AssistantAnswer } from "@kletia/core";

import { useAccountSession } from "../../pages/developers/keys/accountSession";
import { isPlatformError } from "../../pages/developers/keys/accountClient";
import { formatUtcMinutes } from "../../site/format/utcTime";
import { Button } from "../../site/ui/Button";
import { cx, LABEL } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_PANEL } from "../shell/viewStyles";
import { getDeskStore, type TaskRecord } from "../state/deskStore";
import { PlanningSkeleton } from "../tasks/PlanningSkeleton";
import { TaskTicket } from "../tasks/TaskTicket";
import { assistantApi } from "./assistantClient";
import { barRows, readConsent, rememberConsent, shortAddress, sourceName } from "./assistantModel";

const AccountSignIn = React.lazy(() => import("../../pages/developers/keys/AccountSignIn"));

const copy = DESK_COPY.assistant;
const CHIP = "inline-flex min-h-11 items-center border-2 border-control bg-surface px-3 text-left text-sm font-bold text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "done"; readonly answer: AssistantAnswer };

function failureText(failure: unknown): string {
  return isPlatformError(failure) && failure.status > 0 && failure.status < 500 ? failure.message : copy.failed;
}

function Facts({ answer }: { readonly answer: AssistantAnswer }) {
  if (answer.facts.length === 0) return null;
  return (
    <section aria-label={copy.factsTitle} className="flex flex-col gap-2">
      <p className={LABEL}>{copy.factsTitle}</p>
      <dl className="m-0 grid gap-2 sm:grid-cols-2">
        {answer.facts.slice(0, 12).map((fact) => (
          <div key={fact.id} className="min-w-0 border-2 border-control bg-surface-2 px-3 py-2">
            <dt className="break-words text-xs font-semibold text-muted">{fact.label}</dt>
            <dd className="m-0 break-words font-code text-base font-bold">{fact.value}</dd>
            <dd className="m-0 text-xs text-muted">{copy.source(sourceName(fact.source), fact.asOf ? (formatUtcMinutes(fact.asOf) ?? "") : "")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Chart({ answer }: { readonly answer: AssistantAnswer }) {
  if (!answer.chart || answer.chart.points.length < 2) return null;
  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className={LABEL}>{answer.chart.label}</figcaption>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {barRows(answer.chart).map((row) => (
          <li key={row.label} className="grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="truncate font-semibold">{row.label}</span>
            <span className="h-3 bg-surface-2" aria-hidden="true">
              <span className={cx("block h-3", row.negative ? "bg-[var(--kl-danger)]" : "bg-[var(--kl-info)]")} style={{ width: `${row.width}%` }} />
            </span>
            <span className="font-code">{row.text}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Table({ answer }: { readonly answer: AssistantAnswer }) {
  const table = answer.table;
  if (!table || table.rows.length === 0 || (answer.chart && answer.chart.points.length >= 2)) return null;
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key} scope="col" className={cx("border-b-2 border-control px-2 py-1 text-xs font-black uppercase tracking-wider", column.numeric ? "text-right" : "text-left")}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index} className="border-b border-control">
              {table.columns.map((column) => (
                <td key={column.key} className={cx("px-2 py-1 align-top", column.numeric ? "text-right font-code" : "break-words")}>
                  {row[column.key] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Answer({ answer, onModel, modelNote }: { readonly answer: AssistantAnswer; readonly onModel: () => void; readonly modelNote: string | null }) {
  const actions = useDeskActions();
  const wallet = answer.wallets[0];
  const plan = (sentence: string) => {
    const store = getDeskStore().getState();
    store.addTask({ sentence, departure: store.departure });
  };
  return (
    <section aria-label={copy.heading} className={VIEW_PANEL}>
      <p className={LABEL}>{copy.heading}</p>
      <p className="text-base font-semibold" aria-live="polite">
        {answer.text}
      </p>
      {answer.wording === "model" ? <p className="text-xs text-muted">{copy.worded}</p> : null}
      {answer.status === "partial" ? <ViewNote tone="warning">{copy.partial}</ViewNote> : null}
      {answer.status === "unknown" ? <ViewNote>{copy.unknown}</ViewNote> : null}
      {answer.status === "needs-model" ? (
        <ViewNote tone="info">
          <p>{modelNote ?? copy.modelOff}</p>
          {modelNote ? null : (
            <Button size="sm" variant="secondary" className="mt-2" onClick={onModel}>
              {copy.modelOn}
            </Button>
          )}
        </ViewNote>
      ) : null}
      {answer.action && answer.action.sentences.length > 0 ? (
        <section aria-labelledby={`assistant-action-${answer.asOf}`} className="flex flex-col gap-2 border-t-2 border-control pt-3">
          <h3 id={`assistant-action-${answer.asOf}`} className={PANEL_TITLE}>
            {copy.actionTitle}
          </h3>
          <p className="text-sm">{copy.actionLead}</p>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {answer.action.sentences.map((sentence) => (
              <li key={sentence} className="flex flex-wrap items-center justify-between gap-2 border-2 border-control bg-surface-2 px-3 py-2">
                <span className="min-w-0 break-words font-code text-sm">{sentence}</span>
                <span className="flex flex-wrap gap-2">
                  <Button size="sm" aria-label={copy.planLabel(sentence)} onClick={() => plan(sentence)}>
                    {copy.plan}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={copy.editLabel(sentence)} onClick={() => actions.fill(sentence)}>
                    {copy.edit}
                  </Button>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <Chart answer={answer} />
      <Table answer={answer} />
      <Facts answer={answer} />
      {answer.assumptions.length > 0 ? (
        <p className="text-sm">
          <span className="font-bold">{copy.assumptions}: </span>
          {answer.assumptions.join(" ")}
        </p>
      ) : null}
      {answer.gaps.length > 0 ? (
        <div className="text-sm">
          <p className="font-bold">{copy.gaps}</p>
          <ul className="m-0 list-disc pl-5">
            {answer.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {answer.followUps.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className={LABEL}>{copy.followUps}</p>
          <div className="flex flex-wrap gap-2">
            {answer.followUps.map((question) => (
              <button key={question} type="button" className={CHIP} aria-label={copy.followUpLabel(question)} onClick={() => actions.fill(question)}>
                {question}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {wallet ? <p className="text-xs text-muted">{copy.covers(wallet.label, shortAddress(wallet.address))}</p> : null}
    </section>
  );
}

export function AssistantTaskBody({ task }: { readonly task: TaskRecord }) {
  const session = useAccountSession();
  const actions = useDeskActions();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [modelNote, setModelNote] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const token = session?.token ?? null;

  /** One ask; the result lands in the view and the task (never after unmount). */
  const request = (consent: string | null) => {
    if (!token) return;
    void assistantApi.ask(token, task.sentence, consent).then(
      (answer) => {
        if (!aliveRef.current) return;
        setLoad(answer ? { kind: "done", answer } : { kind: "failed", message: copy.failed });
        getDeskStore().getState().patchTask(task.id, { status: answer ? "completed" : "failed" });
      },
      (failure: unknown) => {
        if (!aliveRef.current) return;
        setLoad({ kind: "failed", message: failureText(failure) });
        getDeskStore().getState().patchTask(task.id, { status: "failed" });
      },
    );
  };

  const run = (consent: string | null) => {
    setLoad({ kind: "loading" });
    getDeskStore().getState().patchTask(task.id, { status: "planning" });
    request(consent);
  };

  // One read per task and signed-in wallet (a restored task has no answer to show).
  useEffect(() => {
    aliveRef.current = true;
    if (task.sentence && !task.restored && session) request(readConsent(session.address));
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per task and session
  }, [token]);

  const turnOnModel = () => {
    if (!token || !session) return;
    void assistantApi.consent(token).then(
      (consent) => {
        rememberConsent(session.address, consent.token, consent.expiresAt);
        run(consent.token);
      },
      (failure: unknown) => setModelNote(isPlatformError(failure) && failure.code === "ASSISTANT_MODEL_NOT_CONFIGURED" ? copy.modelUnavailable : failureText(failure)),
    );
  };

  let body: React.ReactNode;
  if (task.restored || !task.sentence) {
    body = <p className="text-sm font-semibold text-muted">{copy.sentenceForgotten}</p>;
  } else if (!session) {
    body = (
      <div className={VIEW_PANEL}>
        <p className="text-sm">{copy.signIn}</p>
        <Suspense fallback={<ViewLoading>{copy.loadingWallets}</ViewLoading>}>
          <AccountSignIn onCancel={() => actions.openView("desk")} />
        </Suspense>
      </div>
    );
  } else if (load.kind === "loading") {
    body = <PlanningSkeleton label={copy.loading} />;
  } else if (load.kind === "failed") {
    body = (
      <ViewNote role="alert" tone="danger">
        <p>{load.message}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => run(readConsent(session.address))}>
          {copy.retry}
        </Button>
      </ViewNote>
    );
  } else {
    body = <Answer answer={load.answer} onModel={turnOnModel} modelNote={modelNote} />;
  }

  return (
    <>
      <TaskTicket task={task} ends={null} departureLine={null} />
      {body}
    </>
  );
}
