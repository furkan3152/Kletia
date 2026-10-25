/**
 * A question typed in the composer about the person's own data ("how much did
 * I spend on fees last month?") or a portfolio request ("rebalance my
 * portfolio to 60/40 ETH/USDC"), answered in the thread by the assistant
 * (POST /v1/assistant/ask) from the signed-in wallet's data: the answer, the
 * facts it used with their sources, a small table or chart, "Ask a
 * follow-up", and for a request the sentences it computed, each planned as a
 * new task through the normal review, confirm and sign flow. A fact or row
 * about a transaction opens its row in History; a rate offers the same
 * "Move here" deposit sentence as the dashboard. Nothing here plans or
 * signs; the answer is never stored.
 */
import React, { Suspense, useEffect, useRef, useState } from "react";
import type { AssistantAnswer, AssistantLink } from "@kletia/core";

import { useAccountSession } from "../../pages/developers/keys/accountSession";
import { isPlatformError } from "../../pages/developers/keys/accountClient";
import { formatUtcMinutes } from "../../site/format/utcTime";
import { cx, LABEL } from "../../site/ui/styles";
import { Icon, Key } from "../../kit";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE } from "../shell/viewStyles";
import { getDeskStore, type TaskRecord } from "../state/deskStore";
import { KletiaTurn, Say, ThinkingBlock } from "../tasks/Conversation";
import { requestHistoryFocus } from "../history/historyModel";
import { assistantApi } from "./assistantClient";
import { barRows, readConsent, rememberConsent, shortAddress, sourceName } from "./assistantModel";

const AccountSignIn = React.lazy(() => import("../../pages/developers/keys/AccountSignIn"));

const copy = DESK_COPY.assistant;

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "done"; readonly answer: AssistantAnswer };

function failureText(failure: unknown): string {
  return isPlatformError(failure) && failure.status > 0 && failure.status < 500 ? failure.message : copy.failed;
}

const LINK_BUTTON = "k-linkbtn";

/** Where a fact or row leads: its transaction's History row, or a deposit sentence in the composer (the dashboard's "Move here"). */
function useFollowLink(): (link: AssistantLink) => void {
  const actions = useDeskActions();
  return (link) => {
    if (link.kind === "transaction") {
      requestHistoryFocus(link.id);
      actions.openView("history");
    } else {
      actions.fill(link.sentence);
    }
  };
}

function FactLink({ link, label }: { readonly link: AssistantLink; readonly label: string }) {
  const follow = useFollowLink();
  const transaction = link.kind === "transaction";
  return (
    <button type="button" className={LINK_BUTTON} aria-label={transaction ? copy.openInHistoryLabel(label) : copy.moveHereLabel(label.replace(/ \(supply APY\)$/u, ""))} onClick={() => follow(link)}>
      {transaction ? copy.openInHistory : copy.moveHere}
    </button>
  );
}

function Facts({ answer }: { readonly answer: AssistantAnswer }) {
  if (answer.facts.length === 0) return null;
  return (
    <section aria-label={copy.factsTitle} className="flex flex-col gap-2">
      <p className={LABEL}>{copy.factsTitle}</p>
      <dl className="m-0 grid gap-2 sm:grid-cols-2">
        {answer.facts.slice(0, 12).map((fact) => (
          <div key={fact.id} className="kd-fact">
            <dt className="break-words text-xs font-semibold text-muted">{fact.label}</dt>
            <dd className="m-0 break-words font-code text-base font-bold">{fact.value}</dd>
            <dd className="m-0 text-xs text-muted">{copy.source(sourceName(fact.source), fact.asOf ? (formatUtcMinutes(fact.asOf) ?? "") : "")}</dd>
            {fact.link ? <dd className="m-0"><FactLink link={fact.link} label={fact.label} /></dd> : null}
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
  const follow = useFollowLink();
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
            {table.links ? <th scope="col"><span className="sr-only">{copy.openRow}</span></th> : null}
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
              {table.links ? (
                <td className="px-2 py-1 align-top">
                  {table.links[index] ? (
                    <button type="button" className={LINK_BUTTON} aria-label={copy.openRowLabel(index + 1)} onClick={() => follow(table.links![index]!)}>
                      {copy.openRow}
                    </button>
                  ) : null}
                </td>
              ) : null}
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
    <section aria-label={copy.heading} className="kd-answer">
      <p className="kd-answer-h">{copy.heading}</p>
      <p className="kd-say" aria-live="polite">
        {answer.text}
      </p>
      {answer.wording === "model" ? <p className="text-xs text-muted">{copy.worded}</p> : null}
      {answer.status === "partial" ? <ViewNote tone="warning">{copy.partial}</ViewNote> : null}
      {answer.status === "unknown" ? <ViewNote>{copy.unknown}</ViewNote> : null}
      {answer.status === "needs-model" ? (
        <ViewNote tone="info">
          <p>{modelNote ?? copy.modelOff}</p>
          {modelNote ? null : (
            <Key size="sm" className="mt-2" onClick={onModel}>
              {copy.modelOn}
            </Key>
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
              <li key={sentence} className="kd-rate">
                <span className="min-w-0 break-words font-code text-sm">{sentence}</span>
                <span className="flex flex-wrap gap-2">
                  <Key size="sm" tone="lime" aria-label={copy.planLabel(sentence)} onClick={() => plan(sentence)}>
                    {copy.plan}
                  </Key>
                  <Key size="sm" tone="flat" aria-label={copy.editLabel(sentence)} onClick={() => actions.fill(sentence)}>
                    {copy.edit}
                  </Key>
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
              <Key key={question} size="sm" aria-label={copy.followUpLabel(question)} onClick={() => actions.fill(question)}>
                {question}
              </Key>
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
  const [startedAt, setStartedAt] = useState(() => Date.now());
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
    setStartedAt(Date.now());
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
    body = <Say muted>{copy.sentenceForgotten}</Say>;
  } else if (!session) {
    body = (
      <div className="kd-answer">
        <p className="kd-say">{copy.signIn}</p>
        <Suspense fallback={<ViewLoading>{copy.loadingWallets}</ViewLoading>}>
          <AccountSignIn onCancel={() => actions.openView("desk")} />
        </Suspense>
      </div>
    );
  } else if (load.kind === "loading") {
    body = <ThinkingBlock key={startedAt} startedAt={startedAt} result={null} steps={["Reading your question", "Reading your wallet's history", "Working out the answer"]} />;
  } else if (load.kind === "failed") {
    body = (
      <p role="alert" className="kd-alert">
        <Icon name="warn" />
        <span>{load.message}</span>
        <Key size="sm" onClick={() => run(readConsent(session.address))}>
          {copy.retry}
        </Key>
      </p>
    );
  } else {
    body = <Answer answer={load.answer} onModel={turnOnModel} modelNote={modelNote} />;
  }

  return <KletiaTurn at={task.createdAt}>{body}</KletiaTurn>;
}
