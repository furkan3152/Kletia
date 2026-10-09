/**
 * Static check of a link against its publisher key's Rule Book chain
 * (intent-links design §8, at creation): every intent the expansion table
 * can produce is evaluated as synthetic facts at its largest amount, so a
 * link that its own key would refuse is reported before anyone opens it
 * (L3 answers LINK_POLICY_CONFLICT with the rule ids), and reachable holds
 * are listed (refused unless the body sets `allowHolds`).
 *
 * Statically unknown: which venue wins an auction (protocol rules), fees,
 * slippage and settlement times (`limits.*`). Those are judged when each
 * visitor's intent is planned; this check never replaces that evaluation.
 */
import {
  CHAINS,
  evaluatePolicyChain,
  formatAccountId,
  linkFundingAsset,
  linkFundingOptions,
  toBaseUnits,
  type AccountId,
  type AssetDescriptor,
  type AssetRef,
  type NetworkKey,
  type PolicyFacts,
  type PolicyViolation,
  type StepFacts,
  type StoredLinkDefinition,
  type VirtualMachine,
} from "@kletia/core";
import { listedAsset } from "../policy/feeds.js";
import { notionalUsdMicros, policyPrices } from "../policy/pricing.js";
import type { PolicyChainLevel } from "../policy/ports.js";

export interface LinkPolicyCheck {
  /** Rules every (or some) reachable intent would break: the link conflicts with its key's rule book. */
  readonly conflicts: readonly PolicyViolation[];
  /** Confirmation triggers reachable intents would raise (held for approval). */
  readonly holds: readonly PolicyViolation[];
}

/** Rules a static check cannot judge (auction winners, quotes). */
const DYNAMIC_RULES = new Set(["protocols.allow", "protocols.deny", "limits.maxSlippageBps", "limits.maxFeeUsd", "limits.maxSeconds", "limits.maxExtraCostUsd", "schedule.window"]);

const PLACEHOLDER: Readonly<Record<VirtualMachine, string>> = { evm: "0x000000000000000000000000000000000000c0de", svm: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" };

function visitor(network: NetworkKey): AccountId {
  return formatAccountId(CHAINS[network], PLACEHOLDER[CHAINS[network].vm]) as AccountId;
}

function ref(asset: AssetDescriptor): AssetRef & { readonly network: NetworkKey } {
  return { asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network: asset.network };
}

/** Evaluates every reachable intent shape of a link against a chain (root first). */
export async function linkPolicyCheck(input: { readonly link: StoredLinkDefinition; readonly levels: readonly PolicyChainLevel[]; readonly now?: number }): Promise<LinkPolicyCheck> {
  const { definition, pins } = input.link;
  const actions = definition.destination.actions;
  const first = actions[0];
  if (!first) return { conflicts: [], holds: [] };
  const destinationNetwork = first.network;
  const destination = listedAsset(pins.destinationAsset.asset);
  const deliver = definition.funding.amount.mode === "deliver";
  const options = linkFundingOptions(definition.funding);
  const outputs = actions.flatMap((action) => (typeof action.to === "string" ? [linkFundingAsset(action.toNetwork ?? action.network, action.to)] : [])).filter((asset): asset is AssetDescriptor => asset !== null);
  const prices = await policyPrices([...options.map((option) => ref(option.asset)), ...(destination ? [ref(destination)] : []), ...outputs.map(ref)]);
  const price = (asset: AssetDescriptor, units: bigint): bigint | null => {
    const quote = prices.get(asset.id);
    return quote ? notionalUsdMicros(units, asset.decimals, quote) : null;
  };
  const facts = (asset: AssetDescriptor, units: bigint) => ({
    asset: asset.id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount: units.toString(),
    listed: true,
    category: asset.category,
    ...(asset.group ? { group: asset.group } : {}),
    usdMicros: price(asset, units),
  });
  const recipientOf = (index: number, network: NetworkKey): AccountId =>
    pins.recipients.find((pin) => pin.action === index)?.account ?? visitor(network);

  const conflicts = new Map<string, PolicyViolation>();
  const holds = new Map<string, PolicyViolation>();
  for (const option of options) {
    const source = option.asset;
    let units: bigint;
    try {
      if (deliver) {
        const fixed = toBaseUnits(String(first.amount ?? "0"), pins.destinationAsset.decimals);
        units = BigInt(fixed) * 10n ** BigInt(Math.max(0, source.decimals - pins.destinationAsset.decimals)) / 10n ** BigInt(Math.max(0, pins.destinationAsset.decimals - source.decimals));
      } else {
        const bounds = definition.funding.amount.bounds[option.symbol];
        if (!bounds) continue;
        units = BigInt(toBaseUnits(bounds.max, source.decimals));
      }
    } catch {
      continue;
    }
    const sameAsset = destination !== null && source.id === destination.id;
    const rootUsd = price(source, units);
    const steps: StepFacts[] = [];
    const accounts = new Set<AccountId>([visitor(option.network)]);
    const bridge = option.network !== destinationNetwork;
    // Deliver links funded from another network: the transfer rides inside the bridge (one step).
    const absorbed = deliver && bridge;
    if (bridge || !sameAsset) {
      steps.push({
        id: "s1",
        index: 0,
        kind: bridge ? "bridge" : "swap",
        protocol: "relay",
        network: option.network,
        ...(bridge ? { destinationNetwork } : {}),
        root: true,
        input: facts(source, units),
        ...(destination ? { output: { ...facts(destination, 0n), usdMicros: rootUsd } } : {}),
        recipient: absorbed ? recipientOf(0, destinationNetwork) : visitor(destinationNetwork),
        external: false,
        slippageBps: 0,
        extraCosts: [],
      });
      accounts.add(visitor(destinationNetwork));
    }
    if (!absorbed) {
      actions.forEach((action, index) => {
        const network = action.network;
        const pin = pins.contracts.find((entry) => entry.action === index);
        const output = typeof action.to === "string" ? linkFundingAsset(action.toNetwork ?? network, action.to) : null;
        const root = steps.length === 0;
        // A funded step spends what the previous one produced: its notional is at most the root's.
        const input = index === 0 && destination ? (root ? facts(destination, units) : { ...facts(destination, 0n), usdMicros: rootUsd }) : undefined;
        accounts.add(visitor(network));
        steps.push({
          id: `s${steps.length + 1}`,
          index: steps.length,
          kind: action.kind,
          protocol: action.kind === "call" ? "custom-call" : action.kind === "action" ? "solana-actions" : action.protocol ?? "relay",
          network,
          ...(action.toNetwork && action.toNetwork !== network ? { destinationNetwork: action.toNetwork } : {}),
          root,
          ...(input ? { input } : {}),
          ...(output ? { output: { ...facts(output, 0n), usdMicros: rootUsd } } : {}),
          recipient: action.recipient !== undefined ? recipientOf(index, action.toNetwork ?? network) : visitor(action.toNetwork ?? network),
          external: false,
          ...(pin ? { contract: { id: pin.contract, entry: pin.entry, target: pin.target } } : {}),
          slippageBps: 0,
          extraCosts: [],
        });
      });
    }
    const networks: NetworkKey[] = [];
    for (const step of steps) for (const network of [step.network, step.destinationNetwork]) if (network && !networks.includes(network)) networks.push(network);
    const shape: PolicyFacts = {
      stage: "plan",
      stored: true,
      accounts: [...accounts],
      steps,
      intent: { stepCount: steps.length, networks, feesUsdMicros: 0n, notionalUsdMicros: null, crossNetwork: steps.some((step) => step.destinationNetwork !== undefined) },
    };
    const evaluation = evaluatePolicyChain(
      input.levels.map((level) => ({ policy: level.policy, scope: level.scope, keyId: level.id, defaults: level.defaults })),
      shape,
      { ...(input.now !== undefined ? { now: input.now } : {}), keyActive: true },
    );
    const label = `${option.symbol} on ${option.network}`;
    for (const violation of evaluation.allViolations) {
      if (DYNAMIC_RULES.has(violation.rule)) continue;
      const key = `${violation.rule}|${violation.keyId ?? violation.scope}|${violation.path ?? ""}|${violation.observed ?? ""}`;
      if (!conflicts.has(key)) conflicts.set(key, { ...violation, message: `${violation.message} (funding ${label})` });
    }
    for (const trigger of evaluation.triggers) {
      const key = `${trigger.rule}|${trigger.keyId ?? trigger.scope}`;
      if (!holds.has(key)) holds.set(key, { ...trigger, message: `${trigger.message} (funding ${label})` });
    }
  }
  return { conflicts: [...conflicts.values()], holds: [...holds.values()] };
}
