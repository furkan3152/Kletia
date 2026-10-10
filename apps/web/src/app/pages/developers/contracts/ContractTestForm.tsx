import type { ContractActionView, ContractTestResult, ContractView } from "@kletia/core";
import { FlaskConical } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextField } from "../../../site/ui/Field";
import { cx, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { accountOn } from "../portal/accounts";
import { isDecimalText } from "../portal/portalFormat";
import { SimulationPreview } from "./SimulationPreview";

function spends(action: ContractActionView | undefined): boolean {
  return Boolean(action && "input" in action && action.input);
}

/**
 * Dry run of one entry for an account: plan, prepare and the mandatory
 * simulation, through `POST /v1/contracts/{id}/test`. Works while the
 * registration is pending (the owner tests the latest revision).
 */
export function ContractTestForm({ contract, apiKey }: { readonly contract: ContractView; readonly apiKey: string }) {
  const formId = useId();
  const [entry, setEntry] = useState(contract.actions[0]?.id ?? "");
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const action = contract.actions.find((candidate) => candidate.id === entry);
  const test = useApiAction((_client, signal, id: string, body: Parameters<ReturnType<typeof keyedClient>["contracts"]["test"]>[1]) =>
    keyedClient(apiKey).contracts.test(id, body, { signal: sdkSignal(signal) }),
  );
  const accountId = accountOn(contract.network, account);
  const needsAmount = spends(action);
  const amountOk = !amount.trim() ? !needsAmount : isDecimalText(amount.trim());
  const anyRecipient = Boolean(action && "recipient" in action && action.recipient === "any");
  const accountError = touched && !accountId ? `Enter an address on ${contract.network}, or a CAIP-10 account.` : undefined;
  const amountError = touched && !amountOk ? (needsAmount && !amount.trim() ? "This entry spends a token: enter an amount." : "Use a decimal amount, e.g. 25 or 0.5.") : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!accountId || !amountOk || !action) return;
    const paramValues: Record<string, string | boolean> = {};
    for (const param of action.params ?? []) {
      const value = params[param.name];
      if (value === undefined || value === "") continue;
      paramValues[param.name] = param.type === "bool" ? value === "true" : value;
    }
    await test.run(contract.id, {
      entry: action.id,
      account: accountId,
      ...(amount.trim() ? { amount: amount.trim() } : {}),
      ...(Object.keys(paramValues).length > 0 ? { params: paramValues } : {}),
      ...(anyRecipient && recipient.trim() ? { recipient: recipient.trim() } : {}),
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <form id={formId} onSubmit={submit} noValidate className="grid min-w-0 gap-4 md:grid-cols-2">
        <SelectField
          label="Entry"
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value);
            setParams({});
            test.reset();
          }}
          options={contract.actions.map((candidate) => ({ value: candidate.id, label: `${candidate.id} · ${candidate.label}` }))}
        />
        <TextField
          label="Test account"
          mono
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder={contract.vm === "evm" ? "0x… (an account that holds the input)" : "Solana address"}
          autoComplete="off"
          spellCheck={false}
          error={accountError}
          hint="Simulated against this account's real balances. Use one that holds the input token."
        />
        <TextField
          label={needsAmount ? "Amount (input token units)" : "Amount (optional)"}
          mono
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="100"
          autoComplete="off"
          error={amountError}
        />
        {anyRecipient ? (
          <TextField
            label="Recipient (optional)"
            mono
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            hint="This entry allows third-party recipients; the review flags them."
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        {(action?.params ?? []).map((param) =>
          param.type === "bool" || param.type === "enum" ? (
            <SelectField
              key={param.name}
              label={`Parameter ${param.name}`}
              value={params[param.name] ?? ""}
              onChange={(event) => setParams((current) => ({ ...current, [param.name]: event.target.value }))}
              options={[
                { value: "", label: param.default !== undefined ? `Default (${String(param.default)})` : "Not set" },
                ...(param.type === "bool" ? ["true", "false"] : (param.enum ?? [])).map((value) => ({ value, label: value })),
              ]}
            />
          ) : (
            <TextField
              key={param.name}
              label={`Parameter ${param.name}`}
              mono
              inputMode="numeric"
              value={params[param.name] ?? ""}
              onChange={(event) => setParams((current) => ({ ...current, [param.name]: event.target.value }))}
              placeholder={param.default !== undefined ? String(param.default) : ""}
              hint={[param.min ? `min ${param.min}` : "", param.max ? `max ${param.max}` : ""].filter(Boolean).join(", ") || undefined}
            />
          ),
        )}
        <div className="flex flex-col gap-2 md:col-span-2">
          <Button type="submit" loading={test.status === "loading"} className="self-start">
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
            Run the test
          </Button>
          <p className={cx("text-xs", TEXT_MUTED)}>
            Calls <code className="font-code">POST /v1/contracts/{"{id}"}/test</code>: plan, prepare and simulation as a dry run. 20 tests per
            minute per key.
          </p>
        </div>
      </form>
      <div aria-live="polite" className="min-w-0">
        {test.status === "error" && test.error ? <ApiErrorPanel error={test.error} title="The test did not run" /> : null}
        {test.status === "success" && test.data ? <SimulationPreview result={test.data as ContractTestResult} /> : null}
      </div>
    </div>
  );
}
