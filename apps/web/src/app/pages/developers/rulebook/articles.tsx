import {
  ASSET_CATEGORIES,
  ASSET_GROUPS,
  CHAINS,
  CONFIRM_TRIGGERS,
  INTENT_ACTION_KINDS,
  POLICY_PERMISSIONS,
  PROTOCOLS,
  type ContractView,
  type NetworkKey,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyPermission,
} from "@kletia/core";
import type { PolicySpendReport } from "@kletia/sdk";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cx, FOCUS_RING, INK_BORDER_THIN, TEXT_MUTED } from "../../../site/ui/styles";
import { formatUsd, formatWhen, usageRatio } from "../portal/portalFormat";
import { ChipsControl, ClauseRow, LinesControl, SelectControl, SwitchControl, TextControl, type ControlIds } from "./clauses";
import { ARTICLES, CONFIRM_TTL_OPTIONS, DELAY_OPTIONS, getIn } from "./policyModel";
import { TimetableGrid } from "./TimetableGrid";

export interface ArticleContext {
  readonly defaults: PolicyDefaults;
  /** The project rule book (no key): permissions do not apply. */
  readonly isProject: boolean;
  readonly keyExpiresAt: string | null | undefined;
  readonly contracts: readonly ContractView[] | null;
  readonly projectKeys: readonly { readonly id: string; readonly name: string }[];
  readonly spend: PolicySpendReport["scopes"][number] | null;
  readonly now: number;
  readonly issuesFor: (path: string) => string[];
  readonly warningsFor: (path: string) => string[];
  readonly changeOf: (path: string) => "tightened" | "loosened" | null;
  readonly delayText: string;
  readonly disabled: boolean;
  readonly isOpen: (article: number) => boolean;
  readonly toggle: (article: number) => void;
  readonly summary: (article: number) => string;
  readonly marks: (article: number) => { readonly issues: number; readonly changed: boolean };
}

export interface ArticleProps {
  readonly draft: PolicyDocument;
  readonly set: (path: readonly string[], value: unknown) => void;
  readonly ctx: ArticleContext;
}

const PERMISSION_TEXT: Readonly<Record<PolicyPermission, { label: string; meaning: string }>> = {
  createChildKeys: { label: "Create agent keys", meaning: "Issue agent keys under itself (never above two levels)." },
  webhooks: { label: "Manage webhooks", meaning: "Create, delete and test webhooks." },
  registerContracts: { label: "Register contracts", meaning: "Register, update and reverify custom contracts." },
  sessions: { label: "Create sessions", meaning: "Create embed sessions for its fixed actions." },
  storeIntents: { label: "Store intents", meaning: "Store intents (POST /v1/intents without a dry run). On by default." },
  mcpCreateIntents: { label: "Store intents through MCP", meaning: "Use the MCP create_intent tool." },
  links: { label: "Publish links", meaning: "Create intent links, bounded by this rule book." },
};

/**
 * One article of the booklet: a tab that shows its number, name and what it
 * says now; opening it shows the clauses. Articles with an issue, or changed
 * in the draft, say so on the tab.
 */
function Article({ n, ctx, children }: { readonly n: number; readonly ctx: ArticleContext; readonly children: ReactNode }) {
  const info = ARTICLES[n - 1]!;
  const open = ctx.isOpen(n);
  const marks = ctx.marks(n);
  return (
    <section id={`rb-article-${n}`} aria-labelledby={`rb-article-${n}-title`} className={cx("flex min-w-0 flex-col", INK_BORDER_THIN, open ? "bg-white dark:bg-[#131E32]" : "")}>
      <h5 id={`rb-article-${n}-title`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`rb-article-${n}-body`}
          onClick={() => ctx.toggle(n)}
          className={cx("flex w-full min-w-0 items-start gap-3 p-3 text-left sm:p-4", FOCUS_RING, "focus-visible:-outline-offset-4")}
        >
          <span className="kl-rb-plate shrink-0">
            Art. <b>{info.n}</b>
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
              <span className="font-display text-lg font-bold tracking-[-0.01em]">{info.name}</span>
              <span className={cx("text-[13px] font-semibold", TEXT_MUTED)}>{info.title}</span>
            </span>
            <span className="mt-0.5 block break-words font-code text-[12px] font-semibold">{ctx.summary(n)}</span>
            {marks.issues > 0 || marks.changed ? (
              <span className="mt-1 flex flex-wrap gap-2">
                {marks.issues > 0 ? (
                  <span className="border-2 border-[#B91C1C] px-1.5 font-code text-[10px] font-black uppercase tracking-[0.08em] text-[#B91C1C] dark:border-[#FCA5A5] dark:text-[#FCA5A5]">
                    {marks.issues} {marks.issues === 1 ? "issue" : "issues"}
                  </span>
                ) : null}
                {marks.changed ? (
                  <span className="border-2 border-dashed border-[#1A1A1A] px-1.5 font-code text-[10px] font-black uppercase tracking-[0.08em] dark:border-white/60">Changed in the draft</span>
                ) : null}
              </span>
            ) : null}
          </span>
          <ChevronDown className={cx("mt-1 h-5 w-5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
        </button>
      </h5>
      {open ? (
        <div id={`rb-article-${n}-body`} className="min-w-0 border-t-2 border-dashed border-[#1A1A1A]/20 px-3 pb-4 pt-4 dark:border-white/10 sm:px-5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The clause row wired to the context (issues, warnings, tighten/loosen stamp). */
function Clause({
  ctx,
  code,
  field,
  label,
  meaning,
  wide,
  children,
}: {
  readonly ctx: ArticleContext;
  readonly code: string;
  readonly field: string;
  readonly label: string;
  readonly meaning: ReactNode;
  readonly wide?: boolean;
  readonly children: (ids: ControlIds) => ReactNode;
}) {
  return (
    <ClauseRow
      wide={wide}
      code={code}
      field={field}
      label={label}
      meaning={meaning}
      issues={ctx.issuesFor(field)}
      warnings={ctx.warningsFor(field)}
      change={ctx.changeOf(field)}
      delayText={ctx.delayText}
    >
      {children}
    </ClauseRow>
  );
}

function list(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

const agentDefault = (ctx: ArticleContext, agentText: string, projectText = "No limit") => (ctx.defaults === "agent" ? agentText : projectText);

/* 1 Service ----------------------------------------------------------- */
export function ServiceArticle({ draft, set, ctx }: ArticleProps) {
  const mode = draft.mode ?? "live";
  return (
    <Article n={1} ctx={ctx}>
      <Clause ctx={ctx} code="§1.1" field="mode" label="Service" meaning="Live plans and prepares; dry run only plans and quotes; paused stops everything new.">
        {(ids) => (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="kl-rb-lamp" data-aspect={mode} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <SelectControl
              ids={ids}
              disabled={ctx.disabled}
              value={draft.mode ?? ""}
              onChange={(value) => set(["mode"], value || undefined)}
              options={[
                { value: "", label: "Live (default)" },
                { value: "live", label: "Live" },
                { value: "dry-run", label: "Dry run: plans and quotes only" },
                { value: "paused", label: "Paused: nothing new" },
              ]}
            />
          </div>
        )}
      </Clause>
      <ClauseRow code="§1.2" field="key.expiresAt" label="Key expiry" meaning="Set on the key itself (PATCH /v1/keys/{id}); shortening applies at once, extending is a loosening.">
        {(ids) => (
          <p id={ids.id} className="font-code text-sm font-bold">
            {ctx.isProject ? "Project rule book: no expiry." : ctx.keyExpiresAt ? `Expires ${formatWhen(ctx.keyExpiresAt)}` : "No expiry"}
          </p>
        )}
      </ClauseRow>
      <Clause ctx={ctx} code="§1.3" field="label" label="Label" meaning="A name for this rule book, at most 64 characters. Printed on the cover.">
        {(ids) => <TextControl ids={ids} disabled={ctx.disabled} value={draft.label ?? ""} onChange={(value) => set(["label"], value || undefined)} placeholder="Payouts bot" />}
      </Clause>
    </Article>
  );
}

/* 2 Lines ------------------------------------------------------------- */
export function LinesArticle({ draft, set, ctx }: ArticleProps) {
  const networks = (Object.keys(CHAINS) as NetworkKey[]).map((key) => ({ value: key, label: CHAINS[key].name }));
  return (
    <Article n={2} ctx={ctx}>
      <Clause ctx={ctx} code="§2.1" field="networks.allow" label="Networks" meaning="Every step's network, and a bridge's destination, must be listed.">
        {(ids) => <ChipsControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["networks", "allow"]))} onChange={(value) => set(["networks", "allow"], value)} options={networks} anyLabel="Any network" />}
      </Clause>
      <Clause ctx={ctx} code="§2.2" field="networks.lanes" label="Lanes" meaning="Production and testnet are separate capital and never share a plan.">
        {(ids) => (
          <ChipsControl
            ids={ids}
            disabled={ctx.disabled}
            value={list(getIn(draft, ["networks", "lanes"]))}
            onChange={(value) => set(["networks", "lanes"], value)}
            options={[
              { value: "production", label: "Production" },
              { value: "testnet", label: "Testnet" },
            ]}
            anyLabel="Both lanes"
          />
        )}
      </Clause>
    </Article>
  );
}

/* 3 Carriers ---------------------------------------------------------- */
export function CarriersArticle({ draft, set, ctx }: ArticleProps) {
  const venues = PROTOCOLS.filter((protocol) => protocol.capabilities.includes("execute") || protocol.capabilities.includes("quote")).map((protocol) => ({ value: protocol.id, label: protocol.name }));
  return (
    <Article n={3} ctx={ctx}>
      <Clause ctx={ctx} code="§3.1" field="kinds.allow" label="Kinds of step" meaning="Transfer, swap, bridge, stake, deposit, withdraw, a custom call or action, and the rest.">
        {(ids) => (
          <ChipsControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["kinds", "allow"]))} onChange={(value) => set(["kinds", "allow"], value)} options={INTENT_ACTION_KINDS.map((kind) => ({ value: kind, label: kind }))} anyLabel="Any kind" />
        )}
      </Clause>
      <Clause ctx={ctx} code="§3.2" field="protocols.allow" label="Allowed venues" meaning="Only these venues may carry a step. Leave on Any to let the planner choose.">
        {(ids) => <ChipsControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["protocols", "allow"]))} onChange={(value) => set(["protocols", "allow"], value)} options={venues} anyLabel="Any venue" />}
      </Clause>
      <Clause ctx={ctx} code="§3.3" field="protocols.deny" label="Denied venues" meaning="Never these venues. Deny always wins over allow.">
        {(ids) => (
          <ChipsControl
            ids={ids}
            disabled={ctx.disabled}
            value={list(getIn(draft, ["protocols", "deny"])) ?? undefined}
            onChange={(value) => set(["protocols", "deny"], value && value.length > 0 ? value : undefined)}
            options={venues}
            anyLabel="Deny none"
          />
        )}
      </Clause>
    </Article>
  );
}

/* 4 Private sidings --------------------------------------------------- */
export function SidingsArticle({ draft, set, ctx }: ArticleProps) {
  const allow = draft.contracts?.allow;
  const contracts = ctx.contracts ?? [];
  const isOn = (id: string) => allow?.find((entry) => entry.id === id);
  const update = (next: { id: string; entries?: readonly string[] }[] | undefined) => set(["contracts", "allow"], next);
  return (
    <Article n={4} ctx={ctx}>
      <Clause
        ctx={ctx}
        code="§4.1"
        field="contracts.allow"
        label="Registered contracts"
        meaning={agentDefault(ctx, "Agent default: none. Only the registrations and entries listed here.", "Absent: every registration the key may use.")}
      >
        {(ids) => (
          <div id={ids.id} aria-describedby={ids.describedBy} className="flex min-w-0 flex-col gap-2">
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 self-start text-sm font-bold">
              <input type="checkbox" className="h-4 w-4 accent-[#0052FF]" disabled={ctx.disabled} checked={allow === undefined} onChange={(event) => update(event.target.checked ? undefined : [])} />
              {ctx.defaults === "agent" ? "Default (none)" : "Any registration the key may use"}
            </label>
            {allow !== undefined ? (
              contracts.length === 0 ? (
                <p className={cx("text-sm", TEXT_MUTED)}>No registrations visible to the key in memory. With none listed, no custom contract may be called.</p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                  {contracts.map((contract) => {
                    const entry = isOn(contract.id);
                    return (
                      <li key={contract.id} className={cx("min-w-0 p-2.5", INK_BORDER_THIN)}>
                        <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm font-bold">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#0052FF]"
                            disabled={ctx.disabled}
                            checked={Boolean(entry)}
                            onChange={(event) => update(event.target.checked ? [...allow, { id: contract.id }] : allow.filter((item) => item.id !== contract.id))}
                          />
                          <span className="min-w-0 break-words">{contract.integrator.name}</span>
                          <code className={cx("font-code text-[11px]", TEXT_MUTED)}>{contract.id}</code>
                        </label>
                        {entry ? (
                          <div className="ml-6 flex flex-wrap gap-x-4 gap-y-1">
                            {contract.actions.map((action) => {
                              const all = entry.entries === undefined;
                              const on = all || entry.entries!.includes(action.id);
                              return (
                                <label key={action.id} className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 text-[13px]">
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 accent-[#0052FF]"
                                    disabled={ctx.disabled}
                                    checked={on}
                                    onChange={(event) => {
                                      const current = all ? contract.actions.map((item) => item.id) : [...entry.entries!];
                                      const nextEntries = event.target.checked ? [...current, action.id] : current.filter((id) => id !== action.id);
                                      const full = contract.actions.every((item) => nextEntries.includes(item.id));
                                      update(allow.map((item) => (item.id === contract.id ? (full ? { id: contract.id } : { id: contract.id, entries: nextEntries }) : item)));
                                    }}
                                  />
                                  <code className="font-code">{action.id}</code>
                                </label>
                              );
                            })}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
          </div>
        )}
      </Clause>
    </Article>
  );
}

/* 5 Cargo ------------------------------------------------------------- */
export function CargoArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={5} ctx={ctx}>
      <Clause ctx={ctx} code="§5.1" field="assets.allow" label="Assets" meaning={<>One per line: a symbol (USDC), a symbol on a network (USDC@base), a group ({ASSET_GROUPS.map((group) => `group:${group}`).join(", ")}) or a CAIP-19 id.</>}>
        {(ids) => <LinesControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["assets", "allow"]))} onChange={(value) => set(["assets", "allow"], value)} placeholder={"group:USDC\nETH@base"} />}
      </Clause>
      <Clause ctx={ctx} code="§5.2" field="assets.categories" label="Categories" meaning="Only assets of these categories.">
        {(ids) => (
          <ChipsControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["assets", "categories"]))} onChange={(value) => set(["assets", "categories"], value)} options={ASSET_CATEGORIES.map((category) => ({ value: category, label: category }))} anyLabel="Any category" />
        )}
      </Clause>
      <Clause
        ctx={ctx}
        code="§5.3"
        field="assets.unlisted"
        label="Unlisted tokens"
        meaning="Tokens outside the registry. Position tokens of the registry's lending venues (aTokens, vault shares) count as listed."
      >
        {(ids) => (
          <SelectControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.assets?.unlisted ?? ""}
            onChange={(value) => set(["assets", "unlisted"], value || undefined)}
            options={[
              { value: "", label: ctx.defaults === "agent" ? "Default (deny)" : "Default (allow)" },
              { value: "deny", label: "Deny" },
              { value: "allow", label: "Allow" },
            ]}
          />
        )}
      </Clause>
    </Article>
  );
}

/* 6 Passengers -------------------------------------------------------- */
export function PassengersArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={6} ctx={ctx}>
      <Clause ctx={ctx} code="§6.1" field="accounts.allow" label="Accounts" meaning="CAIP-10 accounts the intent may spend from, one per line; eip155:*:0x… matches every EVM network.">
        {(ids) => <LinesControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["accounts", "allow"]))} onChange={(value) => set(["accounts", "allow"], value)} placeholder="eip155:*:0x4f18…" rows={3} />}
      </Clause>
    </Article>
  );
}

/* 7 Destinations ------------------------------------------------------ */
export function DestinationsArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={7} ctx={ctx}>
      <Clause ctx={ctx} code="§7.1" field="recipients.mode" label="Recipients" meaning="Own: only the intent's own accounts. Allowlist: those and the list below. Any: anyone not denied.">
        {(ids) => (
          <SelectControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.recipients?.mode ?? ""}
            onChange={(value) => set(["recipients", "mode"], value || undefined)}
            options={[
              { value: "", label: ctx.defaults === "agent" ? "Default (own accounts only)" : "Default (any)" },
              { value: "own", label: "Own accounts only" },
              { value: "allowlist", label: "Own accounts and the allowlist" },
              { value: "any", label: "Anyone not denied" },
            ]}
          />
        )}
      </Clause>
      <Clause ctx={ctx} code="§7.2" field="recipients.allow" label="Allowlist" meaning="CAIP-10 patterns or names (ENS, Basenames, SNS), one per line.">
        {(ids) => <LinesControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["recipients", "allow"]))} onChange={(value) => set(["recipients", "allow"], value)} placeholder={"eip155:8453:0x1111…\nacme.base.eth"} />}
      </Clause>
      <Clause ctx={ctx} code="§7.3" field="recipients.deny" label="Denylist" meaning="Never these recipients, whatever the mode.">
        {(ids) => <LinesControl ids={ids} disabled={ctx.disabled} value={list(getIn(draft, ["recipients", "deny"]))} onChange={(value) => set(["recipients", "deny"], value)} />}
      </Clause>
      <Clause ctx={ctx} code="§7.4" field="recipients.names" label="Names" meaning="Deny names, check them after resolving (resolve), or trust a listed name whatever it resolves to (trusted).">
        {(ids) => (
          <SelectControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.recipients?.names ?? ""}
            onChange={(value) => set(["recipients", "names"], value || undefined)}
            options={[
              { value: "", label: "Default (resolve)" },
              { value: "deny", label: "Deny names" },
              { value: "resolve", label: "Resolve, then check" },
              { value: "trusted", label: "Trusted names" },
            ]}
          />
        )}
      </Clause>
    </Article>
  );
}

/* 8 Fares ------------------------------------------------------------- */
function Gauge({ used, cap, label }: { readonly used: string | null | undefined; readonly cap: string | null | undefined; readonly label: string }) {
  const ratio = usageRatio(used, cap);
  if (ratio === null) return null;
  const level = ratio >= 0.95 ? "full" : ratio >= 0.8 ? "warn" : "ok";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="kl-rb-gauge" data-level={level} aria-hidden="true">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <p className="font-code text-[11px] font-bold">
        {label}: {formatUsd(used ?? "0")} of {formatUsd(cap)} used ({Math.round(ratio * 100)}%)
      </p>
    </div>
  );
}

export function FaresArticle({ draft, set, ctx }: ArticleProps) {
  const usd = (path: readonly string[], field: string, label: string, meaning: string, gauge?: ReactNode) => (
    <Clause ctx={ctx} code="§8" field={field} label={label} meaning={meaning}>
      {(ids) => (
        <div className="flex min-w-0 flex-col gap-2">
          <TextControl ids={ids} disabled={ctx.disabled} prefix="$" inputMode="decimal" value={text(getIn(draft, path))} onChange={(value) => set(path, value.trim() ? value.trim() : undefined)} placeholder="No cap" />
          {gauge}
        </div>
      )}
    </Clause>
  );
  const int = (path: readonly string[], field: string, label: string, meaning: string, placeholder: string) => (
    <Clause ctx={ctx} code="§8" field={field} label={label} meaning={meaning}>
      {(ids) => (
        <TextControl
          ids={ids}
          disabled={ctx.disabled}
          inputMode="numeric"
          value={text(getIn(draft, path))}
          onChange={(value) => set(path, value.trim() ? (Number.isFinite(Number(value)) ? Number(value) : value) : undefined)}
          placeholder={placeholder}
        />
      )}
    </Clause>
  );
  const spend = ctx.spend;
  return (
    <Article n={8} ctx={ctx}>
      {usd(["caps", "perStepUsd"], "caps.perStepUsd", "Per step", "The USD value of each step, priced fresh at prepare.")}
      {usd(["caps", "perIntentUsd"], "caps.perIntentUsd", "Per intent", "The fresh USD value of the whole intent.")}
      {usd(["caps", "dailyUsd"], "caps.dailyUsd", "Per day", "Rolling 24 hours of exposure, counted when a payload is handed out (not when it lands).", spend ? <Gauge used={spend.usedDailyUsd} cap={spend.capDailyUsd} label="Last 24 hours" /> : null)}
      {usd(["caps", "weeklyUsd"], "caps.weeklyUsd", "Per week", "Rolling 7 days of exposure.", spend ? <Gauge used={spend.usedWeeklyUsd} cap={spend.capWeeklyUsd} label="Last 7 days" /> : null)}
      {int(["limits", "maxSteps"], "limits.maxSteps", "Steps", "At most this many steps per intent (1-8).", "No limit")}
      {int(["limits", "maxSlippageBps"], "limits.maxSlippageBps", "Slippage (basis points)", "Tightens the intent's own slippage before planning (1-1000).", "No limit")}
      {usd(["limits", "maxExtraCostUsd"], "limits.maxExtraCostUsd", "Extra cost per step", "Value paid on top of the input, such as a bridge's fixed fee.")}
      {usd(["limits", "maxFeeUsd"], "limits.maxFeeUsd", "Network fees per intent", "Estimated network fees of the whole intent.")}
      {int(["limits", "maxSeconds"], "limits.maxSeconds", "Settlement time (seconds)", "Each cross-network step's settlement estimate (10-86400).", "No limit")}
      {spend ? null : <p className={cx("pt-3 text-xs", TEXT_MUTED)}>Usage gauges appear once the key's spend windows load.</p>}
    </Article>
  );
}

/* 9 Timetable --------------------------------------------------------- */
export function TimetableArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={9} ctx={ctx}>
      <Clause ctx={ctx} wide code="§9.1" field="schedule" label="Open hours" meaning="Payloads are prepared only inside a window (the key's time zone, daylight saving included). Plans outside one carry a warning.">
        {(ids) => (
          <TimetableGrid labelId={ids.labelId} describedBy={ids.describedBy} schedule={draft.schedule} onChange={(schedule) => (ctx.disabled ? undefined : set(["schedule"], schedule))} now={ctx.now} />
        )}
      </Clause>
    </Article>
  );
}

/* 10 Inspection ------------------------------------------------------- */
export function InspectionArticle({ draft, set, ctx }: ArticleProps) {
  const triggers: Readonly<Record<string, string>> = {
    "external-recipient": "Pays a recipient outside the request's accounts",
    "contract-call": "Calls a custom contract",
    "cross-network": "Crosses networks",
  };
  return (
    <Article n={10} ctx={ctx}>
      <Clause ctx={ctx} code="§10.1" field="confirm.aboveUsd" label="Hold above" meaning="Intents worth more than this wait for an approver.">
        {(ids) => <TextControl ids={ids} disabled={ctx.disabled} prefix="$" inputMode="decimal" value={draft.confirm?.aboveUsd ?? ""} onChange={(value) => set(["confirm", "aboveUsd"], value.trim() || undefined)} placeholder="Never" />}
      </Clause>
      <Clause ctx={ctx} code="§10.2" field="confirm.when" label="Also hold when" meaning="More triggers is tighter.">
        {(ids) => (
          <ChipsControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.confirm?.when ? [...draft.confirm.when] : undefined}
            onChange={(value) => set(["confirm", "when"], value && value.length > 0 ? value : undefined)}
            options={CONFIRM_TRIGGERS.map((trigger) => ({ value: trigger, label: triggers[trigger] ?? trigger }))}
            anyLabel="No other trigger"
          />
        )}
      </Clause>
      <Clause ctx={ctx} code="§10.3" field="confirm.approvers.keys" label="Approver keys" meaning="Only these project keys may approve (none listed: any project key outside the requester's subtree). Adding approvers is a loosening.">
        {(ids) => (
          <ChipsControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.confirm?.approvers?.keys ? [...draft.confirm.approvers.keys] : undefined}
            onChange={(value) => set(["confirm", "approvers", "keys"], value && value.length > 0 ? value : undefined)}
            options={ctx.projectKeys.map((key) => ({ value: key.id, label: key.name }))}
            anyLabel="Any project key"
          />
        )}
      </Clause>
      <Clause ctx={ctx} code="§10.4" field="confirm.approvers.wallets" label="Approver wallets" meaning="CAIP-10 wallets that may approve by signing (EIP-712 on EVM, a message on Solana), one per line.">
        {(ids) => (
          <LinesControl ids={ids} disabled={ctx.disabled} value={draft.confirm?.approvers?.wallets ? [...draft.confirm.approvers.wallets] : undefined} onChange={(value) => set(["confirm", "approvers", "wallets"], value)} placeholder="eip155:8453:0x9a…" />
        )}
      </Clause>
      <Clause ctx={ctx} code="§10.5" field="confirm.approvers.requireWallet" label="Wallet only" meaning="Only a listed wallet's signature approves; keys cannot.">
        {(ids) => (
          <SwitchControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.confirm?.approvers?.requireWallet}
            onChange={(value) => set(["confirm", "approvers", "requireWallet"], value)}
            defaultText="Default (keys or wallets)"
            onText="Wallets only"
            offText="Keys or wallets"
          />
        )}
      </Clause>
      <Clause ctx={ctx} code="§10.6" field="confirm.ttlSeconds" label="Hold time" meaning="An undecided approval expires after this long.">
        {(ids) => <SelectControl ids={ids} disabled={ctx.disabled} value={text(draft.confirm?.ttlSeconds)} onChange={(value) => set(["confirm", "ttlSeconds"], value ? Number(value) : undefined)} options={CONFIRM_TTL_OPTIONS} />}
      </Clause>
    </Article>
  );
}

/* 11 Staff ------------------------------------------------------------ */
export function StaffArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={11} ctx={ctx}>
      {ctx.defaults !== "agent" ? (
        <p className={cx("text-sm", TEXT_MUTED)}>Permissions apply to agent keys only; project keys and the project rule book ignore them.</p>
      ) : (
        POLICY_PERMISSIONS.map((permission) => {
          const info = PERMISSION_TEXT[permission];
          return (
            <Clause key={permission} ctx={ctx} code="§11" field={`permissions.${permission}`} label={info.label} meaning={info.meaning}>
              {(ids) => (
                <SwitchControl
                  ids={ids}
                  disabled={ctx.disabled}
                  value={draft.permissions?.[permission]}
                  onChange={(value) => set(["permissions", permission], value)}
                  defaultText={permission === "storeIntents" ? "Default (allowed)" : "Default (not allowed)"}
                  onText="Allowed"
                  offText="Not allowed"
                />
              )}
            </Clause>
          );
        })
      )}
    </Article>
  );
}

/* 12 Execution -------------------------------------------------------- */
export function ExecutionArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={12} ctx={ctx}>
      <Clause
        ctx={ctx}
        code="§12.1"
        field="execution.pinNonce"
        label="Pin the nonce"
        meaning="EVM payloads carry the account's nonce, so preparing a step again replaces its exposure instead of adding one, and a landed transaction on another nonce is recorded."
      >
        {(ids) => (
          <SwitchControl
            ids={ids}
            disabled={ctx.disabled}
            value={draft.execution?.pinNonce}
            onChange={(value) => set(["execution", "pinNonce"], value)}
            defaultText={ctx.defaults === "agent" ? "Default (pinned)" : "Default (not pinned)"}
            onText="Pinned"
            offText="Not pinned"
          />
        )}
      </Clause>
    </Article>
  );
}

/* 13 Amendments ------------------------------------------------------- */
export function AmendmentsArticle({ draft, set, ctx }: ArticleProps) {
  return (
    <Article n={13} ctx={ctx}>
      <Clause
        ctx={ctx}
        code="§13.1"
        field="amendments.delaySeconds"
        label="Loosening delay"
        meaning="A change that loosens anything waits this long; tightening is always at once. The delay in force is the current version's, so it cannot be removed and used in the same save."
      >
        {(ids) => <SelectControl ids={ids} disabled={ctx.disabled} value={text(draft.amendments?.delaySeconds)} onChange={(value) => set(["amendments", "delaySeconds"], value ? Number(value) : undefined)} options={DELAY_OPTIONS} />}
      </Clause>
    </Article>
  );
}

/** All 13 articles of the booklet, in order. */
export function RuleBookArticles(props: ArticleProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ServiceArticle {...props} />
      <LinesArticle {...props} />
      <CarriersArticle {...props} />
      <SidingsArticle {...props} />
      <CargoArticle {...props} />
      <PassengersArticle {...props} />
      <DestinationsArticle {...props} />
      <FaresArticle {...props} />
      <TimetableArticle {...props} />
      <InspectionArticle {...props} />
      <StaffArticle {...props} />
      <ExecutionArticle {...props} />
      <AmendmentsArticle {...props} />
    </div>
  );
}
