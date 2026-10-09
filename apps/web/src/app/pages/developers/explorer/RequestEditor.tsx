import { ArrowDownRight, Braces, RefreshCw } from "lucide-react";
import React, { useId } from "react";

import { PREVIEW_ACCOUNTS } from "../../../../shared/platform/previewAccounts";
import { SelectField, TextField } from "../../../site/ui/Field";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { IDEMPOTENCY_HEADER, idPrefixFor, type CollectedIds, type ExplorerOperation, type ExplorerParam } from "./operations";
import { describeConstraints, describeSchemaType, schemaTypes, type JsonSchema, type SchemaIssue } from "./schema";

export interface RequestDraft {
  readonly values: Readonly<Record<string, string>>;
  readonly bodyText: string;
  /** Index of the loaded body example. */
  readonly example: number;
  /** Idempotency-Key value; "" sends none. */
  readonly idempotencyKey: string;
}

export interface RequestEditorProps {
  readonly operation: ExplorerOperation;
  readonly draft: RequestDraft;
  readonly onChange: (next: Partial<RequestDraft>) => void;
  readonly bodyError: string | null;
  readonly bodyIssues: readonly SchemaIssue[];
  readonly collected: CollectedIds | null;
  readonly withKey: boolean;
  readonly onNewIdempotencyKey: () => void;
}

const CHIP = cx(
  "inline-flex min-h-8 max-w-full items-center gap-1 border-2 border-[#1A1A1A] bg-white px-2 py-0.5 font-code text-[11px] hover:bg-[#FFF7CC] dark:border-[#4B5563] dark:bg-[#0B1120] dark:hover:bg-[#1A2841]",
  FOCUS_RING,
);

function suggestionsFor(operation: ExplorerOperation, param: ExplorerParam, collected: CollectedIds | null): string[] {
  if (param.in !== "path") return [];
  if (param.name === "stepId") return [...(collected?.stepIds ?? [])].slice(0, 4);
  if (param.name === "accountId") return [PREVIEW_ACCOUNTS.solana, PREVIEW_ACCOUNTS.evm];
  const prefix = idPrefixFor(operation, param.name);
  return prefix ? [...(collected?.ids[prefix] ?? [])].slice(0, 3) : [];
}

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function ParamField({
  operation,
  param,
  value,
  onValue,
  collected,
}: {
  operation: ExplorerOperation;
  param: ExplorerParam;
  value: string;
  onValue: (value: string) => void;
  collected: CollectedIds | null;
}) {
  const constraints = describeConstraints(param.schema);
  const label = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-code normal-case tracking-normal">{param.name}</span>
      <span className="font-code text-[10px] font-semibold normal-case tracking-normal text-[#45464B] dark:text-[#A9B6C8]">
        {param.in} · {describeSchemaType(param.schema)}
      </span>
      {param.required ? <span className="text-[#B91C1C] dark:text-[#FCA5A5]">required</span> : null}
    </span>
  );
  const hint = [param.description, constraints.length > 0 ? constraints.join(" · ") : null].filter(Boolean).join(" ");
  const suggestions = suggestionsFor(operation, param, collected);
  const options = param.schema.enum?.map((option) => String(option));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {options ? (
        <SelectField
          label={label}
          value={value}
          onChange={(event) => onValue(event.target.value)}
          options={[...(param.required ? [] : [{ value: "", label: "(not set)" }]), ...options.map((option) => ({ value: option, label: option }))]}
          hint={hint || undefined}
        />
      ) : (
        <TextField
          label={label}
          value={value}
          onChange={(event) => onValue(event.target.value)}
          placeholder={param.schema.pattern ? param.schema.pattern.replace(/^\^|\$$/gu, "") : param.name}
          inputMode={schemaTypes(param.schema).includes("integer") ? "numeric" : undefined}
          hint={hint || undefined}
          mono
          spellCheck={false}
          autoComplete="off"
          required={param.required}
        />
      )}
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Recent values for ${param.name}`}>
          <span className={cx("text-[11px]", TEXT_MUTED)}>Use:</span>
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className={CHIP} onClick={() => onValue(suggestion)} title={suggestion} aria-label={`Use ${suggestion}`}>
              {shortId(suggestion)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SchemaRows({ schema, required }: { schema: JsonSchema; required: readonly string[] }) {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-[12px] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      {entries.map(([name, property]) => (
        <React.Fragment key={name}>
          <dt className="min-w-0 break-words font-code font-bold">
            {name}
            {required.includes(name) ? <span className="ml-1 text-[#B91C1C] dark:text-[#FCA5A5]">*</span> : null}
          </dt>
          <dd className={cx("min-w-0", TEXT_MUTED)}>
            <span className="break-words font-code text-[11px] text-[#1A1A1A] dark:text-white">{describeSchemaType(property)}</span>
            {describeConstraints(property).length > 0 ? <span className="font-code text-[11px]"> · {describeConstraints(property).join(" · ")}</span> : null}
            {property.description ? <span className="block">{property.description}</span> : null}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function BodySchema({ schema }: { schema: JsonSchema }) {
  const alternatives = schema.oneOf ?? schema.anyOf;
  return (
    <details className="kl-details group">
      <summary className={cx("inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-bold", FOCUS_RING)}>
        <ArrowDownRight className="kl-details-chevron h-3.5 w-3.5" aria-hidden="true" />
        Body schema
      </summary>
      <div className={cx("mt-2 flex flex-col gap-4 p-3", INK_BORDER_THIN)}>
        {alternatives && alternatives.length > 0 ? (
          alternatives.map((alternative, index) => (
            <div key={index} className="flex flex-col gap-2">
              <p className={cx(LABEL, "!text-[10px]")}>{alternative.title ?? `Shape ${index + 1}`}</p>
              <SchemaRows schema={alternative} required={alternative.required ?? []} />
            </div>
          ))
        ) : (
          <SchemaRows schema={schema} required={schema.required ?? []} />
        )}
        {schema.anyOf && schema.properties ? <SchemaRows schema={schema} required={schema.required ?? []} /> : null}
        <p className={cx("text-[11px]", TEXT_MUTED)}>* required. Generated from the OpenAPI schema.</p>
      </div>
    </details>
  );
}

/** Parameter form, JSON body editor and request headers for one operation. */
export function RequestEditor({
  operation,
  draft,
  onChange,
  bodyError,
  bodyIssues,
  collected,
  withKey,
  onNewIdempotencyKey,
}: RequestEditorProps) {
  const bodyId = useId();
  const idemId = useId();
  const groups: readonly { title: string; params: readonly ExplorerParam[] }[] = [
    { title: "Path", params: operation.params.filter((param) => param.in === "path") },
    { title: "Query", params: operation.params.filter((param) => param.in === "query") },
    { title: "Headers", params: operation.params.filter((param) => param.in === "header") },
  ];
  const setValue = (name: string, value: string) => onChange({ values: { ...draft.values, [name]: value } });
  const body = operation.body;
  const lines = draft.bodyText.split("\n").length;
  const hasParams = operation.params.length > 0;

  const formatBody = () => {
    try {
      onChange({ bodyText: JSON.stringify(JSON.parse(draft.bodyText), null, 2) });
    } catch {
      // Leave invalid JSON as typed; the error is shown below the editor.
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {hasParams ? (
        groups
          .filter((group) => group.params.length > 0)
          .map((group) => (
            <fieldset key={group.title} className="flex min-w-0 flex-col gap-3">
              <legend className={cx(LABEL, "mb-3", TEXT_MUTED)}>{group.title} parameters</legend>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                {group.params.map((param) => (
                  <ParamField
                    key={`${param.in}-${param.name}`}
                    operation={operation}
                    param={param}
                    value={draft.values[param.name] ?? ""}
                    onValue={(value) => setValue(param.name, value)}
                    collected={collected}
                  />
                ))}
              </div>
            </fieldset>
          ))
      ) : !body ? (
        <p className={cx("text-sm", TEXT_MUTED)}>No parameters.</p>
      ) : null}

      {body ? (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={bodyId} className={cx(LABEL, "inline-flex items-center gap-1.5 text-[#1A1A1A] dark:text-[#E2E8F0]")}>
              <Braces className="h-3.5 w-3.5" aria-hidden="true" />
              JSON body{body.required ? "" : " (optional)"}
            </label>
            <button type="button" onClick={formatBody} className={cx("text-[11px] font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
              Format
            </button>
          </div>
          {body.examples.length > 1 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Body examples">
              {body.examples.map((example, index) => (
                <button
                  key={example.label}
                  type="button"
                  aria-pressed={draft.example === index}
                  onClick={() => onChange({ example: index, bodyText: JSON.stringify(example.value, null, 2) })}
                  className={cx(CHIP, draft.example === index && "!bg-[#FFD60A] !text-[#1A1A1A]")}
                >
                  {example.label}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            id={bodyId}
            value={draft.bodyText}
            onChange={(event) => onChange({ bodyText: event.target.value })}
            rows={Math.min(18, Math.max(5, lines + 1))}
            spellCheck={false}
            autoComplete="off"
            wrap="off"
            aria-invalid={bodyError ? true : undefined}
            aria-describedby={`${bodyId}-status`}
            className={cx(
              "w-full min-w-0 resize-y border-[3px] border-[#1A1A1A] bg-[#0D1117] px-3 py-2.5 font-code text-[12.5px] leading-5 text-[#E6EDF3] caret-[#FFD60A] dark:border-[#4B5563]",
              FOCUS_RING,
            )}
          />
          <div id={`${bodyId}-status`} className="flex flex-col gap-1 text-xs" aria-live="polite">
            {bodyError ? (
              <p className="font-bold text-[#B91C1C] dark:text-[#FCA5A5]">{bodyError}</p>
            ) : bodyIssues.length > 0 ? (
              <>
                <p className="font-bold text-[#8A6100] dark:text-[#FFD60A]">The schema suggests a problem (the API decides; you can still send):</p>
                <ul className="flex flex-col gap-0.5">
                  {bodyIssues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className="font-code text-[11px]">
                      {issue.path} {issue.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : draft.bodyText.trim() ? (
              <p className={TEXT_MUTED}>Valid JSON, matches the schema checks.</p>
            ) : null}
          </div>
          <BodySchema schema={body.schema} />
        </div>
      ) : null}

      {operation.idempotent ? (
        <div className={cx("flex min-w-0 flex-col gap-2 p-3", INK_BORDER_THIN)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={idemId} className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm font-bold">
              <input
                id={idemId}
                type="checkbox"
                checked={Boolean(draft.idempotencyKey)}
                onChange={(event) => (event.target.checked ? onNewIdempotencyKey() : onChange({ idempotencyKey: "" }))}
                className="h-4 w-4 accent-[#0052FF]"
              />
              Send {IDEMPOTENCY_HEADER}
            </label>
            {draft.idempotencyKey ? (
              <button type="button" onClick={onNewIdempotencyKey} className={cx(CHIP, "font-sans font-bold")}>
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                New key
              </button>
            ) : null}
          </div>
          {draft.idempotencyKey ? (
            <code className="break-all font-code text-[12px]">{draft.idempotencyKey}</code>
          ) : null}
          <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
            {withKey
              ? "Send twice with the same key: the second response is replayed (Idempotent-Replayed: true). Change the body with the same key to see 422 IDEMPOTENCY_KEY_REUSED."
              : "Makes retries of this POST safe. Works only with an API key."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
