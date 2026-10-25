/**
 * Planner entry points: planIntent and planIntentWithPreviews.
 */
import {
  CHAINS,
  CUSTOM_CONTRACT_WARNING,
  deriveIntentStatus,
  getProtocol,
  INTENT_SPEC_VERSION,
  validateIntentGraph,
  validateIntentRequest,
  buildPlanRecord,
  planRecordDigest,
  type IntentActionSpec,
  type IntentEdge,
  type IntentDeparture,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type RouteChoice,
  type RouteScore,
} from "@kletia/core";
import { PlatformError, toPlatformError } from "../../errors.js";
import { accountForNetwork, ownAccountOn, parseAccounts } from "../accounts.js";
import { candidateAdapters } from "../adapters/registry.js";
import type { AdapterRoute, PlannedStepPreview } from "../adapters/types.js";
import { resolveAsset, type ResolvedAsset } from "../assets.js";
import {
  DEFAULT_MAX_SECONDS,
  runVenueAuction,
  type QuoteContact,
} from "../auction.js";
import { pickFundedSource, resolveDeparture } from "../departure.js";
import { onlyPreviewAccounts } from "../holdings.js";
import {
  compileIntentText,
  MissingSourceError,
  type GrammarResult,
} from "../grammar.js";
import { screenIntentRequest } from "../secretScreen.js";
import { newIntentId } from "../util.js";
import {
  assertFeeSanity,
  assertSignatureCap,
  PlanBudget,
} from "../routing/caps.js";
import { assertWithinDeadline, remainingMs } from "../routing/deadline.js";
import { readAssetUsd } from "../routing/score.js";
import { providersContacted, routeChoice } from "../routing/snapshot.js";
import {
  compareShapes,
  RUNNER_UP_MIN_BUDGET_MS,
  shouldPlanRunnerUp,
  type LegQuoter,
  type ShapeEvaluation,
} from "../routing/composer.js";
import { currentRoutePin, legPinKey } from "../routing/deliverExact.js";
import { compositeRouteChoice } from "../routing/explain.js";
import {
  arrivalGasState,
  gasShortfallError,
  gasUnknownWarning,
  planGas,
} from "../routing/gasPlan.js";
import {
  compositesAllowed,
  enumerateShapes,
  sameFamily,
  type LegSpec,
} from "../routing/shapes.js";
import {
  CONTRACT_KINDS,
  DEFAULT_SLIPPAGE_BPS,
  GRAMMAR_REFUSALS,
  intentTtl,
  issue,
} from "./shared.js";
import { normalizeActions } from "./normalize.js";
import type {
  NormalizedAction,
  PlanOptions,
  PlanTrace,
  PreviousStep,
  StepDraft,
} from "./types.js";
import { noCandidates } from "./resolve.js";
import { canMerge, draftStep } from "./draft.js";
import { dlnEligible } from "./gasReserve.js";
import { buildStep, contractPhrases, summarize } from "./build.js";
import {
  crossingAmount,
  crossingAssets,
  exactDeliveryDraft,
  extraCostsUsdOf,
  gasPlanReader,
  gasPlanStep,
  insertCrossings,
  ownRecipient,
  realRoute,
  routeOptionsOf,
  shapeActions,
  shapePinValue,
  valueMovedUsd,
  withRouteOptions,
} from "./crossings.js";

export async function planIntent(input: unknown, options: PlanOptions = {}): Promise<IntentGraph> {
  return (await planIntentWithPreviews(input, options)).graph;
}

export interface PlannedIntent {
  readonly graph: IntentGraph;
  /**
   * Plan-time quote transactions by step id (asset-change preview): what the
   * winning quotes already returned, never stored in the graph.
   */
  readonly previews: ReadonlyMap<string, PlannedStepPreview>;
}

/**
 * Plans an intent and also returns the winning quotes' transactions for the
 * plan-time preview. The graph carries its immutable plan record
 * (`graph.plan`), dry runs included.
 */
export async function planIntentWithPreviews(input: unknown, options: PlanOptions = {}): Promise<PlannedIntent> {
  // Also here for callers that plan without creating (POST /v1/policy/evaluate): secrets are never planned.
  screenIntentRequest(input);
  const validated = validateIntentRequest(input);
  if (!validated.ok) {
    throw new PlatformError("INVALID_REQUEST", "The intent request is invalid.", 400, validated.issues);
  }
  const request = validated.value;
  const nowMs = options.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  if (request.constraints?.deadline !== undefined && request.constraints.deadline * 1000 <= nowMs) {
    throw new PlatformError("DEADLINE_PASSED", "constraints.deadline is in the past.", 422, issue("constraints.deadline", "In the past."));
  }
  const accounts = parseAccounts(request.accounts);

  // A departure the clarify layer applied is kept as is; sourceNetwork is then ignored (never applied twice).
  const suppliedDeparture = options.interpretation?.departure;
  const sourceNetwork = suppliedDeparture ? undefined : request.sourceNetwork;
  const fixedSource = sourceNetwork !== undefined && sourceNetwork !== "auto" ? sourceNetwork : undefined;
  const readBalance = options.readBalance;
  let departure: IntentDeparture | undefined = suppliedDeparture;
  const plannerWarnings: string[] = [];

  let source: "structured" | "grammar";
  let specs: readonly IntentActionSpec[];
  let explicitNetwork: readonly boolean[];
  let normalizedText: string | undefined;
  let confidence = 1;
  if (request.actions && request.actions.length > 0) {
    source = "structured";
    specs = request.actions;
    // Structured actions name their networks: they win over a departure like a sentence that names one.
    explicitNetwork = specs.map(() => true);
  } else {
    const contracts = await contractPhrases(options.contractAuthorityKeyId ?? options.ownerKeyId);
    const compile = (defaultNetwork: NetworkKey | undefined): GrammarResult => compileIntentText(request.text ?? "", {
      ...(defaultNetwork ? { defaultNetwork } : {}),
      accounts: request.accounts,
      ...(contracts.length > 0 ? { contracts } : {}),
    });
    // A fixed departure also serves as defaultNetwork when the request has none.
    const defaultNetwork = request.defaultNetwork ?? fixedSource;
    let compiled: GrammarResult;
    try {
      try {
        compiled = compile(defaultNetwork);
      } catch (error) {
        // auto: a bridge whose sentence names no source starts on the best-funded network.
        if (sourceNetwork !== "auto" || !(error instanceof MissingSourceError)) throw error;
        const picked = await pickFundedSource(error.missing, request.accounts, request, readBalance);
        compiled = compile(picked.network);
        departure = picked.departure;
      }
    } catch (error) {
      // The strict grammar could not read the text (the strict Goal-reader fallback in service.ts may take it).
      if (error instanceof PlatformError && error.code === "INTENT_UNSUPPORTED") GRAMMAR_REFUSALS.add(error);
      throw error;
    }
    source = "grammar";
    specs = compiled.actions;
    explicitNetwork = compiled.explicitNetwork;
    normalizedText = compiled.normalizedText;
    confidence = compiled.confidence;
    plannerWarnings.push(...compiled.warnings);
  }
  if (sourceNetwork !== undefined && departure === undefined) {
    const resolved = await resolveDeparture(specs, explicitNetwork, request, request.accounts, readBalance);
    specs = resolved.actions;
    // Kept aligned with the actions (a departure bridge is prepended unsaid): the safety net reads it.
    explicitNetwork = resolved.explicitNetwork.length === specs.length ? resolved.explicitNetwork : specs.map(() => false);
    departure = resolved.departure;
    plannerWarnings.push(...resolved.warnings);
  }
  // Route options: routePreference, routeShapes and allowCrossings shape every choice below.
  const routeOptions = routeOptionsOf(input, request);
  const planning = withRouteOptions(request, routeOptions);
  const normalized = normalizeActions(specs, planning);
  // Strict-path safety net: dependent steps on another network get a crossing leg, or are refused.
  const crossed = insertCrossings(normalized, source, routeOptions.allowCrossings, accounts, explicitNetwork);
  const actions = crossed.actions;
  await options.beforeQuote?.(actions.map((action) => ({ network: action.network, destinationNetwork: action.destinationNetwork })));
  // Registrations resolve against the contract authority (a flow's saver) when one is given.
  const contractKeyId = options.contractAuthorityKeyId ?? options.ownerKeyId;

  const drafts: StepDraft[] = [];
  const optimizations: string[] = [...crossed.notes];
  const trace: PlanTrace = { budget: new PlanBudget(), contacts: [] };
  let previous: PreviousStep | null = null;
  const steps: IntentStep[] = [];
  /** Crossings the composer compared: their steps and route explanation. */
  const composedRoutes: { readonly stepIds: readonly string[]; readonly choice: RouteChoice }[] = [];
  // Gas on arrival: networks still waiting for the first eligible leg that arrives there.
  const topups = new Map(Object.entries(request.constraints?.gasOnArrival ?? {}) as [NetworkKey, string][]);
  const arrivals = new Map<NetworkKey, "native" | "third-party">();
  const reserved = new Set<string>();
  const gasRead = gasPlanReader(accounts, request.accounts);

  const topupFor = (action: NormalizedAction): string | undefined => (action.kind === "bridge" ? topups.get(action.destinationNetwork) : undefined);
  const draftAction = (action: NormalizedAction, later: readonly NormalizedAction[]): Promise<StepDraft> => {
    const gasTopupUsd = topupFor(action);
    return draftStep(action, previous, accounts, planning, contractKeyId, { later, reserved, trace, ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}) });
  };
  const commit = (action: NormalizedAction, draft: StepDraft): IntentStep => {
    if (draft.merged) optimizations.push(draft.merged);
    if (draft.gasReserve) reserved.add(`${draft.action.network}|${draft.account.id.toLowerCase()}`);
    if (topupFor(action) !== undefined) {
      if (draft.gasTopupUsd !== undefined) topups.delete(action.destinationNetwork);
      else if (!arrivals.has(action.destinationNetwork)) arrivals.set(action.destinationNetwork, draft.output?.isNative ? "native" : "third-party");
    }
    const step = buildStep(draft, steps.length, previous, now);
    steps.push(step);
    drafts.push(draft);
    previous = { step, output: draft.output, network: draft.action.destinationNetwork, recipient: draft.recipient };
    return step;
  };
  const saveState = () => ({
    steps: steps.length, drafts: drafts.length, previous, optimizations: optimizations.length,
    reserved: new Set(reserved), topups: new Map(topups), arrivals: new Map(arrivals),
  });
  const restoreState = (state: ReturnType<typeof saveState>) => {
    steps.length = state.steps;
    drafts.length = state.drafts;
    previous = state.previous;
    optimizations.length = state.optimizations;
    reserved.clear();
    state.reserved.forEach((key) => reserved.add(key));
    topups.clear();
    state.topups.forEach((usd, network) => topups.set(network, usd));
    arrivals.clear();
    state.arrivals.forEach((kind, network) => arrivals.set(network, kind));
  };
  /** Plans a shape the composer chose: its legs in order, each funded by the previous leg's minimum (chained floors). */
  const planShape = async (evaluation: ShapeEvaluation, base: NormalizedAction, later: readonly NormalizedAction[], written?: readonly NormalizedAction[]): Promise<IntentStep[]> => {
    const legs = written ?? shapeActions(evaluation, base);
    const built: IntentStep[] = [];
    for (const [position, leg] of legs.entries()) {
      assertWithinDeadline();
      const pinnedLeg = written && evaluation.legs[position] ? { ...leg, pin: evaluation.legs[position].winner.protocol } : leg;
      built.push(commit(pinnedLeg, await draftAction(pinnedLeg, [...legs.slice(position + 1), ...later])));
    }
    return built;
  };
  /**
   * Composes one crossing: pre-screens its shapes, plans the winner for
   * real, plans the runner-up instead when the winner's real value fell more
   * than 10 bps below it (once, with budget left), and records the route
   * explanation. Returns false when the crossing is not composed (the caller
   * plans it as today).
   */
  const composeCrossing = async (
    base: NormalizedAction,
    input: ResolvedAsset,
    output: ResolvedAsset,
    later: readonly NormalizedAction[],
    asWritten?: { readonly legs: readonly LegSpec[]; readonly actions: readonly NormalizedAction[]; readonly merged: NormalizedAction },
  ): Promise<boolean> => {
    let candidates = enumerateShapes(input, output, { composites: true, ...(asWritten ? { asWritten: asWritten.legs } : {}) });
    const crossKey = legPinKey({ kind: "bridge", network: input.network, destinationNetwork: output.network, input, output });
    const pinnedShape = currentRoutePin()?.shape(crossKey);
    if (pinnedShape) candidates = candidates.filter((candidate) => shapePinValue(candidate) === pinnedShape);
    if (candidates.length < 2 && !asWritten) return false;
    if (candidates.length === 0) return false;
    const amount = crossingAmount(base, input, previous);
    if (amount === null || amount <= 0n) return false;
    const arrivalGas = await arrivalGasState(output.network, gasRead, topups.has(output.network) && !output.isNative);
    const maxSeconds = planning.constraints?.maxSeconds ?? DEFAULT_MAX_SECONDS;
    const quote: LegQuoter = async (leg, units) => {
      const route: AdapterRoute = { kind: leg.kind, network: leg.input.network, destinationNetwork: leg.output.network, input: leg.input, output: leg.output };
      const crossing = route.network !== route.destinationNetwork;
      const gasTopupUsd = crossing && !route.output.isNative ? topups.get(route.destinationNetwork) : undefined;
      let venues = candidateAdapters(route, planning.constraints);
      if (crossing) venues = await dlnEligible(venues, route, accounts, planning, { later: [], reserved, ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}) });
      if (gasTopupUsd !== undefined) venues = venues.filter((adapter) => adapter.supportsGasTopup?.(route) === true);
      if (venues.length === 0) throw noCandidates(route, undefined);
      const account = accountForNetwork(accounts, route.network);
      const destinationAccount = crossing ? ownAccountOn(accounts, route.destinationNetwork) : undefined;
      const contacts: QuoteContact[] = [];
      try {
        return await runVenueAuction(venues, {
          ...route,
          amount: units.toString(),
          account,
          recipient: crossing ? accountForNetwork(accounts, route.destinationNetwork) : account,
          slippageBps: planning.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
          ...(destinationAccount ? { destinationAccount } : {}),
          ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}),
        }, {
          maxSeconds,
          explicitMaxSeconds: planning.constraints?.maxSeconds !== undefined,
          explicitSlippage: planning.constraints?.maxSlippageBps !== undefined,
          prefer: planning.constraints?.preferProtocols ?? [],
          ...(planning.constraints?.routePreference ? { preference: planning.constraints.routePreference } : {}),
          prescreen: true,
          contacts,
        });
      } finally {
        trace.contacts.push(...contacts);
      }
    };
    const result = await compareShapes({
      candidates,
      amount,
      quote,
      preference: planning.constraints?.routePreference ?? "value",
      maxSeconds,
      arrivalGas,
      priceOf: (asset) => readAssetUsd(asset),
    });
    if (!result.winner) return false;
    const tried = new Set<ShapeEvaluation>();
    let chosen: ShapeEvaluation = result.winner;
    let built: IntentStep[] = [];
    let real: { value: number | null; score: RouteScore | null; minimum: bigint | null } = { value: null, score: null, minimum: null };
    for (;;) {
      tried.add(chosen);
      const state = saveState();
      const before = steps.length;
      try {
        if (chosen.candidate.asWritten && asWritten) {
          built = await planShape(chosen, base, later, asWritten.actions);
        } else if (chosen.candidate.legs.length === 1 && asWritten) {
          const draft = await draftAction({ ...asWritten.merged, ...(chosen.legs[0] ? { pin: chosen.legs[0].winner.protocol } : {}) }, later);
          const venue = getProtocol(draft.planned.protocol)?.name ?? draft.adapter.label;
          const parts = base.inserted ? "the added bridge and the swap" : `the bridge (action ${base.index + 1}) and the swap (action ${(asWritten.actions[1]?.index ?? base.index + 1) + 1})`;
          built = [commit(asWritten.merged, { ...draft, merged: `Merged ${parts} into one ${venue} cross-network swap into ${draft.output?.symbol ?? output.symbol}; it delivers the most after costs.` })];
        } else {
          built = await planShape(chosen, base, later);
        }
      } catch (error) {
        // A shape that fails to plan for real gives way to the next eligible one, else to the plan as written.
        restoreState(state);
        const code = toPlatformError(error).code;
        if (code === "PLAN_TIMEOUT" || code === "PLAN_TOO_LARGE" || code.startsWith("RECIPIENT_") || code === "NAME_RESOLUTION_UNAVAILABLE") throw error;
        const fallback = result.ranked.find((evaluation) => !tried.has(evaluation) && evaluation.excluded === undefined && evaluation.value !== null);
        if (fallback && tried.size < 2 && remainingMs() >= RUNNER_UP_MIN_BUDGET_MS) {
          chosen = fallback;
          continue;
        }
        return false;
      }
      real = realRoute(chosen, steps.slice(before));
      const runnerUp = result.ranked.find((evaluation) => !tried.has(evaluation) && evaluation.excluded === undefined && evaluation.value !== null);
      if (tried.size === 1 && shouldPlanRunnerUp(real.value, runnerUp, chosen.inputUsd) && runnerUp) {
        restoreState(state);
        chosen = runnerUp;
        continue;
      }
      break;
    }
    currentRoutePin()?.recordShape(crossKey, shapePinValue(chosen.candidate));
    if (chosen.candidate.legs.length > 1 && !chosen.candidate.asWritten) {
      optimizations.push(`Routed ${input.symbol} on ${CHAINS[input.network].name} to ${output.symbol} on ${CHAINS[output.network].name} ${chosen.candidate.carrier && chosen.candidate.carrier !== "input" ? `via ${chosen.candidate.carrier} ` : ""}in ${chosen.candidate.legs.length} steps: it delivers the most after costs (one cross-network swap is the alternative).`);
    }
    composedRoutes.push({
      stepIds: built.map((step) => step.id),
      choice: compositeRouteChoice(built.map((step) => step.id), chosen, result.ranked, real.score ? { score: real.score, minimum: real.minimum } : undefined),
    });
    return true;
  };

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] as NormalizedAction;
    const next = actions[index + 1];
    const later = (from: number) => actions.slice(from);
    assertWithinDeadline();

    // Exact delivery: the recipient receives the stated amount; the input is sized by inverse quoting.
    if (action.receiveExact && action.kind === "bridge") {
      commit(action, await exactDeliveryDraft(action, previous, draftAction, later(index + 1)));
      continue;
    }

    const composable = compositesAllowed(planning.constraints) && action.kind === "bridge" && action.network !== action.destinationNetwork &&
      !action.protocol && !action.receiveExact && (!action.recipient || ownRecipient(action.recipient, accounts));
    if (canMerge(action, next, planning)) {
      if (composable && next.kind === "swap") {
        const sides = await crossingAssets(action, previous, accounts);
        const finalOut = sides ? await resolveAsset(next.network, next.to as string).catch(() => null) : null;
        if (sides && finalOut && !finalOut.transferOnly) {
          const merged: NormalizedAction = { ...action, to: finalOut.id, ...(next.provider ? { provider: next.provider } : {}) };
          const legs: LegSpec[] = [
            { kind: "bridge", input: sides.input, output: sides.output },
            { kind: "swap", input: sides.output, output: finalOut },
          ];
          if (await composeCrossing(action, sides.input, finalOut, later(index + 2), { legs, actions: [action, next], merged })) {
            index += 1;
            continue;
          }
        }
      }
      // Single shapes (KLETIA_ROUTE_SHAPES=single): one cross-network swap when a venue quotes it, else the steps as written.
      const merged: NormalizedAction = {
        ...action,
        to: next.to as string,
        ...(next.provider ? { provider: next.provider } : {}),
      };
      try {
        const candidate = await draftAction(merged, later(index + 2));
        const venue = getProtocol(candidate.planned.protocol)?.name ?? candidate.adapter.label;
        const parts = action.inserted
          ? `the added bridge and ${next.kind} on ${CHAINS[next.network].name} (action ${next.index + 1})`
          : `${action.kind} (action ${action.index + 1}) and ${next.kind} on ${CHAINS[next.network].name} (action ${next.index + 1})`;
        commit(action, { ...candidate, merged: `Merged ${parts} into one ${venue} cross-network swap into ${candidate.output?.symbol ?? next.to}; saves a signature and a settlement wait.` });
        index += 1;
        continue;
      } catch (error) {
        // Name resolution failures are the user's input, not a missing merged route: report them.
        const code = toPlatformError(error).code;
        if (code.startsWith("RECIPIENT_") || code === "NAME_RESOLUTION_UNAVAILABLE") throw error;
      }
    } else if (composable) {
      // A token-changing crossing: the composer compares the one-shot with carrier composites.
      const sides = await crossingAssets(action, previous, accounts);
      if (sides && !sameFamily(sides.input, sides.output) && await composeCrossing(action, sides.input, sides.output, later(index + 1))) continue;
    }
    commit(action, await draftAction(action, later(index + 1)));
  }

  // Gas on every network that signs later: a known shortfall refuses; an unreadable balance warns.
  const gas = await planGas(drafts.map((draft, position) => gasPlanStep(draft, steps[position] as IntentStep, position, accounts)), gasRead);
  const shortfall = gas.shortfalls[0];
  if (shortfall) throw gasShortfallError(shortfall, CHAINS[shortfall.network].vm === "evm");
  // Preview (demo) accounts are never read: no warning about balances nobody holds.
  if (!onlyPreviewAccounts(request.accounts)) for (const entry of gas.unknown) plannerWarnings.push(gasUnknownWarning(entry));

  const edges: IntentEdge[] = steps.flatMap((step, index) =>
    step.dependsOn.map((dependency) => ({
      from: dependency,
      to: step.id,
      kind: drafts[index]?.funded ? ("funds" as const) : ("orders" as const),
    })),
  );

  // A named network no eligible leg arrives on: refused, except a leg that delivers the gas asset itself.
  for (const network of topups.keys()) {
    const arrival = arrivals.get(network);
    if (arrival === "native") {
      plannerWarnings.push(`No gas top-up on ${CHAINS[network].name}: the leg arriving there delivers ${CHAINS[network].nativeAsset.symbol} itself.`);
      continue;
    }
    throw new PlatformError(
      "INVALID_REQUEST",
      arrival === "third-party"
        ? `The leg arriving on ${CHAINS[network].name} pays another account; gas on arrival is delivered to your own account only.`
        : `No leg of this intent arrives on ${CHAINS[network].name}.`,
      400,
      issue(`constraints.gasOnArrival.${network}`, arrival === "third-party" ? "The leg pays another account." : "No leg arrives on this network."),
    );
  }
  // Reserves and top-ups are committed in the plan record (its warnings).
  for (const draft of drafts) {
    for (const note of draft.notes) {
      if (note.startsWith("Keeps ") || note.startsWith("Includes a gas top-up")) plannerWarnings.push(note);
    }
  }
  const warnings: string[] = [...new Set(plannerWarnings)];
  const signatures = drafts.reduce((total, draft) => total + draft.planned.transactionCount, 0);
  // Plan size: wallet signatures counted exactly after expansion.
  assertSignatureCap(signatures, trace.budget.auctions, steps.map((step) => step.title));
  if (steps.some((step) => step.settlement?.kind === "cross-network")) {
    warnings.push("Cross-network steps settle asynchronously; dependent steps unlock after the destination fill is observed.");
  }
  if (drafts.some((draft) => draft.funded)) {
    warnings.push("Dependent steps spend the previous step's guaranteed minimum output (or the observed output once known).");
  }
  if (drafts.some((draft) => draft.funded && draft.action.network.startsWith("solana") && draft.planned.input?.asset.endsWith("/slip44:501"))) {
    warnings.push("Keep a little SOL outside this intent for Solana network fees.");
  }
  if (steps.some((step) => CONTRACT_KINDS.includes(step.kind))) warnings.push(CUSTOM_CONTRACT_WARNING);
  const totalFees = steps.reduce((total, step) => total + (step.feesUsd ?? 0), 0);
  const maxFee = request.constraints?.maxFeeUsd;
  if (maxFee !== undefined) {
    if (totalFees > maxFee) {
      throw new PlatformError(
        "FEE_LIMIT_EXCEEDED",
        `Estimated fees are $${totalFees.toFixed(2)}, above constraints.maxFeeUsd ($${maxFee}).`,
        422,
        issue("constraints.maxFeeUsd", "Exceeded."),
      );
    }
    if (steps.some((step) => step.feesUsd === undefined)) warnings.push("Some step fees could not be estimated; maxFeeUsd was checked against known fees only.");
  } else if (source === "grammar" && (options.feeSanity ?? options.interpretation?.thread === undefined) && steps.every((step) => CHAINS[step.network].environment === "mainnet")) {
    // Fee sanity: text requests without maxFeeUsd refuse fees above 5 % of the value moved (testnet capital has no value).
    assertFeeSanity({ feeUsd: totalFees + extraCostsUsdOf(steps), valueUsd: await valueMovedUsd(steps) });
  }
  // Route explanations: one entry per composed crossing, one per other auctioned step.
  const composedSteps = new Set(composedRoutes.flatMap((entry) => entry.stepIds));
  const routes: RouteChoice[] = [];
  drafts.forEach((draft, index) => {
    const step = steps[index];
    if (!step) return;
    const composed = composedRoutes.find((entry) => entry.stepIds[0] === step.id);
    if (composed) routes.push(composed.choice);
    else if (draft.auction && !composedSteps.has(step.id)) routes.push(routeChoice(step, draft.auction));
  });
  const contacted = providersContacted(trace.contacts);

  const expiry = Math.min(
    nowMs + intentTtl(options.ttlMs),
    request.constraints?.deadline !== undefined ? request.constraints.deadline * 1000 : Number.POSITIVE_INFINITY,
  );
  const expiresAt = new Date(expiry).toISOString();
  const title = steps.length <= 3 ? steps.map((step) => step.title).join(" → ") : normalizedText ?? `${steps.length}-step intent`;
  const graph: IntentGraph = {
    spec: INTENT_SPEC_VERSION,
    id: options.id ?? newIntentId(),
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: deriveIntentStatus(steps, expiresAt, nowMs),
    request,
    interpretation: {
      source,
      ...(normalizedText ? { normalizedText } : {}),
      confidence,
      ...(optimizations.length > 0 ? { optimizations } : {}),
      ...(departure ? { departure } : {}),
      ...(options.interpretation?.assumptions ? { assumptions: options.interpretation.assumptions } : {}),
      ...(options.interpretation?.thread ? { thread: options.interpretation.thread } : {}),
      ...(options.interpretation?.modelReading ? { modelReading: options.interpretation.modelReading } : {}),
      ...(routes.length > 0 ? { routes } : {}),
      ...(contacted.length > 0 ? { providersContacted: contacted } : {}),
    },
    steps,
    edges,
    summary: summarize(steps, edges, signatures, title.slice(0, 200), request),
    warnings,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
  const issues = validateIntentGraph(graph);
  if (issues.length > 0) {
    throw new PlatformError("PLAN_INVALID", "The planned graph failed validation.", 422, issues);
  }
  // The plan as created: prepare replaces amounts in the steps, never this record (receipts commit to it).
  const record = buildPlanRecord(graph);
  const previews = new Map<string, PlannedStepPreview>();
  drafts.forEach((draft, index) => {
    const preview = draft.planned.preview;
    const step = steps[index];
    if (preview && step && preview.transactions.length > 0) previews.set(step.id, preview);
  });
  return { graph: { ...graph, plan: { digest: planRecordDigest(record), record } }, previews };
}

/**
 * Re-times a just-planned graph (a Rule Book hold extends its lifetime):
 * expiry = createdAt + ttl (INTENT_TTL_MS..24 h), never
 * past the deadline; status and the plan record (which commits to the
 * expiry) follow. Only for graphs that were never stored.
 */
export function withIntentTtl(graph: IntentGraph, ttlMs: number, nowMs: number = Date.now()): IntentGraph {
  const created = Date.parse(graph.createdAt);
  const deadline = graph.request.constraints?.deadline;
  const expiry = Math.min(
    (Number.isFinite(created) ? created : nowMs) + intentTtl(ttlMs),
    deadline !== undefined ? deadline * 1000 : Number.POSITIVE_INFINITY,
  );
  const expiresAt = new Date(expiry).toISOString();
  if (expiresAt === graph.expiresAt) return graph;
  const { plan: _plan, ...rest } = graph;
  const next: IntentGraph = { ...rest, expiresAt, status: deriveIntentStatus(graph.steps, expiresAt, nowMs) };
  const record = buildPlanRecord(next);
  return { ...next, plan: { digest: planRecordDigest(record), record } };
}
