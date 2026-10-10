/**
 * `@kletia/widget/review`: pure, React-free helpers that turn what Kletia
 * returns before a signature into display data. The widget renders them in
 * its own design system and the Kletia web app (Studio, `/embed`) in the
 * Interchange one, so both say the same thing:
 *
 * - `fareModel`: the intent-level asset-change preview ("fare breakdown"):
 *   what you pay, what you get (expected and at least), what passes through
 *   your wallets, fees in USD, allowances, what your wallets must hold (gas
 *   on arrival) and a certainty label on every number.
 * - `contractReviewModel`: the review of a custom-contract (`call` /
 *   `action`) step, in the order who, what, permissions, result,
 *   provenance, notice, and whether signing needs an explicit
 *   acknowledgement.
 * - `policyHold` / `policyRefusal`: Rule Book outcomes (held for approval,
 *   refused) with the rule ids and a safe approval link.
 * - Receipt share profiles and link checks.
 *
 * Everything integrators or venues control (names, websites, labels,
 * arguments, URLs) is returned as plain text for text nodes, cleaned of
 * control and bidirectional-override characters, and links are only ever
 * returned for https URLs of the expected shape.
 */
import {
  APPROVAL_ID_PATTERN,
  CHAINS,
  CONTRACT_REVIEW_NOTICE,
  formatPreviewAmount,
  isNetworkKey,
  RECEIPT_ID_PATTERN,
  RECEIPT_PROFILES,
  RECEIPT_SHARE_ID_PATTERN,
  toChecksumAddress,
  type Certainty,
  type ContractReview,
  type IntentGraph,
  type IntentPreview,
  type PreviewIssue,
  type PreviewNeed,
} from "@kletia/core";

/* ================================================================== text */

// C0/C1 controls, bidirectional overrides and isolates, zero-width marks.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+/gu;

/** Text an integrator, venue or API controls, safe to print in a text node: no controls or direction overrides, bounded length. */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s{2,}/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The URL when it is an absolute https URL without credentials, else null. */
export function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function isHttpsUrl(value: unknown): value is string {
  return httpsUrl(value) !== null;
}

/** `0x5eed…c0de` for long addresses; the full value belongs in a title or next to it. */
export function shortAddress(value: string, head = 6, tail = 4): string {
  const address = value.slice(value.lastIndexOf(":") + 1);
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function networkLabel(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].name : cleanText(network, 40);
}

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Absolute USD for display: "$100.00", "<$0.01", "$0.00"; null when unpriced. */
export function formatUsdAbs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.005) return "<$0.01";
  return usd2.format(absolute);
}

/** "-100" / "+95.4773" → "100" / "95.4773", with thousands separators. */
export function unsignedAmount(formatted: string): string {
  const body = formatted.replace(/^[+-]/u, "");
  const [whole = "0", fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function unitsText(units: string | undefined | null, decimals: number): string | null {
  if (typeof units !== "string" || !/^-?\d{1,78}$/u.test(units)) return null;
  return unsignedAmount(formatPreviewAmount(units, decimals));
}

function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} h`;
}

/* ============================================================ certainty */

export type CertaintyShape = "dot" | "half" | "diamond" | "ring" | "dashed";

export interface CertaintyInfo {
  /** Printed next to a number, e.g. "simulated". */
  readonly label: string;
  /** Read aloud with the number, e.g. "simulated with funds a bridge delivers". */
  readonly spoken: string;
  /** One sentence for the legend. */
  readonly sentence: string;
  /** Glyph shape: the label is never carried by colour alone. */
  readonly shape: CertaintyShape;
}

export const CERTAINTY_INFO: Readonly<Record<Certainty, CertaintyInfo>> = Object.freeze({
  simulated: {
    label: "simulated",
    spoken: "simulated",
    sentence: "Simulated: the exact transactions, run against current state.",
    shape: "dot",
  },
  "simulated-assumed-funds": {
    label: "simulated, funds assumed",
    spoken: "simulated with funds a bridge delivers",
    sentence: "Simulated with funds a bridge has not delivered yet. It is simulated again before you sign it.",
    shape: "half",
  },
  "venue-minimum": {
    label: "venue minimum",
    spoken: "the venue's committed minimum",
    sentence: "Venue minimum: the floor the venue committed to. Kletia checks it on arrival.",
    shape: "diamond",
  },
  quoted: {
    label: "quoted",
    spoken: "quoted by the venue, not simulated",
    sentence: "Quoted: the venue's quote, not simulated.",
    shape: "ring",
  },
  estimated: {
    label: "estimated",
    spoken: "estimated",
    sentence: "Estimated: derived from other numbers, not simulated.",
    shape: "dashed",
  },
});

const CERTAINTIES: readonly Certainty[] = ["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"];

function certaintyOf(value: unknown): Certainty {
  return CERTAINTIES.includes(value as Certainty) ? (value as Certainty) : "estimated";
}

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
  const index = (stepId: string) => order.get(stepId);
  const used = new Set<Certainty>();
  const note = (certainty: Certainty) => {
    used.add(certainty);
    return certainty;
  };

  const networkFeeSteps = new Map<string, Set<string>>();
  for (const fee of preview.fees ?? []) {
    if (fee.kind !== "network" && fee.kind !== "l1-data") continue;
    const set = networkFeeSteps.get(fee.network) ?? new Set<string>();
    set.add(fee.stepId);
    networkFeeSteps.set(fee.network, set);
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
    const feeNote =
      debit && isNative(row.asset) && feeSteps && row.steps.some((step) => feeSteps.has(step))
        ? ["network fee", legsText(row.steps, index)].filter(Boolean).join(", ")
        : null;
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

/* ===================================================== contract review */

const ARG_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  amount: "your amount",
  account: "your address",
  recipient: "the recipient you chose",
  token: "the token of this step",
  self: "the contract's own address",
  minimumOutput: "your minimum output",
  deadline: "a deadline Kletia sets",
  previousOutput: "the previous leg's output",
  param: "a value you chose",
});

const SOURCE_TEXT: Readonly<Record<string, { readonly text: string; readonly verified: boolean }>> = Object.freeze({
  exact_match: { text: "Source verified (exact match)", verified: true },
  match: { text: "Source verified (partial match)", verified: true },
  unverified: { text: "Source not verified", verified: false },
  unknown: { text: "Source verification unknown", verified: false },
});

const PROXY_KIND: Readonly<Record<string, string>> = Object.freeze({
  eip1967: "EIP-1967 proxy",
  "eip1967-beacon": "EIP-1967 beacon proxy",
  eip1822: "EIP-1822 proxy",
  zeppelinos: "ZeppelinOS proxy",
  eip1167: "EIP-1167 minimal proxy",
});

export interface ContractReviewModel {
  readonly kind: ContractReview["kind"];
  readonly integrator: {
    readonly name: string;
    /** https only. */
    readonly website: string | null;
    readonly domain: string | null;
    readonly domainVerified: boolean;
  };
  readonly contract: {
    readonly networkName: string;
    readonly address: string;
    readonly explorerUrl: string | null;
    readonly source: string;
    readonly sourceVerified: boolean;
    readonly proxy: { readonly kind: string; readonly implementation: string; readonly source: string; readonly verified: boolean } | null;
    readonly revision: number | null;
  } | null;
  readonly call: {
    readonly label: string;
    readonly signature: string;
    readonly args: readonly { readonly key: string; readonly name: string; readonly type: string; readonly value: string; readonly source: string }[];
    readonly value: string | null;
  } | null;
  readonly action: {
    readonly title: string | null;
    readonly domain: string;
    readonly url: string | null;
    readonly instructionCount: number;
    readonly programs: readonly { readonly id: string; readonly verified: string; readonly upgradeable: string }[];
  } | null;
  /** "Allow Steakhouse USDC to spend exactly 100 USDC". */
  readonly permissions: readonly { readonly key: string; readonly text: string; readonly spender: string; readonly existing: string | null }[];
  readonly result: {
    readonly simulated: boolean;
    readonly changes: readonly { readonly key: string; readonly text: string; readonly debit: boolean; readonly unlisted: boolean }[];
    readonly networkFee: string | null;
    readonly where: string | null;
    readonly warnings: readonly string[];
  };
  /** The fixed notice first ("Not audited by Kletia. …"), then any further notices. */
  readonly notices: readonly string[];
  /** Signing needs an explicit acknowledgement (unverified source, unverified domain or program). */
  readonly needsAcknowledgement: boolean;
  readonly acknowledgementReasons: readonly string[];
}

/** Display model of a custom-contract review (`step.call.review` or `payload.review`). */
export function contractReviewModel(review: ContractReview): ContractReviewModel {
  const integratorName = cleanText(review.integrator?.name, 80) || "Unnamed integrator";
  const website = httpsUrl(review.integrator?.website);
  const domainVerified = review.integrator?.domainVerified === true;
  const reasons: string[] = [];
  if (!domainVerified) reasons.push(`${integratorName} has not verified its website domain with Kletia.`);

  let contract: ContractReviewModel["contract"] = null;
  if (review.contract) {
    const source = SOURCE_TEXT[review.contract.source] ?? SOURCE_TEXT.unknown!;
    const proxy = review.contract.proxy
      ? (() => {
          const implementation = SOURCE_TEXT[review.contract!.proxy!.implementationSource] ?? SOURCE_TEXT.unknown!;
          return {
            kind: PROXY_KIND[review.contract!.proxy!.kind] ?? "Proxy",
            implementation: cleanText(review.contract!.proxy!.implementation, 80),
            source: implementation.text,
            verified: implementation.verified,
          };
        })()
      : null;
    if (!source.verified) reasons.push("The contract's source code is not verified.");
    if (proxy && !proxy.verified) reasons.push("The proxy's implementation source code is not verified.");
    const explorer = httpsUrl(review.contract.explorerUrl);
    contract = {
      networkName: networkLabel(review.contract.network),
      address: cleanText(review.contract.address, 80),
      explorerUrl: explorer ? explorer.href : null,
      source: source.text,
      sourceVerified: source.verified,
      proxy,
      revision: Number.isInteger(review.contract.revision) ? review.contract.revision : null,
    };
  }

  const call = review.call
    ? {
        label: cleanText(review.call.label, 80),
        signature: cleanText(review.call.function, 200),
        args: (review.call.args ?? []).map((arg, position) => ({
          key: `${position}`,
          name: cleanText(arg.name, 40) || `arg${position}`,
          type: cleanText(arg.type, 40),
          value: cleanText(arg.display, 200),
          source: arg.source === "literal" ? `fixed by ${integratorName}` : (ARG_SOURCES[arg.source] ?? "set by the integrator"),
        })),
        value: review.call.value && review.call.value.amount !== "0" ? `${unsignedAmount(review.call.value.formatted)} ${cleanText(review.call.value.symbol, 24)}` : null,
      }
    : null;

  let action: ContractReviewModel["action"] = null;
  if (review.action) {
    const url = httpsUrl(review.action.url);
    const programs = (review.action.programs ?? []).map((program) => {
      if (program.verified !== true) reasons.push(`Program ${shortAddress(program.id)} is not a verified build.`);
      return {
        id: cleanText(program.id, 64),
        verified: program.verified === true ? "Verified build" : program.verified === false ? "Not a verified build" : "Build verification unknown",
        upgradeable: program.upgradeable ? `Upgradeable${program.upgradeAuthority ? ` by ${shortAddress(program.upgradeAuthority)}` : ""}` : "Not upgradeable",
      };
    });
    action = {
      title: cleanText(review.action.title, 120) || null,
      domain: cleanText(review.action.domain, 120),
      url: url ? url.href : null,
      instructionCount: Number.isInteger(review.action.instructionCount) ? review.action.instructionCount : 0,
      programs,
    };
  }

  const permissions = (review.approvals ?? []).map((approval, position) => {
    const symbol = cleanText(approval.token?.symbol, 24) || "?";
    const spender = cleanText(approval.spender, 80);
    const spenderName = contract && spender.toLowerCase() === contract.address.toLowerCase() ? `${integratorName}'s contract` : shortAddress(spender);
    return {
      key: `${position}`,
      text: `Allow ${spenderName} to spend exactly ${unsignedAmount(approval.amount.formatted)} ${symbol}`,
      spender,
      existing: approval.existingAllowance ? `${unsignedAmount(approval.existingAllowance.formatted)} ${symbol} allowed before` : null,
    };
  });

  const simulation = review.simulation;
  const simulated = simulation?.status === "ok";
  if (!simulated) reasons.push("Kletia could not simulate this transaction.");
  const changes = (simulation?.assetChanges ?? []).map((change, position) => {
    const debit = change.delta.startsWith("-");
    const symbol = cleanText(change.symbol, 24) || "?";
    return {
      key: `${position}`,
      text: `${debit ? "−" : "+"}${unsignedAmount(change.formatted)} ${symbol}`,
      debit,
      unlisted: change.listed === false,
    };
  });

  const notices = [CONTRACT_REVIEW_NOTICE];
  for (const notice of review.notices ?? []) {
    const text = cleanText(notice, 400);
    if (text && text !== CONTRACT_REVIEW_NOTICE && !notices.includes(text)) notices.push(text);
  }

  return {
    kind: review.kind,
    integrator: { name: integratorName, website: website ? website.href : null, domain: website ? website.hostname : null, domainVerified },
    contract,
    call,
    action,
    permissions,
    result: {
      simulated,
      changes,
      networkFee: review.simulation?.networkFee ? `${unsignedAmount(review.simulation.networkFee.formatted)} ${cleanText(review.simulation.networkFee.symbol, 24)}` : null,
      where: simulation?.block ? `block ${cleanText(simulation.block, 24)}` : simulation?.slot ? `slot ${cleanText(simulation.slot, 24)}` : null,
      warnings: (simulation?.warnings ?? []).map((warning) => cleanText(warning, 300)).filter(Boolean),
    },
    notices,
    needsAcknowledgement: reasons.length > 0,
    acknowledgementReasons: reasons,
  };
}

/** Steps whose transactions run integrator code (custom contracts). */
export function isContractStep(step: { readonly kind: string; readonly protocol?: string; readonly call?: unknown }): boolean {
  return step.kind === "call" || step.kind === "action" || step.call !== undefined || step.protocol === "custom-call" || step.protocol === "solana-actions";
}

/* ============================================================ Rule Book */

export interface PolicyRuleLine {
  readonly key: string;
  /** Stable rule id, e.g. `caps.dailyUsd`. */
  readonly rule: string;
  readonly message: string;
  /** "observed 2140.00, limit 2000.00". */
  readonly detail: string | null;
}

export interface PolicyOutcomeView {
  readonly kind: "held" | "refused";
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly rules: readonly PolicyRuleLine[];
  readonly approval: {
    readonly id: string;
    /** https link (or the caller's same-origin fallback); null when none is safe. */
    readonly href: string | null;
    readonly expiresAt: string | null;
    readonly ceilingUsd: string | null;
    readonly status: string | null;
  } | null;
  /** ISO time a retry may succeed (spend windows, schedule). */
  readonly retryAt: string | null;
}

export interface ApprovalLinkOptions {
  /**
   * Used when the API's approval URL is not https (local development):
   * the caller's own origin, e.g. `location.origin` on the Kletia web app.
   * The link is then `<origin>/approve#<id>`.
   */
  readonly fallbackOrigin?: string | null;
}

/** A safe link to the approval gate: the API's https `/approve#apr_…` URL for that id, else the fallback origin's. */
export function approvalHref(approval: { readonly id?: unknown; readonly url?: unknown } | null | undefined, options: ApprovalLinkOptions = {}): string | null {
  const id = typeof approval?.id === "string" && APPROVAL_ID_PATTERN.test(approval.id) ? approval.id : null;
  if (!id) return null;
  const url = httpsUrl(approval?.url);
  if (url && url.pathname === "/approve" && url.hash === `#${id}` && !url.search) return url.href;
  const origin = options.fallbackOrigin;
  if (typeof origin === "string") {
    try {
      const base = new URL(origin);
      if ((base.protocol === "https:" || base.protocol === "http:") && base.origin === origin) return `${origin}/approve#${id}`;
    } catch {
      return null;
    }
  }
  return null;
}

interface PolicyViolationLike {
  readonly rule?: unknown;
  readonly message?: unknown;
  readonly observed?: unknown;
  readonly limit?: unknown;
}

function ruleLines(violations: readonly PolicyViolationLike[] | undefined, triggers?: readonly unknown[]): PolicyRuleLine[] {
  const lines: PolicyRuleLine[] = [];
  for (const [position, violation] of (violations ?? []).entries()) {
    const rule = cleanText(violation.rule, 64) || "rule";
    const observed = cleanText(violation.observed, 40);
    const limit = cleanText(violation.limit, 40);
    lines.push({
      key: `${rule}|${position}`,
      rule,
      message: cleanText(violation.message, 300),
      detail: observed || limit ? [observed ? `observed ${observed}` : "", limit ? `limit ${limit}` : ""].filter(Boolean).join(", ") : null,
    });
  }
  for (const [position, trigger] of (triggers ?? []).entries()) {
    const rule = cleanText(trigger, 64);
    if (rule && !lines.some((line) => line.rule === rule)) lines.push({ key: `${rule}|t${position}`, rule, message: "", detail: null });
  }
  return lines;
}

const usdText = (value: unknown): string | null => {
  const text = cleanText(value, 24);
  return /^\d+(?:\.\d+)?$/u.test(text) ? `$${Number(text).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
};

/** The plan-time hold of an intent (`intent.policy.outcome === "confirm"`), or null. */
export function policyHold(intent: Pick<IntentGraph, "policy"> | null | undefined, options: ApprovalLinkOptions = {}): PolicyOutcomeView | null {
  const stamp = intent?.policy;
  if (!stamp || stamp.outcome !== "confirm") return null;
  const approval = stamp.approval;
  return {
    kind: "held",
    code: "POLICY_APPROVAL_REQUIRED",
    title: "Held for approval",
    message:
      "The integrator's rule book asks a person to approve this intent before Kletia prepares anything to sign. You can sign once it is approved.",
    rules: ruleLines([], approval?.triggers ?? []),
    approval: approval
      ? {
          id: cleanText(approval.id, 64),
          href: approvalHref(approval, options),
          expiresAt: cleanText(approval.expiresAt, 40) || null,
          ceilingUsd: usdText(approval.ceilingUsd),
          status: "pending",
        }
      : null,
    retryAt: null,
  };
}

export interface PolicyErrorLike {
  readonly code: string;
  readonly message?: string;
  readonly policy?: {
    readonly violations?: readonly PolicyViolationLike[];
    readonly retryAt?: string | null;
    readonly approval?: { readonly id?: unknown; readonly url?: unknown; readonly expiresAt?: unknown; readonly ceilingUsd?: unknown; readonly status?: unknown };
  } | null;
}

const POLICY_TITLES: Readonly<Record<string, string>> = Object.freeze({
  POLICY_VIOLATION: "Refused by the rule book",
  POLICY_SPEND_LIMIT: "Over a spend limit",
  POLICY_SCHEDULE_CLOSED: "Outside the allowed hours",
  POLICY_PRICE_UNAVAILABLE: "No fresh price to check a limit",
  POLICY_OWNER_REVOKED: "The key behind this intent was revoked",
  POLICY_APPROVAL_REQUIRED: "Held for approval",
  POLICY_APPROVAL_REJECTED: "Approval rejected",
  POLICY_APPROVAL_EXPIRED: "Approval expired",
  POLICY_APPROVAL_STALE: "The approval no longer covers this intent",
  AGENT_KEY_FORBIDDEN: "Not allowed for this agent key",
});

const POLICY_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  POLICY_VIOLATION: "The integrator's rule book does not allow this intent. Nothing was prepared and nothing can be signed.",
  POLICY_SPEND_LIMIT: "This would go over a spend limit of the integrator's rule book. Nothing was prepared.",
  POLICY_SCHEDULE_CLOSED: "The integrator's rule book does not allow payloads at this time. Nothing was prepared.",
  POLICY_PRICE_UNAVAILABLE: "A USD limit applies and no fresh price covers an asset, so Kletia refused rather than guess. Try again shortly.",
  POLICY_OWNER_REVOKED: "The integrator's key (or a key above it) was revoked or expired. Nothing was prepared.",
  POLICY_APPROVAL_REQUIRED: "A person must approve this intent before Kletia prepares anything to sign.",
  POLICY_APPROVAL_REJECTED: "The approver rejected this intent, so it was cancelled. Nothing was signed.",
  POLICY_APPROVAL_EXPIRED: "Nobody approved this intent in time. Plan it again to ask for a new approval.",
  POLICY_APPROVAL_STALE: "Prices moved above the approved ceiling. Plan the intent again.",
  AGENT_KEY_FORBIDDEN: "The agent key behind this intent lacks the permission.",
});

export function isPolicyCode(code: unknown): boolean {
  return typeof code === "string" && (code.startsWith("POLICY_") || code === "AGENT_KEY_FORBIDDEN");
}

/** A Rule Book refusal or hold from an API error (`error.policy`), or null for other errors. */
export function policyOutcome(error: PolicyErrorLike | null | undefined, options: ApprovalLinkOptions = {}): PolicyOutcomeView | null {
  if (!error || !isPolicyCode(error.code)) return null;
  const policy = error.policy ?? null;
  const approval = policy?.approval;
  const held = error.code === "POLICY_APPROVAL_REQUIRED";
  const approvalId = typeof approval?.id === "string" && APPROVAL_ID_PATTERN.test(approval.id) ? approval.id : null;
  return {
    kind: held ? "held" : "refused",
    code: cleanText(error.code, 64),
    title: POLICY_TITLES[error.code] ?? "Refused by the rule book",
    message: POLICY_MESSAGES[error.code] ?? cleanText(error.message, 300),
    rules: ruleLines(policy?.violations),
    approval: approvalId
      ? {
          id: approvalId,
          href: approvalHref(approval, options),
          expiresAt: cleanText(approval?.expiresAt, 40) || null,
          ceilingUsd: usdText(approval?.ceilingUsd),
          status: cleanText(approval?.status, 16) || null,
        }
      : null,
    retryAt: cleanText(policy?.retryAt, 40) || null,
  };
}

/* ============================================================== receipts */

export type ReceiptShareProfile = "route" | "amounts" | "proof" | "full";

export const RECEIPT_SHARE_PROFILES: readonly {
  readonly id: ReceiptShareProfile;
  readonly label: string;
  readonly description: string;
  /** Shows transaction evidence, which reveals the sending addresses on any explorer. */
  readonly revealsAddresses: boolean;
}[] = Object.freeze([
  { id: "route", label: "Route only", description: "Networks, steps and venues. No amounts or addresses.", revealsAddresses: false },
  { id: "amounts", label: "Route and amounts", description: "Adds the amounts and the outcome, without addresses.", revealsAddresses: false },
  { id: "proof", label: "Proof", description: "Adds transactions and timing, so anyone can re-check it on-chain.", revealsAddresses: true },
  { id: "full", label: "Everything", description: "Every field, including your accounts and the request.", revealsAddresses: true },
]);

export const RECEIPT_EVIDENCE_WARNING = "Showing transactions reveals the addresses that sent them.";

/**
 * The disclosure groups a share can open one by one (group path patterns,
 * `*` = every step), for a "choose what to show" share. The route itself
 * (networks, steps, venues, statuses) is always visible.
 */
export const RECEIPT_SHARE_GROUPS: readonly {
  readonly pattern: string;
  readonly label: string;
  readonly description: string;
  /** Reveals account addresses (directly, or through the transactions on any explorer). */
  readonly revealsAddresses: boolean;
}[] = Object.freeze([
  { pattern: "steps.*.amounts", label: "Step amounts", description: "What each step took in and paid out, and its fees.", revealsAddresses: false },
  { pattern: "intent.outcome", label: "Outcome", description: "What the whole intent consumed and delivered.", revealsAddresses: false },
  { pattern: "intent.timing", label: "Timing", description: "When it started, finished and became final.", revealsAddresses: false },
  { pattern: "intent.plan", label: "Plan", description: "The plan Kletia committed to before you signed.", revealsAddresses: false },
  { pattern: "steps.*.evidence", label: "Transactions", description: "Transaction references, so anyone can re-check them on-chain.", revealsAddresses: true },
  { pattern: "steps.*.parties", label: "Accounts", description: "Your accounts and the recipients of each step.", revealsAddresses: true },
  { pattern: "intent.request", label: "Request", description: "What you asked for, word for word.", revealsAddresses: true },
]);

const PROFILE_IDS: readonly ReceiptShareProfile[] = ["route", "amounts", "proof", "full"];

/** `steps.s1.amounts` → `steps.*.amounts`; intent groups stay as they are. */
function groupPattern(group: string): string {
  return /^steps\.[^.]+\.[a-z]+$/u.test(group) ? group.replace(/^steps\.[^.]+\./u, "steps.*.") : group;
}

/**
 * What a share shows, in words: the profile name when its groups are exactly
 * a profile's, else "Custom: …" with the group labels. Accepts concrete
 * slots (`steps.s1.amounts`, as share lists return them) or patterns.
 */
export function receiptGroupsLabel(groups: readonly string[]): string {
  const patterns = [...new Set(groups.filter((group) => typeof group === "string").map(groupPattern))];
  const same = (list: readonly string[]) => list.length === patterns.length && list.every((pattern) => patterns.includes(pattern));
  const profile = PROFILE_IDS.find((id) => same(RECEIPT_PROFILES[id]));
  if (profile) return RECEIPT_SHARE_PROFILES.find((item) => item.id === profile)?.label ?? "Custom";
  const labels = RECEIPT_SHARE_GROUPS.filter((group) => patterns.includes(group.pattern)).map((group) => group.label.toLowerCase());
  return labels.length > 0 ? `Custom: ${labels.join(", ")}` : "Custom";
}

const SHARE_FRAGMENT = /^#s=(rsh_[0-9a-f]{24})&k=([A-Za-z0-9_-]{43})$/u;

/**
 * A safe receipt link from a share's `url`: https, path `/r/<receiptId>`,
 * fragment `#s=<shareId>&k=<key>`. With `fallbackOrigin` (the Kletia web app
 * itself), a non-https URL of the same shape is rebuilt on that origin.
 */
export function receiptShareHref(share: { readonly receiptId?: unknown; readonly id?: unknown; readonly url?: unknown } | null | undefined, options: ApprovalLinkOptions = {}): string | null {
  const receiptId = typeof share?.receiptId === "string" && RECEIPT_ID_PATTERN.test(share.receiptId) ? share.receiptId : null;
  const shareId = typeof share?.id === "string" && RECEIPT_SHARE_ID_PATTERN.test(share.id) ? share.id : null;
  if (!receiptId || !shareId || typeof share?.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(share.url);
  } catch {
    return null;
  }
  const fragment = SHARE_FRAGMENT.exec(url.hash);
  if (url.pathname !== `/r/${receiptId}` || url.search || !fragment || fragment[1] !== shareId || url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  const origin = options.fallbackOrigin;
  if (typeof origin === "string" && /^https?:\/\/[^/]+$/u.test(origin)) return `${origin}/r/${receiptId}${url.hash}`;
  return null;
}

const RECEIPT_PENDING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  queued: "Kletia queued this receipt and signs it shortly.",
  awaiting_finality: "Waiting for every leg to be final on-chain. Kletia signs the receipt then.",
  finality_timeout: "Finality is taking longer than usual. Kletia keeps checking and signs the receipt once every leg is final.",
  rpc_unavailable: "Public nodes did not answer Kletia's finality check. It keeps trying and signs the receipt once every leg is final.",
  anchor_reorged: "A block of this intent was reorganized. Kletia re-reads the legs before it signs anything.",
  signer_missing: "This Kletia deployment is not signing receipts right now.",
  issuer_error: "Kletia could not sign this receipt yet. It keeps trying.",
});

/** One sentence for a pending receipt (`pending.reason` from `GET …/receipt`). */
export function receiptPendingText(reason: unknown): string {
  return (typeof reason === "string" ? RECEIPT_PENDING_TEXT[reason] : undefined) ?? RECEIPT_PENDING_TEXT.awaiting_finality!;
}

/** Intent statuses a receipt can exist for. */
export function receiptApplies(status: string): boolean {
  return status === "completed" || status === "partially_completed" || status === "failed" || status === "cancelled";
}
