/**
 * Shared helpers: statuses, asset references, amount and text formatting,
 * asset identity, values and refund paths.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import {
  nativeAssetId,
  parseAccountId,
  parseAssetId,
  type AccountId,
} from "../caip.js";
import {
  findAssetByAddress,
  findAssetBySymbol,
  getAsset,
  type AssetDescriptor,
} from "../assets.js";
import { getProtocol, YIELD_VENUES, type YieldVenue } from "../protocols.js";
import { formatPreviewAmount } from "../preview.js";
import { isOwnRequestAccount } from "../flow.js";
import type {
  AssetAmount,
  AssetRef,
  IntentActionSpec,
  IntentGraph,
  IntentRequest,
  IntentStep,
  StepStatus,
} from "../intent.js";
import {
  CONSEQUENCE_KINDS,
  type ConsequenceKind,
  type ConsequenceSeverity,
  type JourneyOptionKind,
  type JourneyValueSource,
} from "./constants.js";
import type {
  AmountView,
  AssetIdentity,
  JourneyConsequence,
  JourneyFacts,
  JourneyOption,
  JourneyOptionAction,
  JourneyRefund,
  JourneyValue,
} from "./types.js";

/* ================================================================ builder */

/* ------------------------------------------------------------- helpers */

export const SEVERITY_RANK: Readonly<Record<ConsequenceSeverity, number>> = { block: 0, act: 1, warn: 2, info: 3 };
export const KIND_RANK = new Map<ConsequenceKind, number>(CONSEQUENCE_KINDS.map((kind, index) => [kind, index]));
/** Payload lifetime of a prepared EVM step (engine `PAYLOAD_TTL_SECONDS`). */
export const PAYLOAD_TTL_SECONDS = 90;
/** Unresolved settlement goes to manual review after this long (engine poller). */
export const MANUAL_REVIEW_SECONDS = 3 * 60 * 60;
/** Overhead of a Relay gas top-up on top of the delivered amount (live A8). */
export const TOPUP_OVERHEAD_USD = 0.02;
/** Relayer fee of the $1 gas leg into SOL (live A10). */
export const GAS_LEG_COST_USD = 0.03;
const ONE_E18 = 10n ** 18n;
export const EXPLORER_REFERENCE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/u;

const STARTED_STATUSES: ReadonlySet<StepStatus> = new Set(["submitted", "confirmed", "settling", "settled", "indeterminate"]);
export const IN_FLIGHT_STATUSES: ReadonlySet<StepStatus> = new Set(["submitted", "confirmed", "settling", "indeterminate"]);
export const UNSIGNED_STATUSES: ReadonlySet<StepStatus> = new Set(["pending", "ready", "awaiting_signature", "failed"]);
export const TERMINAL_INTENT_STATUSES: ReadonlySet<string> = new Set(["completed", "partially_completed", "failed", "expired", "cancelled"]);

export function started(step: IntentStep): boolean {
  return STARTED_STATUSES.has(step.status);
}

export function normalizedAsset(asset: string): string {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : asset;
}

export function sameAsset(a: string, b: string): boolean {
  return normalizedAsset(a) === normalizedAsset(b);
}

export function addressOf(account: string): string {
  const parsed = parseAccountId(account);
  if (!parsed) return account;
  return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
}

export function nativeKey(network: NetworkKey, account: string): string {
  return `${network}:${addressOf(account)}`;
}

export function refOf(amount: Pick<AssetAmount, "asset" | "symbol" | "decimals">): AssetRef {
  return { asset: amount.asset, symbol: amount.symbol, decimals: amount.decimals };
}

export function nativeRef(network: NetworkKey): AssetRef {
  const chain = CHAINS[network];
  return { asset: nativeAssetId(network), symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals };
}

export function isNativeOf(asset: string, network: NetworkKey): boolean {
  const parsed = parseAssetId(asset);
  return parsed !== null && parsed.isNative && parsed.chain.key === network;
}

export function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function view(units: bigint, decimals: number): AmountView {
  const positive = nonNegative(units);
  return { amount: positive.toString(), formatted: formatPreviewAmount(positive, decimals).replace(/^\+/u, "") };
}

/** Round half-even to cents (display only). */
export function cents(value: number): number {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = Math.abs(diff - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return rounded / 100 + 0;
}

export function wholeUnits(units: bigint, decimals: number): number {
  return Number(units) / 10 ** decimals;
}

export function networkName(network: NetworkKey): string {
  return CHAINS[network]?.name ?? network;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "unknown time" : `${date.toISOString().slice(11, 16)} UTC`;
}

export function usdText(value: number | null): string {
  return value === null ? "an unknown amount" : `$${value.toFixed(2)}`;
}

export function symbolText(amount: AmountView, symbol: string): string {
  return `${amount.formatted} ${symbol}`;
}

/** Registry descriptor of an asset id (EVM addresses compared case-insensitively). */
export function lookupAsset(asset: string): AssetDescriptor | null {
  const direct = getAsset(asset);
  if (direct) return direct;
  const parsed = parseAssetId(asset);
  if (!parsed || parsed.isNative) return parsed ? getAsset(nativeAssetId(parsed.chain.key)) : null;
  return findAssetByAddress(parsed.chain.key, parsed.reference);
}

export function isStable(asset: string): boolean {
  return lookupAsset(asset)?.category === "stablecoin";
}

/** The request's own account on `network` (same address on that network's VM). */
function ownAccountOn(graph: IntentGraph, network: NetworkKey): AccountId | null {
  const namespace = CHAINS[network].namespace;
  for (const account of graph.request.accounts) {
    const parsed = parseAccountId(account);
    if (parsed && parsed.chain.namespace === namespace) return `${CHAINS[network].id}:${parsed.address}` as AccountId;
  }
  return null;
}

export function destinationOf(step: IntentStep): NetworkKey {
  return step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork ?? step.network : step.network;
}

export function isCross(step: IntentStep): boolean {
  return step.settlement?.kind === "cross-network";
}

/** Who receives a step's output: the recipient, else the own account on the destination network. */
export function holderOf(graph: IntentGraph, step: IntentStep): AccountId {
  if (step.recipient) return step.recipient;
  const destination = destinationOf(step);
  if (destination === step.network) return step.account;
  return ownAccountOn(graph, destination) ?? step.account;
}

function outputOf(step: IntentStep): AssetAmount | undefined {
  return step.actualOutput ?? step.observedCredit ?? step.minimumOutput ?? step.expectedOutput;
}

export function venueName(step: IntentStep): string {
  return getProtocol(step.protocol)?.name ?? step.protocol;
}

export function portionText(portionBps: number): string {
  if (portionBps >= 10_000) return "";
  if (portionBps === 5_000) return "half of ";
  const percent = portionBps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}% of `;
}

/* -------------------------------------------------------------- identity */

const RECEIPT_KIND_LABEL: Readonly<Record<string, string>> = {
  "aave-reserve": "aToken",
  comet: "Compound balance",
  erc4626: "vault shares",
  ctoken: "mToken",
  "jupiter-lend": "jlToken",
  "kamino-reserve": "Kamino collateral",
  "save-reserve": "cToken",
  "fluid-ftoken": "fToken shares",
  "spark-vault": "savings shares",
  "yearn-vault": "vault shares",
  "savings-vault": "savings shares",
};

/** 1:1 receipts: the balance is the underlying (aTokens, Comet balances). */
export function oneToOne(venue: YieldVenue): boolean {
  return venue.kind === "aave-reserve" || venue.kind === "comet";
}

function receiptVenue(asset: string, network: NetworkKey): YieldVenue | null {
  const parsed = parseAssetId(asset);
  if (!parsed || parsed.isNative) return null;
  const reference = parsed.chain.namespace === "eip155" ? parsed.reference.toLowerCase() : parsed.reference;
  return YIELD_VENUES.find((venue) => {
    if (venue.network !== network || !("receipt" in venue)) return false;
    const address = parsed.chain.namespace === "eip155" ? venue.receipt.address.toLowerCase() : venue.receipt.address;
    return address === reference;
  }) ?? null;
}

export function underlyingRef(venue: YieldVenue): AssetRef | undefined {
  const network = venue.network;
  if (CHAINS[network].nativeAsset.symbol.toUpperCase() === venue.asset.toUpperCase()) return nativeRef(network);
  const descriptor = findAssetBySymbol(network, venue.asset);
  return descriptor ? { asset: descriptor.id, symbol: descriptor.symbol, decimals: descriptor.decimals } : undefined;
}

/**
 * The identity of an asset at a stop: what it is a claim on. `venueHint`
 * names the venue of a deposit or withdraw step, for receipts the registry
 * does not list (Kamino collateral).
 */
export function assetIdentity(asset: AssetRef, network: NetworkKey, venueHint?: YieldVenue | null): AssetIdentity {
  const chain = CHAINS[network];
  if (isNativeOf(asset.asset, network)) {
    return { kind: "native", label: `${chain.name}'s gas asset (${chain.nativeAsset.symbol})` };
  }
  const venue = receiptVenue(asset.asset, network) ?? (venueHint && !lookupAsset(asset.asset) ? venueHint : null);
  if (venue) {
    const underlying = underlyingRef(venue);
    const what = RECEIPT_KIND_LABEL[venue.kind] ?? "position token";
    const label = oneToOne(venue)
      ? `Your ${venue.name} position: 1 ${asset.symbol} = 1 ${venue.asset} plus interest (${what})`
      : `Your ${venue.name} position (${what}); its value in ${venue.asset} follows the venue's share rate`;
    return { kind: "receipt", label, ...(underlying ? { underlying } : {}) };
  }
  const descriptor = lookupAsset(asset.asset);
  if (!descriptor) return { kind: "unlisted", label: `${asset.symbol} is not in Kletia's asset registry; it is never valued by its symbol` };
  if (descriptor.transferOnly) return { kind: "bridged", label: `${descriptor.name} (${descriptor.symbol}), a bridged token distinct from native USDC` };
  if ((descriptor.group === "USDC" || descriptor.group === "EURC") && descriptor.category === "stablecoin" && chain.settlement.cctpDomain !== undefined) {
    return { kind: "issuer", label: `Circle-issued ${descriptor.symbol} (CCTP domain ${chain.settlement.cctpDomain})` };
  }
  if (descriptor.category === "wrapped") {
    if (descriptor.symbol.toUpperCase() === `W${chain.nativeAsset.symbol.toUpperCase()}`) {
      return { kind: "wrapped", label: `${descriptor.symbol}: 1:1 wrapper of ${chain.nativeAsset.symbol} on ${chain.name}` };
    }
    return { kind: "bridged", label: `${descriptor.symbol} on ${chain.name} is bridged ${descriptor.group ?? descriptor.symbol}, not the network's gas asset` };
  }
  if (descriptor.category === "liquid-staking") {
    const staked = descriptor.group === "SOL" || chain.vm === "svm" ? "SOL" : "ETH";
    const underlying = descriptor.group === "SOL" || chain.vm === "svm" ? nativeRef(network) : undefined;
    return { kind: "liquid-staking", label: `${descriptor.symbol}: a claim on staked ${staked} with a moving exchange rate`, ...(underlying ? { underlying } : {}) };
  }
  if (descriptor.category === "btc") {
    const issuer = descriptor.symbol === "cbBTC" ? "Coinbase" : "its custodian";
    return { kind: "custodial", label: `${descriptor.symbol}: bitcoin held by ${issuer}, issued 1:1` };
  }
  return { kind: "listed", label: `${descriptor.name} (${descriptor.symbol}), listed on ${chain.name}` };
}

/* ------------------------------------------------------------- valuation */

export function priceFact(facts: JourneyFacts, asset: string): { readonly usd: number; readonly source: JourneyValueSource; readonly at: string } | null {
  const direct = facts.prices[asset] ?? facts.prices[normalizedAsset(asset)];
  if (direct && Number.isFinite(direct.usd) && direct.usd >= 0) return direct;
  return null;
}

/** Underlying per whole share as a number (18-decimal fixed point in facts); null when unknown. */
function shareRateOf(venue: YieldVenue, facts: JourneyFacts): { readonly rate: number; readonly at: string } | null {
  if (oneToOne(venue)) return { rate: 1, at: facts.at };
  const fact = facts.venues[venue.id];
  if (!fact || fact.shareRate === null || !/^\d+$/u.test(fact.shareRate)) return null;
  const raw = BigInt(fact.shareRate);
  if (raw <= 0n) return null;
  return { rate: Number(raw) / Number(ONE_E18), at: fact.at };
}

/**
 * USD value of a holding: the price fact of the asset itself, else, for a
 * receipt, its underlying's price through the venue's share rate. Unpriced is
 * never 0.
 */
export function valueOf(asset: AssetRef, identity: AssetIdentity, expected: bigint, atLeast: bigint, facts: JourneyFacts, network: NetworkKey, venueHint?: YieldVenue | null): JourneyValue {
  const usd = (units: bigint, price: number) => cents(wholeUnits(units, asset.decimals) * price);
  const direct = priceFact(facts, asset.asset);
  if (direct && identity.kind !== "receipt") {
    return {
      expectedUsd: usd(expected, direct.usd),
      atLeastUsd: usd(atLeast, direct.usd),
      price: direct.usd,
      source: direct.source,
      at: direct.at,
      ...(identity.kind === "liquid-staking" ? { basis: identity.label } : {}),
    };
  }
  if (identity.kind === "receipt" && identity.underlying) {
    const venue = receiptVenue(asset.asset, network) ?? venueHint ?? null;
    const underlying = priceFact(facts, identity.underlying.asset);
    const rate = venue ? shareRateOf(venue, facts) : null;
    if (venue && underlying && rate) {
      // Price per whole share = underlying price × underlying per whole share.
      const price = underlying.usd * rate.rate;
      const basis = oneToOne(venue)
        ? `1 ${asset.symbol} = 1 ${identity.underlying.symbol} plus interest (${RECEIPT_KIND_LABEL[venue.kind] ?? "receipt"})`
        : `1 ${asset.symbol} = ${rate.rate.toPrecision(6).replace(/\.?0+$/u, "")} ${identity.underlying.symbol} (share rate at ${timeOf(rate.at)})`;
      return {
        expectedUsd: usd(expected, price),
        atLeastUsd: usd(atLeast, price),
        price,
        source: underlying.source === "testnet" ? "testnet" : "venue-rate",
        at: rate.at < underlying.at ? rate.at : underlying.at,
        basis,
      };
    }
  }
  return { expectedUsd: null, atLeastUsd: null, price: null, source: "unpriced", at: null };
}

/* ----------------------------------------------------------- refund path */

export function lifiTool(step: IntentStep): "across" | "polymer" | "unknown" {
  const text = [step.title, ...(step.warnings ?? []), ...step.evidence.map((entry) => entry.detail ?? "")].join(" ");
  if (/polymer|cctp/iu.test(text)) return "polymer";
  if (/across/iu.test(text)) return "across";
  return "unknown";
}

/**
 * How a cross-network leg returns the money when it cannot fill (plus Across
 * and CCTP V2). Null for same-network legs (atomic).
 */
export function refundPath(graph: IntentGraph, step: IntentStep): JourneyRefund | null {
  if (!isCross(step)) return null;
  const origin = networkName(step.network);
  const destinationKey = destinationOf(step);
  const destination = networkName(destinationKey);
  const input = step.input;
  const upTo = input ? view(BigInt(input.amount), input.decimals) : undefined;
  const what = input && upTo ? symbolText(upTo, input.symbol) : "the deposit";
  const base = { network: step.network, to: step.account, asset: input ? refOf(input) : null, ...(upTo ? { upTo } : {}) };
  switch (step.protocol) {
    case "relay":
      return { ...base, mode: "automatic", label: `If Relay cannot fill, it refunds up to ${what} to your ${origin} wallet, minus the refund's gas.`, typicalDelay: "minutes" };
    case "across":
      return { ...base, mode: "after-deadline", label: `If no relayer fills before the fill deadline, Across refunds ${what} to your ${origin} wallet; this can take several hours.`, typicalDelay: "hours" };
    case "cctp-v2":
      return {
        mode: "none",
        network: destinationKey,
        to: holderOf(graph, step),
        asset: null,
        label: `USDC is burned on ${origin} and minted on ${destination} by Circle's CCTP; there is no refund. If the mint is not completed, the transfer is indeterminate until it is minted on ${destination} with Circle's attestation (the message hash is the reference).`,
        typicalDelay: "unknown",
      };
    case "lifi": {
      const tool = lifiTool(step);
      if (tool === "polymer") {
        return {
          mode: "none",
          network: destinationKey,
          to: holderOf(graph, step),
          asset: null,
          label: `USDC is burned on ${origin} and minted on ${destination}; there is no refund. If the relayer stalls, the mint can be completed on ${destination} with Circle's attestation.`,
          typicalDelay: "unknown",
        };
      }
      return { ...base, mode: "after-deadline", label: `If no relayer fills before the fill deadline, Across (through LI.FI) refunds ${what} to your ${origin} wallet; this can take several hours.`, typicalDelay: tool === "across" ? "hours" : "unknown" };
    }
    case "debridge-dln": {
      const authority = holderOf(graph, step);
      const own = isOwnRequestAccount(graph, authority);
      const native = nativeRef(destinationKey);
      return {
        ...base,
        mode: "after-cancel",
        label: `If no solver fills, cancel the order from your ${destination} account (it needs ${native.symbol} there for the cancel fee); the full deposit then returns to your ${origin} wallet.`,
        needs: { network: destinationKey, account: own ? authority : null, asset: native, why: `A deBridge cancel is sent from the destination account with a positive ${native.symbol} value.` },
        typicalDelay: "minutes",
      };
    }
    default:
      return { ...base, mode: "automatic", label: `If ${venueName(step)} cannot complete the transfer, it returns ${what} on ${origin} under its own rules.`, typicalDelay: "unknown" };
  }
}

/* ------------------------------------------------------------ consequences */

export type Draft = Omit<JourneyConsequence, "collapsed" | "prompt"> & { readonly question?: string };

export function option(id: JourneyOptionKind, label: string, effect: string, action: JourneyOptionAction, costUsd: number | null = null, recommended = false): JourneyOption {
  return { id, label, effect, costUsd, recommended, action };
}

export const OK_OPTION = option("ok", "I will handle it", "Nothing changes; you take care of it yourself.", { type: "acknowledge" });

/** A request without its text: the structured actions replace it. */
export function actionsRequest(graph: IntentGraph, actions: readonly IntentActionSpec[]): IntentRequest {
  const { text: _text, actions: _actions, sourceNetwork: _source, ...rest } = graph.request;
  void _text;
  void _actions;
  void _source;
  return { ...rest, actions: [...actions] };
}
