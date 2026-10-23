/**
 * The canonical sentence: a ready thread written back in the grammar's own
 * sentence shapes, so the engine plans it as plain text
 * (`interpretation.source` stays "grammar") and the sentence compiles to
 * exactly the resolved actions. Steps with no sentence shape (a bridge that
 * pays a third party) render to null; the engine then plans structured
 * actions with the closest sentence kept as the request text.
 */
import type { IntentActionSpec } from "@kletia/core";
import { protocolWord, stakeProvider, VAULT_PROTOCOLS } from "./catalog.js";
import type { ResolvedAction } from "./types.js";

function dependentWord(action: ResolvedAction): string {
  if (!action.portionBps || action.portionBps === 10_000) return "it";
  if (action.portionBps === 5_000) return "half";
  return `${action.portionBps / 100}%`;
}

function vaultSuffix(action: ResolvedAction): string {
  return action.vault && action.protocol && VAULT_PROTOCOLS.includes(action.protocol) ? ` ${action.vault}` : "";
}

/** One step in the grammar's words; `exact` false gives the closest reading for a step with no shape. */
function clause(action: ResolvedAction, index: number): string | null {
  const dependent = action.amount === "max" && index > 0 && action.kind !== "withdraw";
  const amount = dependent ? dependentWord(action) : action.amount === "max" ? "all" : action.amount;
  const asset = dependent ? "" : ` ${action.from}`;
  switch (action.kind) {
    case "swap":
      return `swap ${amount}${asset} to ${action.to} on ${action.network}${action.protocol ? ` via ${protocolWord(action.protocol)}` : ""}`;
    case "bridge":
      if (action.recipient) return null;
      return `bridge ${amount}${asset} from ${action.network} to ${action.toNetwork}${action.to && action.to !== action.from ? ` as ${action.to}` : ""}` +
        `${action.protocol ? ` via ${protocolWord(action.protocol)}` : ""}`;
    case "transfer":
      return `send ${amount}${asset} to ${action.recipient} on ${action.network}`;
    case "stake": {
      const provider = stakeProvider(action.provider);
      return `stake ${amount}${dependent ? "" : ` ${provider?.input ?? action.from}`} with ${provider?.word ?? action.provider ?? "jito"}`;
    }
    case "deposit":
      return `deposit ${amount}${asset} into ${protocolWord(action.protocol as string)}${vaultSuffix(action)} on ${action.network}`;
    case "withdraw":
      return `withdraw ${action.amount === "max" ? "all" : action.amount} ${action.from} from ${protocolWord(action.protocol as string)}${vaultSuffix(action)} on ${action.network}`;
    case "call":
    case "action": {
      const connector = /^(?:withdraw|redeem|claim|unstake|exit|remove|unwrap)$/u.test(action.verb ?? "") ? "from" : "into";
      const spend = action.amount === "" ? "" : dependent ? amount : `${action.amount}${action.from ? ` ${action.from}` : ""}`;
      return `${action.verb}${spend ? ` ${spend}` : ""} ${connector} ${action.alias} on ${action.network}`;
    }
  }
}

/** The canonical sentence of resolved actions, or null when a step has no sentence shape. */
export function render(actions: readonly ResolvedAction[]): string | null {
  const parts: string[] = [];
  for (const [index, action] of actions.entries()) {
    const text = clause(action, index);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.join(", then ");
}

/** The closest sentence for actions that have no full sentence shape (normalizedText of the structured fallback). */
export function closestSentence(actions: readonly ResolvedAction[]): string {
  return actions
    .map((action, index) => clause(action, index) ?? clause({ ...action, recipient: undefined }, index) + ` for ${action.recipient}`)
    .join(", then ");
}

/** Structured actions for the planner (the fallback when no sentence renders). */
export function toActionSpecs(actions: readonly ResolvedAction[]): IntentActionSpec[] {
  return actions.map((action) => {
    const params: Record<string, string | number | boolean> = {};
    if (action.portionBps !== undefined && action.portionBps !== 10_000) params.portionBps = action.portionBps;
    if (action.vault) params.venue = action.vault;
    if (action.kind === "stake") {
      const provider = stakeProvider(action.provider);
      if (provider) params.provider = provider.grammarProvider;
    }
    return {
      kind: action.kind,
      network: action.network,
      ...(action.from ? { from: action.from } : {}),
      ...(action.to ? { to: action.to } : {}),
      ...(action.amount ? { amount: action.amount } : {}),
      ...(action.toNetwork ? { toNetwork: action.toNetwork } : {}),
      ...(action.recipient ? { recipient: action.recipient } : {}),
      ...(action.protocol && action.kind !== "stake" ? { protocol: action.protocol as IntentActionSpec["protocol"] } : {}),
      ...(action.contract ? { contract: action.contract } : {}),
      ...(action.entry ? { entry: action.entry } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      // A payment whose recipient receives exactly the stated amount (the decision layer sets it).
      ...((action as ResolvedAction & { receiveExact?: true }).receiveExact === true && action.recipient ? { receiveExact: true as const } : {}),
    } as IntentActionSpec;
  });
}

/** Resolved actions from planner specs (after departure.ts rewrote them). */
export function fromActionSpecs(specs: readonly IntentActionSpec[], before: readonly ResolvedAction[]): ResolvedAction[] {
  return specs.map((spec) => {
    const twin = before.find((action) => action.kind === spec.kind && action.network === spec.network && action.recipient === spec.recipient && action.contract === spec.contract);
    const bps = typeof spec.params?.portionBps === "number" ? spec.params.portionBps : undefined;
    return {
      ...(twin ?? {}),
      kind: spec.kind as ResolvedAction["kind"],
      network: spec.network,
      ...(spec.toNetwork ? { toNetwork: spec.toNetwork } : {}),
      from: spec.from ?? twin?.from ?? "",
      ...(spec.to ? { to: spec.to } : {}),
      amount: spec.amount ?? "max",
      ...(bps !== undefined ? { portionBps: bps } : {}),
      ...(spec.recipient ? { recipient: spec.recipient } : {}),
      ...(spec.protocol ? { protocol: spec.protocol } : twin?.protocol ? { protocol: twin.protocol } : {}),
    } as ResolvedAction;
  });
}
