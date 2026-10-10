import {
  assetsForNetwork,
  CHAINS,
  CONTRACT_LIMITS,
  reservedContractPhrase,
  validateContractDefinition,
  type ContractInspection,
  type ContractView,
  type NetworkKey,
  type SolanaProgramInspectionView,
} from "@kletia/core";
import { Plus, ScanSearch, Send, Trash2 } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { formatWhen, httpsUrl } from "../portal/portalFormat";
import { buildSvmDefinition, newSvmEntryDraft, programList, svmSectionOf, WELL_KNOWN_PATH, wellKnownSnippet, type PayeeDraft, type SvmEntryDraft } from "./contractModel";
import { ContractTestForm } from "./ContractTestForm";

const SVM_NETWORKS = (Object.keys(CHAINS) as NetworkKey[]).filter((key) => CHAINS[key].vm === "svm");

function isSvmInspection(value: ContractInspection | null | undefined): value is SolanaProgramInspectionView {
  return Boolean(value && value.vm === "svm");
}

function Issues({ issues }: { readonly issues: readonly { path: string; message: string }[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`} className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
          <code className="font-code">{issue.path}</code>: {issue.message}
        </li>
      ))}
    </ul>
  );
}

export interface SolanaActionFormProps {
  readonly apiKey: string;
  readonly onRegistered: (contract: ContractView) => void;
  readonly onCancel: () => void;
}

/**
 * Register a Solana Actions origin with its program allowlist (design §7.4):
 * origin and action URLs, programs (pins and OtterSec status), payees,
 * inputs and outputs, then register and test with an account. Kletia
 * fetches each action's metadata itself when you register.
 */
export function SolanaActionForm({ apiKey, onRegistered, onCancel }: SolanaActionFormProps) {
  const [network, setNetwork] = useState<NetworkKey>(SVM_NETWORKS.includes("solana" as NetworkKey) ? ("solana" as NetworkKey) : SVM_NETWORKS[0]!);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [visibility, setVisibility] = useState<"private" | "project">("private");
  const [origin, setOrigin] = useState("");
  const [programs, setPrograms] = useState("");
  const [payees, setPayees] = useState<PayeeDraft[]>([]);
  const [entries, setEntries] = useState<SvmEntryDraft[]>([newSvmEntryDraft("", [])]);
  const [registered, setRegistered] = useState<ContractView | null>(null);
  // Issues show once a section was left (or on request), never on a pristine form.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const leave = (section: string) => () => setSeen((current) => (current.has(section) ? current : new Set([...current, section])));
  const visible = (section: string) => showAll || seen.has(section);
  const inspect = useApiAction((_client, signal, query: { network: NetworkKey; programs: readonly string[] }) =>
    keyedClient(apiKey).contracts.inspect(query, { signal: sdkSignal(signal) }),
  );
  const register = useApiAction((_client, signal, definition: unknown) => keyedClient(apiKey).contracts.register(definition as never, { signal: sdkSignal(signal) }));
  const programIds = programList(programs);
  const inspection = isSvmInspection(inspect.data) ? inspect.data : null;
  const built = buildSvmDefinition({ network, name, website, visibility, origin, programs, payees, entries });
  const checked = validateContractDefinition(built.definition);
  const issues = [...built.issues, ...(checked.ok ? [] : checked.issues.map((issue) => ({ path: issue.path, message: issue.message })))];
  const sectionIssues = (section: ReturnType<typeof svmSectionOf>) => issues.filter((issue) => svmSectionOf(issue.path) === section);
  const tokens = assetsForNetwork(network);
  const setEntry = (index: number, patch: Partial<SvmEntryDraft>) => setEntries((current) => current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));

  const doRegister = async () => {
    if (!checked.ok) return;
    const result = await register.run(checked.value);
    if (result?.contract) {
      setRegistered(result.contract);
      onRegistered(result.contract);
    }
  };

  if (registered) {
    const site = httpsUrl(website.trim());
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <div role="status" className={cx("flex flex-col gap-2 p-4", INK_BORDER_THIN, registered.status === "pending" ? "bg-[#FFF3B0] text-[#1A1A1A]" : "bg-[#E9FFF5] dark:bg-[#0E2A20]")}>
          <p className="font-display text-xl font-bold">
            Registered {registered.integrator.name} as <code className="font-code text-base">{registered.id}</code>.
          </p>
          <p className="text-sm">
            {registered.status === "pending" ? `Pending until ${formatWhen(registered.activatesAt)}. Tests work already.` : "Active: intents created with this key can call it now."}
          </p>
          {registered.actions.map((action) =>
            "metadata" in action && action.metadata ? (
              <p key={action.id} className="text-sm">
                <code className="font-code font-bold">{action.id}</code>: fetched &ldquo;{action.metadata.title}&rdquo; ({action.metadata.label})
                {action.metadata.disabled ? ", which the action server marks disabled" : ""}.
              </p>
            ) : null,
          )}
        </div>
        {site ? <CodeBlock code={wellKnownSnippet([registered.id])} language="json" label="Domain verification file" filename={`${new URL(site).host}${WELL_KNOWN_PATH}`} /> : null}
        <section aria-label="Test the registration" className={cx("min-w-0 p-4 sm:p-5", INK_BORDER_THIN)}>
          <h4 className="mb-4 font-display text-xl font-bold">Test it with an account</h4>
          <ContractTestForm contract={registered} apiKey={apiKey} />
        </section>
        <Button variant="secondary" className="self-start" onClick={onCancel}>
          Close the form
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <fieldset className="grid min-w-0 gap-4 md:grid-cols-2" onBlur={leave("origin")}>
        <legend className={cx(LABEL, "mb-2 md:col-span-2")}>1 · Action server</legend>
        <SelectField label="Network" value={network} onChange={(event) => setNetwork(event.target.value as NetworkKey)} options={SVM_NETWORKS.map((key) => ({ value: key, label: CHAINS[key].name }))} />
        <TextField
          label="Origin (https)"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://actions.acme.example"
          spellCheck={false}
          autoComplete="off"
          hint="Every action URL is on it. Public DNS name, port 443 or 1024+."
        />
        <div className="md:col-span-2">
          <Issues issues={visible("origin") ? sectionIssues("origin") : []} />
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-4" onBlur={leave("programs")}>
        <legend className={cx(LABEL, "mb-2")}>2 · Programs your signature may reach (1-{CONTRACT_LIMITS.programs})</legend>
        <TextAreaField
          label="Program ids, one per line"
          mono
          rows={3}
          value={programs}
          onChange={(event) => {
            setPrograms(event.target.value);
            inspect.reset();
          }}
          spellCheck={false}
          hint="Allowlist only programs you control: a program that receives the user's wallet can act on everything the user holds in it."
        />
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          loading={inspect.status === "loading"}
          disabled={programIds.length === 0}
          onClick={() => void inspect.run({ network, programs: programIds.slice(0, CONTRACT_LIMITS.programs) })}
        >
          <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />
          Check the programs
        </Button>
        <div aria-live="polite" className="min-w-0">
          {inspect.status === "error" && inspect.error ? <ApiErrorPanel error={inspect.error} title="Could not check the programs" /> : null}
          {inspection ? (
            <ul className="flex flex-col gap-2">
              {inspection.programs.map((entry) => (
                <li key={entry.program} className={cx("flex min-w-0 flex-col gap-1 p-3 text-sm", INK_BORDER_THIN, entry.denied ? "bg-[#FFE4E4] text-[#1A1A1A]" : "")}>
                  <p className="flex min-w-0 flex-wrap items-center gap-2">
                    <code className="min-w-0 break-all font-code text-[12px] font-bold">{entry.program}</code>
                    {entry.denied ? <Badge tone="red">Refused</Badge> : entry.pin ? <Badge tone="green">Pinned</Badge> : <Badge tone="yellow">Not found</Badge>}
                    <Badge tone={entry.verification.verified === true ? "green" : "neutral"}>
                      OtterSec {entry.verification.verified === true ? "verified" : entry.verification.verified === false ? "not verified" : "unknown"}
                    </Badge>
                  </p>
                  {entry.denied ? <p className="font-bold">{entry.denied}</p> : null}
                  {entry.pin ? (
                    <p className={cx("break-all font-code text-[11px]", TEXT_MUTED)}>
                      {entry.pin.upgradeAuthority ? `upgradeable by ${entry.pin.upgradeAuthority}` : "immutable"}
                      {entry.pin.lastDeploySlot ? ` · last deployed at slot ${entry.pin.lastDeploySlot}` : ""}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Issues issues={visible("programs") ? sectionIssues("programs") : []} />
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3" onBlur={leave("payees")}>
        <legend className={cx(LABEL, "mb-2")}>3 · Payees (optional, at most {CONTRACT_LIMITS.payees})</legend>
        <p className={cx("text-sm", TEXT_MUTED)}>The only third parties a top-level SOL transfer may pay, each with a lamport cap per transaction.</p>
        {payees.map((payee, index) => (
          <div key={index} className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,10rem)_auto] sm:items-end">
            <TextField label="Label" value={payee.label} onChange={(event) => setPayees((current) => current.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))} placeholder="Acme fee" />
            <TextField label="Address" mono value={payee.address} onChange={(event) => setPayees((current) => current.map((item, position) => (position === index ? { ...item, address: event.target.value } : item)))} spellCheck={false} />
            <TextField label="Max lamports" mono inputMode="numeric" value={payee.maxLamports} onChange={(event) => setPayees((current) => current.map((item, position) => (position === index ? { ...item, maxLamports: event.target.value } : item)))} placeholder="5000000" />
            <Button size="sm" variant="ghost" onClick={() => setPayees((current) => current.filter((_, position) => position !== index))} aria-label={`Remove payee ${payee.label || index + 1}`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Remove
            </Button>
          </div>
        ))}
        {payees.length < CONTRACT_LIMITS.payees ? (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setPayees((current) => [...current, { label: "", address: "", maxLamports: "" }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add a payee
          </Button>
        ) : null}
        <Issues issues={visible("payees") ? sectionIssues("payees") : []} />
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-4" onBlur={leave("actions")}>
        <legend className={cx(LABEL, "mb-2")}>4 · Actions (1-{CONTRACT_LIMITS.actionsPerRegistration})</legend>
        {entries.map((entry, index) => {
          const reserved = entry.aliases
            .split(",")
            .map((alias) => alias.trim())
            .filter(Boolean)
            .map((alias) => [alias, reservedContractPhrase(alias)] as const)
            .filter(([, word]) => word);
          const entryIssues = issues.filter((issue) => issue.path.startsWith(`actions[${index}]`));
          return (
            <div key={index} className={cx("grid min-w-0 gap-4 p-3 sm:p-4 md:grid-cols-2", INK_BORDER_THIN)}>
              <TextField label="Id" mono value={entry.id} onChange={(event) => setEntry(index, { id: event.target.value })} placeholder="stake" />
              <TextField label="Label (shown in reviews)" value={entry.label} maxLength={80} onChange={(event) => setEntry(index, { label: event.target.value })} placeholder="Stake USDC with Acme" />
              <TextField
                label="Action URL"
                mono
                containerClassName="md:col-span-2"
                value={entry.href}
                onChange={(event) => setEntry(index, { href: event.target.value })}
                placeholder="https://actions.acme.example/api/actions/stake?amount={amount}"
                spellCheck={false}
                hint="Placeholders: {amount} (decimal), {amountBaseUnits} and {<parameter>}. Only single-transaction responses are executed."
              />
              <SelectField
                label="Primary program"
                value={entry.primaryProgram}
                onChange={(event) => setEntry(index, { primaryProgram: event.target.value })}
                options={[{ value: "", label: programIds.length > 0 ? "Choose…" : "Add programs first" }, ...programIds.map((program) => ({ value: program, label: program }))]}
                hint="The transaction must invoke it."
              />
              <SelectField
                label="Token the action spends"
                value={entry.inputToken}
                onChange={(event) => setEntry(index, { inputToken: event.target.value })}
                options={[{ value: "", label: "Nothing" }, ...tokens.map((asset) => (asset.address === null ? { value: "native", label: `${asset.symbol} (native)` } : { value: asset.symbol, label: asset.symbol }))]}
              />
              <TextField label="Output mint (optional)" mono value={entry.outputMint} onChange={(event) => setEntry(index, { outputMint: event.target.value })} spellCheck={false} hint="The token the user receives, e.g. a receipt mint." />
              {entry.outputMint.trim() ? (
                <TextField label="Output tolerance (basis points)" mono inputMode="numeric" value={entry.toleranceBps} onChange={(event) => setEntry(index, { toleranceBps: event.target.value })} />
              ) : null}
              <TextField label="Verbs (comma separated)" value={entry.verbs} onChange={(event) => setEntry(index, { verbs: event.target.value })} placeholder="stake" />
              <TextField
                label="Aliases (comma separated)"
                value={entry.aliases}
                onChange={(event) => setEntry(index, { aliases: event.target.value })}
                placeholder="acme stake"
                error={reserved.length > 0 ? reserved.map(([alias, word]) => `"${alias}" uses the reserved word "${word}".`).join(" ") : undefined}
              />
              <TextField label="Minimum amount" mono inputMode="decimal" value={entry.minAmount} onChange={(event) => setEntry(index, { minAmount: event.target.value })} />
              <TextField label="Maximum amount" mono inputMode="decimal" value={entry.maxAmount} onChange={(event) => setEntry(index, { maxAmount: event.target.value })} hint="Required on mainnet for spending actions." />
              <div className="flex min-w-0 flex-col gap-2 md:col-span-2">
                <Issues issues={visible("actions") ? entryIssues : []} />
                {entries.length > 1 ? (
                  <Button size="sm" variant="ghost" className="self-start" onClick={() => setEntries((current) => current.filter((_, position) => position !== index))}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Remove this action
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        {entries.length < CONTRACT_LIMITS.actionsPerRegistration ? (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setEntries((current) => [...current, { ...newSvmEntryDraft(origin, programIds), id: `action-${current.length + 1}` }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add an action
          </Button>
        ) : null}
      </fieldset>

      <fieldset className="grid min-w-0 gap-4 md:grid-cols-2" onBlur={leave("integrator")}>
        <legend className={cx(LABEL, "mb-2 md:col-span-2")}>5 · Who users see</legend>
        <TextField label="Integrator name" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="Acme Stake" />
        <TextField label="Website (https)" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://acme.example" spellCheck={false} />
        <SelectField
          label="Who may use it"
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as "private" | "project")}
          options={[
            { value: "private", label: "Only this key (private)" },
            { value: "project", label: "Every key of the project" },
          ]}
        />
        <div className="md:col-span-2">
          <Issues issues={visible("integrator") ? sectionIssues("integrator") : []} />
        </div>
      </fieldset>

      <div className="flex min-w-0 flex-col gap-3">
        {issues.length === 0 ? (
          <p role="status" className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">
            The definition passes the same checks the API runs. Registering pins the programs and fetches each action&apos;s metadata.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-bold">
              {issues.length} {issues.length === 1 ? "thing" : "things"} to fix before registering{showAll ? " (listed beside each section)" : ""}.
            </p>
            {showAll ? null : (
              <Button size="sm" variant="secondary" onClick={() => setShowAll(true)}>
                Show what to fix
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button loading={register.status === "loading"} disabled={!checked.ok || built.issues.length > 0} onClick={() => void doRegister()}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Register
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <div aria-live="polite">{register.status === "error" && register.error ? <ApiErrorPanel error={register.error} title="Registration refused" /> : null}</div>
      </div>
    </div>
  );
}
