/**
 * Network and action scope of a widget (integrator design §4.3): the host
 * names the networks and the kinds of action its page works with, and a plan
 * that reaches outside them is refused before Execute, with the offending
 * steps listed. A UX boundary: the visitor signs everything in their own
 * wallet anyway, and the API enforces scope for publishable keys.
 *
 * Pure (no React), so the `/embed` frame and tests share it.
 */
import {
  CHAINS,
  isNetworkKey,
  parseAccountId,
  PROJECT_ACTIONS,
  type IntentActionKind,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type ProjectAction,
  type SourceNetwork,
} from "@kletia/core";

export type WidgetAction = ProjectAction;
export const WIDGET_ACTIONS: readonly WidgetAction[] = PROJECT_ACTIONS;

export interface WidgetScope {
  /** Networks the plan may touch (bridge destinations and recipients included). Absent: any network. */
  readonly networks?: readonly NetworkKey[];
  /** Kinds of action the plan may use. Absent: any kind. */
  readonly actions?: readonly WidgetAction[];
}

/** The scope a step needs: an unstake counts as staking; kinds outside the list (borrow, call, …) are never in an action scope. */
export function scopeActionOf(kind: IntentActionKind): WidgetAction | null {
  if (kind === "unstake") return "stake";
  return (WIDGET_ACTIONS as readonly string[]).includes(kind) ? (kind as WidgetAction) : null;
}

/** Every network a step touches: where it runs, where a bridge lands and where its recipient lives. */
export function stepNetworks(step: IntentStep): NetworkKey[] {
  const networks = new Set<NetworkKey>([step.network]);
  const destination = step.settlement?.destinationNetwork;
  if (destination) networks.add(destination);
  const recipient = step.recipient ? parseAccountId(step.recipient) : null;
  if (recipient) networks.add(recipient.chain.key);
  return [...networks];
}

export interface ScopeOffence {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly title: string;
  /** Networks of this step outside the scope. */
  readonly networks: readonly NetworkKey[];
  /** The step's kind when it is outside the action scope. */
  readonly kind: IntentActionKind | null;
}

export interface ScopeRefusal {
  /** Networks outside the scope, in order of first use. */
  readonly networks: readonly NetworkKey[];
  /** Kinds outside the scope, in order of first use. */
  readonly kinds: readonly IntentActionKind[];
  readonly steps: readonly ScopeOffence[];
}

/**
 * The steps of `intent` outside `scope`, or `null` when the plan stays inside
 * it (or no scope is set). Steps are read in execution order.
 */
export function outOfScope(intent: Pick<IntentGraph, "steps">, scope: WidgetScope): ScopeRefusal | null {
  const allowedNetworks = scope.networks && scope.networks.length > 0 ? new Set(scope.networks) : null;
  const allowedActions = scope.actions && scope.actions.length > 0 ? new Set(scope.actions) : null;
  if (!allowedNetworks && !allowedActions) return null;
  const networks: NetworkKey[] = [];
  const kinds: IntentActionKind[] = [];
  const steps: ScopeOffence[] = [];
  for (const step of [...intent.steps].sort((a, b) => a.index - b.index)) {
    const outside = allowedNetworks ? stepNetworks(step).filter((network) => !allowedNetworks.has(network)) : [];
    const action = scopeActionOf(step.kind);
    const kindOutside = allowedActions !== null && (action === null || !allowedActions.has(action));
    if (outside.length === 0 && !kindOutside) continue;
    for (const network of outside) if (!networks.includes(network)) networks.push(network);
    if (kindOutside && !kinds.includes(step.kind)) kinds.push(step.kind);
    steps.push({ stepId: step.id, stepIndex: step.index, title: step.title, networks: outside, kind: kindOutside ? step.kind : null });
  }
  return steps.length > 0 ? { networks, kinds, steps } : null;
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  swap: "swaps",
  bridge: "bridges",
  transfer: "transfers",
  stake: "staking",
  unstake: "unstaking",
  deposit: "deposits",
  withdraw: "withdrawals",
};

/** The refusal in words, e.g. "This site works with Base and Solana. This plan also uses Ethereum (step 1)." */
export function describeScopeRefusal(refusal: ScopeRefusal, scope: WidgetScope): string[] {
  const lines: string[] = [];
  if (refusal.networks.length > 0 && scope.networks) {
    const allowed = listText(scope.networks.map((network) => CHAINS[network].name));
    const stepsUsing = refusal.steps.filter((step) => step.networks.length > 0).map((step) => step.stepIndex + 1);
    lines.push(
      `This site works with ${allowed}. This plan also uses ${listText(refusal.networks.map((network) => CHAINS[network].name))} (step${stepsUsing.length === 1 ? "" : "s"} ${listText(stepsUsing.map(String))}).`,
    );
  }
  if (refusal.kinds.length > 0 && scope.actions) {
    const allowed = listText(scope.actions.map((action) => ACTION_WORDS[action] ?? action));
    lines.push(`This site offers ${allowed}. This plan also needs ${listText(refusal.kinds.map((kind) => ACTION_WORDS[kind] ?? kind))}.`);
  }
  return lines;
}

/**
 * Cleans a scope from props or URL values: known network keys of one capital
 * lane (the first valid key's), at most 9, de-duplicated; known actions. An
 * empty result means "no scope".
 */
export function normalizeScope(input: { readonly networks?: readonly unknown[] | null; readonly actions?: readonly unknown[] | null }): WidgetScope {
  const networks: NetworkKey[] = [];
  for (const value of input.networks ?? []) {
    if (!isNetworkKey(value) || networks.includes(value)) continue;
    if (networks.length > 0 && CHAINS[value].environment !== CHAINS[networks[0] as NetworkKey].environment) continue;
    networks.push(value);
  }
  const actions: WidgetAction[] = [];
  for (const value of input.actions ?? []) {
    if (typeof value === "string" && (WIDGET_ACTIONS as readonly string[]).includes(value) && !actions.includes(value as WidgetAction)) actions.push(value as WidgetAction);
  }
  return { ...(networks.length > 0 ? { networks } : {}), ...(actions.length > 0 ? { actions } : {}) };
}

/**
 * The starting network to send with a plan: "auto" or a network key, kept
 * inside the network scope (a key outside it is dropped). `null` means none.
 */
export function scopedSourceNetwork(source: unknown, scope: WidgetScope): SourceNetwork | null {
  if (source === "auto") return "auto";
  if (!isNetworkKey(source)) return null;
  if (scope.networks && scope.networks.length > 0 && !scope.networks.includes(source)) return null;
  return source;
}

/** Virtual machines the scope needs wallets for; both when no network scope is set. */
export function scopeVms(scope: WidgetScope): ReadonlySet<"evm" | "svm"> {
  if (!scope.networks || scope.networks.length === 0) return new Set(["evm", "svm"]);
  return new Set(scope.networks.map((network) => CHAINS[network].vm));
}

/**
 * Reported through `onError` when a plan reaches outside the widget's scope
 * (the `/embed` frame forwards it as `kletia:error` `EMBED_SCOPE_REFUSED`).
 * Carries no addresses or amounts.
 */
export class KletiaScopeError extends Error {
  readonly code = "EMBED_SCOPE_REFUSED";
  readonly refusal: ScopeRefusal;

  constructor(refusal: ScopeRefusal) {
    super("This plan uses networks or actions this widget does not offer, so it was not offered for signing.");
    this.name = "KletiaScopeError";
    this.refusal = refusal;
  }
}
