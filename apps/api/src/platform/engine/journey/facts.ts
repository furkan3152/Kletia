/**
 * Journey facts (journey design §5): the read-only inputs of the consequence
 * analysis, gathered for one intent under a budget.
 *
 * - Balances, gas prices, Solana rent and token accounts come only through
 *   `holdings.readFacts` (its budgets and caches; preview accounts are never
 *   read). Venue capacity comes from the adapters' `venueCapacity` and the
 *   lending metrics; the Rule Book from `policyHeadroom`; prices from the
 *   preview pricer's `quote`; remaining allowances from `readAllowance`.
 * - Every read runs in parallel under the journey deadline (2.5 s at plan,
 *   4 s on a GET); a failed read is `null` in the facts, which the builder
 *   reports as unknown ("could not read"), never as zero or an omission.
 *
 * Everything here is a read-only call; nothing is signed or sent.
 */
import {
  CHAINS,
  findAssetBySymbol,
  getYieldVenue,
  isPreviewAccount,
  nativeAssetId,
  parseAccountId,
  parseAssetId,
  sameAddressAccount,
  YIELD_VENUES,
  type AssetRef,
  type Certainty,
  type IntentActionSpec,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type JourneyFacts,
  type JourneyPolicyFacts,
  type JourneyVenueFacts,
  type NetworkKey,
  type YieldVenue,
} from "@kletia/core";
import { activeProtocolAdapters } from "../adapters/registry.js";
import { isEvmLendingVenue, readLendingMetrics } from "../adapters/lending/metrics.js";
import { isEvmNetwork, readAllowance } from "../chains/evm.js";
import { readFacts, type FactNeed, type WalletFacts } from "../holdings.js";
import { policyHeadroom } from "../policy/index.js";
import { quoteAsset } from "../preview/pricer.js";
import { decodeStepRef } from "../stepRef.js";
import { estimateStepFee, evmGasUnits, gasPriceFrom, rentFrom, SOLANA_PRIORITY_LAMPORTS, SOLANA_SIGNATURE_LAMPORTS } from "./fees.js";

/** Journey deadline at plan (in parallel with the preview's simulations) and on a GET. */
export const JOURNEY_PLAN_DEADLINE_MS = 2_500;
export const JOURNEY_GET_DEADLINE_MS = 4_000;
/** Per-read timeout inside the deadline. */
export const JOURNEY_READ_TIMEOUT_MS = 1_500;
/** Most gas balances, venues and allowances one journey reads. */
const MAX_GAS_BALANCES = 6;
const MAX_VENUES = 6;
const MAX_ALLOWANCES = 4;
/** One exit transaction (approve + bridge deposit), before headroom (design §5). */
const EXIT_GAS = 130_000n;
/** USD of the gas leg into a destination's gas asset (owner request: $1). */
const GAS_LEG_USD = 1;

export interface FactOptions {
  readonly reads?: "live" | "none";
  readonly deadlineMs?: number;
  /** Unix ms; defaults to now. */
  readonly now?: number;
}

/** Test seam: the venue reads (adapter capacity and lending metrics). */
export type VenueReader = (venue: YieldVenue) => Promise<JourneyVenueFacts>;

function withDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), Math.max(1, ms));
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function addressOf(account: string): string {
  const parsed = parseAccountId(account);
  if (!parsed) return account;
  return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
}

/** A bare address as compared here (EVM lower-case). */
function plainAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/u.test(address) ? address.toLowerCase() : address;
}

function destinationOf(step: IntentStep): NetworkKey {
  return step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork ?? step.network : step.network;
}

/** The account that receives a step's output (recipient, else the own account on the destination). */
function holderOf(graph: IntentGraph, step: IntentStep): string {
  if (step.recipient) return step.recipient;
  const destination = destinationOf(step);
  if (destination === step.network) return step.account;
  const namespace = CHAINS[destination].namespace;
  const own = graph.request.accounts.map((account) => parseAccountId(account)).find((parsed) => parsed?.chain.namespace === namespace);
  return own ? `${CHAINS[destination].id}:${own.address}` : step.account;
}

function isOwn(graph: IntentGraph, account: string): boolean {
  return graph.request.accounts.some((own) => sameAddressAccount(own, account));
}

function started(step: IntentStep): boolean {
  return ["submitted", "confirmed", "settling", "settled", "indeterminate"].includes(step.status);
}

function unsigned(step: IntentStep): boolean {
  return step.mode === "wallet" && ["pending", "ready", "awaiting_signature", "failed"].includes(step.status) && (step.references?.length ?? 0) === 0;
}

/** Listed underlying of a venue (its gas asset, or the registry asset of its symbol). */
export function venueUnderlying(venue: YieldVenue): AssetRef | null {
  const chain = CHAINS[venue.network];
  if (chain.nativeAsset.symbol.toUpperCase() === venue.asset.toUpperCase()) {
    return { asset: nativeAssetId(venue.network), symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals };
  }
  const listed = findAssetBySymbol(venue.network, venue.asset);
  return listed ? { asset: listed.id, symbol: listed.symbol, decimals: listed.decimals } : null;
}

/* ------------------------------------------------------------- venues */

/** Venue facts: the adapter's capacity (caps, pause, share rate) and, for EVM lending venues, the metrics (APY, utilization, exit liquidity). */
export const defaultVenueReader: VenueReader = async (venue) => {
  const adapter = activeProtocolAdapters().find((candidate) => candidate.protocols.includes(venue.protocol));
  const [capacity, metrics] = await Promise.all([
    adapter?.venueCapacity ? adapter.venueCapacity(venue).catch(() => null) : Promise.resolve(null),
    isEvmLendingVenue(venue) ? readLendingMetrics(venue.id).catch(() => null) : Promise.resolve(null),
  ]);
  if (!capacity && !metrics) throw new Error(`no reads for ${venue.id}`);
  return {
    name: venue.name,
    apy: metrics?.supplyApy ?? capacity?.apy ?? null,
    utilization: metrics?.utilization ?? capacity?.utilization ?? null,
    exitLiquidity: capacity?.exitLiquidity ?? metrics?.exitLiquidity?.amount ?? null,
    capRemaining: capacity?.capRemaining ?? null,
    paused: capacity?.paused ?? false,
    frozen: capacity?.frozen ?? false,
    shareRate: capacity?.shareRate ?? null,
    at: capacity?.observedAt ?? metrics?.observedAt ?? new Date().toISOString(),
  };
};

let venueReader: VenueReader = defaultVenueReader;

/** Replaces the venue reads (tests); null restores the default. */
export function configureJourneyVenueReader(next: VenueReader | null): void {
  venueReader = next ?? defaultVenueReader;
}

/** The intent's deposit and withdraw venues, then suggestion candidates for assets credited to the user (≤ 6). */
export function venuesToRead(graph: IntentGraph, preview: IntentPreview | null): YieldVenue[] {
  const out: YieldVenue[] = [];
  const add = (venue: YieldVenue | null) => {
    if (venue && !out.some((entry) => entry.id === venue.id) && out.length < MAX_VENUES) out.push(venue);
  };
  for (const step of graph.steps) if (step.venue) add(getYieldVenue(step.venue));
  const credited = (preview?.rows ?? []).filter((row) => row.role === "you" && BigInt(row.worst.amount) > 0n);
  for (const row of credited) {
    for (const venue of YIELD_VENUES) {
      if (venue.network !== row.network || !venue.actions.includes("deposit")) continue;
      const underlying = venueUnderlying(venue);
      if (underlying && underlying.asset.toLowerCase() === row.asset.toLowerCase()) add(venue);
    }
  }
  return out;
}

/* ----------------------------------------------------------- gas options */

/** Relay serves both networks of a leg (registry chain ids), no quote. */
function relayServes(network: NetworkKey): boolean {
  return CHAINS[network].settlement.relayChainId !== undefined && CHAINS[network].environment === "mainnet";
}

/**
 * What can deliver gas on each cross-network leg (design §5, registry only):
 * a Relay top-up when Relay serves the pair, the destination is EVM and the
 * output is not its gas asset; otherwise a gas leg ($1 of the first leg's
 * input bridged into the destination's gas asset by Relay) when the first
 * leg's input is priced and Relay serves that pair.
 */
function gasOptionsFor(graph: IntentGraph, prices: JourneyFacts["prices"]): JourneyFacts["gasOptions"] {
  const out: Record<string, { topup: boolean; gasLeg: IntentActionSpec | null }> = {};
  const first = [...graph.steps].sort((a, b) => a.index - b.index).find((step) => step.mode === "wallet" && step.input);
  for (const step of graph.steps) {
    if (step.settlement?.kind !== "cross-network") continue;
    const destination = destinationOf(step);
    const output = step.minimumOutput ?? step.expectedOutput;
    const nativeOutput = output ? parseAssetId(output.asset)?.isNative === true : false;
    const own = isOwn(graph, holderOf(graph, step));
    const topup = own && relayServes(step.network) && relayServes(destination) && CHAINS[destination].vm === "evm" && !nativeOutput;
    let gasLeg: IntentActionSpec | null = null;
    if (own && !topup && first?.input && relayServes(first.network) && relayServes(destination)) {
      const price = prices[first.input.asset]?.usd ?? null;
      if (price !== null && price > 0) {
        const units = Math.ceil((GAS_LEG_USD / price) * 10 ** Math.min(first.input.decimals, 9)) / 10 ** Math.min(first.input.decimals, 9);
        gasLeg = {
          kind: "bridge",
          network: first.network,
          from: first.input.asset,
          to: nativeAssetId(destination),
          toNetwork: destination,
          amount: units.toFixed(Math.min(first.input.decimals, 9)).replace(/\.?0+$/u, ""),
          protocol: "relay",
        };
      }
    }
    out[step.id] = { topup, gasLeg };
  }
  return out;
}

/* ----------------------------------------------------------------- facts */

/** Assets whose price the builder needs: every held asset, receipts' underlyings and the gas assets visited. */
function assetsToPrice(graph: IntentGraph, preview: IntentPreview | null): string[] {
  const out = new Set<string>();
  for (const step of graph.steps) {
    for (const amount of [step.input, step.expectedOutput, step.minimumOutput, step.actualOutput, step.observedCredit, step.gasTopup]) {
      if (amount) out.add(amount.asset);
    }
    out.add(nativeAssetId(step.network));
    out.add(nativeAssetId(destinationOf(step)));
    const venue = step.venue ? getYieldVenue(step.venue) : null;
    const underlying = venue ? venueUnderlying(venue) : null;
    if (underlying) out.add(underlying.asset);
  }
  for (const row of preview?.rows ?? []) out.add(row.asset);
  return [...out];
}

/** Fee of each unsigned wallet step: the preview's fee lines when present, else an estimate (§6.6). */
function feesFor(graph: IntentGraph, preview: IntentPreview | null, wallet: WalletFacts | null, natives: JourneyFacts["native"]): JourneyFacts["fees"] {
  const out: Record<string, { network: NetworkKey; asset: AssetRef; amount: string; certainty: Certainty }> = {};
  for (const step of graph.steps) {
    if (!unsigned(step)) continue;
    const chain = CHAINS[step.network];
    const asset: AssetRef = { asset: nativeAssetId(step.network), symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals };
    const lines = (preview?.steps.find((entry) => entry.stepId === step.id)?.fees ?? [])
      .filter((line) => (line.kind === "network" || line.kind === "l1-data" || (line.kind === "rent" && line.certainty === "estimated")) && line.amount !== undefined && /^\d+$/u.test(line.amount));
    if (lines.length > 0) {
      const amount = lines.reduce((total, line) => total + BigInt(line.amount as string), 0n);
      const certainty = lines.some((line) => line.certainty === "estimated") ? "estimated" : (lines[0] as { certainty: Certainty }).certainty;
      out[step.id] = { network: step.network, asset, amount: amount.toString(), certainty };
      continue;
    }
    if (!wallet) continue;
    if (chain.vm === "svm") {
      const rent = rentFrom(wallet, step.network);
      const owner = addressOf(step.account);
      const balance = natives[`${step.network}:${owner}`];
      const output = step.minimumOutput ?? step.expectedOutput;
      const mint = output ? parseAssetId(output.asset) : null;
      const tokenFact = mint && !mint.isNative && step.kind !== "transfer" && step.kind !== "bridge"
        ? wallet.tokenAccounts.find((entry) => entry.network === step.network && entry.mint === mint.reference && plainAddress(entry.owner) === owner)
        : undefined;
      const estimate = estimateStepFee(step, {
        tokenAccountRentLamports: rent.tokenAccount,
        walletRentLamports: rent.wallet,
        walletLamports: balance ? BigInt(balance.amount) : null,
        tokenAccounts: tokenFact ? [tokenFact.status === "known" ? tokenFact.exists ?? null : null] : [],
      });
      if (estimate.amount !== null) out[step.id] = { network: step.network, asset, amount: estimate.amount, certainty: "estimated" };
    } else {
      const estimate = estimateStepFee(step, { gasPriceWei: gasPriceFrom(wallet, step.network) });
      if (estimate.amount !== null) out[step.id] = { network: step.network, asset, amount: estimate.amount, certainty: "estimated" };
    }
  }
  return out;
}

/** Gas-asset units to leave each network later: one approve + bridge deposit, or one Solana transaction (§5). */
function exitFeesFor(networks: readonly NetworkKey[], wallet: WalletFacts | null): JourneyFacts["exitFees"] {
  const out: Partial<Record<NetworkKey, string>> = {};
  if (!wallet) return out;
  for (const network of networks) {
    if (CHAINS[network].vm === "svm") {
      out[network] = (SOLANA_SIGNATURE_LAMPORTS + SOLANA_PRIORITY_LAMPORTS).toString();
      continue;
    }
    const price = gasPriceFrom(wallet, network);
    if (price === null) continue;
    out[network] = (evmGasUnits(network, { quotedGas: [EXIT_GAS] }).gas * price).toString();
  }
  return out;
}

async function policyFacts(graph: IntentGraph, deadline: number): Promise<JourneyPolicyFacts | null> {
  const stamp = graph.policy;
  if (!stamp) return null;
  const headroom = await withDeadline(policyHeadroom(stamp.keyId), deadline - Date.now()).catch(() => null);
  if (!headroom) return null;
  return {
    perStepUsd: headroom.perStepUsd,
    perIntentUsd: headroom.perIntentUsd,
    dailyRemainingUsd: headroom.dailyRemainingUsd,
    weeklyRemainingUsd: headroom.weeklyRemainingUsd,
    schedule: headroom.schedule,
    approvalExpiresAt: stamp.approval?.expiresAt ?? null,
  };
}

/** Remaining allowances to spenders this intent approved (live and final stages). */
async function allowancesFor(graph: IntentGraph, preview: IntentPreview | null, deadline: number): Promise<JourneyFacts["allowances"]> {
  const approvals = (preview?.approvals ?? []).filter((approval) => {
    const step = graph.steps.find((candidate) => candidate.id === approval.stepId);
    return step !== undefined && started(step) && isEvmNetwork(approval.network);
  }).slice(0, MAX_ALLOWANCES);
  const reads = await Promise.allSettled(approvals.map(async (approval) => {
    const step = graph.steps.find((candidate) => candidate.id === approval.stepId) as IntentStep;
    const token = parseAssetId(approval.token.asset);
    if (!token || token.isNative || !isEvmNetwork(approval.network)) throw new Error("not an ERC-20");
    const amount = await withDeadline(readAllowance(approval.network, token.reference, addressOf(step.account), approval.spender), Math.min(JOURNEY_READ_TIMEOUT_MS, deadline - Date.now()));
    return { network: approval.network, token: approval.token, spender: approval.spender, spenderLabel: approval.spenderLabel, amount: amount.toString(), at: new Date().toISOString() };
  }));
  return reads.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/**
 * Reads the journey facts of an intent. `reads: "none"` (or only demo
 * accounts) skips every account read; prices, venues and fees still come in.
 */
export async function readJourneyFacts(graph: IntentGraph, preview: IntentPreview | null, options: FactOptions = {}): Promise<JourneyFacts> {
  const now = options.now ?? Date.now();
  const deadlineMs = Math.max(1, options.deadlineMs ?? JOURNEY_PLAN_DEADLINE_MS);
  const deadline = Date.now() + deadlineMs;
  const demo = graph.request.accounts.length > 0 && graph.request.accounts.every((account) => isPreviewAccount(account));
  const reads: JourneyFacts["reads"] = options.reads === "none" || demo ? "none" : "live";
  const at = new Date(now).toISOString();

  // Wallet facts: gas balances of own accounts where a wallet leg signs or own money stops, gas prices, rent, token accounts.
  const networks = new Set<NetworkKey>();
  const balanceKeys: { network: NetworkKey; owner: string }[] = [];
  const addBalance = (network: NetworkKey, account: string) => {
    if (!isOwn(graph, account) || balanceKeys.length >= MAX_GAS_BALANCES) return;
    const owner = addressOf(account);
    if (!balanceKeys.some((entry) => entry.network === network && entry.owner === owner)) balanceKeys.push({ network, owner });
  };
  for (const step of [...graph.steps].sort((a, b) => a.index - b.index)) {
    networks.add(step.network);
    networks.add(destinationOf(step));
    if (unsigned(step)) addBalance(step.network, step.account);
    addBalance(destinationOf(step), holderOf(graph, step));
  }
  const needs: FactNeed[] = [];
  if (reads === "live") {
    for (const entry of balanceKeys) needs.push({ kind: "balance", network: entry.network, asset: CHAINS[entry.network].nativeAsset.symbol, owner: entry.owner });
    for (const step of graph.steps) {
      if (CHAINS[step.network].vm !== "svm" || !unsigned(step) || step.kind === "transfer" || step.kind === "bridge") continue;
      const output = step.minimumOutput ?? step.expectedOutput;
      const mint = output ? parseAssetId(output.asset) : null;
      if (mint && !mint.isNative) needs.push({ kind: "tokenAccount", network: step.network, mint: mint.reference, owner: addressOf(step.account) });
    }
  }
  for (const network of networks) needs.push(CHAINS[network].vm === "evm" ? { kind: "gasPrice", network } : { kind: "solanaRent", network });

  const assets = assetsToPrice(graph, preview);
  const venues = venuesToRead(graph, preview);
  const remaining = () => Math.max(1, deadline - Date.now());
  const [wallet, priceResults, venueResults, policy, allowances] = await Promise.all([
    readFacts(graph.request.accounts, needs, { deadlineMs: Math.min(remaining(), JOURNEY_READ_TIMEOUT_MS * 2) }).catch(() => null),
    Promise.allSettled(assets.map((asset) => withDeadline(quoteAsset(asset as AssetRef["asset"]), Math.min(JOURNEY_READ_TIMEOUT_MS, remaining())))),
    Promise.allSettled(venues.map((venue) => withDeadline(venueReader(venue), Math.min(JOURNEY_READ_TIMEOUT_MS, remaining())))),
    policyFacts(graph, deadline),
    reads === "live" ? allowancesFor(graph, preview, deadline) : Promise.resolve([]),
  ]);

  const native: Record<string, { amount: string; at: string } | null> = {};
  if (reads === "live") {
    for (const entry of balanceKeys) {
      const fact = wallet?.balances.find((candidate) => candidate.network === entry.network && plainAddress(candidate.owner) === entry.owner && candidate.asset === nativeAssetId(entry.network));
      native[`${entry.network}:${entry.owner}`] = fact?.status === "known" && fact.amount !== undefined ? { amount: fact.amount, at } : null;
    }
  }
  const gasPrice: Partial<Record<NetworkKey, { wei: string; at: string }>> = {};
  for (const network of networks) {
    const price = wallet ? gasPriceFrom(wallet, network) : null;
    if (price !== null) gasPrice[network] = { wei: price.toString(), at };
  }
  const solanaNetwork = [...networks].find((network) => CHAINS[network].vm === "svm");
  const rent = solanaNetwork && wallet ? rentFrom(wallet, solanaNetwork) : null;
  const tokenAccounts: Record<string, boolean> = {};
  for (const fact of wallet?.tokenAccounts ?? []) if (fact.status === "known" && fact.exists !== undefined) tokenAccounts[`${fact.owner}:${fact.mint}`] = fact.exists;
  const prices: Record<string, JourneyFacts["prices"][string]> = {};
  assets.forEach((asset, index) => {
    const result = priceResults[index];
    prices[asset] = result?.status === "fulfilled" && result.value ? result.value : null;
  });
  const venueFacts: Record<string, JourneyVenueFacts | null> = {};
  venues.forEach((venue, index) => {
    const result = venueResults[index];
    venueFacts[venue.id] = result?.status === "fulfilled" ? result.value : null;
  });
  const funding: Record<string, { portionBps: number; gasReserve?: string }> = {};
  for (const step of graph.steps) {
    if (step.funding) continue;
    const ref = decodeStepRef(step.quoteRef);
    if (ref?.portionBps !== undefined) funding[step.id] = { portionBps: ref.portionBps };
  }
  return {
    at,
    reads,
    native,
    gasPrice,
    solanaRent: rent && rent.wallet !== null && rent.tokenAccount !== null ? { walletLamports: rent.wallet.toString(), tokenAccountLamports: rent.tokenAccount.toString(), at } : null,
    tokenAccounts,
    prices,
    venues: venueFacts,
    policy,
    allowances,
    fees: feesFor(graph, preview, wallet, native),
    exitFees: exitFeesFor([...networks], wallet),
    gasOptions: gasOptionsFor(graph, prices),
    funding,
  };
}
