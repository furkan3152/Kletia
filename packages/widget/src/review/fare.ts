/**
 * The fare model: the intent-level asset-change preview.
 */
import {
  toChecksumAddress,
  totalFeesUsd,
  type Certainty,
  type IntentGraph,
  type IntentPreview,
  type PreviewIssue,
  type PreviewNeed,
} from "@kletia/core";
import {
  CERTAINTIES,
  certaintyOf,
  cleanText,
  durationText,
  formatUsdAbs,
  networkLabel,
  shortAddress,
  unitsText,
  unsignedAmount,
} from "./text.js";

/* ================================================================= fare */

export interface FareMoney {
  /** Unsigned amount with separators, e.g. "100" or "0.000008". */
  readonly amount: string;
  readonly symbol: string;
  /** "$100.00", "<$0.01"; null when the asset has no price (print "price unavailable", never "$0"). */
  readonly usd: string | null;
  readonly certainty: Certainty;
}

export interface FareRow {
  readonly key: string;
  readonly network: string;
  readonly networkName: string;
  /** The user's account on that network (CAIP-10). */
  readonly account: string;
  /**
   * "0x5eed…c0de" when the fare moves money of more than one wallet of the
   * same kind (so each row says whose it is); null otherwise.
   */
  readonly accountLabel: string | null;
  /** What leaves or arrives (expected). */
  readonly expected: FareMoney;
  /** The bound in the user's disfavour when it differs from `expected` ("up to" for debits, "at least" for credits). */
  readonly bound: FareMoney | null;
  /** E.g. "network fee, leg 2". */
  readonly note: string | null;
  /** Not in Kletia's registry. */
  readonly unlisted: boolean;
}

export interface FareTransitRow {
  readonly key: string;
  readonly networkName: string;
  readonly symbol: string;
  /** "99.47 to 99.97 USDC" or "99.97 USDC". */
  readonly text: string;
  readonly legs: string;
  readonly certainty: Certainty;
}

export interface FarePayment {
  readonly key: string;
  readonly networkName: string;
  /** Full address (never truncated: users must be able to check every character). */
  readonly recipient: string;
  readonly recipientName: string | null;
  readonly expected: FareMoney;
  readonly atLeast: FareMoney | null;
}

export interface FareFee {
  readonly key: string;
  readonly label: string;
  readonly usd: string | null;
  readonly detail: string | null;
  readonly certainty: Certainty;
}

export interface FareAllowance {
  readonly key: string;
  readonly networkName: string;
  readonly spenderLabel: string;
  readonly spender: string;
  readonly amount: string;
  /** "0 left", "12.5 USDC left", or "not simulated". */
  readonly left: string;
  readonly leftover: boolean;
}

export interface FareNeed {
  readonly key: string;
  readonly reason: PreviewNeed["reason"];
  readonly networkName: string;
  readonly text: string;
  /** What the wallet holds now, when Kletia read it. */
  readonly have: string | null;
}

export interface FareModel {
  readonly digest: string;
  readonly stage: IntentPreview["stage"];
  readonly basis: IntentPreview["basis"];
  /** Why some numbers are not simulated, or null. */
  readonly basisNote: string | null;
  readonly legs: number;
  readonly networkChanges: number;
  readonly youPay: readonly FareRow[];
  readonly youGet: readonly FareRow[];
  readonly passesThrough: readonly FareTransitRow[];
  readonly paidToOthers: readonly FarePayment[];
  readonly fees: readonly FareFee[];
  readonly totals: {
    readonly youPay: string | null;
    readonly youGetExpected: string | null;
    readonly youGetAtLeast: string | null;
    readonly cost: string | null;
    /** Network fees, venue fees and costs on top (`totalFeesUsd`): the same total the review shows. */
    readonly fees: string | null;
  };
  readonly allowances: readonly FareAllowance[];
  readonly bring: readonly FareNeed[];
  /** "On Arbitrum in about 16 s". */
  readonly arrival: string | null;
  readonly warnings: readonly string[];
  /** Issues that stop signing (severity `block`). */
  readonly blocking: readonly PreviewIssue[];
  /** Symbols without a USD price. */
  readonly unpriced: readonly string[];
  /** Certainty labels that appear, in legend order. */
  readonly legend: readonly Certainty[];
}

function money(amount: { formatted: string; usd?: number }, symbol: string, certainty: Certainty): FareMoney {
  return { amount: unsignedAmount(amount.formatted), symbol: cleanText(symbol, 24) || "?", usd: formatUsdAbs(amount.usd), certainty };
}

function legsText(steps: readonly string[], index: (stepId: string) => number | undefined): string {
  const numbers = steps.map(index).filter((value): value is number => typeof value === "number").map((value) => value + 1);
  if (numbers.length === 0) return "";
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  return unique.length === 1 ? `leg ${unique[0]}` : `legs ${unique.join(", ")}`;
}

function isNative(asset: string): boolean {
  return /\/slip44:\d+$/u.test(asset);
}

const HIDDEN_ISSUE_CODES = new Set(["PREVIEW_GAS_ON_ARRIVAL", "PREVIEW_UNPRICED", "INSUFFICIENT_BALANCE"]);
/**
 * The address part of a CAIP-10 account, in full; EVM addresses in their
 * checksummed form (EIP-55), as wallets and explorers print them.
 */
function printedAddress(account: string): string {
  const address = cleanText(account.slice(account.lastIndexOf(":") + 1), 120);
  if (!account.startsWith("eip155:")) return address;
  try {
    return toChecksumAddress(address);
  } catch {
    return address;
  }
}
/** "PREVIEW_UNPRICED: no price for …" → code and sentence. */
const CODED_WARNING = /^([A-Z][A-Z0-9_]{2,63}):\s*/u;

/**
 * Display model of an intent preview. `intent` (optional) numbers the legs
 * ("network fee, leg 2"); without it notes omit leg numbers.
 */
export function fareModel(preview: IntentPreview, intent?: Pick<IntentGraph, "steps"> | null): FareModel {
  const order = new Map((intent?.steps ?? []).map((step) => [step.id, step.index]));
  /** What each step spends (its input asset): a debit of it is the amount moved, not a fee. */
  const inputAssets = new Map((intent?.steps ?? []).flatMap((step) => (step.input ? [[step.id, step.input.asset.toLowerCase()] as const] : [])));
  const index = (stepId: string) => order.get(stepId);
  const used = new Set<Certainty>();
  const note = (certainty: Certainty) => {
    used.add(certainty);
    return certainty;
  };

  const networkFeeSteps = new Map<string, Set<string>>();
  /** Base units of network fees per network and fee asset (to tell a fee-only debit from an input that also pays the fee). */
  const networkFeeUnits = new Map<string, bigint | null>();
  for (const fee of preview.fees ?? []) {
    if (fee.kind !== "network" && fee.kind !== "l1-data") continue;
    const set = networkFeeSteps.get(fee.network) ?? new Set<string>();
    set.add(fee.stepId);
    networkFeeSteps.set(fee.network, set);
    const unitsKey = `${fee.network}|${(fee.asset?.asset ?? "").toLowerCase()}`;
    const known = networkFeeUnits.has(unitsKey) ? networkFeeUnits.get(unitsKey)! : 0n;
    networkFeeUnits.set(unitsKey, known === null || !fee.amount || !/^\d+$/u.test(fee.amount) ? null : known + BigInt(fee.amount));
  }

  const youPay: FareRow[] = [];
  const youGet: FareRow[] = [];
  const passesThrough: FareTransitRow[] = [];
  for (const [position, row] of (preview.rows ?? []).entries()) {
    const certainty = note(certaintyOf(row.certainty));
    const key = `${row.network}|${row.account}|${row.asset}|${position}`;
    const symbol = cleanText(row.symbol, 24) || "?";
    if (row.role === "transit") {
      // The row nets to zero; print what passes through: the credit that fed it, as "worst to expected".
      const credit = (preview.steps ?? [])
        .flatMap((step) => step.deltas ?? [])
        .find(
          (delta) =>
            delta.network === row.network &&
            delta.asset.toLowerCase() === row.asset.toLowerCase() &&
            /^\d+$/u.test(delta.expected.amount) &&
            delta.expected.amount !== "0",
        );
      const high = credit ? unsignedAmount(credit.expected.formatted) : null;
      const low = credit ? unsignedAmount(credit.worst.formatted) : null;
      passesThrough.push({
        key,
        networkName: networkLabel(row.network),
        symbol,
        text: high === null ? symbol : low !== null && low !== high && !credit?.worst.amount.startsWith("-") ? `${low} to ${high} ${symbol}` : `${high} ${symbol}`,
        legs: legsText(row.steps, index),
        certainty,
      });
      continue;
    }
    const expected = BigInt(/^-?\d+$/u.test(row.expected.amount) ? row.expected.amount : "0");
    const worst = BigInt(/^-?\d+$/u.test(row.worst.amount) ? row.worst.amount : "0");
    if (expected === 0n && worst === 0n) continue;
    const debit = expected < 0n || (expected === 0n && worst < 0n);
    const differs = row.worst.amount !== row.expected.amount && worst !== 0n;
    const feeSteps = networkFeeSteps.get(row.network);
    // The amount swapped, bridged or deposited is never a fee: a debit that is more than the network
    // fee it pays (0.1 SOL swapped plus its fee) says it includes the fee; only a fee-only debit is "network fee".
    const paysFee = debit && isNative(row.asset) && feeSteps !== undefined && row.steps.some((step) => feeSteps.has(step));
    const feeUnits = networkFeeUnits.get(`${row.network}|${row.asset.toLowerCase()}`);
    const debited = expected < 0n ? -expected : -worst;
    const spentByStep = row.steps.some((stepId) => inputAssets.get(stepId) === row.asset.toLowerCase());
    const feeOnly = paysFee && (typeof feeUnits === "bigint" ? debited <= feeUnits : !spentByStep);
    const feeNote = paysFee ? [feeOnly ? "network fee" : "includes the network fee", legsText(row.steps, index)].filter(Boolean).join(", ") : null;
    const entry: FareRow = {
      key,
      network: row.network,
      networkName: networkLabel(row.network),
      account: cleanText(row.account, 140),
      accountLabel: null,
      expected: money(row.expected, symbol, certainty),
      bound: differs ? money(row.worst, symbol, certainty) : null,
      note: feeNote,
      unlisted: row.listed === false,
    };
    (debit ? youPay : youGet).push(entry);
  }
  // Several wallets of one kind (two EVM addresses, say): every row names its wallet.
  const owners = new Map<string, Set<string>>();
  for (const entry of [...youPay, ...youGet]) {
    const namespace = entry.account.split(":")[0] ?? "";
    const address = entry.account.slice(entry.account.lastIndexOf(":") + 1);
    const set = owners.get(namespace) ?? new Set<string>();
    set.add(namespace === "eip155" ? address.toLowerCase() : address);
    owners.set(namespace, set);
  }
  const label = (entry: FareRow): FareRow =>
    (owners.get(entry.account.split(":")[0] ?? "")?.size ?? 0) > 1 ? { ...entry, accountLabel: shortAddress(entry.account) } : entry;
  youPay.splice(0, youPay.length, ...youPay.map(label));
  youGet.splice(0, youGet.length, ...youGet.map(label));

  const paidToOthers: FarePayment[] = (preview.payments ?? []).map((payment, position) => {
    const certainty = note(certaintyOf(payment.certainty));
    const symbol = cleanText(payment.symbol, 24) || "?";
    return {
      key: `${payment.stepId}|${payment.recipient}|${position}`,
      networkName: networkLabel(payment.network),
      recipient: printedAddress(payment.recipient),
      recipientName: cleanText(payment.recipientName, 80) || null,
      expected: money(payment.expected, symbol, certainty),
      atLeast: payment.worst.amount !== payment.expected.amount ? money(payment.worst, symbol, certainty) : null,
    };
  });

  // Fees: network (gas + L1 data) per network, venue and extra per label, rent.
  const fees: FareFee[] = [];
  const networkTotals = new Map<string, { usd: number | null; certainty: Certainty }>();
  for (const fee of preview.fees ?? []) {
    const certainty = note(certaintyOf(fee.certainty));
    if (fee.kind === "network" || fee.kind === "l1-data") {
      const current = networkTotals.get(fee.network) ?? { usd: 0, certainty };
      const usd = current.usd === null || typeof fee.usd !== "number" ? null : current.usd + fee.usd;
      networkTotals.set(fee.network, { usd, certainty: CERTAINTIES.indexOf(certainty) > CERTAINTIES.indexOf(current.certainty) ? certainty : current.certainty });
      continue;
    }
    const amountText = fee.formatted && fee.asset ? `${unsignedAmount(fee.formatted)} ${cleanText(fee.asset.symbol, 24)}` : null;
    const paid = fee.paid === "deducted" ? "already in the amount you get" : fee.paid === "refundable" ? "refunded when the account closes" : "paid on top";
    fees.push({
      key: `${fee.stepId}|${fee.kind}|${fee.label}|${fees.length}`,
      label: cleanText(fee.label, 60) || (fee.kind === "rent" ? "Account rent" : "Venue fee"),
      usd: formatUsdAbs(fee.usd),
      detail: [amountText, paid].filter(Boolean).join(", "),
      certainty,
    });
  }
  const networkFees: FareFee[] = [...networkTotals.entries()].map(([network, total]) => ({
    key: `network|${network}`,
    label: `${networkLabel(network)} network fee`,
    usd: formatUsdAbs(total.usd),
    detail: "paid on top",
    certainty: total.certainty,
  }));
  const totals = preview.totals;
  if (totals && typeof totals.priceDifferenceUsd === "number" && Math.abs(totals.priceDifferenceUsd) >= 0.005) {
    fees.push({
      key: "price-difference",
      label: "Price difference",
      usd: formatUsdAbs(totals.priceDifferenceUsd),
      detail: totals.priceDifferenceUsd < 0 ? "in your favour" : "between what you pay and what you get, after fees",
      certainty: "estimated",
    });
  }

  const allowances: FareAllowance[] = (preview.approvals ?? []).map((approval, position) => {
    const symbol = cleanText(approval.token?.symbol, 24) || "?";
    const decimals = approval.token?.decimals ?? 0;
    const leftAmount = unitsText(approval.leftAfter, decimals);
    const leftover = approval.leftAfter !== null && approval.leftAfter !== "0" && /^\d+$/u.test(approval.leftAfter ?? "");
    return {
      key: `${approval.stepId}|${approval.spender}|${position}`,
      networkName: networkLabel(approval.network),
      spenderLabel: cleanText(approval.spenderLabel, 80) || shortAddress(approval.spender),
      spender: cleanText(approval.spender, 80),
      amount: `${unsignedAmount(approval.formatted)} ${symbol}`,
      left: approval.leftAfter === null ? "not simulated" : leftover ? `${leftAmount ?? approval.leftAfter} ${symbol} left` : "0 left",
      leftover,
    };
  });

  const bring: FareNeed[] = (preview.needs ?? []).map((need, position) => {
    const symbol = cleanText(need.asset?.symbol, 24) || "?";
    const amount = unsignedAmount(need.formatted);
    const where = networkLabel(need.network);
    const have = unitsText(need.have, need.asset?.decimals ?? 0);
    const text =
      need.reason === "gas-on-arrival"
        ? `About ${amount} ${symbol} on ${where} to pay network fees when you sign there`
        : need.reason === "rent"
          ? `${amount} ${symbol} on ${where} for account rent`
          : `${amount} ${symbol} on ${where} to fund this intent`;
    return { key: `${need.network}|${need.reason}|${position}`, reason: need.reason, networkName: where, text, have: have !== null ? `${have} ${symbol}` : null };
  });

  const warnings: string[] = [];
  const blocking: PreviewIssue[] = [];
  const seen = new Set<string>();
  for (const warning of preview.warnings ?? []) {
    // Intent-level warnings arrive as "PREVIEW_CODE: sentence". The code is for programs: the
    // sentence is shown, and codes the fare already prints as rows (gas on arrival under Bring,
    // unpriced assets under the totals) are not repeated.
    const raw = cleanText(warning, 300);
    const coded = CODED_WARNING.exec(raw);
    if (coded && HIDDEN_ISSUE_CODES.has(coded[1]!)) continue;
    const sentence = coded ? raw.slice(coded[0].length).trim() : raw;
    const text = sentence ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}` : "";
    if (text && !seen.has(text)) {
      seen.add(text);
      warnings.push(text);
    }
  }
  for (const step of preview.steps ?? []) {
    for (const issue of step.issues ?? []) {
      const message = cleanText(issue.message, 300);
      if (issue.severity === "block") {
        blocking.push({ code: cleanText(issue.code, 64), severity: "block", message });
        continue;
      }
      if (HIDDEN_ISSUE_CODES.has(issue.code) || !message || seen.has(message)) continue;
      seen.add(message);
      warnings.push(message);
    }
  }

  const unpricedIds = new Set(totals?.unpriced ?? []);
  const unpriced = [
    ...new Set(
      [...(preview.rows ?? []), ...(preview.payments ?? [])]
        .filter((row) => unpricedIds.has(row.asset))
        .map((row) => cleanText(row.symbol, 24)),
    ),
  ];
  const networks = new Set<string>([...(preview.rows ?? []).map((row) => row.network)]);
  const basisNote =
    preview.basis === "simulated"
      ? null
      : preview.basis === "partial"
        ? "Some legs are quoted or estimated, not simulated. Each number says how it was obtained."
        : preview.basis === "quoted"
          ? "These numbers are the venues' quotes: Kletia did not simulate them."
          : "Kletia could not simulate this plan right now. The numbers are the venues' quotes.";

  return {
    digest: preview.digest,
    stage: preview.stage,
    basis: preview.basis,
    basisNote,
    legs: (intent?.steps.length ?? new Set((preview.steps ?? []).map((step) => step.stepId)).size) || 0,
    networkChanges: Math.max(0, networks.size - 1),
    youPay,
    youGet,
    passesThrough,
    paidToOthers,
    fees: [...networkFees, ...fees],
    totals: {
      youPay: formatUsdAbs(totals?.youPayUsd),
      youGetExpected: formatUsdAbs(totals?.youGetUsd?.expected),
      youGetAtLeast: formatUsdAbs(totals?.youGetUsd?.worst),
      cost: formatUsdAbs(totals?.costUsd?.expected),
      fees: totals ? formatUsdAbs(totalFeesUsd({ preview })) : null,
    },
    allowances,
    bring,
    arrival: preview.arrival ? `On ${networkLabel(preview.arrival.network)} in ${durationText(preview.arrival.seconds)}` : null,
    warnings,
    blocking,
    unpriced,
    legend: CERTAINTIES.filter((certainty) => used.has(certainty)),
  };
}

/** Plain-language lines for what got worse (`PREVIEW_CHANGED` changes or `materialChange`). */
export function fareChangeLines(changes: readonly PreviewIssue[] | null | undefined): string[] {
  const lines: string[] = [];
  for (const change of changes ?? []) {
    const text = cleanText(change.message, 300);
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines;
}

/** Issues of severity `block` for one step, from a payload preview and an intent preview. */
export function blockingIssuesFor(
  stepId: string,
  ...previews: Readonly<{ readonly issues?: readonly PreviewIssue[]; readonly steps?: readonly { readonly stepId: string; readonly issues: readonly PreviewIssue[] }[] } | null | undefined>[]
): PreviewIssue[] {
  const out: PreviewIssue[] = [];
  for (const preview of previews) {
    if (!preview) continue;
    const issues = preview.steps ? (preview.steps.find((step) => step.stepId === stepId)?.issues ?? []) : (preview.issues ?? []);
    for (const issue of issues) if (issue.severity === "block") out.push(issue);
  }
  return out;
}
