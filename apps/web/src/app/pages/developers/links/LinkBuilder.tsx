import { assetsForNetwork, CHAINS, validateLinkDefinition, type ContractView, type IntentRequest, type LinkOwnerView, type NetworkKey } from "@kletia/core";
import type { PolicyEvaluateResponse } from "@kletia/sdk";
import { Link2, ShieldCheck } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { lineFor, type Line } from "../../../site/art";
import { LinkTicket } from "../../../site/art/LinkTicket";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextField } from "../../../site/ui/Field";
import { cx, FOCUS_RING, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { anyAccount } from "../portal/accounts";
import { hostOf } from "../portal/portalFormat";
import { ruleInfo } from "../rulebook/policyModel";
import { LinkCreated } from "./LinkCreated";
import { buildLinkDefinition, destinationAction, draftBounds, draftSentence, LINK_TEMPLATES, templateDraft, type LinkDraft, type LinkTemplateId } from "./linkTemplates";

const FUNDING_SYMBOLS = ["USDC", "USDT", "ETH", "SOL", "EURC", "DAI"] as const;

function networksOnLane(lane: string): NetworkKey[] {
  return (Object.keys(CHAINS) as NetworkKey[]).filter((key) => CHAINS[key].lane === lane);
}

function Chips({ legend, options, value, onChange }: { readonly legend: string; readonly options: readonly { value: string; label: string }[]; readonly value: readonly string[]; readonly onChange: (value: string[]) => void }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className={cx(LABEL, "mb-1")}>{legend}</legend>
      <ul className="flex min-w-0 flex-wrap gap-1.5">
        {options.map((option) => {
          const on = value.includes(option.value);
          return (
            <li key={option.value}>
              <label
                className={cx(
                  "inline-flex min-h-9 cursor-pointer items-center gap-1.5 border-2 px-2.5 text-[12px] font-bold",
                  on ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#FFD60A]" : "border-[#1A1A1A]/40 text-[#45464B] dark:border-white/25 dark:text-[#A9B6C8]",
                )}
              >
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#1A1A1A]" checked={on} onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((entry) => entry !== option.value))} />
                {option.label}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

export interface LinkBuilderProps {
  readonly apiKey: string;
  readonly contracts: readonly ContractView[] | null;
  /** Whether the key is bound by a rule book (then the builder offers a check). */
  readonly ruleBook: boolean;
  readonly keyId: string | null;
  readonly onCreated: (link: LinkOwnerView) => void;
}

/** "New link": three templates, a live ticket preview, local validation, the Rule Book check, then the link with its card. */
export function LinkBuilder({ apiKey, contracts, ruleBook, keyId, onCreated }: LinkBuilderProps) {
  const [draft, setDraft] = useState<LinkDraft>(() => templateDraft("get-paid"));
  const [touched, setTouched] = useState(false);
  const [sample, setSample] = useState("");
  const [created, setCreated] = useState<LinkOwnerView | null>(null);
  const create = useApiAction((_client, signal, definition: unknown) => keyedClient(apiKey).links.create(definition, { signal: sdkSignal(signal) }));
  const check = useApiAction((_client, signal, body: Parameters<ReturnType<typeof keyedClient>["policies"]["evaluate"]>[0]) =>
    keyedClient(apiKey).policies.evaluate(body, { signal: sdkSignal(signal) }),
  );
  const set = (patch: Partial<LinkDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    check.reset();
  };
  const lane = CHAINS[draft.network]?.lane ?? "production";
  const laneNetworks = networksOnLane(lane);
  const definition = useMemo(() => buildLinkDefinition(draft), [draft]);
  const validation = validateLinkDefinition(definition);
  const issues = validation.ok ? [] : validation.issues;
  const lines = draft.fundingNetworks.map((key) => lineFor(key)).filter((line): line is Line => Boolean(line));
  const destinationNetworks = draft.template === "deposit" ? [...new Set((contracts ?? []).map((contract) => contract.network))] : draft.template === "bridge-stake" ? (["solana"] as NetworkKey[]) : laneNetworks;
  const contractOptions = (contracts ?? []).filter((contract) => contract.network === draft.network);
  const chosenContract = contractOptions.find((contract) => contract.id === draft.contract);
  const payAssets = assetsForNetwork(draft.network).map((asset) => asset.symbol);

  const switchTemplate = (id: LinkTemplateId) => {
    const next = templateDraft(id);
    setDraft({ ...next, publisherName: draft.publisherName, website: draft.website, ...(id === "deposit" && contracts?.[0] ? { network: contracts[0].network, contract: contracts[0].id, entry: contracts[0].actions[0]?.id ?? "deposit" } : {}) });
    setTouched(false);
    check.reset();
    create.reset();
  };

  const runCheck = async () => {
    const account = anyAccount(sample);
    if (!account || !keyId) return;
    const action = { ...destinationAction(draft) };
    if (action.amount === "$amount") {
      const asset = draft.fundingAssets[0] ?? "";
      const bounds = draft.bounds[asset];
      action.amount = bounds?.default?.trim() || bounds?.min?.trim() || "1";
    }
    await check.run({ keyId, request: { actions: [action], accounts: [account] } as unknown as IntentRequest, stage: "plan" });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!validation.ok) return;
    const result = await create.run(validation.value);
    if (result?.link) {
      setCreated(result.link);
      onCreated(result.link);
    }
  };

  if (created) return <LinkCreated link={created} onAnother={() => setCreated(null)} />;

  const evaluation = check.data?.evaluation as PolicyEvaluateResponse["evaluation"] | undefined;
  const domain = hostOf(draft.website.trim());

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] 2xl:items-start">
      <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-6">
        <fieldset className="grid min-w-0 gap-3 md:grid-cols-3">
          <legend className={cx(LABEL, "mb-2 md:col-span-3")}>Template</legend>
          {LINK_TEMPLATES.map((template) => {
            const on = draft.template === template.id;
            return (
              <label key={template.id} className={cx("flex min-w-0 cursor-pointer flex-col gap-1.5 p-3", INK_BORDER, on ? "bg-[#FFD60A] text-[#1A1A1A]" : SURFACE, "has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#0052FF]")}>
                <span className="flex items-center gap-2 font-display text-[15px] font-bold">
                  <input type="radio" name="link-template" className="h-4 w-4 accent-[#1A1A1A]" checked={on} onChange={() => switchTemplate(template.id)} />
                  {template.title}
                </span>
                <span className={cx("text-xs leading-relaxed", on ? "text-[#1A1A1A]" : TEXT_MUTED)}>{template.summary}</span>
              </label>
            );
          })}
        </fieldset>

        <fieldset className="grid min-w-0 gap-4 md:grid-cols-2">
          <legend className={cx(LABEL, "mb-2 md:col-span-2")}>What the page says</legend>
          <TextField label="Title" value={draft.title} maxLength={80} onChange={(event) => set({ title: event.target.value })} error={touched ? issues.find((issue) => issue.path === "title")?.message : undefined} hint="3-80 characters, no dashes or the word Kletia." />
          <TextField label="Description (optional)" value={draft.description} maxLength={280} onChange={(event) => set({ description: event.target.value })} />
          <TextField label="Publisher name" value={draft.publisherName} maxLength={40} onChange={(event) => set({ publisherName: event.target.value })} placeholder="Acme Store" error={touched ? issues.find((issue) => issue.path.startsWith("publisher.name"))?.message : undefined} />
          <TextField
            label="Publisher website (https)"
            value={draft.website}
            onChange={(event) => set({ website: event.target.value })}
            placeholder="https://shop.acme.example"
            spellCheck={false}
            autoComplete="off"
            error={touched ? issues.find((issue) => issue.path.startsWith("publisher.website"))?.message : undefined}
            hint="Required on the production lane; verify it with /.well-known/kletia.json for a green seal."
          />
        </fieldset>

        <fieldset className="grid min-w-0 gap-4 md:grid-cols-2">
          <legend className={cx(LABEL, "mb-2 md:col-span-2")}>Where the money goes (fixed by you)</legend>
          {draft.template === "deposit" && contractOptions.length === 0 && (contracts ?? []).length === 0 ? (
            <p className="text-sm md:col-span-2">
              Register a contract first (Contracts, above): a deposit link calls one of your registered entries.
            </p>
          ) : null}
          <SelectField
            label="Network"
            value={draft.network}
            onChange={(event) => set({ network: event.target.value as NetworkKey, ...(draft.template === "deposit" ? { contract: "" } : {}) })}
            options={(destinationNetworks.length > 0 ? destinationNetworks : [draft.network]).map((key) => ({ value: key, label: CHAINS[key]?.name ?? key }))}
          />
          {draft.template === "get-paid" ? (
            <>
              <TextField label="Recipient (address or name)" mono value={draft.recipient} onChange={(event) => set({ recipient: event.target.value })} placeholder="acme.base.eth or 0x…" spellCheck={false} autoComplete="off" hint="Names are resolved and pinned when you create the link." />
              <TextField label="Amount delivered" mono inputMode="decimal" value={draft.payAmount} onChange={(event) => set({ payAmount: event.target.value })} />
              <SelectField label="Asset" value={draft.payAsset} onChange={(event) => set({ payAsset: event.target.value, fundingAssets: [event.target.value] })} options={payAssets.map((symbol) => ({ value: symbol, label: symbol }))} />
            </>
          ) : draft.template === "deposit" ? (
            <>
              <SelectField
                label="Contract"
                value={draft.contract}
                onChange={(event) => {
                  const contract = contractOptions.find((candidate) => candidate.id === event.target.value);
                  set({ contract: event.target.value, entry: contract?.actions[0]?.id ?? draft.entry });
                }}
                options={[{ value: "", label: contractOptions.length > 0 ? "Choose…" : "No registration on this network" }, ...contractOptions.map((contract) => ({ value: contract.id, label: `${contract.integrator.name} (${contract.id})` }))]}
              />
              <SelectField
                label="Entry"
                value={draft.entry}
                onChange={(event) => set({ entry: event.target.value })}
                options={(chosenContract?.actions ?? []).map((action) => ({ value: action.id, label: `${action.id} · ${action.label}` }))}
              />
            </>
          ) : (
            <SelectField
              label="Stake as"
              value={draft.stakeTo}
              onChange={(event) => set({ stakeTo: event.target.value })}
              options={["JitoSOL", "mSOL", "JupSOL"].map((symbol) => ({ value: symbol, label: symbol }))}
            />
          )}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className={cx(LABEL, "mb-2")}>Where the money may come from (the visitor chooses)</legend>
          <Chips legend="Networks" value={draft.fundingNetworks} onChange={(fundingNetworks) => set({ fundingNetworks: fundingNetworks as NetworkKey[] })} options={laneNetworks.map((key) => ({ value: key, label: CHAINS[key].name }))} />
          {draft.amountMode === "deliver" ? (
            <p className={cx("text-sm", TEXT_MUTED)}>
              The payer brings {draft.payAsset} (or its group) and you receive at least {draft.payAmount || "?"} {draft.payAsset}: Kletia sizes the input with up to three quotes.
            </p>
          ) : (
            <>
              <Chips legend="Assets" value={draft.fundingAssets} onChange={(fundingAssets) => set({ fundingAssets })} options={FUNDING_SYMBOLS.map((symbol) => ({ value: symbol, label: symbol }))} />
              <div className="flex min-w-0 flex-col gap-3">
                {draft.fundingAssets.map((asset) => {
                  const bounds = draft.bounds[asset] ?? { min: "", max: "", default: "" };
                  const setBounds = (patch: Partial<typeof bounds>) => set({ bounds: { ...draft.bounds, [asset]: { ...bounds, ...patch } } });
                  return (
                    <div key={asset} className="grid min-w-0 gap-3 sm:grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] sm:items-end">
                      <p className="font-code text-sm font-bold sm:pb-3">{asset}</p>
                      <TextField label="Min" mono inputMode="decimal" value={bounds.min} onChange={(event) => setBounds({ min: event.target.value })} />
                      <TextField label="Max" mono inputMode="decimal" value={bounds.max} onChange={(event) => setBounds({ max: event.target.value })} />
                      <TextField label="Default" mono inputMode="decimal" value={bounds.default} onChange={(event) => setBounds({ default: event.target.value })} />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <legend className={cx(LABEL, "mb-2 md:col-span-2 xl:col-span-4")}>Bounds Kletia enforces</legend>
          <TextField label="Expires on (UTC)" type="date" value={draft.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} hint="Default 30 days, at most 365." />
          <TextField label="Uses in total" mono inputMode="numeric" value={draft.maxUses} onChange={(event) => set({ maxUses: event.target.value })} placeholder="No limit" />
          <TextField label="Uses per account" mono inputMode="numeric" value={draft.perAccountMaxUses} onChange={(event) => set({ perAccountMaxUses: event.target.value })} placeholder="No limit" />
          <TextField label="Max slippage (bps)" mono inputMode="numeric" value={draft.maxSlippageBps} onChange={(event) => set({ maxSlippageBps: event.target.value })} placeholder="Default" hint="Up to 300." />
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold md:col-span-2">
            <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" checked={draft.blink} onChange={(event) => set({ blink: event.target.checked })} />
            Offer a Solana blink when eligible
          </label>
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold md:col-span-2">
            <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" checked={draft.allowHolds} onChange={(event) => set({ allowHolds: event.target.checked })} />
            Publish even if my rule book holds its intents for approval
          </label>
        </fieldset>

        {ruleBook ? (
          <section aria-label="Rule Book check" className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER_THIN)}>
            <p className="flex items-center gap-2 font-display text-lg font-bold">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              Check against my rule book
            </p>
            <p className={cx("text-sm", TEXT_MUTED)}>
              A link can never widen the key&apos;s rule book. This runs the simulator on the destination with a sample visitor account (a dry run; the API checks the link again when you create it).
            </p>
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <TextField label="Sample visitor account" mono value={sample} onChange={(event) => setSample(event.target.value)} placeholder={`${CHAINS[draft.network]?.id ?? "eip155:8453"}:…`} containerClassName="min-w-0 flex-1" spellCheck={false} />
              <Button variant="secondary" loading={check.status === "loading"} disabled={!anyAccount(sample)} onClick={() => void runCheck()}>
                Run the check
              </Button>
            </div>
            <div aria-live="polite">
              {check.status === "error" && check.error ? <ApiErrorPanel error={check.error} title="The check did not run" /> : null}
              {evaluation ? (
                <div className="flex flex-col gap-2">
                  <p className="font-bold">
                    {evaluation.outcome === "allow" ? "Cleared by the rule books." : evaluation.outcome === "confirm" ? "Its intents would be held for approval: tick the option above to publish anyway." : "Refused: the rule book does not allow this destination."}
                    {evaluation.complete ? "" : " (Planning failed, so only request-level rules ran.)"}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {[...evaluation.violations, ...evaluation.triggers].map((violation, index) => (
                      <li key={`${violation.rule}-${index}`} className="text-sm">
                        <code className="font-code text-xs font-bold">{violation.rule}</code> · {ruleInfo(violation.rule).title}
                        {violation.observed ? ` · observed ${violation.observed}` : ""}
                        {violation.limit ? ` · limit ${violation.limit}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {touched && issues.length > 0 ? (
          <div role="alert" className="flex flex-col gap-1.5 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-4 text-sm text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
            <p className="font-display text-lg font-bold">Fix these before publishing</p>
            {issues.slice(0, 12).map((issue, index) => (
              <p key={`${issue.path}-${index}`}>
                <code className="font-code text-xs font-bold">{issue.path || "link"}</code>: {issue.message}
              </p>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={create.status === "loading"}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Publish the link
          </Button>
          <p className={cx("text-xs", TEXT_MUTED)}>Validated here with validateLinkDefinition first; the API also pins names and contracts and dry-runs one visitor.</p>
        </div>
        <div aria-live="polite">{create.status === "error" && create.error ? <ApiErrorPanel error={create.error} title="The link was not created" /> : null}</div>
      </form>

      <aside aria-label="Preview" className="flex min-w-0 flex-col gap-3 2xl:sticky 2xl:top-28">
        <p className={LABEL}>Preview, as visitors will see it</p>
        <div className="min-w-0 [container-type:inline-size]">
          <LinkTicket
            serial="NEW"
            intent={draftSentence(draft)}
            publisher={{ name: draft.publisherName.trim() || "Your name", domain: domain ?? undefined, verified: false }}
            bounds={draftBounds(draft)}
            networks={lines}
            url={`${typeof window === "undefined" ? "kletiaai.xyz" : window.location.host}/go/lk_…`}
            expires={draft.expiresOn || "In 30 days"}
            uses={draft.maxUses.trim() && Number(draft.maxUses) > 0 ? { used: 0, max: Number(draft.maxUses) } : undefined}
            example
          />
        </div>
        <p className={cx("text-xs", TEXT_MUTED)}>
          New publishers print unverified until their domain file lists the link.{" "}
          <Link to="/developers#recipe-links" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            The links recipe
          </Link>{" "}
          shows the same with the SDK.
        </p>
      </aside>
    </div>
  );
}
