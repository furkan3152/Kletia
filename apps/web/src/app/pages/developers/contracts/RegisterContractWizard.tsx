import {
  CHAINS,
  CONTRACT_LIMITS,
  isEvmAddress,
  reservedContractPhrase,
  validateContractDefinition,
  type ContractInspection,
  type ContractView,
  type EvmContractInspectionView,
  type NetworkKey,
} from "@kletia/core";
import { ArrowLeft, ArrowRight, Plus, ScanSearch, Send, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { formatWhen, shortAddress } from "../portal/portalFormat";
import { buildArg, classifyFunctions, eventItems, findFunction, guessArg, parseAbiText } from "./abi";
import { AbiFunctionPicker } from "./AbiFunctionPicker";
import { BindingEditor } from "./BindingEditor";
import {
  buildEvmDefinition,
  evmStepOf,
  newEntryDraft,
  waitsForActivation,
  WELL_KNOWN_PATH,
  wellKnownSnippet,
  type AddressDraft,
  type BuildIssue,
  type EvmDraft,
  type EvmEntryDraft,
  type EvmStep,
} from "./contractModel";
import { ContractTestForm } from "./ContractTestForm";
import { EventEditor } from "./EventEditor";
import { WizardSteps } from "./WizardSteps";

const EVM_NETWORKS = (Object.keys(CHAINS) as NetworkKey[]).filter((key) => CHAINS[key].vm === "evm");

const STEPS = [
  { n: 1, label: "Contract" },
  { n: 2, label: "ABI" },
  { n: 3, label: "Bindings" },
  { n: 4, label: "Events" },
  { n: 5, label: "Phrases" },
  { n: 6, label: "Register" },
] as const;

function isEvmInspection(value: ContractInspection | null | undefined): value is EvmContractInspectionView {
  return Boolean(value && value.vm === "evm");
}

function inspectionProblem(inspection: EvmContractInspectionView): string | null {
  if (inspection.eip7702) return "This address is an EIP-7702 delegated account, not a contract. Kletia refuses it (CONTRACT_DELEGATED_EOA).";
  if (!inspection.deployed) return "There is no code at this address on this network (CONTRACT_NOT_DEPLOYED).";
  if (inspection.denied) return `Kletia never calls this address: it is ${inspection.denied} (CONTRACT_DENIED).`;
  return null;
}

function sourceText(status: string | undefined): string {
  switch (status) {
    case "exact_match":
      return "Source verified on Sourcify (exact match)";
    case "match":
      return "Source verified on Sourcify (partial match)";
    case "unverified":
      return "Source not verified: users must acknowledge that before signing";
    default:
      return "Source verification unknown: Sourcify did not answer";
  }
}

function aliasProblems(aliases: string): string[] {
  return aliases
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean)
    .flatMap((alias) => {
      const word = reservedContractPhrase(alias);
      return word ? [`"${alias}" uses the reserved word "${word}".`] : [];
    });
}

export interface RegisterContractWizardProps {
  readonly apiKey: string;
  readonly onRegistered: (contract: ContractView) => void;
  readonly onCancel: () => void;
}

/** BYOC register wizard for EVM contracts (design §7.4): inspect, ABI, bindings, events, phrases, register and test. */
export function RegisterContractWizard({ apiKey, onRegistered, onCancel }: RegisterContractWizardProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [step, setStep] = useState<EvmStep>(1);
  const [reached, setReached] = useState<EvmStep>(1);
  const [network, setNetwork] = useState<NetworkKey>("base");
  const [addressText, setAddressText] = useState("");
  const [abiText, setAbiText] = useState("");
  const [abiSource, setAbiSource] = useState<"sourcify" | "paste">("paste");
  const [selected, setSelected] = useState<string[]>([]);
  const [entries, setEntries] = useState<Record<string, EvmEntryDraft>>({});
  const [addresses, setAddresses] = useState<AddressDraft[]>([]);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [visibility, setVisibility] = useState<"private" | "project">("private");
  const [entryIndex, setEntryIndex] = useState(0);
  const [registered, setRegistered] = useState<ContractView | null>(null);

  const inspect = useApiAction((_client, signal, query: { network: NetworkKey; address: string }) =>
    keyedClient(apiKey).contracts.inspect(query, { signal: sdkSignal(signal) }),
  );
  const register = useApiAction((_client, signal, definition: unknown) =>
    keyedClient(apiKey).contracts.register(definition as never, { signal: sdkSignal(signal) }),
  );
  const inspection = isEvmInspection(inspect.data) ? inspect.data : null;
  const problem = inspection ? inspectionProblem(inspection) : null;
  const address = inspection?.address ?? addressText.trim();

  const parsed = useMemo(() => {
    if (abiSource === "sourcify" && inspection?.abi) return { items: inspection.abi, errors: [] as string[], skipped: 0 };
    return abiText.trim() ? parseAbiText(abiText) : { items: [], errors: [] as string[], skipped: 0 };
  }, [abiSource, abiText, inspection]);
  const functions = useMemo(() => classifyFunctions(parsed.items), [parsed.items]);
  const events = useMemo(() => eventItems(parsed.items), [parsed.items]);
  const labels = addresses.map((entry) => entry.label.trim()).filter(Boolean);
  const chosen = selected.map((signature) => entries[signature]).filter((entry): entry is EvmEntryDraft => Boolean(entry));

  const draft: EvmDraft = { network, address, name, website, visibility, abi: parsed.items, addresses, entries: chosen };
  // Cheap enough per render (a few keccak hashes): the same checks the API runs, live.
  const built = buildEvmDefinition(draft, buildArg);
  const checked = validateContractDefinition(built.definition);
  const issues: BuildIssue[] = [...built.issues, ...(checked.ok ? [] : checked.issues.map((issue) => ({ path: issue.path, message: issue.message })))];
  const flagged = [...new Set(issues.map((issue) => evmStepOf(issue.path)))];

  const go = (next: EvmStep) => {
    setStep(next);
    setReached((current) => (next > current ? next : current));
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const toggle = (signature: string, on: boolean) => {
    if (on) {
      const fn = findFunction(parsed.items, signature);
      if (!fn) return;
      setEntries((current) => (current[signature] ? current : { ...current, [signature]: newEntryDraft(fn, parsed.items, guessArg) }));
      setSelected((current) => (current.includes(signature) ? current : [...current, signature]));
    } else {
      setSelected((current) => current.filter((value) => value !== signature));
      setEntryIndex(0);
    }
  };

  const updateEntry = (entry: EvmEntryDraft) => setEntries((current) => ({ ...current, [entry.signature]: entry }));

  const submitInspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!isEvmAddress(addressText.trim())) return;
    const result = await inspect.run({ network, address: addressText.trim() });
    if (isEvmInspection(result) && result.abi && result.abi.length > 0) setAbiSource("sourcify");
    else setAbiSource("paste");
    setSelected([]);
    setEntries({});
  };

  const doRegister = async () => {
    if (!checked.ok) return;
    const result = await register.run(checked.value);
    if (result?.contract) {
      setRegistered(result.contract);
      onRegistered(result.contract);
    }
  };

  const currentEntry = chosen[Math.min(entryIndex, Math.max(0, chosen.length - 1))];
  const currentFn = currentEntry ? findFunction(parsed.items, currentEntry.signature) : null;
  const line = lineFor(network);

  if (registered) {
    const pending = registered.status === "pending";
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <div role="status" className={cx("flex flex-col gap-2 p-4", INK_BORDER_THIN, pending ? "bg-[#FFF3B0] text-[#1A1A1A]" : "bg-[#E9FFF5] dark:bg-[#0E2A20]")}>
          <p className="font-display text-xl font-bold">
            Registered {registered.integrator.name} as <code className="font-code text-base">{registered.id}</code>.
          </p>
          <p className="text-sm">
            {pending
              ? `It is pending until ${formatWhen(registered.activatesAt)}: your key's webhooks got contract.registered now and get contract.activated then. Tests work already; intents start planning on it once it is active.`
              : "It is active: intents created with this key can call it now."}
          </p>
        </div>
        {website.trim() ? (
          <div className="min-w-0">
            <p className={cx(LABEL, "mb-2")}>Domain verification (optional)</p>
            <p className={cx("mb-3 text-sm", TEXT_MUTED)}>
              Publish at <code className="break-all font-code">{`${website.trim().replace(/\/+$/u, "")}${WELL_KNOWN_PATH}`}</code>, then Reverify the registration.
            </p>
            <CodeBlock code={wellKnownSnippet([registered.id])} language="json" label="Domain verification file" filename="kletia.json" />
          </div>
        ) : null}
        <section aria-label="Test the registration" className={cx("min-w-0 p-4 sm:p-5", INK_BORDER_THIN)}>
          <h4 className="mb-1 font-display text-xl font-bold">Test it with an account</h4>
          <p className={cx("mb-4 text-sm", TEXT_MUTED)}>The simulation, approvals and the review card exactly as users will see them.</p>
          <ContractTestForm contract={registered} apiKey={apiKey} />
        </section>
        <Button variant="secondary" className="self-start" onClick={onCancel}>
          Close the wizard
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <WizardSteps steps={STEPS} current={step} reached={reached} flagged={step === 6 ? flagged : flagged.filter((n) => n < reached)} onGo={(n) => go(n as EvmStep)} />
      <h4 ref={headingRef} tabIndex={-1} className="font-display text-2xl font-bold tracking-[-0.02em] focus:outline-none">
        {step}. {STEPS[step - 1]!.label}
      </h4>

      {step === 1 ? (
        <form onSubmit={submitInspect} noValidate className="flex min-w-0 flex-col gap-5">
          <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <SelectField
              label="Network"
              value={network}
              onChange={(event) => {
                setNetwork(event.target.value as NetworkKey);
                inspect.reset();
              }}
              options={EVM_NETWORKS.map((key) => ({ value: key, label: `${CHAINS[key].name}${CHAINS[key].environment === "testnet" ? " (testnet)" : ""}` }))}
            />
            <TextField
              label="Contract address"
              mono
              value={addressText}
              onChange={(event) => {
                setAddressText(event.target.value);
                inspect.reset();
              }}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              error={addressText.trim() && !isEvmAddress(addressText.trim()) ? "That is not a 0x address." : undefined}
              hint="The contract users call. Tokens, routers, Permit2, Multicall3, EntryPoints and system contracts are refused."
            />
          </div>
          <Button type="submit" loading={inspect.status === "loading"} disabled={!isEvmAddress(addressText.trim())} className="self-start">
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
            Inspect
          </Button>
          <div aria-live="polite" className="min-w-0">
            {inspect.status === "error" && inspect.error ? <ApiErrorPanel error={inspect.error} title="Inspection failed" /> : null}
            {inspection ? (
              <div className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER_THIN, problem ? "bg-[#FFE4E4] text-[#1A1A1A]" : "")}>
                <p className="flex min-w-0 flex-wrap items-center gap-2 font-bold">
                  {line ? <LineBullet line={line} decorative /> : null}
                  <span className="min-w-0 break-all font-code text-sm">{inspection.address}</span>
                  {problem ? <Badge tone="red">Refused</Badge> : <Badge tone="green">Can be registered</Badge>}
                </p>
                {problem ? <p className="text-sm font-bold">{problem}</p> : null}
                {inspection.pins ? (
                  <dl className="grid min-w-0 gap-x-4 gap-y-1 font-code text-[12px] sm:grid-cols-[9rem_minmax(0,1fr)]">
                    <dt className="font-bold">code hash</dt>
                    <dd className="min-w-0 break-all">{inspection.pins.codeHash}</dd>
                    <dt className="font-bold">code size</dt>
                    <dd>{inspection.codeSize.toLocaleString("en-US")} bytes</dd>
                    {inspection.pins.proxy ? (
                      <>
                        <dt className="font-bold">proxy</dt>
                        <dd className="min-w-0 break-all">
                          {inspection.pins.proxy.kind}, implementation {inspection.pins.proxy.implementation}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt className="font-bold">proxy</dt>
                        <dd>none</dd>
                      </>
                    )}
                  </dl>
                ) : null}
                <p className="text-sm">{sourceText(inspection.verification.source?.status)}.</p>
                {inspection.verification.implementationSource ? (
                  <p className="text-sm">Implementation: {sourceText(inspection.verification.implementationSource.status).toLowerCase()}.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <div className="flex min-w-0 flex-col gap-5">
          {inspection?.abi && inspection.abi.length > 0 ? (
            <fieldset className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <legend className={cx(LABEL, "mb-2")}>ABI source</legend>
              <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
                <input type="radio" name="abi-source" className="accent-[#0052FF]" checked={abiSource === "sourcify"} onChange={() => setAbiSource("sourcify")} />
                The verified ABI from Sourcify ({inspection.abi.length} items)
              </label>
              <label className="inline-flex min-h-9 cursor-pointer items-center gap-2">
                <input type="radio" name="abi-source" className="accent-[#0052FF]" checked={abiSource === "paste"} onChange={() => setAbiSource("paste")} />
                Paste my own
              </label>
            </fieldset>
          ) : null}
          {abiSource === "paste" || !inspection?.abi?.length ? (
            <TextAreaField
              label="ABI"
              mono
              rows={8}
              value={abiText}
              onChange={(event) => {
                setAbiText(event.target.value);
                setSelected([]);
              }}
              placeholder={"function deposit(uint256 assets, address receiver) returns (uint256 shares)\nevent Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"}
              hint="A JSON ABI (or a build artifact with an abi field), or one human-readable signature per line. Tuples need the JSON form."
              error={parsed.errors.length > 0 ? parsed.errors.slice(0, 3).join(" ") : undefined}
              spellCheck={false}
            />
          ) : null}
          {parsed.items.length > 0 ? (
            <AbiFunctionPicker functions={functions} selected={selected} onToggle={toggle} max={CONTRACT_LIMITS.actionsPerRegistration} />
          ) : null}
          <p className={cx("text-xs", TEXT_MUTED)}>
            Only the functions you choose, and the events they bind, go into the registration: the ABI is an allowlist. Up to{" "}
            {CONTRACT_LIMITS.abiItems} items.
          </p>
        </div>
      ) : null}

      {step === 3 || step === 4 ? (
        chosen.length === 0 ? (
          <p className={cx("text-sm", TEXT_MUTED)}>Choose at least one function in step 2.</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            {chosen.length > 1 ? (
              <SelectField
                label="Entry"
                value={String(Math.min(entryIndex, chosen.length - 1))}
                onChange={(event) => setEntryIndex(Number(event.target.value))}
                options={chosen.map((entry, index) => ({ value: String(index), label: `${entry.id || "entry"} · ${entry.signature}` }))}
                containerClassName="max-w-xl"
              />
            ) : null}
            {currentEntry && currentFn ? (
              step === 3 ? (
                <BindingEditor
                  entry={currentEntry}
                  fn={currentFn}
                  network={network}
                  labels={labels}
                  index={chosen.indexOf(currentEntry)}
                  issues={issues}
                  onChange={updateEntry}
                />
              ) : (
                <EventEditor entry={currentEntry} events={events} labels={labels} index={chosen.indexOf(currentEntry)} issues={issues} onChange={updateEntry} />
              )
            ) : null}
            {step === 3 ? (
              <fieldset className="flex min-w-0 flex-col gap-3">
                <legend className={cx(LABEL, "mb-1")}>Other contracts (optional, at most {CONTRACT_LIMITS.extraAddresses})</legend>
                <p className={cx("text-sm", TEXT_MUTED)}>A separate approval spender or event emitter, pinned like the target and named by a label.</p>
                {addresses.map((entry, index) => (
                  <div key={index} className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
                    <TextField
                      label="Label"
                      mono
                      value={entry.label}
                      onChange={(event) => setAddresses((current) => current.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))}
                      placeholder="router"
                    />
                    <TextField
                      label="Address"
                      mono
                      value={entry.address}
                      onChange={(event) => setAddresses((current) => current.map((item, position) => (position === index ? { ...item, address: event.target.value } : item)))}
                      placeholder="0x…"
                      spellCheck={false}
                    />
                    <Button size="sm" variant="ghost" onClick={() => setAddresses((current) => current.filter((_, position) => position !== index))} aria-label={`Remove ${entry.label || "this address"}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Remove
                    </Button>
                  </div>
                ))}
                {addresses.length < CONTRACT_LIMITS.extraAddresses ? (
                  <Button size="sm" variant="secondary" className="self-start" onClick={() => setAddresses((current) => [...current, { label: "", address: "" }])}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add a contract
                  </Button>
                ) : null}
              </fieldset>
            ) : null}
          </div>
        )
      ) : null}

      {step === 5 ? (
        <div className="flex min-w-0 flex-col gap-6">
          {chosen.map((entry, index) => {
            const problems = aliasProblems(entry.aliases);
            return (
              <fieldset key={entry.signature} className={cx("grid min-w-0 gap-4 p-3 sm:p-4 md:grid-cols-2", INK_BORDER_THIN)}>
                <legend className="px-1 font-code text-[12.5px] font-bold">{entry.id || entry.signature}</legend>
                <TextField
                  label="Verbs (comma separated, 1-4)"
                  value={entry.verbs}
                  onChange={(event) => updateEntry({ ...entry, verbs: event.target.value })}
                  placeholder="deposit, supply"
                  hint="Lower-case words of 2-16 letters."
                />
                <TextField
                  label="Aliases (comma separated, 1-4)"
                  value={entry.aliases}
                  onChange={(event) => updateEntry({ ...entry, aliases: event.target.value })}
                  placeholder="acme vault"
                  hint="What users type: deposit 100 USDC into acme vault."
                  error={problems.length > 0 ? problems.join(" ") : issues.find((issue) => issue.path.startsWith(`actions[${index}].phrases`))?.message}
                />
                <TextField label="Minimum amount (optional)" mono inputMode="decimal" value={entry.minAmount} onChange={(event) => updateEntry({ ...entry, minAmount: event.target.value })} />
                <TextField
                  label={waitsForActivation(network) && entry.inputToken ? "Maximum amount (required on mainnet)" : "Maximum amount (optional)"}
                  mono
                  inputMode="decimal"
                  value={entry.maxAmount}
                  onChange={(event) => updateEntry({ ...entry, maxAmount: event.target.value })}
                  error={issues.find((issue) => issue.path.startsWith(`actions[${index}].limits`))?.message}
                  hint="In input-token units, per step."
                />
              </fieldset>
            );
          })}
          <fieldset className="grid min-w-0 gap-4 md:grid-cols-2">
            <legend className={cx(LABEL, "mb-2 md:col-span-2")}>Who users see on every step</legend>
            <TextField
              label="Integrator name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme Yield"
              hint="2-40 letters, digits, spaces and . , & ' ( ) -. Brand names (Aave, Kletia, …) need that brand's website and a verified domain."
              error={issues.find((issue) => issue.path.startsWith("integrator.name"))?.message}
            />
            <TextField
              label={waitsForActivation(network) ? "Website (https, required on mainnet)" : "Website (https)"}
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="https://acme.example"
              spellCheck={false}
              autoComplete="off"
              error={issues.find((issue) => issue.path.startsWith("integrator.website"))?.message}
            />
            <SelectField
              label="Who may use it"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as "private" | "project")}
              options={[
                { value: "private", label: "Only this key (private)" },
                { value: "project", label: "Every key of the project" },
              ]}
            />
          </fieldset>
          <div className="min-w-0">
            <p className={cx(LABEL, "mb-2")}>Domain verification file</p>
            <p className={cx("mb-3 max-w-3xl text-sm", TEXT_MUTED)}>
              After registering, publish this at <code className="font-code">{`https://<your website>${WELL_KNOWN_PATH}`}</code> with the id you get, then press
              Reverify. Until then reviews say the domain is not verified and each step is capped at $1,000.
            </p>
            <CodeBlock code={wellKnownSnippet(["ct_<the id you get>"])} language="json" label="Domain verification file" filename="kletia.json" />
          </div>
        </div>
      ) : null}

      {step === 6 ? (
        <div className="flex min-w-0 flex-col gap-5">
          {issues.length > 0 ? (
            <div role="alert" className="flex min-w-0 flex-col gap-2 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-4 text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
              <p className="font-display text-lg font-bold">
                {issues.length} {issues.length === 1 ? "thing" : "things"} to fix before registering
              </p>
              <ul className="flex flex-col gap-1.5">
                {issues.slice(0, 20).map((issue, index) => (
                  <li key={`${issue.path}-${index}`} className="flex min-w-0 flex-col gap-1 border-l-[3px] border-current pl-3 text-sm sm:flex-row sm:items-start sm:gap-3">
                    <button type="button" className="shrink-0 self-start font-code text-xs font-bold underline decoration-2 underline-offset-2" onClick={() => go(evmStepOf(issue.path))}>
                      Step {evmStepOf(issue.path)} · {issue.path || "definition"}
                    </button>
                    <span className="min-w-0 break-words">{issue.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p role="status" className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">
              The definition passes the same checks the API runs (validateContractDefinition). Registering pins the code again on-chain.
            </p>
          )}
          <CodeBlock code={JSON.stringify(checked.ok ? checked.value : built.definition, null, 2)} language="json" label="Contract definition" filename="definition.json" maxHeightClassName="max-h-[26rem]" />
          <div className={cx("flex flex-col gap-2 p-4 text-sm", INK_BORDER_THIN)}>
            <p className="font-bold">
              {line ? <LineBullet line={line} decorative className="mr-2 align-middle" /> : null}
              {chosen.length} {chosen.length === 1 ? "entry" : "entries"} on {CHAINS[network].name} at {address ? shortAddress(address) : "—"}
            </p>
            <p className={TEXT_MUTED}>
              {waitsForActivation(network)
                ? "On mainnet the registration is pending for the activation delay (15 minutes by default) and your webhooks hear about it first. Test it meanwhile."
                : "Testnet registrations activate at once."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading={register.status === "loading"} disabled={!checked.ok || built.issues.length > 0} onClick={() => void doRegister()}>
              <Send className="h-4 w-4" aria-hidden="true" />
              Register
            </Button>
          </div>
          <div aria-live="polite">{register.status === "error" && register.error ? <ApiErrorPanel error={register.error} title="Registration refused" /> : null}</div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-dashed border-[#1A1A1A]/25 pt-4 dark:border-white/15">
        <div className="flex flex-wrap gap-2">
          {step > 1 ? (
            <Button variant="secondary" onClick={() => go((step - 1) as EvmStep)}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          ) : null}
          {step < 6 ? (
            <Button
              variant="ink"
              disabled={(step === 1 && (!inspection || Boolean(problem))) || (step === 2 && chosen.length === 0)}
              onClick={() => go((step + 1) as EvmStep)}
            >
              Next
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {step === 1 && !inspection ? <p className={cx("text-xs", TEXT_MUTED)}>Inspect the address to continue: Kletia reads its code, proxy and source verification first.</p> : null}
      {step === 2 && parsed.items.length > 0 && chosen.length === 0 ? <p className={cx("text-xs", TEXT_MUTED)}>Choose the functions to register to continue.</p> : null}
    </div>
  );
}
