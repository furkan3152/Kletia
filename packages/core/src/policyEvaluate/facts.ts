/**
 * Asset registry checks, own accounts, notional values and building
 * policy facts from an intent.
 */
import { ASSETS } from "../assets.js";
import { CHAINS, type NetworkKey } from "../chains.js";
import {
  formatAssetId,
  parseAssetId,
  sameAddressAccount,
  type AssetId,
} from "../caip.js";
import type { AssetAmount, IntentActionKind, IntentGraph } from "../intent.js";
import { YIELD_VENUES } from "../protocols.js";
import { formatUsdMicros } from "../policy.js";
import type {
  AssetFacts,
  PolicyFacts,
  PolicyStage,
  StepFacts,
} from "./rules.js";

/** Registry descriptor of an asset id (EVM addresses compared case-insensitively). */
export const REGISTRY = new Map(ASSETS.map((asset) => [normalizeAssetIdText(asset.id), asset]));

/**
 * Position tokens of core yield venues (aTokens, Comet, vault shares, mTokens, jlTokens). They are
 * never in `ASSETS` (receipt symbols are ambiguous), but they are fixed by the venue registry rather
 * than named by a request, so `assets.unlisted` does not treat them as unlisted: otherwise the agent
 * default would refuse every lending deposit and withdrawal. `assets.allow` and `assets.categories`
 * still apply to them as written.
 */
const VENUE_RECEIPT_TOKENS: ReadonlySet<string> = new Set(
  YIELD_VENUES.flatMap((venue) =>
    "receipt" in venue ? [normalizeAssetIdText(formatAssetId(venue.network, CHAINS[venue.network].vm === "svm" ? "token" : "erc20", venue.receipt.address))] : [],
  ),
);

/** True when `assets.unlisted` lets the asset through: a registry asset or a core venue's position token. */
export function listedForPolicy(asset: string): boolean {
  const id = normalizeAssetIdText(asset);
  return REGISTRY.has(id) || VENUE_RECEIPT_TOKENS.has(id);
}

export function normalizeAssetIdText(asset: string): string {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : asset;
}

function networkOfAsset(asset: string): NetworkKey | null {
  return parseAssetId(asset)?.chain.key ?? null;
}

/** True when an asset matches one normalised `assets.allow` entry. Unlisted tokens only ever match their exact CAIP-19 id. */
export function assetMatchesEntry(asset: AssetId, entry: string): boolean {
  const id = normalizeAssetIdText(asset);
  if (entry.includes("/")) return id === entry;
  const descriptor = REGISTRY.get(id);
  if (!descriptor) return false;
  if (entry.startsWith("group:")) return descriptor.group === entry.slice(6);
  const at = entry.lastIndexOf("@");
  if (at > 0) return descriptor.symbol.toUpperCase() === entry.slice(0, at).toUpperCase() && descriptor.network === entry.slice(at + 1);
  return descriptor.symbol.toUpperCase() === entry.toUpperCase();
}

/** True when `account` is one of `own` (same address on any chain of its namespace). */
export function isOwnAccount(own: readonly string[], account: string): boolean {
  return own.some((candidate) => sameAddressAccount(candidate, account));
}

/** Kinds that move no value of their own (a missing input is then not an unknown amount). */
const NO_INPUT_KINDS: ReadonlySet<IntentActionKind> = new Set(["read", "approve", "claim"]);

/** True when a step moves value but its input amount is unknown (fail closed under USD rules). */
export function inputUnknown(step: StepFacts): boolean {
  return step.input === undefined && !NO_INPUT_KINDS.has(step.kind);
}

/**
 * Fresh value: Σ input notional of root steps + Σ priced extra costs
 * of every step; null when any is unpriced (a value-moving root step without
 * an input amount counts as unpriced).
 */
export function policyNotionalUsdMicros(steps: readonly StepFacts[]): { readonly value: bigint | null; readonly unpriced: readonly string[] } {
  let total = 0n;
  const unpriced: string[] = [];
  for (const step of steps) {
    if (step.root && inputUnknown(step)) unpriced.push(`steps[${step.index}].input`);
    if (step.root && step.input) {
      if (step.input.usdMicros === null) unpriced.push(`steps[${step.index}].input`);
      else total += step.input.usdMicros;
    }
    step.extraCosts.forEach((cost, index) => {
      if (cost.usdMicros === null) unpriced.push(`steps[${step.index}].extraCosts[${index}]`);
      else total += cost.usdMicros;
    });
  }
  return { value: unpriced.length > 0 ? null : total, unpriced };
}

export const usdText = (micros: bigint | null) => (micros === null ? "unpriced" : formatUsdMicros(micros));

export function laneOf(network: NetworkKey): string {
  return CHAINS[network].lane;
}

/**
 * Builds facts from an intent graph (pure). `price` returns the conservative
 * USD value of an amount in micro-dollars (rounded up), or null when
 * unpriced; without it the graph's reported `usd` values are used (the SDK
 * signer guard). The engine passes its pricer's results.
 */
export function buildPolicyFacts(
  graph: IntentGraph,
  options: {
    readonly stage: PolicyStage;
    readonly stored: boolean;
    readonly price?: (amount: AssetAmount) => bigint | null;
    /** Slippage per step when the caller knows it from the step ref (default: expected vs minimum output). */
    readonly slippageBps?: (stepId: string) => number | undefined;
  },
): PolicyFacts {
  const funded = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const price = options.price ?? ((amount: AssetAmount) => (typeof amount.usd === "number" && Number.isFinite(amount.usd) && amount.usd >= 0 ? BigInt(Math.ceil(amount.usd * 1_000_000)) : null));
  const assetFacts = (amount: AssetAmount): AssetFacts => {
    const descriptor = REGISTRY.get(normalizeAssetIdText(amount.asset));
    return {
      asset: amount.asset,
      symbol: amount.symbol,
      decimals: amount.decimals,
      amount: amount.amount,
      listed: descriptor !== undefined,
      ...(descriptor ? { category: descriptor.category, ...(descriptor.group ? { group: descriptor.group } : {}) } : {}),
      usdMicros: price(amount),
    };
  };
  const steps = graph.steps.map((step): StepFacts => {
    const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
    const recipient = step.recipient ?? step.account;
    let slippage = options.slippageBps?.(step.id);
    if (slippage === undefined) {
      const expected = step.expectedOutput;
      const minimum = step.minimumOutput;
      slippage = 0;
      if (expected && minimum && expected.asset === minimum.asset && BigInt(expected.amount) > 0n && BigInt(minimum.amount) < BigInt(expected.amount)) {
        const gap = BigInt(expected.amount) - BigInt(minimum.amount);
        slippage = Number((gap * 10_000n + BigInt(expected.amount) - 1n) / BigInt(expected.amount));
      }
    }
    const estimated = step.estimatedSeconds ?? step.settlement?.expectedSeconds;
    return {
      id: step.id,
      index: step.index,
      kind: step.kind,
      protocol: step.protocol,
      network: step.network,
      ...(destination ? { destinationNetwork: destination } : {}),
      root: !funded.has(step.id),
      ...(step.input ? { input: assetFacts(step.input) } : {}),
      ...(step.expectedOutput ? { output: assetFacts(step.expectedOutput) } : {}),
      recipient,
      ...(step.recipientName ? { recipientName: step.recipientName } : {}),
      external: !isOwnAccount(graph.request.accounts, recipient),
      ...(step.call ? { contract: { id: step.call.contract, entry: step.call.entry, target: step.call.target } } : {}),
      slippageBps: slippage,
      extraCosts: (step.extraCosts ?? []).map(assetFacts),
      ...(estimated !== undefined ? { estimatedSeconds: estimated } : {}),
    };
  });
  const networks: NetworkKey[] = [];
  for (const step of steps) {
    for (const network of [step.network, step.destinationNetwork]) if (network && !networks.includes(network)) networks.push(network);
  }
  const fees = graph.steps.map((step) => (typeof step.feesUsd === "number" && Number.isFinite(step.feesUsd) && step.feesUsd >= 0 ? BigInt(Math.ceil(step.feesUsd * 1_000_000)) : step.mode === "wallet" ? null : 0n));
  return {
    stage: options.stage,
    stored: options.stored,
    accounts: graph.request.accounts,
    steps,
    intent: {
      stepCount: graph.steps.length,
      networks,
      feesUsdMicros: fees.some((fee) => fee === null) ? null : fees.reduce<bigint>((sum, fee) => sum + (fee as bigint), 0n),
      notionalUsdMicros: policyNotionalUsdMicros(steps).value,
      crossNetwork: steps.some((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network),
    },
  };
}
