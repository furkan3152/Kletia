/**
 * Intent-level asset-change preview ("fare breakdown", asset-preview design
 * V2): simulates (or quotes) every step of an intent graph, aggregates the
 * net change per network, account and asset with core `aggregatePreview`,
 * prices it, and keeps previews in a store so `acknowledgedPreview` digests
 * can be checked at prepare.
 *
 * Sources per step (design §5.1): the prepared payload (prepare), the
 * quote transactions the plan already fetched (`PlannedStep.preview`, kept in
 * memory here until the quote expires), otherwise the step's quote. No
 * provider is called for a preview unless the caller asks to refresh quotes.
 *
 * Read-only and fail-safe: a preview never signs or sends anything; RPC
 * trouble makes steps `unavailable` (quoted numbers, with a warning), never
 * an exception, except where the caller enforces simulation (strict mode,
 * link intents, custom contract steps at prepare).
 */
import {
  aggregatePreview,
  CHAINS,
  isStepDone,
  materialChange,
  parseAccountId,
  PREVIEW_WARNING_CODES,
  type AssetId,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type PreviewIssue,
  type PreviewNeed,
  type PreviewStage,
  type StepPreview,
  type TransactionRequest,
} from "@kletia/core";
import { isSolanaNetworkKey, SOLANA_RPC_URLS } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import type { PlannedStepPreview } from "../adapters/types.js";
import { isEvmNetwork, type EvmNetworkKey } from "../chains/evm.js";
import { jsonRpc, simulationEndpoints } from "../contracts/simulationRpc.js";
import { assertInvariants, isContractStep, type InvariantViolation } from "./invariants.js";
import { buildEvmJobs, planBlock, type EvmJob, type StepTransactions } from "./jobs.js";
import { priceAssets } from "./pricer.js";
import { simulateEvmJob, simulateSolanaStep, type SimulatedJob, type SimulatedSolanaStep } from "./simulate.js";
import { evmStepPreview, quotedStepPreview, solanaStepPreview, type BuiltStep, type StepBuildContext } from "./steps.js";

export { configurePreviewPricer, defaultPreviewPricer, type PreviewPricer } from "./pricer.js";
export { resetPreviewSimulationCaches } from "./simulate.js";
export type { StepTransactions } from "./jobs.js";

/* ----------------------------------------------------------------- limits */

/** Previews (and every digest issued) are kept this long (design §8.3, §9). */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Per-simulation deadline at plan; the whole plan-time preview is abandoned after PLAN_BUDGET_MS. */
export const PLAN_SIMULATION_MS = 2_500;
export const PLAN_BUDGET_MS = 3_000;
/** Deadline at prepare and refresh. */
export const PREPARE_SIMULATION_MS = 6_000;
const NATIVE_BALANCE_TTL_MS = 30_000;
const MAX_PLANNED_INTENTS = 20_000;

export interface PreviewContext {
  readonly stage: PreviewStage;
  /** Re-quote ready steps (`quotes=refresh`); handled by the service's refreshIntentPreview. */
  readonly refreshQuotes?: boolean;
  /** Overall budget in ms (default: 3 s at plan / indicative, 6 s otherwise). */
  readonly deadlineMs?: number;
  /** Extra plan-time sources (refreshed quotes), by step id. */
  readonly sources?: ReadonlyMap<string, PlannedStepPreview>;
  /** Overrides graph.id in the preview (dry runs). */
  readonly intentId?: string;
  /** Store the preview (default true). */
  readonly store?: boolean;
}

/* ------------------------------------------------------------------ store */

export interface PreviewStore {
  put(preview: IntentPreview, ttlMs: number): Promise<void>;
  byDigest(digest: string): Promise<IntentPreview | null>;
  latest(intentId: string): Promise<IntentPreview | null>;
  /** Removes previews that expired before `before` (ISO). */
  prune(before: string): Promise<void>;
}

/** Bounded in-memory store (LRU of 20,000 digests, latest preview per intent). */
export class MemoryPreviewStore implements PreviewStore {
  private readonly byId = new Map<string, { preview: IntentPreview; expiresAt: number }>();
  private readonly latestByIntent = new Map<string, string>();

  constructor(private readonly maxEntries = 20_000) {}

  async put(preview: IntentPreview, ttlMs: number): Promise<void> {
    this.byId.delete(preview.digest);
    this.byId.set(preview.digest, { preview: structuredClone(preview), expiresAt: Date.now() + ttlMs });
    this.latestByIntent.delete(preview.intentId);
    this.latestByIntent.set(preview.intentId, preview.digest);
    while (this.byId.size > this.maxEntries) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    while (this.latestByIntent.size > this.maxEntries) {
      const oldest = this.latestByIntent.keys().next().value;
      if (oldest === undefined) break;
      this.latestByIntent.delete(oldest);
    }
  }

  async byDigest(digest: string): Promise<IntentPreview | null> {
    const entry = this.byId.get(digest);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return structuredClone(entry.preview);
  }

  async latest(intentId: string): Promise<IntentPreview | null> {
    const digest = this.latestByIntent.get(intentId);
    return digest ? this.byDigest(digest) : null;
  }

  async prune(before: string): Promise<void> {
    const cutoff = Date.parse(before);
    for (const [digest, entry] of this.byId) if (entry.expiresAt <= cutoff) this.byId.delete(digest);
  }
}

let previewStore: PreviewStore = new MemoryPreviewStore();

/** Installs the preview store (the HTTP layer: memory or Postgres); null restores the default memory store. */
export function configurePreviewStore(store: PreviewStore | null): void {
  previewStore = store ?? new MemoryPreviewStore();
}

export function getPreviewStore(): PreviewStore {
  return previewStore;
}

/* ---------------------------------------------------- plan-time sources */

const plannedSources = new Map<string, { readonly previews: ReadonlyMap<string, PlannedStepPreview> }>();

/** Keeps a plan's quote transactions in memory (never in the graph) until each quote expires. */
export function rememberPlannedPreviews(intentId: string, previews: ReadonlyMap<string, PlannedStepPreview>): void {
  if (previews.size === 0) return;
  plannedSources.delete(intentId);
  plannedSources.set(intentId, { previews: new Map(previews) });
  while (plannedSources.size > MAX_PLANNED_INTENTS) {
    const oldest = plannedSources.keys().next().value;
    if (oldest === undefined) break;
    plannedSources.delete(oldest);
  }
}

/** The plan-time quote transactions still valid at `now`, by step id. */
export function plannedPreviews(intentId: string, now = Date.now()): Map<string, PlannedStepPreview> {
  const entry = plannedSources.get(intentId);
  const out = new Map<string, PlannedStepPreview>();
  for (const [stepId, preview] of entry?.previews ?? []) if (preview.expiresAt * 1000 > now) out.set(stepId, preview);
  return out;
}

/** Forgets plan-time sources and stored previews (tests). */
export function resetPreviews(): void {
  plannedSources.clear();
  nativeBalances.clear();
  previewStore = new MemoryPreviewStore();
}

/* ------------------------------------------------------------- helpers */

/** Steps whose transactions were sent (or that need none): previews show what happened, never re-simulate them. */
function started(step: IntentStep): boolean {
  return isStepDone(step) || ["submitted", "confirmed", "settling", "indeterminate"].includes(step.status) || (step.references?.length ?? 0) > 0;
}

function fundingParentPending(graph: IntentGraph, step: IntentStep): boolean {
  return graph.edges.some((edge) => edge.to === step.id && edge.kind === "funds" &&
    !isStepDone(graph.steps.find((candidate) => candidate.id === edge.from) ?? step));
}

const nativeBalances = new Map<string, { value: bigint; at: number }>();

/** Native balance of an account (EVM: eth_getBalance through the simulation endpoints; Solana: getBalance), cached 30 s. */
async function readNativeBalance(network: IntentStep["network"], address: string, deadline: number): Promise<bigint | null> {
  const key = `${network}:${address.startsWith("0x") ? address.toLowerCase() : address}`;
  const cached = nativeBalances.get(key);
  if (cached && Date.now() - cached.at < NATIVE_BALANCE_TTL_MS) return cached.value;
  const timeout = Math.max(250, deadline - Date.now());
  let value: bigint | null = null;
  try {
    if (isEvmNetwork(network)) {
      for (const url of await simulationEndpoints(network)) {
        const outcome = await jsonRpc(url, "eth_getBalance", [address, "latest"], timeout).catch(() => null);
        if (outcome?.ok && typeof outcome.result === "string" && /^0x[0-9a-fA-F]+$/u.test(outcome.result)) {
          value = BigInt(outcome.result);
          break;
        }
      }
    } else if (isSolanaNetworkKey(network)) {
      const outcome = await jsonRpc(SOLANA_RPC_URLS[network], "getBalance", [address, { commitment: "confirmed" }], timeout).catch(() => null);
      const result = outcome?.ok ? (outcome.result as { value?: unknown } | null) : null;
      if (result && typeof result.value === "number" && Number.isSafeInteger(result.value)) value = BigInt(result.value);
    }
  } catch {
    value = null;
  }
  if (value !== null) nativeBalances.set(key, { value, at: Date.now() });
  return value;
}

function sourceFromPlanned(step: IntentStep, preview: PlannedStepPreview): StepTransactions {
  return {
    stepId: step.id,
    transactions: preview.transactions,
    origin: "planned",
    ...(preview.approvalSpender ? { approvalSpender: preview.approvalSpender } : {}),
    ...(preview.venueFees ? { venueFees: preview.venueFees } : {}),
  };
}

function solanaHost(network: string): string {
  try {
    return isSolanaNetworkKey(network as IntentStep["network"]) ? new URL(SOLANA_RPC_URLS[network as "solana"]).host : "unknown";
  } catch {
    return "unknown";
  }
}

interface Simulations {
  readonly evm: Map<string, { job: Extract<SimulatedJob, { status: "ok" }>; index: number }>;
  readonly evmUnavailable: Map<string, string>;
  readonly solana: Map<string, SimulatedSolanaStep[]>;
  readonly solanaUnavailable: Map<string, string>;
  readonly balances: Map<string, bigint>;
}

/**
 * Native balances to read: every signer (plan: gas on arrival), only EVM
 * signers whose step spends the native asset (prepare: the input check;
 * Solana simulations return balances themselves), or none.
 */
type BalanceReads = "signers" | "native-inputs" | "none";

async function runSimulations(
  graph: IntentGraph,
  jobs: readonly EvmJob[],
  solanaSources: readonly { step: IntentStep; source: StepTransactions }[],
  deadline: number,
  reads: BalanceReads = "signers",
  fresh = false,
): Promise<Simulations> {
  const out: Simulations = { evm: new Map(), evmUnavailable: new Map(), solana: new Map(), solanaUnavailable: new Map(), balances: new Map() };
  const signers = new Map<string, { network: IntentStep["network"]; address: string }>();
  for (const step of reads === "none" ? [] : graph.steps) {
    if (started(step) || step.mode !== "wallet") continue;
    if (reads === "native-inputs" && !(isEvmNetwork(step.network) && step.input?.asset.includes("/slip44:"))) continue;
    const account = parseAccountId(step.account);
    if (!account) continue;
    const address = account.chain.namespace === "eip155" ? account.address.toLowerCase() : account.address;
    signers.set(`${step.network}:${address}`, { network: step.network, address });
  }
  await Promise.all([
    ...jobs.map(async (job) => {
      const result = await simulateEvmJob(job, deadline, { fresh }).catch((): SimulatedJob => ({ status: "unavailable", job, reason: "simulation failed" }));
      if (result.status === "ok") result.blocks.forEach((block, index) => out.evm.set(block.plan.step.id, { job: result, index }));
      else for (const block of job.blocks) out.evmUnavailable.set(block.step.id, result.reason);
    }),
    ...solanaSources.map(async ({ step, source }) => {
      if (!isSolanaNetworkKey(step.network)) return;
      const results: SimulatedSolanaStep[] = [];
      for (const transaction of source.transactions) {
        if (transaction.vm !== "svm") {
          out.solanaUnavailable.set(step.id, "the payload is not a Solana transaction");
          return;
        }
        const simulated = await simulateSolanaStep(step.network, transaction, solanaHost(step.network));
        if (simulated.status !== "ok") {
          out.solanaUnavailable.set(step.id, simulated.reason);
          return;
        }
        results.push(simulated);
      }
      out.solana.set(step.id, results);
    }),
    ...[...signers.entries()].map(async ([key, signer]) => {
      const value = await readNativeBalance(signer.network, signer.address, deadline);
      if (value !== null) out.balances.set(key, value);
    }),
  ]);
  return out;
}

/** Builds one step's preview from whatever was simulated for it. */
async function buildStep(context: StepBuildContext, simulations: Simulations, attempted: boolean): Promise<BuiltStep> {
  const { step } = context;
  const evm = simulations.evm.get(step.id);
  if (evm) {
    const block = evm.job.blocks[evm.index];
    if (block) return evmStepPreview(context, evm.job, block);
  }
  const solana = simulations.solana.get(step.id);
  if (solana) return solanaStepPreview(context, solana);
  const reason = simulations.evmUnavailable.get(step.id) ?? simulations.solanaUnavailable.get(step.id);
  if (attempted || reason) {
    return quotedStepPreview(context, "unavailable", [
      { code: PREVIEW_WARNING_CODES.unavailable, severity: "warn", message: `Step ${step.index + 1} could not be simulated (${reason ?? "no simulation"}); its numbers are quoted.` },
    ]);
  }
  return quotedStepPreview(context, "quoted", []);
}

/** Gas-on-arrival needs (design §5.7): a wallet step on a network where the signer holds no native asset. */
function gasOnArrival(graph: IntentGraph, previews: readonly StepPreview[], balances: ReadonlyMap<string, bigint>): { needs: PreviewNeed[]; warnings: string[] } {
  const needs: PreviewNeed[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const step of graph.steps) {
    if (started(step) || step.mode !== "wallet") continue;
    const account = parseAccountId(step.account);
    if (!account) continue;
    const address = account.chain.namespace === "eip155" ? account.address.toLowerCase() : account.address;
    const key = `${step.network}:${address}`;
    if (balances.get(key) !== 0n || seen.has(key)) continue;
    const preview = previews.find((entry) => entry.stepId === step.id);
    const fee = (preview?.fees ?? [])
      .filter((line) => (line.kind === "network" || line.kind === "l1-data") && line.amount !== undefined && line.asset)
      .reduce((total, line) => total + BigInt(line.amount as string), 0n);
    if (fee === 0n) continue;
    seen.add(key);
    const chain = CHAINS[step.network];
    const formatted = (Number(fee) / 10 ** chain.nativeAsset.decimals).toPrecision(2);
    needs.push({
      network: step.network,
      account: step.account,
      asset: { asset: `${chain.id}/slip44:${chain.vm === "svm" ? "501" : "60"}` as AssetId, symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals },
      amount: fee.toString(),
      formatted,
      reason: "gas-on-arrival",
      have: "0",
    });
    warnings.push(`${PREVIEW_WARNING_CODES.gasOnArrival}: you need about ${formatted} ${chain.nativeAsset.symbol} on ${chain.name} to sign step ${step.index + 1}.`);
  }
  return { needs, warnings };
}

async function finish(
  graph: IntentGraph,
  built: readonly BuiltStep[],
  balances: ReadonlyMap<string, bigint>,
  stage: PreviewStage,
  now: number,
  intentId: string | undefined,
): Promise<IntentPreview> {
  const previews = built.map((entry) => entry.preview);
  const arrival = gasOnArrival(graph, previews, balances);
  const assets = new Set<AssetId>();
  for (const preview of previews) {
    for (const row of preview.deltas) assets.add(row.asset);
    for (const entry of preview.payments) assets.add(entry.asset);
    for (const fee of preview.fees) if (fee.asset) assets.add(fee.asset.asset);
  }
  const prices = await priceAssets(assets);
  const notes = built.flatMap((entry) => entry.notes);
  const aggregated = aggregatePreview(graph, previews, prices, now, {
    stage,
    needs: [...built.flatMap((entry) => entry.needs), ...arrival.needs],
    warnings: [...notes, ...arrival.warnings],
    ...(intentId ? { intentId } : {}),
  });
  if (aggregated.totals.unpriced.length === 0) return aggregated;
  return aggregatePreview(graph, previews, prices, now, {
    stage,
    needs: [...built.flatMap((entry) => entry.needs), ...arrival.needs],
    warnings: [...notes, ...arrival.warnings, `${PREVIEW_WARNING_CODES.unpriced}: no price for ${aggregated.totals.unpriced.length} asset(s); totals that need them are null.`],
    ...(intentId ? { intentId } : {}),
  });
}

/* ------------------------------------------------------------- previews */

/**
 * The intent preview (stage `plan`, `refresh` or `indicative`): plan-time
 * quote transactions are simulated while valid, everything else is quoted.
 * Never throws for RPC trouble; past the budget every step is `unavailable`.
 */
export async function previewIntent(graph: IntentGraph, context: PreviewContext): Promise<IntentPreview> {
  const now = Date.now();
  const stage = context.stage;
  const planStage = stage === "plan" || stage === "indicative";
  const budget = context.deadlineMs ?? (planStage ? PLAN_BUDGET_MS : PREPARE_SIMULATION_MS);
  const deadline = now + Math.min(budget, planStage ? PLAN_SIMULATION_MS : budget);
  const planned = new Map([...plannedPreviews(graph.id, now), ...(context.sources ?? [])]);
  const sources = new Map<string, StepTransactions>();
  const solanaSources: { step: IntentStep; source: StepTransactions }[] = [];
  for (const step of graph.steps) {
    const preview = planned.get(step.id);
    if (!preview || started(step) || preview.transactions.length === 0) continue;
    const source = sourceFromPlanned(step, preview);
    if (isEvmNetwork(step.network)) sources.set(step.id, source);
    // Solana has no account overrides: a step whose funds are still in flight stays quoted (design §5.3).
    else if (isSolanaNetworkKey(step.network) && !fundingParentPending(graph, step)) solanaSources.push({ step, source });
  }
  const jobs = buildEvmJobs(graph, sources, stage);
  const empty: Simulations = { evm: new Map(), evmUnavailable: new Map(), solana: new Map(), solanaUnavailable: new Map(), balances: new Map() };
  let timedOut = false;
  const simulations = await Promise.race([
    runSimulations(graph, jobs, solanaSources, deadline),
    new Promise<Simulations>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve(empty);
      }, budget);
      timer.unref?.();
    }),
  ]);
  const built = new Map<string, StepPreview>();
  const steps: BuiltStep[] = [];
  for (const step of graph.steps) {
    const attempted = sources.has(step.id) || solanaSources.some((entry) => entry.step.id === step.id);
    const context2: StepBuildContext = {
      graph,
      step,
      stage,
      now,
      source: sources.get(step.id) ?? solanaSources.find((entry) => entry.step.id === step.id)?.source ?? (planned.get(step.id) ? sourceFromPlanned(step, planned.get(step.id) as PlannedStepPreview) : null),
      built,
      nativeBalances: simulations.balances,
    };
    const entry = started(step)
      ? quotedStepPreview(context2, "quoted", [])
      : timedOut && attempted
        ? quotedStepPreview(context2, "unavailable", [{ code: PREVIEW_WARNING_CODES.unavailable, severity: "warn", message: `Step ${step.index + 1} was not simulated within the preview budget; its numbers are quoted.` }])
        : await buildStep(context2, simulations, attempted);
    built.set(step.id, entry.preview);
    steps.push(entry);
  }
  const preview = await finish(graph, steps, simulations.balances, stage, now, context.intentId);
  if (context.store !== false) await previewStore.put(preview, PREVIEW_TTL_MS).catch(() => undefined);
  return preview;
}

/** True when an unsimulated payload must be refused (design §5.8): strict mode, link intents, custom contract steps. */
export function previewEnforced(graph: IntentGraph, step: IntentStep): boolean {
  return process.env.KLETIA_PREVIEW_ENFORCE?.trim().toLowerCase() === "strict" ||
    graph.metadata?.linkId !== undefined ||
    isContractStep(step);
}

export interface PreparedPreview {
  /** The prepared step's own preview, bound to `payload.quoteBinding`. */
  readonly step: StepPreview;
  /** The whole intent with this step freshly simulated (stage `prepare`). */
  readonly intent: IntentPreview;
  readonly violations: readonly InvariantViolation[];
  /** "matched": the acknowledged digest was found and nothing material changed; "unknown": not found; absent: none sent. */
  readonly ack?: "matched" | "unknown";
}

/**
 * Simulates a just-prepared payload (no overrides: S8), applies the
 * invariants (throws their refusal), rebuilds the intent preview around it
 * and checks it against the acknowledged preview (PREVIEW_CHANGED).
 * `step` is the step as it will be committed (prepared input and outputs).
 */
export async function previewPreparedStep(
  graph: IntentGraph,
  step: IntentStep,
  payload: { readonly transactions: readonly TransactionRequest[]; readonly quoteBinding: string },
  options: {
    readonly acknowledgedPreview?: string;
    readonly deadlineMs?: number;
    /** False for an embedder's adapter that did not opt in: the step preview is quoted, nothing is simulated. */
    readonly simulate?: boolean;
  } = {},
): Promise<PreparedPreview> {
  const now = Date.now();
  const deadline = now + (options.deadlineMs ?? PREPARE_SIMULATION_MS);
  const current: IntentGraph = { ...graph, steps: graph.steps.map((candidate) => (candidate.id === step.id ? step : candidate)) };
  const source: StepTransactions = { stepId: step.id, transactions: payload.transactions, origin: "prepared", quoteBinding: payload.quoteBinding };
  const account = parseAccountId(step.account);
  const jobs: EvmJob[] = [];
  const solanaSources: { step: IntentStep; source: StepTransactions }[] = [];
  const simulate = options.simulate !== false || previewEnforced(graph, step);
  if (simulate && isEvmNetwork(step.network) && account) {
    const network: EvmNetworkKey = step.network;
    const block = planBlock(network, step, source, account.address.toLowerCase(), null);
    if (block) jobs.push({ network, owner: account.address.toLowerCase(), blocks: [block] });
  } else if (simulate && isSolanaNetworkKey(step.network)) {
    solanaSources.push({ step, source });
  }
  const simulations = await runSimulations({ ...current, steps: [step] }, jobs, solanaSources, deadline, simulate ? "native-inputs" : "none", true);

  const ack = options.acknowledgedPreview ? await previewStore.byDigest(options.acknowledgedPreview).catch(() => null) : null;
  const acknowledged = ack && ack.intentId === graph.id ? ack : null;
  const base = acknowledged ?? (await previewStore.latest(graph.id).catch(() => null));
  const built = new Map<string, StepPreview>();
  const steps: BuiltStep[] = [];
  let fresh: BuiltStep | null = null;
  // Steps funded (directly or not) by a rebuilt step are rebuilt too, so transit rows keep netting to zero.
  const rebuilt = new Set<string>([step.id]);
  for (const candidate of current.steps) {
    const context: StepBuildContext = {
      graph: current,
      step: candidate,
      stage: "prepare",
      now,
      source: candidate.id === step.id ? source : null,
      built,
      nativeBalances: simulations.balances,
    };
    let entry: BuiltStep;
    if (candidate.id === step.id) {
      entry = simulate
        ? await buildStep(context, simulations, true)
        : quotedStepPreview(context, "quoted", []);
      fresh = entry;
    } else {
      const reused = base?.steps.find((preview) => preview.stepId === candidate.id);
      const fundedByRebuilt = current.edges.some((edge) => edge.to === candidate.id && edge.kind === "funds" && rebuilt.has(edge.from));
      if (fundedByRebuilt || started(candidate) || !reused) {
        rebuilt.add(candidate.id);
        entry = quotedStepPreview(context, "quoted", []);
      } else {
        entry = { preview: reused, violations: [], needs: [], notes: [] };
      }
    }
    built.set(candidate.id, entry.preview);
    steps.push(entry);
  }
  const own = fresh as BuiltStep;
  if (own.preview.status === "unavailable" && previewEnforced(graph, step)) {
    throw new PlatformError(
      "SIMULATION_UNAVAILABLE",
      `Step ${step.id} could not be simulated on ${CHAINS[step.network].name} right now, and this step is never prepared unsimulated. Retry shortly.`,
      503,
    );
  }
  assertInvariants(own.violations, step.id);
  const intent = await finish(current, steps, simulations.balances, "prepare", now, undefined);
  await previewStore.put(intent, PREVIEW_TTL_MS).catch(() => undefined);
  if (options.acknowledgedPreview) {
    if (!acknowledged) return { step: own.preview, intent, violations: own.violations, ack: "unknown" };
    const changes = materialPreviewChanges(acknowledged, intent, current);
    if (changes.length > 0) throw previewChangedError(intent, changes);
    return { step: own.preview, intent, violations: own.violations, ack: "matched" };
  }
  return { step: own.preview, intent, violations: own.violations };
}

/* -------------------------------------------------------- material change */

/**
 * Rows without the network fees (gas, L1 data, Solana fee): those move every
 * block and are judged by the fee rule (max(5 %, $0.05)) instead of the
 * 10 bps amount rule.
 */
function withoutNetworkFees(preview: IntentPreview, graph: IntentGraph): IntentPreview {
  const adjust = new Map<string, bigint>();
  for (const fee of preview.fees) {
    if ((fee.kind !== "network" && fee.kind !== "l1-data") || fee.amount === undefined || !fee.asset) continue;
    const step = graph.steps.find((candidate) => candidate.id === fee.stepId);
    const account = step ? parseAccountId(step.account) : null;
    if (!account) continue;
    const key = `${fee.network}|${account.chain.namespace === "eip155" ? account.address.toLowerCase() : account.address}|${fee.asset.asset.toLowerCase()}`;
    adjust.set(key, (adjust.get(key) ?? 0n) + BigInt(fee.amount));
  }
  const rows = preview.rows.map((row) => {
    const account = parseAccountId(row.account);
    const key = `${row.network}|${account && account.chain.namespace === "eip155" ? account.address.toLowerCase() : account?.address ?? row.account}|${row.asset.toLowerCase()}`;
    const add = adjust.get(key);
    if (!add) return row;
    const expected = BigInt(row.expected.amount) + add;
    const worst = BigInt(row.worst.amount) + add;
    return { ...row, expected: { ...row.expected, amount: expected.toString() }, worst: { ...row.worst, amount: worst.toString() } };
  });
  return { ...preview, rows };
}

/** Core `materialChange` with network fees judged by the fee rule only (see withoutNetworkFees). */
export function materialPreviewChanges(before: IntentPreview, after: IntentPreview, graph: IntentGraph): readonly PreviewIssue[] {
  return materialChange(withoutNetworkFees(before, graph), withoutNetworkFees(after, graph));
}

/** PREVIEW_CHANGED (409): `error.preview` carries the fresh preview, `error.changes` (and `issues`) what got worse. */
export function previewChangedError(preview: IntentPreview, changes: readonly PreviewIssue[]): PlatformError {
  const error = new PlatformError(
    "PREVIEW_CHANGED",
    `The fresh simulation is materially worse than the preview you acknowledged (${changes.length} change${changes.length === 1 ? "" : "s"}). Show the new preview and prepare with its digest.`,
    409,
    changes.map((change) => ({ path: change.code, message: change.message })),
  );
  const base = error.toJSON();
  Object.defineProperty(error, "preview", { value: preview, enumerable: false });
  Object.defineProperty(error, "changes", { value: changes, enumerable: false });
  Object.defineProperty(error, "toJSON", { value: () => ({ ...base, preview, changes }), enumerable: false });
  return error;
}
