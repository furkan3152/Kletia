/**
 * Intent-level asset-change preview, `kletia.preview/v1` ("fare breakdown";
 * asset-preview design V1).
 *
 * The engine simulates (or quotes) every step and hands one `StepPreview`
 * per step to `aggregatePreview`, which nets the whole intent per
 * (network, account, asset), collapses transit rows, prices everything with
 * the prices it is given and computes the digest that `acknowledgedPreview`
 * binds at prepare. `materialChange` decides whether a fresh preview is
 * materially worse than the one a user acknowledged.
 *
 * Every number carries a certainty label; nothing is shown as more certain
 * than it is (weakest wins when contributions are summed). Pure functions,
 * no I/O.
 */
import type { NetworkKey } from "./chains.js";
import { CHAINS } from "./chains.js";
import { parseAccountId, parseAssetId, sameAddressAccount, type AccountId, type AssetId } from "./caip.js";
import { canonicalJson } from "./contracts.js";
import { getAsset } from "./assets.js";
import { sha256Hex } from "./hash.js";
import type { AssetRef, IntentActionKind, IntentGraph } from "./intent.js";
import type { ValidationResult } from "./validation.js";

export const PREVIEW_SPEC = "kletia.preview/v1" as const;
export const PREVIEW_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type PreviewStage = "plan" | "prepare" | "refresh" | "indicative";
export type Certainty = "simulated" | "simulated-assumed-funds" | "venue-minimum" | "quoted" | "estimated";
/** Weakest last: aggregation keeps the weakest certainty of every contribution. */
export const CERTAINTY_ORDER: readonly Certainty[] = Object.freeze(["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"]);

/** A signed amount: negative = leaves the account. */
export interface PreviewAmount {
  /** Base units as a decimal integer string, e.g. "-100000000". */
  readonly amount: string;
  /** Display text with sign, e.g. "-100", "+95.4773". */
  readonly formatted: string;
  /** Signed USD, absent when unpriced. */
  readonly usd?: number;
}

export interface AssetDeltaRow {
  readonly network: NetworkKey;
  /** CAIP-10 of the user's account on `network`. */
  readonly account: AccountId;
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** In core ASSETS. */
  readonly listed: boolean;
  readonly expected: PreviewAmount;
  /** Bound in the user's disfavour (largest debit, smallest credit). */
  readonly worst: PreviewAmount;
  /** Weakest certainty among contributions. */
  readonly certainty: Certainty;
  /** Contributing step ids. */
  readonly steps: readonly string[];
  /** `transit`: credits and debits cancel (funds passing through the wallet). */
  readonly role: "you" | "transit";
}

export interface ExternalPayment {
  readonly stepId: string;
  readonly network: NetworkKey;
  readonly recipient: AccountId;
  /** ENS / Basenames / SNS name the address was resolved from. */
  readonly recipientName?: string;
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** Positive: what they receive. */
  readonly expected: PreviewAmount;
  readonly worst: PreviewAmount;
  readonly certainty: Certainty;
}

export type FeeKind = "network" | "l1-data" | "venue" | "extra" | "rent";

export interface FeeLine {
  readonly stepId: string;
  readonly network: NetworkKey;
  readonly kind: FeeKind;
  /** "Base network fee", "Relay relayer fee", "deBridge fixed fee". */
  readonly label: string;
  readonly asset?: AssetRef;
  /** Base units, positive. */
  readonly amount?: string;
  readonly formatted?: string;
  readonly usd?: number;
  /** `deducted`: already inside a lower output; `on-top`: debited in addition; `refundable`: Solana rent returned when the account closes. */
  readonly paid: "deducted" | "on-top" | "refundable";
  readonly certainty: Certainty;
}

export interface ApprovalLine {
  readonly stepId: string;
  readonly network: NetworkKey;
  readonly token: AssetRef;
  readonly spender: string;
  /** Venue or integrator name, never a raw guess. */
  readonly spenderLabel: string;
  readonly amount: string;
  readonly formatted: string;
  /** Allowance read after the simulated block; null when not simulated. "0" means nothing is left. */
  readonly leftAfter: string | null;
}

export interface PreviewIssue {
  /** Error-catalog code or a PREVIEW_* code. */
  readonly code: string;
  readonly severity: "block" | "warn";
  readonly message: string;
}

export interface StepPreview {
  readonly stepId: string;
  readonly network: NetworkKey;
  readonly kind: IntentActionKind;
  readonly status: "simulated" | "simulated-assumed-funds" | "quoted" | "unavailable" | "failed";
  /** ISO time of the simulation or quote. */
  readonly at: string;
  /** Simulated block number (EVM). */
  readonly block?: string;
  /** Simulation context slot (Solana). */
  readonly slot?: string;
  /** Host only, e.g. "base-rpc.publicnode.com". */
  readonly endpoint?: string;
  readonly overrides?: readonly { readonly asset: AssetId; readonly amount: string }[];
  /** Prepare stage: equals `payload.quoteBinding`. */
  readonly quoteBinding?: string;
  readonly deltas: readonly AssetDeltaRow[];
  readonly payments: readonly ExternalPayment[];
  readonly fees: readonly FeeLine[];
  readonly approvals: readonly ApprovalLine[];
  readonly gas?: { readonly used: string; readonly price: string; readonly l1Fee?: string };
  readonly issues: readonly PreviewIssue[];
}

export interface PreviewNeed {
  readonly network: NetworkKey;
  readonly account: AccountId;
  readonly asset: AssetRef;
  readonly amount: string;
  readonly formatted: string;
  readonly reason: "input-balance" | "gas-on-arrival" | "rent";
  /** Balance read, when read. */
  readonly have?: string;
}

export interface PreviewTotals {
  /** Σ |debits| of role "you". */
  readonly youPayUsd: number | null;
  readonly youGetUsd: { readonly expected: number | null; readonly worst: number | null };
  readonly paidToOthersUsd: { readonly expected: number | null; readonly worst: number | null };
  /** network + l1-data. */
  readonly networkFeesUsd: number | null;
  /** Deducted venue fees. */
  readonly venueFeesUsd: number | null;
  /** On-top venue costs. */
  readonly extraCostsUsd: number | null;
  readonly costUsd: { readonly expected: number | null; readonly worst: number | null };
  /** Residual: cost − network − venue − extra (may be negative). */
  readonly priceDifferenceUsd: number | null;
  readonly unpriced: readonly AssetId[];
}

export interface IntentPreview {
  readonly spec: typeof PREVIEW_SPEC;
  /** Dry runs carry their dry-run id. */
  readonly intentId: string;
  readonly computedAt: string;
  readonly stage: PreviewStage;
  readonly basis: "simulated" | "partial" | "quoted" | "unavailable";
  /** "sha256:<hex>" over what moves (`previewDigest`). */
  readonly digest: string;
  readonly rows: readonly AssetDeltaRow[];
  readonly payments: readonly ExternalPayment[];
  readonly fees: readonly FeeLine[];
  readonly approvals: readonly ApprovalLine[];
  readonly steps: readonly StepPreview[];
  readonly totals: PreviewTotals;
  readonly arrival?: { readonly network: NetworkKey; readonly seconds: number };
  readonly needs: readonly PreviewNeed[];
  readonly warnings: readonly string[];
}

/** Warning codes carried in `PreviewIssue.code` (not API errors). Use these constants, not string literals, in API code. */
export const PREVIEW_WARNING_CODES = Object.freeze({
  unavailable: "PREVIEW_UNAVAILABLE",
  overrideUnavailable: "PREVIEW_OVERRIDE_UNAVAILABLE",
  allowanceLeft: "PREVIEW_ALLOWANCE_LEFT",
  gasOnArrival: "PREVIEW_GAS_ON_ARRIVAL",
  unpriced: "PREVIEW_UNPRICED",
  stepQuoted: "PREVIEW_STEP_QUOTED",
} as const);

/** Codes of `materialChange` issues (each one makes `PREVIEW_CHANGED` at prepare). */
export const PREVIEW_CHANGE_CODES = Object.freeze({
  newDebit: "PREVIEW_NEW_DEBIT",
  worseAmount: "PREVIEW_WORSE_AMOUNT",
  recipientChanged: "PREVIEW_RECIPIENT_CHANGED",
  paymentLower: "PREVIEW_PAYMENT_LOWER",
  approvalGrew: "PREVIEW_APPROVAL_GREW",
  feesUp: "PREVIEW_FEES_UP",
} as const);

/** Thresholds of `materialChange` (asset-preview design §7.2). */
export const PREVIEW_CHANGE_LIMITS = Object.freeze({
  /** Rows and payments may get worse by this much (and, for rows, by at least one base unit) before it is material. */
  amountToleranceBps: 10,
  /** Network + extra fees may grow by max(5 %, $0.05). */
  feeGrowthBps: 500,
  feeGrowthMinUsd: 0.05,
});

/** USD per whole token, by CAIP-19 id. Missing or null = unpriced. */
export type PreviewPrices = Readonly<Record<string, number | null | undefined>> | ((asset: AssetId) => number | null | undefined);

export interface AggregatePreviewOptions {
  readonly stage?: PreviewStage;
  /** Needs computed by the engine (balances read, gas on arrival, rent). */
  readonly needs?: readonly PreviewNeed[];
  readonly warnings?: readonly string[];
  /** Overrides graph.id (dry runs). */
  readonly intentId?: string;
}

/* ------------------------------------------------------------------ helpers */

const certaintyRank = (certainty: Certainty): number => CERTAINTY_ORDER.indexOf(certainty);
const weakest = (a: Certainty, b: Certainty): Certainty => (certaintyRank(a) >= certaintyRank(b) ? a : b);

function addressKey(account: string): string {
  const parsed = parseAccountId(account);
  if (!parsed) return account;
  return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
}

function normalizedAccount(account: string): string {
  const parsed = parseAccountId(account);
  return parsed && parsed.chain.namespace === "eip155" ? `${parsed.chain.id}:${parsed.address.toLowerCase()}` : account;
}

function normalizedAsset(asset: string): string {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : asset;
}

function normalizedAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/u.test(address) ? address.toLowerCase() : address;
}

/** Signed display text: at most 6 significant digits, truncated toward zero, "+" for credits. */
export function formatPreviewAmount(units: bigint | string, decimals: number): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  if (value === 0n) return "0";
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  let fraction = (absolute % scale).toString().padStart(decimals, "0");
  const wholeText = whole.toString();
  const significantWhole = whole === 0n ? 0 : wholeText.length;
  let keep: number;
  if (significantWhole >= 6) keep = 0;
  else if (significantWhole > 0) keep = 6 - significantWhole;
  else {
    const leadingZeros = fraction.length - fraction.replace(/^0+/u, "").length;
    keep = leadingZeros + 6;
  }
  fraction = fraction.slice(0, keep).replace(/0+$/u, "");
  const body = fraction ? `${wholeText}.${fraction}` : wholeText;
  return `${negative ? "-" : "+"}${body === "0" ? "0" : body}`.replace(/^\+0$/u, "0");
}

function priceOf(prices: PreviewPrices, asset: AssetId): number | null {
  const value = typeof prices === "function" ? prices(asset) : prices[asset] ?? prices[normalizedAsset(asset)];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** USD of base units at a price, rounded to micro-dollars (display). */
function usdOf(units: bigint, decimals: number, price: number): number {
  const micros = Math.round((Number(units) / 10 ** decimals) * price * 1_000_000);
  return micros / 1_000_000 + 0;
}

/** Round half-even to cents. */
function cents(value: number): number {
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const rounded = Math.abs(diff - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return rounded / 100 + 0;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

function amount(units: bigint, decimals: number, price: number | null): PreviewAmount {
  return {
    amount: units.toString(),
    formatted: formatPreviewAmount(units, decimals),
    ...(price !== null ? { usd: usdOf(units, decimals, price) } : {}),
  };
}

/* ------------------------------------------------------------- aggregation */

interface RowAccumulator {
  network: NetworkKey;
  account: AccountId;
  asset: AssetId;
  symbol: string;
  decimals: number;
  listed: boolean;
  expected: bigint;
  worst: bigint;
  certainty: Certainty;
  steps: string[];
  sawCredit: boolean;
  sawDebit: boolean;
  order: number;
}

/**
 * Aggregates step previews into the intent preview (asset-preview design
 * §5.6). Payments to the user's own accounts (same address rule as the
 * policy's `sameAddressAccount`) count as deltas; rows whose expected and
 * worst both net to zero after a credit and a debit become `transit`.
 * Totals are null when any amount they need is unpriced (the asset is then
 * listed in `totals.unpriced`). The digest is computed here.
 */
export function aggregatePreview(
  graph: IntentGraph,
  stepPreviews: readonly StepPreview[],
  prices: PreviewPrices,
  now: string | number | Date,
  options: AggregatePreviewOptions = {},
): IntentPreview {
  const own = graph.request.accounts;
  const isOwn = (account: string) => own.some((candidate) => sameAddressAccount(candidate, account));
  const ordered = [...stepPreviews].sort((a, b) => stepIndex(graph, a.stepId) - stepIndex(graph, b.stepId));
  const rows = new Map<string, RowAccumulator>();
  const networkOrder: NetworkKey[] = [];
  const unpriced = new Set<AssetId>();
  let sequence = 0;

  const contribute = (entry: {
    network: NetworkKey;
    account: AccountId;
    asset: AssetId;
    symbol: string;
    decimals: number;
    expected: bigint;
    worst: bigint;
    certainty: Certainty;
    stepId: string;
  }) => {
    if (!networkOrder.includes(entry.network)) networkOrder.push(entry.network);
    const key = `${entry.network}|${addressKey(entry.account)}|${normalizedAsset(entry.asset)}`;
    const existing = rows.get(key);
    const accumulator: RowAccumulator = existing ?? {
      network: entry.network,
      account: entry.account,
      asset: entry.asset,
      symbol: entry.symbol,
      decimals: entry.decimals,
      listed: getAsset(entry.asset) !== null,
      expected: 0n,
      worst: 0n,
      certainty: entry.certainty,
      steps: [],
      sawCredit: false,
      sawDebit: false,
      order: sequence++,
    };
    accumulator.expected += entry.expected;
    accumulator.worst += entry.worst;
    accumulator.certainty = existing ? weakest(accumulator.certainty, entry.certainty) : entry.certainty;
    if (!accumulator.steps.includes(entry.stepId)) accumulator.steps.push(entry.stepId);
    if (entry.expected > 0n || entry.worst > 0n) accumulator.sawCredit = true;
    if (entry.expected < 0n || entry.worst < 0n) accumulator.sawDebit = true;
    rows.set(key, accumulator);
  };

  const payments: ExternalPayment[] = [];
  for (const step of ordered) {
    for (const delta of step.deltas) {
      contribute({
        network: delta.network,
        account: delta.account,
        asset: delta.asset,
        symbol: delta.symbol,
        decimals: delta.decimals,
        expected: BigInt(delta.expected.amount),
        worst: BigInt(delta.worst.amount),
        certainty: delta.certainty,
        stepId: step.stepId,
      });
    }
    for (const payment of step.payments) {
      if (isOwn(payment.recipient)) {
        contribute({
          network: payment.network,
          account: payment.recipient,
          asset: payment.asset,
          symbol: payment.symbol,
          decimals: payment.decimals,
          expected: BigInt(payment.expected.amount),
          worst: BigInt(payment.worst.amount),
          certainty: payment.certainty,
          stepId: payment.stepId,
        });
      } else {
        const price = priceOf(prices, payment.asset);
        if (price === null) unpriced.add(payment.asset);
        payments.push({
          ...payment,
          expected: amount(BigInt(payment.expected.amount), payment.decimals, price),
          worst: amount(BigInt(payment.worst.amount), payment.decimals, price),
        });
      }
    }
  }

  const accumulated = [...rows.values()];
  const rank = (row: RowAccumulator) => {
    const transit = row.expected === 0n && row.worst === 0n && row.sawCredit && row.sawDebit;
    return [transit ? 1 : 0, row.expected < 0n ? 0 : row.expected === 0n ? 1 : 2, networkOrder.indexOf(row.network), row.order] as const;
  };
  accumulated.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const diff = (left[index] as number) - (right[index] as number);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  const outRows: AssetDeltaRow[] = accumulated.map((row) => {
    const price = priceOf(prices, row.asset);
    const transit = row.expected === 0n && row.worst === 0n && row.sawCredit && row.sawDebit;
    if (price === null && !transit) unpriced.add(row.asset);
    return {
      network: row.network,
      account: row.account,
      asset: row.asset,
      symbol: row.symbol,
      decimals: row.decimals,
      listed: row.listed,
      expected: amount(row.expected, row.decimals, price),
      worst: amount(row.worst, row.decimals, price),
      certainty: row.certainty,
      steps: row.steps,
      role: transit ? "transit" : "you",
    };
  });

  const fees: FeeLine[] = ordered.flatMap((step) =>
    step.fees.map((fee) => {
      if (fee.asset && fee.amount !== undefined) {
        const price = priceOf(prices, fee.asset.asset);
        if (price === null) {
          if (fee.usd === undefined) unpriced.add(fee.asset.asset);
          return { ...fee, formatted: fee.formatted ?? formatPreviewAmount(BigInt(fee.amount), fee.asset.decimals).replace(/^\+/u, "") };
        }
        return { ...fee, formatted: fee.formatted ?? formatPreviewAmount(BigInt(fee.amount), fee.asset.decimals).replace(/^\+/u, ""), usd: usdOf(BigInt(fee.amount), fee.asset.decimals, price) };
      }
      return fee;
    }),
  );
  const approvals: ApprovalLine[] = ordered.flatMap((step) => step.approvals.map((approval) => ({ ...approval })));

  const youRows = outRows.filter((row) => row.role === "you");
  const usdValue = (value: PreviewAmount): number | null => (value.usd === undefined ? null : value.usd);
  const debits = youRows.filter((row) => BigInt(row.expected.amount) < 0n);
  const credits = youRows.filter((row) => BigInt(row.expected.amount) > 0n);
  const youPay = sumOrNull(debits.map((row) => (row.expected.usd === undefined ? null : Math.abs(row.expected.usd))));
  const youGetExpected = sumOrNull(credits.map((row) => usdValue(row.expected)));
  const youGetWorst = sumOrNull(credits.map((row) => usdValue(row.worst)));
  const othersExpected = sumOrNull(payments.map((payment) => usdValue(payment.expected)));
  const othersWorst = sumOrNull(payments.map((payment) => usdValue(payment.worst)));
  const feeUsd = (kinds: readonly FeeKind[], paid?: FeeLine["paid"]) =>
    sumOrNull(fees.filter((fee) => kinds.includes(fee.kind) && (paid === undefined || fee.paid === paid)).map((fee) => (fee.usd === undefined ? null : fee.usd)));
  const network = feeUsd(["network", "l1-data"]);
  const venue = feeUsd(["venue"], "deducted");
  const extra = feeUsd(["extra"]);
  const costExpected = youPay === null || youGetExpected === null || othersExpected === null ? null : youPay - youGetExpected - othersExpected;
  const costWorst = youPay === null || youGetWorst === null || othersWorst === null ? null : youPay - youGetWorst - othersWorst;
  const difference = costExpected === null || network === null || venue === null || extra === null ? null : costExpected - network - venue - extra;
  const round = (value: number | null) => (value === null ? null : cents(value));

  const simulated = ordered.filter((step) => step.status === "simulated" || step.status === "simulated-assumed-funds").length;
  const quoted = ordered.filter((step) => step.status === "quoted").length;
  const basis: IntentPreview["basis"] =
    graph.steps.length > 0 && simulated === graph.steps.length && ordered.length === graph.steps.length
      ? "simulated"
      : simulated > 0
        ? "partial"
        : quoted > 0
          ? "quoted"
          : "unavailable";

  let arrival: IntentPreview["arrival"];
  for (const step of graph.steps) {
    const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
    const seconds = step.estimatedSeconds ?? step.settlement?.expectedSeconds;
    if (destination && seconds !== undefined && Number.isFinite(seconds) && (!arrival || seconds >= arrival.seconds)) {
      arrival = { network: destination, seconds: Math.max(0, Math.round(seconds)) };
    }
  }

  const computedAt = new Date(now).toISOString();
  const preview: Omit<IntentPreview, "digest"> = {
    spec: PREVIEW_SPEC,
    intentId: options.intentId ?? graph.id,
    computedAt,
    stage: options.stage ?? "plan",
    basis,
    rows: outRows,
    payments,
    fees,
    approvals,
    steps: ordered,
    totals: {
      youPayUsd: round(youPay),
      youGetUsd: { expected: round(youGetExpected), worst: round(youGetWorst) },
      paidToOthersUsd: { expected: round(othersExpected), worst: round(othersWorst) },
      networkFeesUsd: round(network),
      venueFeesUsd: round(venue),
      extraCostsUsd: round(extra),
      costUsd: { expected: round(costExpected), worst: round(costWorst) },
      priceDifferenceUsd: round(difference),
      unpriced: [...unpriced].sort(),
    },
    ...(arrival ? { arrival } : {}),
    needs: [...(options.needs ?? [])],
    warnings: [...(options.warnings ?? [])],
  };
  return { ...preview, digest: previewDigestSync(preview) };
}

function stepIndex(graph: IntentGraph, stepId: string): number {
  const index = graph.steps.findIndex((step) => step.id === stepId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/* ------------------------------------------------------------------ digest */

function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** The material content the digest pins (asset-preview design §7.1). */
export function previewDigestInput(preview: Pick<IntentPreview, "spec" | "intentId" | "rows" | "payments" | "approvals">): unknown {
  return {
    spec: preview.spec,
    intentId: preview.intentId,
    rows: preview.rows
      .map((row) => [row.network, normalizedAccount(row.account), normalizedAsset(row.asset), row.expected.amount, row.worst.amount])
      .sort(compareTuples),
    payments: preview.payments
      .map((payment) => [payment.network, normalizedAccount(payment.recipient), normalizedAsset(payment.asset), payment.expected.amount, payment.worst.amount])
      .sort(compareTuples),
    approvals: preview.approvals
      .map((approval) => [approval.network, normalizedAsset(approval.token.asset), normalizedAddress(approval.spender), approval.amount])
      .sort(compareTuples),
  };
}

function previewDigestSync(preview: Pick<IntentPreview, "spec" | "intentId" | "rows" | "payments" | "approvals">): string {
  return `sha256:${sha256Hex(canonicalJson(previewDigestInput(preview)))}`;
}

/**
 * "sha256:" + hex(SHA-256(canonicalJson(D))) where D holds what moves (rows,
 * payments, approvals) and nothing that drifts every block (USD, times,
 * blocks, fee estimates).
 */
export async function previewDigest(preview: Pick<IntentPreview, "spec" | "intentId" | "rows" | "payments" | "approvals">): Promise<string> {
  return previewDigestSync(preview);
}

/* --------------------------------------------------------- material change */

function rowKey(network: string, account: string, asset: string): string {
  return `${network}|${addressKey(account)}|${normalizedAsset(asset)}`;
}

/** True when `after` is lower than `before` by more than `bps` of |before| (and, with `minUnits`, by more than that many base units). */
function worseBy(before: bigint, after: bigint, bps: number, minUnits: bigint): boolean {
  const diff = before - after;
  if (diff <= 0n) return false;
  const magnitude = before < 0n ? -before : before;
  return diff > minUnits && diff * 10_000n > magnitude * BigInt(bps);
}

/**
 * Issues that make a fresh preview materially worse than an acknowledged one
 * (asset-preview design §7.2): new debit, a row worse by more than
 * max(1 unit, 10 bps), an external payment to another recipient or lower by
 * more than 10 bps, a new or larger approval, network + extra fees up by
 * more than max(5 %, $0.05) (only when both are priced). Empty = acceptable.
 */
export function materialChange(before: IntentPreview, after: IntentPreview): readonly PreviewIssue[] {
  const issues: PreviewIssue[] = [];
  const limits = PREVIEW_CHANGE_LIMITS;
  const beforeRows = new Map(before.rows.map((row) => [rowKey(row.network, row.account, row.asset), row]));
  const afterRows = new Map(after.rows.map((row) => [rowKey(row.network, row.account, row.asset), row]));
  for (const [key, row] of afterRows) {
    const previous = beforeRows.get(key);
    const worst = BigInt(row.worst.amount);
    if (!previous) {
      if (worst < 0n) {
        issues.push({ code: PREVIEW_CHANGE_CODES.newDebit, severity: "block", message: `New debit of ${row.worst.formatted.replace(/^-/u, "")} ${row.symbol} on ${CHAINS[row.network]?.name ?? row.network}.` });
      }
      continue;
    }
    if (worseBy(BigInt(previous.worst.amount), worst, limits.amountToleranceBps, 1n)) {
      issues.push({ code: PREVIEW_CHANGE_CODES.worseAmount, severity: "block", message: `${row.symbol} on ${CHAINS[row.network]?.name ?? row.network}: worst case ${row.worst.formatted}, was ${previous.worst.formatted}.` });
    }
  }
  for (const [key, row] of beforeRows) {
    if (afterRows.has(key)) continue;
    // A row that disappeared nets to zero now: material when it was a guaranteed credit.
    if (worseBy(BigInt(row.worst.amount), 0n, limits.amountToleranceBps, 1n)) {
      issues.push({ code: PREVIEW_CHANGE_CODES.worseAmount, severity: "block", message: `${row.symbol} on ${CHAINS[row.network]?.name ?? row.network} is no longer received.` });
    }
  }
  const paymentKey = (payment: ExternalPayment) => `${payment.stepId}|${payment.network}|${normalizedAsset(payment.asset)}`;
  const beforePayments = new Map(before.payments.map((payment) => [paymentKey(payment), payment]));
  for (const payment of after.payments) {
    const previous = beforePayments.get(paymentKey(payment));
    if (!previous || normalizedAccount(previous.recipient) !== normalizedAccount(payment.recipient)) {
      issues.push({ code: PREVIEW_CHANGE_CODES.recipientChanged, severity: "block", message: `Step ${payment.stepId} now pays ${payment.recipient}.` });
      continue;
    }
    if (worseBy(BigInt(previous.worst.amount), BigInt(payment.worst.amount), limits.amountToleranceBps, 0n)) {
      issues.push({ code: PREVIEW_CHANGE_CODES.paymentLower, severity: "block", message: `Step ${payment.stepId} pays at least ${payment.worst.formatted} ${payment.symbol}, was ${previous.worst.formatted}.` });
    }
  }
  const approvalKey = (approval: ApprovalLine) => `${approval.network}|${normalizedAsset(approval.token.asset)}|${normalizedAddress(approval.spender)}`;
  const beforeApprovals = new Map<string, bigint>();
  for (const approval of before.approvals) beforeApprovals.set(approvalKey(approval), (beforeApprovals.get(approvalKey(approval)) ?? 0n) + BigInt(approval.amount));
  const afterApprovals = new Map<string, { total: bigint; line: ApprovalLine }>();
  for (const approval of after.approvals) {
    const key = approvalKey(approval);
    afterApprovals.set(key, { total: (afterApprovals.get(key)?.total ?? 0n) + BigInt(approval.amount), line: approval });
  }
  for (const [key, { total, line }] of afterApprovals) {
    const previous = beforeApprovals.get(key);
    if (previous === undefined || total > previous) {
      issues.push({ code: PREVIEW_CHANGE_CODES.approvalGrew, severity: "block", message: `Approval of ${line.formatted} ${line.token.symbol} to ${line.spenderLabel} is new or larger.` });
    }
  }
  const feesBefore = before.totals.networkFeesUsd === null || before.totals.extraCostsUsd === null ? null : before.totals.networkFeesUsd + before.totals.extraCostsUsd;
  const feesAfter = after.totals.networkFeesUsd === null || after.totals.extraCostsUsd === null ? null : after.totals.networkFeesUsd + after.totals.extraCostsUsd;
  if (feesBefore !== null && feesAfter !== null) {
    const allowed = Math.max((feesBefore * limits.feeGrowthBps) / 10_000, limits.feeGrowthMinUsd);
    if (feesAfter - feesBefore > allowed + 1e-9) {
      issues.push({ code: PREVIEW_CHANGE_CODES.feesUp, severity: "block", message: `Fees rose from $${feesBefore.toFixed(2)} to $${feesAfter.toFixed(2)}.` });
    }
  }
  return issues;
}

/* -------------------------------------------------------------- prepare body */

export interface PreviewAck {
  /** Digest of the preview the user saw ("sha256:…"). */
  readonly acknowledgedPreview?: string;
}

/** Validates the optional prepare body `{ acknowledgedPreview }` (an empty or absent body is fine). */
export function validatePreviewAck(body: unknown): ValidationResult<PreviewAck> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  const record = body as Record<string, unknown>;
  const issues = Object.keys(record)
    .filter((key) => key !== "acknowledgedPreview")
    .map((key) => ({ path: key, message: "Unknown field. Allowed: acknowledgedPreview." }));
  const ack = record.acknowledgedPreview;
  if (ack !== undefined && (typeof ack !== "string" || !PREVIEW_DIGEST_PATTERN.test(ack))) {
    issues.push({ path: "acknowledgedPreview", message: "Must be a preview digest (sha256: + 64 hex)." });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: typeof ack === "string" ? { acknowledgedPreview: ack } : {} };
}
