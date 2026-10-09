/**
 * Rule Book facts from an intent graph (policy design §4.1): the pure core
 * builder (`buildPolicyFacts`) fed with the conservative pricer's
 * micro-dollars and the slippage each step was planned with. At prepare the
 * freshly prepared step's amounts replace the planned ones (the caller hands
 * in the graph as it will be committed) and every amount is re-priced.
 */
import {
  buildPolicyFacts,
  parseAssetId,
  type AssetAmount,
  type IntentGraph,
  type PolicyDocument,
  type PolicyFacts,
  type PolicyStage,
  type StepFacts,
} from "@kletia/core";
import { decodeStepRef } from "../stepRef.js";
import { notionalUsdMicros, policyPrices, type PriceQuote } from "./pricing.js";

export interface FactsOptions {
  readonly stage: PolicyStage;
  /** False for dry runs and the simulator. */
  readonly stored: boolean;
  /**
   * Price every amount with the conservative oracle. Without it every amount
   * is unpriced (null), never the adapters' advisory `usd`: pass true whenever
   * a USD rule exists (`policyNeedsPricing`) or an exposure must be counted.
   */
  readonly price?: boolean;
}

export interface DetailedFacts {
  readonly facts: PolicyFacts;
  /** Price quotes by asset id (null = unpriced); empty when not priced. */
  readonly prices: ReadonlyMap<string, PriceQuote | null>;
  /** Oracle warnings (sources disagree). */
  readonly warnings: readonly string[];
}

function amountsOf(graph: IntentGraph): AssetAmount[] {
  return graph.steps.flatMap((step) => [
    ...(step.input ? [step.input] : []),
    ...(step.expectedOutput ? [step.expectedOutput] : []),
    ...(step.extraCosts ?? []),
  ]);
}

/** Facts plus the quotes behind them (the gate records warnings and notional). */
export async function policyFactsDetailed(graph: IntentGraph, options: FactsOptions): Promise<DetailedFacts> {
  let prices = new Map<string, PriceQuote | null>();
  if (options.price) {
    const assets = amountsOf(graph).flatMap((amount) => {
      const parsed = parseAssetId(amount.asset);
      return parsed ? [{ asset: amount.asset, symbol: amount.symbol, decimals: amount.decimals, network: parsed.chain.key }] : [];
    });
    prices = await policyPrices(assets);
  }
  const price = (amount: AssetAmount): bigint | null => {
    if (!options.price) return null;
    const quote = prices.get(amount.asset);
    if (!quote || !/^\d+$/u.test(amount.amount)) return null;
    return notionalUsdMicros(amount.amount, amount.decimals, quote);
  };
  const slippage = new Map(graph.steps.map((step) => [step.id, decodeStepRef(step.quoteRef)?.slippageBps]));
  const facts = buildPolicyFacts(graph, {
    stage: options.stage,
    stored: options.stored,
    price,
    slippageBps: (stepId) => slippage.get(stepId),
  });
  const warnings = [...new Set([...prices.values()].flatMap((quote) => quote?.warnings ?? []))];
  return { facts, prices, warnings };
}

/** Frozen PF2 interface: facts of a graph (planned, or with a freshly prepared step). */
export async function policyFactsFromGraph(graph: IntentGraph, options: FactsOptions): Promise<PolicyFacts> {
  return (await policyFactsDetailed(graph, options)).facts;
}

/**
 * USD one prepared payload adds to the windows (design §6.2): the step's
 * input notional when it is a root step, plus its priced extra costs.
 * Null when an amount it needs is unpriced (or a value-moving root step has
 * no input amount).
 */
export function stepExposureUsdMicros(facts: PolicyFacts, stepId: string): bigint | null {
  const step = facts.steps.find((candidate) => candidate.id === stepId);
  if (!step) return null;
  let total = 0n;
  if (step.root) {
    if (!step.input) {
      if (!["read", "approve", "claim"].includes(step.kind)) return null;
    } else if (step.input.usdMicros === null) return null;
    else total += step.input.usdMicros;
  }
  for (const cost of step.extraCosts) {
    if (cost.usdMicros === null) return null;
    total += cost.usdMicros;
  }
  return total;
}

/** True when a rule book in the chain has a rule that needs USD (caps, extra costs, confirmation threshold). */
export function policyNeedsPricing(chain: readonly (PolicyDocument | null)[]): boolean {
  return chain.some((document) =>
    document !== null && (
      document.caps !== undefined && Object.values(document.caps).some((value) => value !== undefined) ||
      document.limits?.maxExtraCostUsd !== undefined ||
      document.confirm?.aboveUsd !== undefined
    ));
}

/** Facts of one step (index lookup for messages). */
export function stepFacts(facts: PolicyFacts, stepId: string): StepFacts | undefined {
  return facts.steps.find((step) => step.id === stepId);
}
