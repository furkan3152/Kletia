/**
 * Cross-network legs: crossing amounts and assets, exact-delivery drafts,
 * gas plan steps, route options and crossing insertion.
 */
import {
  CHAINS,
  fromBaseUnits,
  parseAccountId,
  toBaseUnits,
  type AccountId,
  type IntentRequest,
  type IntentStep,
  type NetworkKey,
  type ParsedAccountId,
  ROUTE_PREFERENCES,
  type RoutePreference,
  type RouteScore,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import { accountForNetwork, ownAccountOn, sameAddress } from "../accounts.js";
import type { PlannedStep } from "../adapters/types.js";
import { assetFromRef, sameAsset, type ResolvedAsset } from "../assets.js";
import { GRAMMAR_EXAMPLES } from "../grammar.js";
import { isRecord, portionOf } from "../util.js";
import { readAssetUsd } from "../routing/score.js";
import type { ShapeEvaluation } from "../routing/composer.js";
import { sizeExactDelivery } from "../routing/deliverExact.js";
import type {
  GasPlanFacts,
  GasPlanReader,
  GasPlanStep,
} from "../routing/gasPlan.js";
import { sameFamily, type ShapeCandidate } from "../routing/shapes.js";
import { baseUnits, CONTRACT_KINDS, issue } from "./shared.js";
import type {
  NormalizedAction,
  PreviousStep,
  RouteOptions,
  StepDraft,
} from "./types.js";
import { resolveInput, resolveOutput } from "./resolve.js";
import { gasReserveReader } from "./gasReserve.js";

/* ---------------------------------------------------- composer helpers */

/** The shape a route pin records for a crossing ("swap-bridge-swap:USDC"). */
export function shapePinValue(candidate: Pick<ShapeCandidate, "shape" | "carrier" | "asWritten">): string {
  return `${candidate.shape}:${candidate.asWritten ? "written" : candidate.carrier ?? ""}`;
}

/** The base units a crossing moves (its exact amount, or its share of the previous step's minimum); null when unknown. */
export function crossingAmount(action: NormalizedAction, input: ResolvedAsset, previous: PreviousStep | null): bigint | null {
  if (action.amount.type === "exact") {
    try {
      return BigInt(toBaseUnits(action.amount.value, input.decimals));
    } catch {
      return null;
    }
  }
  if (action.amount.type === "previous" && previous?.step.minimumOutput) return BigInt(portionOf(previous.step.minimumOutput.amount, action.amount.portionBps));
  return null;
}

/**
 * The resolved input and output of a crossing the composer may compare, or
 * null when the step is not composable (its own draft then plans or refuses
 * it as before): the previous output belongs to someone else, a
 * transfer-only asset, or a resolution failure.
 */
export async function crossingAssets(action: NormalizedAction, previous: PreviousStep | null, accounts: readonly ParsedAccountId[]): Promise<{ readonly input: ResolvedAsset; readonly output: ResolvedAsset } | null> {
  try {
    if (action.amount.type === "previous" && previous && !sameAddress(previous.recipient, accountForNetwork(accounts, action.network))) return null;
    const input = await resolveInput(action, previous);
    const output = await resolveOutput(action, input);
    if (input.transferOnly || output.transferOnly || sameAsset(input, output)) return null;
    return { input, output };
  } catch {
    return null;
  }
}

/**
 * The legs of a composed shape as planner actions: the first spends the
 * crossing's amount, every later one the previous leg's whole output (its
 * guaranteed minimum: chained floors); assets by exact id (carriers by
 * address); each leg on the venue its pre-screen chose; the last pays
 * the crossing's recipient.
 */
export function shapeActions(evaluation: ShapeEvaluation, base: NormalizedAction): NormalizedAction[] {
  const legs = evaluation.candidate.legs;
  return legs.map((leg, position): NormalizedAction => {
    const pin = evaluation.legs[position]?.winner.protocol;
    return {
      index: base.index,
      kind: leg.kind,
      network: leg.input.network,
      destinationNetwork: leg.output.network,
      amount: position === 0 ? base.amount : { type: "previous", portionBps: 10_000 },
      from: leg.input.id,
      to: leg.output.id,
      ...(position === legs.length - 1 && base.recipient ? { recipient: base.recipient } : {}),
      ...(pin ? { pin } : {}),
      ...(base.inserted ? { inserted: true as const } : {}),
    };
  });
}

/** The planned route's own value, score and chained minimum (the pre-screen's costs, the real outputs). */
export function realRoute(evaluation: ShapeEvaluation, built: readonly IntentStep[]): { value: number | null; score: RouteScore | null; minimum: bigint | null } {
  const last = built[built.length - 1];
  const minimumOut = last?.minimumOutput;
  const expectedOut = last?.expectedOutput;
  const minimum = minimumOut ? BigInt(minimumOut.amount) : null;
  if (!evaluation.score || !minimumOut || !expectedOut || minimum === null) return { value: evaluation.value, score: evaluation.score, minimum };
  const { estimate: _estimate, ...score } = evaluation.score;
  const priceOut = evaluation.legs[evaluation.legs.length - 1]?.snapshot.prices.out ?? null;
  if (priceOut === null || evaluation.value === null || evaluation.expected === null) return { value: evaluation.value, score, minimum };
  const expected = BigInt(expectedOut.amount);
  const units = (amount: bigint) => Number(amount) / 10 ** expectedOut.decimals;
  const value = evaluation.value + units(expected - evaluation.expected) * priceOut;
  const round = (amount: number) => Math.round(amount * 10_000) / 10_000;
  return {
    value,
    minimum,
    score: { ...score, valueUsd: round(value), expectedUsd: round(units(expected) * priceOut), minimumUsd: round((Number(minimum) / 10 ** minimumOut.decimals) * priceOut) },
  };
}

/**
 * A payment whose recipient receives exactly the stated amount:
 * the input is sized by inverse quoting (routing/deliverExact.ts), at most
 * three plans, runs 2-3 on run 1's venue. The delivered token must be the
 * same family as the spent one (the stated amount names both). A failure
 * refuses with `details { exactDelivery, statedAmount, quotedReceive }`
 * (the decision layer asks DELIVERY_AMOUNT).
 */
export async function exactDeliveryDraft(
  action: NormalizedAction,
  previous: PreviousStep | null,
  draft: (action: NormalizedAction, later: readonly NormalizedAction[]) => Promise<StepDraft>,
  later: readonly NormalizedAction[],
): Promise<StepDraft> {
  if (action.amount.type !== "exact") {
    throw new PlatformError("INVALID_REQUEST", "receiveExact needs an exact amount.", 400, issue(`actions[${action.index}].amount`, "Must be a decimal amount."));
  }
  const input = await resolveInput(action, previous);
  const output = await resolveOutput(action, input);
  if (!sameFamily(input, output)) {
    throw unsupported(
      `receiveExact delivers the token that is sent: ${input.symbol} arrives as ${output.symbol}, so the stated amount would name two tokens. Remove receiveExact, or send ${input.symbol} to receive ${input.symbol}.`,
      GRAMMAR_EXAMPLES,
      issue(`actions[${action.index}].receiveExact`, "Different tokens."),
    );
  }
  const stated = action.amount.value;
  const target = BigInt(baseUnits(stated, output, action.index));
  const sized = await sizeExactDelivery({
    targetUnits: target,
    targetDecimals: output.decimals,
    inputDecimals: input.decimals,
    plan: async (units, check) => {
      const planned = await draft({ ...action, amount: { type: "exact", value: fromBaseUnits(units, input.decimals) } }, later);
      check(BigInt(planned.planned.minimumOutput?.amount ?? "0"));
      return planned;
    },
    unquotable: (detail, last) => new PlatformError(
      "ROUTE_UNSUPPORTED",
      `No quote delivers ${stated} ${output.symbol} to the recipient on ${CHAINS[output.network].name} (${detail}). Send ${stated} ${input.symbol} and let the recipient receive what arrives, or retry shortly.`,
      422,
      issue(`actions[${action.index}].receiveExact`, "Exact delivery could not be quoted."),
      [],
      { exactDelivery: true, statedAmount: stated, quotedReceive: last ? fromBaseUnits(last.minimumUnits, output.decimals) : null },
    ),
  });
  const sent = fromBaseUnits(sized.inputUnits, input.decimals);
  return { ...sized.value, notes: [...sized.value.notes, `The recipient receives at least ${stated} ${output.symbol}; ${sent} ${input.symbol} is sent to cover the crossing's fees.`] };
}

/** The gas plan's reader: the F6 reserve reader on the person's own account there (one read per network and plan). */
export function gasPlanReader(accounts: readonly ParsedAccountId[], ids: readonly AccountId[]): GasPlanReader {
  const reads = new Map<NetworkKey, Promise<GasPlanFacts>>();
  return (network) => {
    let read = reads.get(network);
    if (!read) {
      const account = ownAccountOn(accounts, network);
      read = account
        ? gasReserveReader(network, account, ids).then((facts) => ({ balance: facts.balance, gasPriceWei: facts.gasPriceWei, tokenAccountRentLamports: facts.tokenAccountRentLamports }))
        : Promise.resolve({ balance: null, gasPriceWei: null, tokenAccountRentLamports: null });
      read.catch(() => undefined);
      reads.set(network, read);
    }
    return read;
  };
}

/** One planned step as the gas plan sees it. */
export function gasPlanStep(draft: StepDraft, step: IntentStep, position: number, accounts: readonly ParsedAccountId[]): GasPlanStep {
  const destination = draft.action.destinationNetwork;
  const own = accounts.some((account) => sameAddress(account, draft.recipient));
  const topup = draft.gasTopupUsd !== undefined ? (draft.planned as PlannedStep).gasTopup : undefined;
  return {
    index: position,
    network: draft.action.network,
    kind: draft.action.kind,
    protocol: draft.planned.protocol,
    ...(step.input ? { inputAsset: step.input.asset } : {}),
    transactions: draft.planned.transactionCount,
    ...(destination !== draft.action.network && own
      ? { arrives: { network: destination, native: draft.output?.isNative === true, ...(topup ? { topupUnits: BigInt(topup.amount) } : {}) } }
      : {}),
  };
}

/**
 * `constraints.routePreference`, `routeShapes` and `allowCrossings`: from the
 * validated request, else from the raw input with strict types (the request
 * validator does not carry them yet; a wrong type is ignored, never guessed).
 */
export function routeOptionsOf(input: unknown, request: IntentRequest): RouteOptions {
  const validated = (request.constraints ?? {}) as Record<string, unknown>;
  const raw = isRecord(input) && isRecord(input.constraints) ? input.constraints : {};
  const pick = (key: string): unknown => (validated[key] !== undefined ? validated[key] : raw[key]);
  const preference = pick("routePreference");
  const shapes = pick("routeShapes");
  return {
    ...(typeof preference === "string" && (ROUTE_PREFERENCES as readonly string[]).includes(preference) ? { routePreference: preference as RoutePreference } : {}),
    ...(shapes === "auto" || shapes === "single" ? { routeShapes: shapes } : {}),
    allowCrossings: pick("allowCrossings") === true,
  };
}

/** The request the planner plans with: the validated request plus its route options. */
export function withRouteOptions(request: IntentRequest, options: RouteOptions): IntentRequest {
  if (!options.routePreference && !options.routeShapes && !options.allowCrossings) return request;
  return {
    ...request,
    constraints: {
      ...(request.constraints ?? {}),
      ...(options.routePreference ? { routePreference: options.routePreference } : {}),
      ...(options.routeShapes ? { routeShapes: options.routeShapes } : {}),
      ...(options.allowCrossings ? { allowCrossings: true } : {}),
    },
  };
}

/** True when a raw recipient is one of the request's own accounts. */
export function ownRecipient(raw: string, accounts: readonly ParsedAccountId[]): boolean {
  const parsed = parseAccountId(raw);
  const address = (parsed?.address ?? raw).trim().toLowerCase();
  return accounts.some((account) => account.address.toLowerCase() === address);
}

/**
 * Strict-path safety net (I6): a step that spends the previous
 * step's output on another network gets a crossing leg (a bridge, or a
 * cross-network convert chosen like any other crossing) that carries the
 * step's share of that output, and an `interpretation.optimizations` note.
 * It never spends other funds on the step's own network instead.
 *
 * Only a step whose network was said (text) or given (structured actions)
 * gets a crossing; payments to someone else (their receiving network is
 * purpose, I13) and dependent bridges never do.
 *
 * Refused instead of bridged, in this order:
 * - the previous output is paid to someone else (the recipient guard runs
 *   before any crossing is inserted: a third party's output is never
 *   replaced by the person's own funds);
 * - the previous step is a bridge, whose destination the person said, or the
 *   crossing would return the funds to a network they already left (a
 *   contradiction, never a round trip);
 * - call / action steps (registrations run where they are registered).
 * Structured `actions[]` keep refusing a network mismatch unless the request
 * sets `constraints.allowCrossings`.
 */
export function insertCrossings(
  actions: readonly NormalizedAction[],
  source: "structured" | "grammar",
  allowCrossings: boolean,
  accounts: readonly ParsedAccountId[],
  explicitNetwork: readonly boolean[],
): { readonly actions: NormalizedAction[]; readonly notes: string[] } {
  const out: NormalizedAction[] = [];
  const notes: string[] = [];
  let path: NetworkKey[] = [];
  for (const action of actions) {
    const previous = out[out.length - 1];
    if (action.amount.type !== "previous" || !previous) {
      path = [action.network, ...(action.destinationNetwork !== action.network ? [action.destinationNetwork] : [])];
      out.push(action);
      continue;
    }
    const landed = previous.destinationNetwork;
    // Only a step whose own network was said (or is explicit in structured actions) is bridged to; a payment to
    // someone else, whose receiving network is purpose (I13), and a dependent bridge from another network keep
    // the refusal (resolveInput), never a crossing chosen for them.
    const said = source === "structured" || explicitNetwork[action.index] === true;
    if (landed === action.network || (source === "structured" && !allowCrossings) || !said ||
      action.kind === "transfer" || action.kind === "bridge" ||
      CONTRACT_KINDS.includes(action.kind) || CONTRACT_KINDS.includes(previous.kind)) {
      if (action.destinationNetwork !== action.network) path.push(action.destinationNetwork);
      out.push(action);
      continue;
    }
    const step = action.index + 1;
    const here = CHAINS[action.network].name;
    const there = CHAINS[landed].name;
    if (previous.kind === "transfer" || (previous.recipient !== undefined && !ownRecipient(previous.recipient, accounts))) {
      throw unsupported(
        `Step ${step} spends the output of step ${action.index}, but that output is paid to ${previous.recipient ?? "another account"}, not to your account. Give step ${step} an explicit amount.`,
        GRAMMAR_EXAMPLES,
        issue(`actions[${action.index}].amount`, "The previous step pays another account."),
      );
    }
    if (previous.kind === "bridge") {
      throw unsupported(
        `Step ${step} runs on ${here}, but step ${action.index} bridges the funds to ${there}. Kletia will not bridge them again or use other funds on ${here}. Say one network: run step ${step} on ${there}, or bridge to ${here} in step ${action.index}.`,
        GRAMMAR_EXAMPLES,
        issue(`actions[${action.index}].network`, "Contradicts the previous step's destination."),
      );
    }
    if (path.includes(action.network) || (action.destinationNetwork !== action.network && [...path, landed].includes(action.destinationNetwork))) {
      throw unsupported(
        `Step ${step} runs on ${here}, a network these funds already left. Kletia will not move them back and forth; rewrite the request with one route.`,
        GRAMMAR_EXAMPLES,
        issue(`actions[${action.index}].network`, "A round trip."),
      );
    }
    out.push(
      {
        index: action.index,
        kind: "bridge",
        network: landed,
        destinationNetwork: action.network,
        amount: { type: "previous", portionBps: action.amount.portionBps },
        ...(action.from ? { to: action.from } : {}),
        inserted: true,
      },
      { ...action, amount: { type: "previous", portionBps: 10_000 } },
    );
    notes.push(`Added a bridge from ${there} to ${here} between steps ${action.index} and ${step}: step ${step} runs on ${here}.`);
    path.push(action.network);
    if (action.destinationNetwork !== action.network) path.push(action.destinationNetwork);
  }
  return { actions: out, notes };
}

/** Plans an intent into a quote-backed IntentGraph (not persisted). */
/** USD of every priced extra cost of the plan (fees paid on top of the inputs). */
export function extraCostsUsdOf(steps: readonly IntentStep[]): number {
  return steps.reduce((total, step) => total + (step.extraCosts ?? []).reduce((sum, cost) => sum + (cost.usd !== undefined && Number.isFinite(cost.usd) ? cost.usd : 0), 0), 0);
}

/**
 * USD value moved into the plan: the inputs of steps that do not spend a
 * previous step's output, at their own `usd` or the score's prices; null
 * when any of them cannot be priced (the fee sanity rule then does not apply).
 */
export async function valueMovedUsd(steps: readonly IntentStep[]): Promise<number | null> {
  let total = 0;
  for (const step of steps) {
    if (step.funding || !step.input) continue;
    if (step.input.usd !== undefined && Number.isFinite(step.input.usd)) {
      total += step.input.usd;
      continue;
    }
    let asset: ResolvedAsset;
    try {
      asset = assetFromRef(step.input);
    } catch {
      return null;
    }
    const price = await readAssetUsd(asset);
    if (price === null) return null;
    total += Number(fromBaseUnits(step.input.amount, step.input.decimals)) * price;
  }
  return total > 0 ? total : null;
}
