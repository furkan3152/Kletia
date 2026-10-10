import type { IntentRequest, PolicyDocument } from "@kletia/core";
import type { PolicyEvaluateResponse } from "@kletia/sdk";
import { Printer } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { lineFor } from "../../../site/art";
import { LineBullet } from "../../../site/art/LineBullet";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { anyAccount } from "../portal/accounts";
import { formatUsd, formatWhen, splitLines } from "../portal/portalFormat";
import { deskOutcome, ruleInfo, type DeskOutcome } from "./policyModel";
import { PolicyStamp } from "./PolicyStamp";

const OUTCOME_TEXT: Readonly<Record<DeskOutcome, string>> = {
  cleared: "Cleared: the rule books allow this request.",
  held: "Held for approval: it would plan, then wait for an approver.",
  refused: "Refused: a rule book does not allow this request.",
};

type Evaluation = PolicyEvaluateResponse["evaluation"];
type RuleRow = Evaluation["rules"][number];

function Mark({ status }: { readonly status: RuleRow["status"] }) {
  if (status === "pass") return <span className="kl-rb-mark kl-rb-mark--pass" aria-hidden="true" />;
  if (status === "trigger")
    return (
      <span className="kl-rb-mark kl-rb-mark--trigger" aria-hidden="true">
        !
      </span>
    );
  if (status === "warn") return <span className="kl-rb-mark kl-rb-mark--warn" aria-hidden="true" />;
  return <span className="kl-rb-mark kl-rb-mark--fail" aria-hidden="true" />;
}

const STATUS_WORD: Readonly<Record<RuleRow["status"], string>> = { pass: "Passed", fail: "Failed", trigger: "Asks for approval", warn: "Warning" };

export interface DeskKey {
  readonly id: string;
  readonly name: string;
}

export interface InspectionDeskProps {
  readonly apiKey: string;
  readonly keys: readonly DeskKey[];
  readonly keyId: string | null;
  /** The editor's unsaved draft of `keyId`'s rule book, if any. */
  readonly draft: PolicyDocument | null;
  readonly names: ReadonlyMap<string, string>;
}

/**
 * The simulator (`POST /v1/policy/evaluate`): a request printed as a ticket
 * and stamped CLEARED, HELD FOR APPROVAL or REFUSED, with every clause it
 * met punched (passed), stamped (asks for approval) or struck (failed).
 * Nothing is stored, reserved or held.
 */
export function InspectionDesk({ apiKey, keys, keyId, draft, names }: InspectionDeskProps) {
  const formId = useId();
  const [target, setTarget] = useState(keyId ?? keys[0]?.id ?? "");
  const [mode, setMode] = useState<"text" | "actions">("text");
  const [text, setText] = useState("bridge 250 USDC from base to arbitrum");
  const [actions, setActions] = useState('[\n  { "kind": "transfer", "network": "base", "from": "USDC", "amount": "300", "recipient": "eip155:8453:0x1111111111111111111111111111111111111111" }\n]');
  const [accounts, setAccounts] = useState("");
  const [at, setAt] = useState("");
  const [stage, setStage] = useState<"plan" | "prepare">("plan");
  const [useDraft, setUseDraft] = useState(true);
  const [touched, setTouched] = useState(false);
  const run = useApiAction((_client, signal, body: Parameters<ReturnType<typeof keyedClient>["policies"]["evaluate"]>[0]) =>
    keyedClient(apiKey).policies.evaluate(body, { signal: sdkSignal(signal) }),
  );
  // Follow the station selected on the key tree (the user can still pick another key here).
  const [seenKeyId, setSeenKeyId] = useState(keyId);
  if (keyId !== seenKeyId) {
    setSeenKeyId(keyId);
    if (keyId && keys.some((key) => key.id === keyId)) setTarget(keyId);
  }

  const accountLines = splitLines(accounts, { commas: true });
  const parsedAccounts = accountLines.map(anyAccount);
  const badAccount = accountLines.find((_, index) => parsedAccounts[index] === null);
  let actionList: unknown = null;
  let actionError: string | null = null;
  if (mode === "actions") {
    try {
      actionList = JSON.parse(actions);
      if (!Array.isArray(actionList)) actionError = "Structured actions are a JSON array.";
    } catch {
      actionError = "That is not valid JSON.";
    }
  }
  const draftApplies = Boolean(draft) && target === keyId;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!target || badAccount || accountLines.length === 0 || (mode === "actions" && actionError) || (mode === "text" && !text.trim())) return;
    const request = {
      ...(mode === "text" ? { text: text.trim() } : { actions: actionList }),
      accounts: parsedAccounts.filter(Boolean),
    } as unknown as IntentRequest;
    await run.run({
      keyId: target,
      request,
      stage,
      ...(at ? { at: new Date(at).toISOString() } : {}),
      ...(draftApplies && useDraft ? { policy: draft } : {}),
    });
  };

  const result = run.status === "success" ? run.data : undefined;
  const evaluation = result?.evaluation;
  const outcome = evaluation ? deskOutcome(evaluation.outcome) : null;
  const firstRule = evaluation?.violations[0]?.rule ?? evaluation?.triggers[0]?.rule;
  // The clause that decided it: the first failure, else the first approval trigger.
  const deciding = evaluation ? (evaluation.rules.find((row) => row.status === "fail") ?? evaluation.rules.find((row) => row.status === "trigger") ?? null) : null;
  const scopeName = (row: { scope: string; keyId?: string }) => (row.scope === "project" ? "Project" : row.keyId ? names.get(row.keyId) ?? row.keyId : "Key");

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] 2xl:items-start">
      <form id={formId} onSubmit={submit} noValidate className={cx("flex min-w-0 flex-col gap-4 bg-[#F1EFE8] p-4 dark:bg-[#0F1A2C] sm:p-5", INK_BORDER)}>
        <p className={cx(LABEL, "flex items-center gap-2")}>
          <Printer className="h-4 w-4" aria-hidden="true" />
          Ticket printer
        </p>
        <SelectField label="Check against the rule books of" value={target} onChange={(event) => setTarget(event.target.value)} options={keys.map((key) => ({ value: key.id, label: key.name }))} />
        <fieldset className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <legend className={cx(LABEL, "mb-1")}>Request</legend>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
            <input type="radio" name={`${formId}-mode`} className="accent-[#0052FF]" checked={mode === "text"} onChange={() => setMode("text")} />
            A sentence
          </label>
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
            <input type="radio" name={`${formId}-mode`} className="accent-[#0052FF]" checked={mode === "actions"} onChange={() => setMode("actions")} />
            Structured actions
          </label>
        </fieldset>
        {mode === "text" ? (
          <TextAreaField label="Intent" rows={2} value={text} onChange={(event) => setText(event.target.value)} error={touched && !text.trim() ? "Write the request." : undefined} />
        ) : (
          <TextAreaField label="Actions (JSON array)" mono rows={6} value={actions} onChange={(event) => setActions(event.target.value)} error={actionError ?? undefined} spellCheck={false} />
        )}
        <TextAreaField
          label="Accounts"
          mono
          rows={2}
          value={accounts}
          onChange={(event) => setAccounts(event.target.value)}
          placeholder={"eip155:8453:0x…\nsolana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:…"}
          hint="One CAIP-10 account per line (or base:0x…). Nothing is signed."
          error={touched && (badAccount ? `"${badAccount}" is not an account.` : accountLines.length === 0 ? "Add at least one account." : undefined)}
          spellCheck={false}
        />
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <TextField label="At (optional)" type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} hint="Moves the clock for the timetable only." />
          <SelectField
            label="Stage"
            value={stage}
            onChange={(event) => setStage(event.target.value as "plan" | "prepare")}
            options={[
              { value: "plan", label: "Plan" },
              { value: "prepare", label: "Prepare (schedule enforced)" },
            ]}
          />
        </div>
        {draftApplies ? (
          <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm font-bold">
            <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" checked={useDraft} onChange={(event) => setUseDraft(event.target.checked)} />
            Use my unsaved draft instead of the key&apos;s rule book
          </label>
        ) : null}
        <Button type="submit" loading={run.status === "loading"} className="self-start">
          <Printer className="h-4 w-4" aria-hidden="true" />
          Print and inspect
        </Button>
        <p className={cx("text-xs", TEXT_MUTED)}>30 evaluations per minute per key. Logged with stage evaluate; nothing is stored, reserved or held.</p>
      </form>

      <div aria-live="polite" className="min-w-0">
        {run.status === "error" && run.error ? <ApiErrorPanel error={run.error} title="The desk could not inspect this request" /> : null}
        {!evaluation ? (
          run.status === "loading" ? null : (
            <div className="flex min-h-48 items-center justify-center border-[3px] border-dashed border-[#1A1A1A]/30 p-6 text-center text-sm dark:border-white/15">
              <p className={TEXT_MUTED}>Print a request to see what the rule books say, clause by clause.</p>
            </div>
          )
        ) : (
          <article aria-label="Inspection result" className="flex min-w-0 flex-col gap-5">
            <div className="kl-rb-cover grid min-w-0 gap-4 py-5 pl-9 pr-5 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,11rem)] sm:items-center">
              <div className="min-w-0">
                <p className={LABEL}>Inspected for {names.get(evaluation.keyId) ?? evaluation.keyId}</p>
                <p className="mt-2 font-display text-xl font-bold leading-snug">{OUTCOME_TEXT[outcome!]}</p>
                {result?.intent ? (
                  <ol className="mt-3 flex flex-col gap-1.5">
                    {result.intent.steps.map((step) => {
                      const line = lineFor(step.network);
                      return (
                        <li key={step.id} className="flex min-w-0 items-center gap-2 text-sm">
                          {line ? <LineBullet line={line} /> : null}
                          <span className="min-w-0 break-words">{step.title}</span>
                          <span className="font-code text-[11px]">· {step.protocol}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
                {deciding ? (
                  <p className={cx("mt-3 border-l-[5px] bg-white/60 px-3 py-2 text-sm", deciding.status === "fail" ? "border-[#C8102E]" : "border-[#A84B00]")}>
                    <strong>{deciding.status === "fail" ? "Decided by" : "Held by"} Art. {ruleInfo(deciding.rule).article}:</strong> {ruleInfo(deciding.rule).title}{" "}
                    <span className="font-code text-[12px]">
                      ({deciding.rule}
                      {deciding.observed ? `, observed ${deciding.observed}` : ""}
                      {deciding.limit ? `, limit ${deciding.limit}` : ""})
                    </span>
                  </p>
                ) : null}
                {result?.planError ? (
                  <p className="mt-3 text-sm">
                    <strong>Not planned:</strong> {result.planError.message} ({result.planError.code}). Only request-level rules ran, so this is not a full pass.
                  </p>
                ) : null}
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <div>
                    <dt className="inline font-bold">Value </dt>
                    <dd className="inline font-code">{formatUsd(evaluation.notionalUsd)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-bold">A real request gets </dt>
                    <dd className="inline font-code">{evaluation.code ?? (evaluation.outcome === "confirm" ? "a held intent" : "no error")}</dd>
                  </div>
                  {evaluation.decisionId ? (
                    <div>
                      <dt className="inline font-bold">Logged as </dt>
                      <dd className="inline font-code">{evaluation.decisionId}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              <div className="mx-auto w-40 sm:w-full">
                <PolicyStamp outcome={outcome!} detail={outcome === "cleared" ? (evaluation.complete ? "All clauses" : "Request-level only") : firstRule} press />
              </div>
            </div>

            <div className="min-w-0">
              <p className={cx(LABEL, "mb-2")}>Every clause it met</p>
              <ul className="flex min-w-0 flex-col divide-y-2 divide-dashed divide-[#1A1A1A]/15 dark:divide-white/10">
                {evaluation.rules.map((row, index) => {
                  const info = ruleInfo(row.rule);
                  return (
                    <li key={`${row.rule}-${row.scope}-${row.keyId ?? ""}-${index}`} className="flex min-w-0 items-start gap-3 py-2.5 text-sm">
                      <Mark status={row.status} />
                      <div className="min-w-0 flex-1">
                        <p className={cx("min-w-0 break-words font-semibold", row.status === "fail" && "kl-rb-strike")}>
                          <span className="sr-only">{STATUS_WORD[row.status]}: </span>
                          {info.title}
                        </p>
                        <p className={cx("break-words font-code text-[11px]", TEXT_MUTED)}>
                          Art. {info.article} · {row.rule} · {scopeName(row)}
                          {row.observed ? ` · observed ${row.observed}` : ""}
                          {row.limit ? ` · limit ${row.limit}` : ""}
                        </p>
                        {row.message && row.status !== "pass" ? <p className="text-[13px]">{row.message}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {evaluation.usage && evaluation.usage.length > 0 ? (
              <div className="min-w-0">
                <p className={cx(LABEL, "mb-2")}>Spend windows</p>
                <ul className="flex flex-col gap-1 font-code text-[12px]">
                  {evaluation.usage.map((usage) => (
                    <li key={`${usage.scope}-${usage.window}`}>
                      {names.get(usage.scope) ?? usage.scope} · {usage.window}: {formatUsd(usage.usedUsd)} used of {formatUsd(usage.capUsd)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {evaluation.schedule && evaluation.schedule.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm">
                {evaluation.schedule.map((entry) => (
                  <li key={entry.scope}>
                    Timetable of {names.get(entry.scope) ?? entry.scope}: {entry.open ? "open" : "closed"}
                    {entry.nextChange ? `, ${entry.open ? "closes" : "opens"} ${formatWhen(entry.nextChange)}` : ""} ({entry.timezone}).
                  </li>
                ))}
              </ul>
            ) : null}
            {evaluation.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {evaluation.warnings.map((warning) => (
                  <li key={warning} className="text-sm font-semibold text-[#92400E] dark:text-[#FBBF24]">
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        )}
      </div>
    </div>
  );
}
