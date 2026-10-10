import { assetsForNetwork, isBeneficiaryArgName, type AbiFunctionItem, type AbiParameter, type NetworkKey } from "@kletia/core";
import { Lock, Plus, Trash2 } from "lucide-react";

import { Button } from "../../../site/ui/Button";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { literalAllowed, sourceOptions, typeFamily, type ArgDraft, type ParamDraft } from "./abi";
import type { EvmEntryDraft } from "./contractModel";

function issueFor(issues: readonly { path: string; message: string }[], path: string): string | undefined {
  const found = issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`));
  return found.length > 0 ? found.map((issue) => issue.message).join(" ") : undefined;
}

function ArgRow({
  param,
  index,
  arg,
  params,
  onChange,
  error,
}: {
  readonly param: AbiParameter;
  readonly index: number;
  readonly arg: ArgDraft;
  readonly params: readonly ParamDraft[];
  readonly onChange: (arg: ArgDraft) => void;
  readonly error?: string;
}) {
  const family = typeFamily(param.type);
  const options = sourceOptions(param, params);
  const literal = literalAllowed(param);
  const beneficiary = family === "address" && isBeneficiaryArgName(param.name);
  const modes = [
    ...(options.length > 0 ? [{ value: "source", label: "From the intent" }] : []),
    ...(literal ? [{ value: "literal", label: "Fixed value" }] : []),
    ...(family === "complex" ? [{ value: "json", label: "JSON binding" }] : []),
  ];
  const mode = modes.some((entry) => entry.value === arg.mode) ? arg.mode : (modes[0]?.value as ArgDraft["mode"] | undefined) ?? "literal";
  return (
    <div className={cx("grid min-w-0 gap-3 p-3 md:grid-cols-[minmax(0,11rem)_minmax(0,12rem)_minmax(0,1fr)] md:items-start", INK_BORDER_THIN)}>
      <div className="min-w-0">
        <p className="break-words font-code text-[13px] font-bold">{param.name || `argument ${index + 1}`}</p>
        <p className={cx("font-code text-[11px]", TEXT_MUTED)}>{param.type}</p>
        {beneficiary ? (
          <p className="mt-1 flex items-start gap-1 text-[11px] font-bold">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            Beneficiary: always the user or the step recipient.
          </p>
        ) : null}
      </div>
      {modes.length > 1 ? (
        <SelectField
          label={`Value of ${param.name || `argument ${index + 1}`}`}
          value={mode}
          onChange={(event) => {
            const next = event.target.value as ArgDraft["mode"];
            onChange(next === "source" ? { mode: "source", value: options[0]?.value ?? "" } : next === "json" ? { mode: "json", value: "" } : { mode: "literal", value: family === "bytes" ? "0x" : "" });
          }}
          options={modes}
        />
      ) : (
        <p className={cx(LABEL, "!text-[10px] md:pt-8", TEXT_MUTED)}>{modes[0]?.label ?? "Not bindable"}</p>
      )}
      <div className="min-w-0">
        {mode === "source" ? (
          <SelectField
            label="Source"
            value={arg.mode === "source" ? arg.value : ""}
            onChange={(event) => onChange({ mode: "source", value: event.target.value })}
            options={[{ value: "", label: "Choose…" }, ...options]}
            error={error}
          />
        ) : mode === "json" ? (
          <TextAreaField
            label="Binding (JSON)"
            mono
            rows={3}
            value={arg.mode === "json" ? arg.value : ""}
            onChange={(event) => onChange({ mode: "json", value: event.target.value })}
            placeholder={'{ "tuple": ["$amount", "$account"] }'}
            hint="Tuples take { tuple: [...] } per member; arrays take literal elements only, at most 8."
            error={error}
          />
        ) : (
          <TextField
            label="Fixed value"
            mono
            value={arg.mode === "literal" ? arg.value : ""}
            onChange={(event) => onChange({ mode: "literal", value: event.target.value })}
            placeholder={family === "bool" ? "true or false" : family === "address" ? "0x…" : family === "bytes" ? "0x" : family === "uint" || family === "int" ? "decimal integer" : ""}
            hint={family === "bytes" ? "bytes arguments accept only the empty value 0x." : "Fixed by you; shown as such in every review."}
            error={error}
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </div>
    </div>
  );
}

function ParamRow({ param, onChange, onRemove }: { readonly param: ParamDraft; readonly onChange: (param: ParamDraft) => void; readonly onRemove: () => void }) {
  return (
    <div className={cx("grid min-w-0 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end", INK_BORDER_THIN)}>
      <TextField label="Name" mono value={param.name} onChange={(event) => onChange({ ...param, name: event.target.value })} placeholder="lockDays" autoComplete="off" />
      <SelectField
        label="Type"
        value={param.type}
        onChange={(event) => onChange({ ...param, type: event.target.value as ParamDraft["type"] })}
        options={[
          { value: "uint", label: "uint" },
          { value: "int", label: "int" },
          { value: "bool", label: "bool" },
          { value: "enum", label: "enum" },
        ]}
      />
      {param.type === "enum" ? (
        <TextField label="Values (comma separated)" value={param.values} onChange={(event) => onChange({ ...param, values: event.target.value })} placeholder="7d, 30d, 90d" />
      ) : param.type === "bool" ? (
        <SelectField
          label="Default"
          value={param.defaultValue}
          onChange={(event) => onChange({ ...param, defaultValue: event.target.value })}
          options={[
            { value: "", label: "None" },
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Min" mono value={param.min} onChange={(event) => onChange({ ...param, min: event.target.value })} />
          <TextField label="Max" mono value={param.max} onChange={(event) => onChange({ ...param, max: event.target.value })} />
        </div>
      )}
      {param.type !== "bool" ? (
        <TextField label="Default" mono value={param.defaultValue} onChange={(event) => onChange({ ...param, defaultValue: event.target.value })} />
      ) : (
        <label className="inline-flex min-h-11 items-center gap-2 text-sm font-bold">
          <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" checked={param.required} onChange={(event) => onChange({ ...param, required: event.target.checked })} />
          Required
        </label>
      )}
      <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove parameter ${param.name || "without a name"}`}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Remove
      </Button>
    </div>
  );
}

export interface BindingEditorProps {
  readonly entry: EvmEntryDraft;
  readonly fn: AbiFunctionItem;
  readonly network: NetworkKey;
  readonly labels: readonly string[];
  readonly index: number;
  readonly issues: readonly { path: string; message: string }[];
  readonly onChange: (entry: EvmEntryDraft) => void;
}

/**
 * One entry: where every argument comes from (only compatible sources are
 * offered, and a beneficiary-named address is locked to the user), the token
 * it spends and its exact approval, the native value and its cap, the
 * output token, user parameters and who may receive.
 */
export function BindingEditor({ entry, fn, network, labels, index, issues, onChange }: BindingEditorProps) {
  const at = `actions[${index}]`;
  const tokens = assetsForNetwork(network);
  const tokenOptions = [
    { value: "", label: "Nothing (no token is spent)" },
    ...tokens.map((asset) => (asset.address === null ? { value: "native", label: `${asset.symbol} (native)` } : { value: asset.symbol, label: asset.symbol })),
  ];
  const spenderOptions = [{ value: "$self", label: "This contract" }, ...labels.map((label) => ({ value: label, label: `Other contract "${label}"` })), { value: "", label: "No approval" }];
  const outputOptions = [{ value: "", label: "No declared output" }, { value: "$self", label: "This contract's token (vault shares)" }, ...labels.map((label) => ({ value: label, label: `Other contract "${label}"` }))];
  const outputIsCustom = entry.outputToken !== "" && entry.outputToken !== "$self" && !labels.includes(entry.outputToken);
  const payable = fn.stateMutability === "payable";
  const set = (patch: Partial<EvmEntryDraft>) => onChange({ ...entry, ...patch });
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <TextField label="Entry id" mono value={entry.id} onChange={(event) => set({ id: event.target.value })} error={issueFor(issues, `${at}.id`)} hint="Lower case, starts with a letter: deposit, stake-30d." autoComplete="off" />
        <TextField label="Label (shown in reviews)" value={entry.label} maxLength={80} onChange={(event) => set({ label: event.target.value })} error={issueFor(issues, `${at}.label`)} autoComplete="off" />
      </div>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className={cx(LABEL, "mb-1")}>Arguments of {entry.signature}</legend>
        {fn.inputs.length === 0 ? <p className={cx("text-sm", TEXT_MUTED)}>This function takes no arguments.</p> : null}
        {fn.inputs.map((param, argIndex) => (
          <ArgRow
            key={`${param.name ?? ""}-${argIndex}`}
            param={param}
            index={argIndex}
            arg={entry.args[argIndex] ?? { mode: "literal", value: "" }}
            params={entry.params}
            error={issueFor(issues, `${at}.args[${argIndex}]`)}
            onChange={(arg) => set({ args: entry.args.map((current, position) => (position === argIndex ? arg : current)) })}
          />
        ))}
      </fieldset>

      <fieldset className="grid min-w-0 gap-4 md:grid-cols-2">
        <legend className={cx(LABEL, "mb-2 md:col-span-2")}>Money in and out</legend>
        <SelectField
          label="Token the call spends"
          value={entry.inputToken}
          onChange={(event) => set({ inputToken: event.target.value, ...(event.target.value === "native" ? { approval: "", valueBind: "$amount" } : {}) })}
          options={tokenOptions}
          hint="Registry assets only. ERC-20 inputs bind the step amount to an argument."
          error={issueFor(issues, `${at}.input`)}
        />
        {entry.inputToken && entry.inputToken !== "native" ? (
          <SelectField
            label="Exact approval to"
            value={entry.approval}
            onChange={(event) => set({ approval: event.target.value })}
            options={spenderOptions}
            hint="Always approve(spender, amount) for the exact step amount, only when the allowance is lower."
          />
        ) : null}
        {payable ? (
          <>
            <SelectField
              label="Native value sent"
              value={entry.valueBind === "$amount" ? "$amount" : entry.valueBind ? "fixed" : ""}
              onChange={(event) => set({ valueBind: event.target.value === "$amount" ? "$amount" : event.target.value === "fixed" ? "0" : "" })}
              options={[
                { value: "$amount", label: "The step amount (native input)" },
                { value: "fixed", label: "A fixed amount in wei" },
                { value: "", label: "None" },
              ]}
              error={issueFor(issues, `${at}.value`)}
            />
            {entry.valueBind && entry.valueBind !== "$amount" ? (
              <TextField label="Fixed value (wei)" mono value={entry.valueBind} onChange={(event) => set({ valueBind: event.target.value })} />
            ) : null}
            <TextField
              label="Value cap (wei)"
              mono
              value={entry.valueMax}
              onChange={(event) => set({ valueMax: event.target.value })}
              hint="Required for payable functions: a payload above it is refused."
            />
          </>
        ) : null}
        <SelectField
          label="Output token"
          value={outputIsCustom ? "custom" : entry.outputToken}
          onChange={(event) => set({ outputToken: event.target.value === "custom" ? "0x" : event.target.value })}
          options={[...outputOptions, { value: "custom", label: "Another ERC-20 address" }]}
          hint="Enables amount: max after the step, and output verification."
          error={issueFor(issues, `${at}.output`)}
        />
        {outputIsCustom ? (
          <TextField label="Output ERC-20 address" mono value={entry.outputToken} onChange={(event) => set({ outputToken: event.target.value })} spellCheck={false} autoComplete="off" />
        ) : null}
        {entry.outputToken ? (
          <TextField
            label="Output tolerance (basis points)"
            mono
            inputMode="numeric"
            value={entry.toleranceBps}
            onChange={(event) => set({ toleranceBps: event.target.value })}
            hint="0-100, default 10: how far below the simulated output a landed call may be."
          />
        ) : null}
        <SelectField
          label="Who may receive"
          value={entry.recipient}
          onChange={(event) => set({ recipient: event.target.value as EvmEntryDraft["recipient"] })}
          options={[
            { value: "account", label: "Only the user (default)" },
            { value: "any", label: "Third parties too (flagged in every review)" },
          ]}
        />
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className={cx(LABEL, "mb-1")}>User parameters (optional, at most 6)</legend>
        <p className={cx("text-sm", TEXT_MUTED)}>Numbers, booleans or a choice the user picks, bound as $param.&lt;name&gt;. Never addresses or bytes.</p>
        {entry.params.map((param, paramIndex) => (
          <ParamRow
            key={paramIndex}
            param={param}
            onChange={(next) => set({ params: entry.params.map((current, position) => (position === paramIndex ? next : current)) })}
            onRemove={() => set({ params: entry.params.filter((_, position) => position !== paramIndex) })}
          />
        ))}
        {issueFor(issues, `${at}.params`) ? <p className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">{issueFor(issues, `${at}.params`)}</p> : null}
        {entry.params.length < 6 ? (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onClick={() => set({ params: [...entry.params, { name: "", type: "uint", min: "", max: "", values: "", defaultValue: "", required: false }] })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add a parameter
          </Button>
        ) : null}
      </fieldset>
    </div>
  );
}
