/**
 * The desk's Automations view as pure functions: templates that become
 * drafts for POST /v1/automations (through `planAutomationFromGoal`, so the
 * desk and the API agree on every issue), list rows with the next and last
 * run, and the inbox diff behind the browser notification. No React here:
 * node --test loads it.
 */
import {
  CHAINS,
  formatAccountId,
  planAutomationFromGoal,
  type AccountId,
  type AutomationGoalAction,
  type AutomationGoalTrigger,
  type AutomationRunView,
  type AutomationTrigger,
  type AutomationView,
  type NetworkKey,
  type ValidatedAutomationDraft,
  type ValidationIssue,
  type Weekday,
} from "@kletia/core";

export const AUTOMATION_COPY = Object.freeze({
  title: "Automations",
  signatureNote: "Kletia never signs. Every run plans an intent and waits here for your wallet's signature, unless a protocol's own order type executes it.",
  signIn: "Sign in with your wallet to keep automations. Signing in moves no funds and approves no transaction.",
  inbox: "Waiting for your signature",
  inboxEmpty: "Nothing waits for your signature.",
  review: "Review and sign",
  list: "Your automations",
  listEmpty: "No automations yet. Start from a template.",
  create: "New automation",
  templates: "Templates",
  pause: "Pause",
  resume: "Resume",
  remove: "Delete",
  notify: "Notify me in this browser",
  notifyOn: "Browser notifications are on for this tab.",
  notifyTitle: "A Kletia automation needs your signature",
  next: (when: string) => `Next run ${when}`,
  last: (when: string) => `Last run ${when}`,
  never: "No run yet",
  native: (provider: string) => `Runs through ${provider} without you online`,
  signature: "Each run needs your signature",
});

export type AutomationTemplateId = "dca" | "price-exit" | "best-yield" | "sweep-dust" | "pay-monthly";

export interface AutomationTemplate {
  readonly id: AutomationTemplateId;
  readonly title: string;
  readonly blurb: string;
  /** Field names the form asks for, with their defaults. */
  readonly defaults: Readonly<Record<string, string>>;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = Object.freeze<AutomationTemplate[]>([
  { id: "dca", title: "Buy every week", blurb: "Buy a fixed dollar amount of an asset on the same weekday.", defaults: { asset: "ETH", amountUsd: "50", network: "base", weekday: "mon", at: "09:00" } },
  { id: "price-exit", title: "Take profit or stop loss", blurb: "Sell when the price crosses a line, once per crossing.", defaults: { asset: "SOL", network: "solana", direction: "below", priceUsd: "120", portion: "half" } },
  { id: "best-yield", title: "Keep it in the best yield", blurb: "Move a stablecoin to the best lending rate when another venue pays clearly more.", defaults: { asset: "USDC", network: "base", amount: "100", minDeltaBps: "50" } },
  { id: "sweep-dust", title: "Sweep dust", blurb: "Once a month, swap a small leftover balance to USDC.", defaults: { asset: "DAI", network: "base", dayOfMonth: "1" } },
  { id: "pay-monthly", title: "Pay someone monthly", blurb: "Send a fixed amount on the same day every month.", defaults: { amount: "100", asset: "USDC", network: "base", recipient: "", dayOfMonth: "1" } },
]);

/** Form labels of the template fields. */
export const TEMPLATE_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  asset: "Asset",
  amountUsd: "Amount in USD",
  amount: "Amount",
  network: "Network",
  weekday: "Weekday (mon-sun)",
  at: "Local time (HH:MM)",
  direction: "Direction (above or below)",
  priceUsd: "Price in USD",
  portion: "Sell (half or all)",
  minDeltaBps: "Move when another venue pays this many bps more",
  dayOfMonth: "Day of the month",
  recipient: "Recipient (address or name)",
});

export interface DraftContext {
  readonly now: number;
  /** The signed-in wallet. */
  readonly wallet: { readonly walletKind: "evm" | "solana"; readonly address: string };
  /** The browser's IANA zone (schedules start at the local time once, then step in UTC). */
  readonly timezone: string;
}

/** The wallet's account on `network` (an EVM wallet is the same address on every EVM network). */
export function walletAccountOn(wallet: DraftContext["wallet"], network: NetworkKey): AccountId | null {
  const vm = CHAINS[network]?.vm;
  if ((vm === "evm") !== (wallet.walletKind === "evm")) return null;
  return formatAccountId(network, wallet.address);
}

function networkOf(values: Readonly<Record<string, string>>): NetworkKey {
  return (values.network ?? "base") as NetworkKey;
}

function goalOf(id: AutomationTemplateId, values: Readonly<Record<string, string>>, timezone: string): { trigger: AutomationGoalTrigger; action: AutomationGoalAction; usdCap?: string } {
  const network = networkOf(values);
  const monthly = (day: string): AutomationGoalTrigger => ({ kind: "every", unit: "month", dayOfMonth: Number(day) || 1, at: "09:00", timezone });
  switch (id) {
    case "dca":
      return {
        trigger: { kind: "every", unit: "week", weekday: (values.weekday ?? "mon") as Weekday, at: values.at ?? "09:00", timezone },
        action: { kind: "intent", text: `buy $${values.amountUsd} of ${values.asset} on ${network}` },
        usdCap: values.amountUsd,
      };
    case "price-exit":
      return {
        trigger: { kind: "price", asset: values.asset ?? "", network, direction: values.direction === "above" ? "above" : "below", priceUsd: values.priceUsd ?? "" },
        action: { kind: "intent", text: `sell ${values.portion === "all" ? "all" : "half"} of my ${values.asset} on ${network} for USDC` },
      };
    case "best-yield":
      return {
        trigger: { kind: "best-yield", asset: values.asset ?? "USDC", networks: [network], minDeltaBps: Number(values.minDeltaBps) || 50 },
        action: { kind: "rebalance", amount: values.amount ?? "" },
      };
    case "sweep-dust":
      return { trigger: monthly(values.dayOfMonth ?? "1"), action: { kind: "intent", text: `swap all my ${values.asset} on ${network} to USDC` } };
    case "pay-monthly":
      return {
        trigger: monthly(values.dayOfMonth ?? "1"),
        action: { kind: "intent", text: `send ${values.amount} ${values.asset} to ${values.recipient} on ${network}` },
      };
  }
}

export type TemplateDraft = { readonly ok: true; readonly draft: ValidatedAutomationDraft } | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** A template's form values as a validated draft (the same issues the API would report). */
export function draftFromTemplate(id: AutomationTemplateId, values: Readonly<Record<string, string>>, context: DraftContext): TemplateDraft {
  const account = walletAccountOn(context.wallet, networkOf(values));
  if (!account) return { ok: false, issues: [{ path: "network", message: "Your signed-in wallet cannot hold assets on this network." }] };
  if (id === "pay-monthly" && !values.recipient?.trim()) return { ok: false, issues: [{ path: "recipient", message: "Say who receives the payment." }] };
  const goal = goalOf(id, values, context.timezone);
  const template = AUTOMATION_TEMPLATES.find((entry) => entry.id === id);
  const planned = planAutomationFromGoal(goal, {
    now: context.now,
    accounts: [account],
    ...(template ? { label: template.title } : {}),
    ...(goal.usdCap ? { limits: { maxUsdPerRun: goal.usdCap } } : {}),
  });
  return planned.ok ? { ok: true, draft: planned.value } : { ok: false, issues: planned.issues };
}

/* ------------------------------------------------------------------- rows */

const DAY_MS = 86_400_000;

/** "in 3 h", "in 2 days", "3 min ago", "now". */
export function relativeTime(at: string, now: number): string {
  const delta = Date.parse(at) - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 1) return "now";
  const text = minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(Math.abs(delta) / DAY_MS)} days`;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

export function triggerSummary(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "schedule": {
      const unit = trigger.every.count === 1 ? trigger.every.unit : `${trigger.every.count} ${trigger.every.unit}s`;
      return `Every ${unit}${trigger.maxRuns ? `, ${trigger.maxRuns} times` : ""}`;
    }
    case "price":
      return `When ${trigger.asset} goes ${trigger.direction} $${trigger.priceUsd}`;
    case "balance":
      return `When the ${trigger.asset} balance goes ${trigger.direction} ${trigger.amount}`;
    case "apy":
      return `When another ${trigger.asset} venue pays ${trigger.minDeltaBps / 100}% more`;
    case "event":
      return `When ${trigger.asset} arrives${trigger.minAmount ? ` (at least ${trigger.minAmount})` : ""}`;
  }
}

function actionSummary(view: AutomationView): string {
  if (view.action.kind === "rebalance") return "Move the position to the best venue";
  return view.action.text ?? `${view.action.actions?.length ?? 0} structured actions`;
}

export interface AutomationRow {
  readonly id: string;
  readonly title: string;
  readonly trigger: string;
  readonly action: string;
  readonly status: AutomationView["status"];
  readonly next: string | null;
  readonly last: string;
  readonly execution: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
}

export function automationRow(view: AutomationView, now: number): AutomationRow {
  return {
    id: view.id,
    title: view.label ?? actionSummary(view),
    trigger: triggerSummary(view.trigger),
    action: actionSummary(view),
    status: view.status,
    next: view.nextRunAt ? AUTOMATION_COPY.next(relativeTime(view.nextRunAt, now)) : null,
    last: view.lastRunAt ? AUTOMATION_COPY.last(relativeTime(view.lastRunAt, now)) : AUTOMATION_COPY.never,
    execution: view.execution.mode === "native" ? AUTOMATION_COPY.native(view.execution.provider) : AUTOMATION_COPY.signature,
    canPause: view.status === "active",
    canResume: view.status === "paused",
  };
}

/* ------------------------------------------------------------------- inbox */

export interface InboxRun extends AutomationRunView {
  readonly automationLabel: string | null;
  readonly intentStatus: string;
  readonly intentExpiresAt: string;
}

/** Runs not seen before (the browser notification fires for these only; the first load notifies nothing). */
export function newInboxRuns(seen: ReadonlySet<string> | null, runs: readonly InboxRun[]): InboxRun[] {
  if (seen === null) return [];
  return runs.filter((run) => !seen.has(run.id));
}

/** The task title a run opens with in the desk. */
export function inboxTaskTitle(run: InboxRun): string {
  return run.title ?? run.automationLabel ?? "Automation run";
}
