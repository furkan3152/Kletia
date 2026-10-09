/**
 * What the receipt page prints, derived from a receipt document and its
 * offline verification. Pure (node --test loads it): no fetch, no DOM.
 *
 * Everything that comes from the receipt is data, never markup: the page
 * renders these strings as React text, and the only links it builds are
 * https explorer links from the @kletia/core registry.
 */
import {
  CHAINS,
  explorerTxUrl,
  getAsset,
  getProtocol,
  isNetworkKey,
  type AmountsGroup,
  type EvidenceGroup,
  type NetworkKey,
  type OutcomeGroup,
  type PartiesGroup,
  type PlanGroup,
  type ReceiptAmount,
  type ReceiptAnchor,
  type ReceiptDisclosure,
  type ReceiptDocument,
  type ReceiptIntentStatus,
  type ReceiptStepSkeleton,
  type ReceiptVerification,
  type RequestGroup,
  type TimingGroup,
} from "@kletia/core";

/* ------------------------------------------------------------ formatting */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2026-10-09" → "09 Oct 2026" (UTC day, never shifted by the reader's time zone). */
export function formatDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return day;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${match[3]} ${month} ${match[1]}` : day;
}

/** "2026-10-09" → "09 OCT 26", as a date stamp prints it. */
export function stampDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return day.toUpperCase();
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${match[3]} ${month.toUpperCase()} ${match[1]?.slice(2)}` : day;
}

/** ISO time → "09 Oct 2026, 10:42:07 UTC". */
export function formatTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

/** 38 → "38 s", 252 → "4 min 12 s", 3720 → "1 h 2 min". */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) {
    const rest = whole % 60;
    return rest ? `${Math.floor(whole / 60)} min ${rest} s` : `${whole / 60} min`;
  }
  const minutes = Math.round((whole % 3600) / 60);
  return minutes ? `${Math.floor(whole / 3600)} h ${minutes} min` : `${Math.floor(whole / 3600)} h`;
}

/** Base units → grouped decimal text, truncated to `maxFraction` digits ("1,250.5"). */
export function formatUnits(amount: string, decimals: number, maxFraction = 6): string {
  if (!/^\d+$/u.test(amount) || !Number.isInteger(decimals) || decimals < 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/u, "");
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals).slice(0, maxFraction).replace(/0+$/u, "") : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatReceiptAmount(amount: ReceiptAmount | null | undefined): string | null {
  if (!amount) return null;
  return `${formatUnits(amount.amount, amount.decimals)} ${amount.symbol}`;
}

/** Block and slot numbers with thin groups: "52 379 872". */
export function groupDigits(value: string): string {
  return /^\d+$/u.test(value) ? value.replace(/\B(?=(\d{3})+(?!\d))/gu, " ") : value;
}

/** "DPB4LdUNnszI2wtce3fgauTIf-F41GF7oaoELWYQbJ8" → "DPB4…bJ8". */
export function shortKid(kid: string): string {
  return kid.length > 10 ? `${kid.slice(0, 4)}…${kid.slice(-3)}` : kid;
}

/** Symbol of a CAIP-19 asset from the registry, or a shortened contract. */
export function assetLabel(assetId: string | null): string | null {
  if (!assetId) return null;
  const known = getAsset(assetId);
  if (known) return known.symbol;
  const reference = assetId.slice(assetId.lastIndexOf(":") + 1);
  return reference.length > 12 ? `token ${reference.slice(0, 6)}…${reference.slice(-4)}` : `token ${reference}`;
}

export function networkLabel(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].name : network;
}

function networkOfChain(chain: string): NetworkKey | null {
  for (const descriptor of Object.values(CHAINS)) if (descriptor.id === chain) return descriptor.key;
  return null;
}

/** An https URL, or null (the page never links anything else). */
export function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Explorer page of an anchor's transaction (https only). */
export function anchorExplorerUrl(anchor: ReceiptAnchor): string | null {
  const network = networkOfChain(anchor.chain);
  if (!network) return null;
  return httpsOnly(explorerTxUrl(network, anchor.vm === "evm" ? anchor.tx : anchor.signature));
}

export function anchorRef(anchor: ReceiptAnchor): string {
  return anchor.vm === "evm" ? anchor.tx : anchor.signature;
}

/** "Block 52 379 872" or "Slot 290 112 004". */
export function anchorWhere(anchor: ReceiptAnchor): string {
  return anchor.vm === "evm" ? `Block ${groupDigits(anchor.blockNumber)}` : `Slot ${groupDigits(anchor.slot)}`;
}

export function anchorNetwork(anchor: ReceiptAnchor): NetworkKey | null {
  return networkOfChain(anchor.chain);
}

const VERBS: Readonly<Record<string, string>> = {
  swap: "Swap",
  transfer: "Transfer",
  bridge: "Bridge",
  stake: "Stake",
  unstake: "Unstake",
  deposit: "Deposit",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  approve: "Approve",
  claim: "Claim",
  read: "Read",
  call: "Contract call",
  action: "Solana Action",
};

export function kindVerb(kind: string): string {
  return VERBS[kind] ?? kind.replace(/_/gu, " ");
}

const STEP_WORDS: Readonly<Record<string, string>> = {
  settled: "settled, seen on-chain",
  confirmed: "confirmed (a read)",
  skipped: "skipped",
  failed: "failed",
  indeterminate: "outcome unknown",
};

export function stepStatusWords(status: string): string {
  return STEP_WORDS[status] ?? status.replace(/_/gu, " ");
}

/* ------------------------------------------------------------ verdict */

export type VerdictKind = "verified" | "void";

export interface OfflineVerdict {
  readonly kind: VerdictKind;
  /** Small print on the stamp, uppercase. */
  readonly stamp: string;
  /** One sentence, for the page and the live region. */
  readonly sentence: string;
  /** Plain-language problems (empty when verified). */
  readonly problems: readonly string[];
  /** The receipt's signature itself checked out (disclosures may still fail). */
  readonly signatureValid: boolean;
}

const FATAL_SIGNATURE = new Set(["SPEC_UNSUPPORTED", "SCHEMA_INVALID", "PROFILE_VIOLATION", "DIGEST_MISMATCH", "KEY_UNKNOWN", "KEY_NOT_YET_VALID", "KEY_REVOKED", "SIGNATURE_INVALID"]);

const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  SPEC_UNSUPPORTED: "This is not a kletia.receipt/v1 document.",
  SCHEMA_INVALID: "The receipt is malformed.",
  PROFILE_VIOLATION: "The receipt breaks the canonical JSON profile.",
  DIGEST_MISMATCH: "The digest does not match the signed content.",
  KEY_UNKNOWN: "The signing key is not confirmed by both Kletia origins, so the signature cannot be trusted.",
  KEY_NOT_YET_VALID: "The receipt is dated before its key was allowed to sign.",
  KEY_REVOKED: "The signing key was revoked before this receipt was issued.",
  SIGNATURE_INVALID: "The signature does not match the receipt.",
  DISCLOSURE_PATH_UNKNOWN: "A shared detail belongs to no part of the receipt.",
  DISCLOSURE_INVALID: "A shared detail is malformed or inconsistent.",
  DISCLOSURE_MISMATCH: "A shared detail does not match what Kletia signed.",
  DISCLOSURE_MISSING: "A required detail is missing.",
  INCLUSION_INVALID: "The transparency log proof does not match.",
  INTENT_REF_MISMATCH: "The receipt belongs to another intent.",
};

/** The page's reading of `verifyReceipt`: VERIFIED only when everything checked out. */
export function offlineVerdict(verification: ReceiptVerification): OfflineVerdict {
  const codes = verification.problems.map((problem) => problem.code);
  const signatureValid = !codes.some((code) => FATAL_SIGNATURE.has(code));
  if (verification.valid) {
    return {
      kind: "verified",
      stamp: `KEY ${shortKid(verification.kid)}`,
      sentence: "Kletia signed this receipt. You can check it without trusting us.",
      problems: [],
      signatureValid: true,
    };
  }
  const stamp = codes.includes("SIGNATURE_INVALID")
    ? "SIGNATURE DOES NOT MATCH"
    : codes.includes("DIGEST_MISMATCH")
      ? "DIGEST DOES NOT MATCH"
      : codes.some((code) => code.startsWith("KEY_"))
        ? codes.includes("KEY_REVOKED")
          ? "KEY REVOKED"
          : "KEY NOT CONFIRMED"
        : codes.some((code) => code.startsWith("DISCLOSURE_"))
          ? "DETAILS DO NOT MATCH"
          : codes.includes("INCLUSION_INVALID")
            ? "LOG PROOF DOES NOT MATCH"
            : "NOT A VALID RECEIPT";
  const problems = [...new Set(codes.map((code) => PROBLEM_WORDS[code] ?? `Check failed: ${code}.`))];
  return {
    kind: "void",
    stamp,
    sentence: signatureValid
      ? "Kletia's signature checks out, but the details in this link do not. Do not rely on them."
      : "This receipt does not verify. Do not rely on anything it says.",
    problems,
    signatureValid,
  };
}

/* ------------------------------------------------------------ the ticket */

export interface LegModel {
  readonly id: string;
  readonly index: number;
  readonly verb: string;
  readonly network: string;
  readonly destination: string | null;
  readonly via: string;
  readonly input: string | null;
  readonly output: string | null;
  readonly status: string;
  readonly statusWords: string;
  readonly mark: "seen" | "failed" | "skipped" | "other";
  readonly failureCode: string | null;
  readonly contract: ReceiptStepSkeleton["contract"];
  readonly evidenceClass: ReceiptStepSkeleton["evidenceClass"];
  readonly parties: PartiesGroup | null;
  readonly amounts: AmountsGroup | null;
  readonly evidence: EvidenceGroup | null;
}

export interface OutcomeStamp {
  readonly state: "settled" | "held" | "failed" | "planned";
  readonly detail: string;
  readonly words: string;
}

export interface ReceiptModel {
  readonly receiptId: string;
  readonly sequence: number;
  readonly replaces: boolean;
  readonly issuedOn: string;
  readonly status: ReceiptIntentStatus;
  readonly terminal: boolean;
  readonly lane: "production" | "testnet";
  readonly networks: readonly string[];
  readonly finishedOn: string;
  readonly duration: string | null;
  readonly finalized: boolean;
  readonly kid: string;
  readonly legs: readonly LegModel[];
  readonly request: RequestGroup | null;
  readonly plan: PlanGroup | null;
  readonly timing: TimingGroup | null;
  readonly outcome: OutcomeGroup | null;
  /** Group paths the owner shared, and the ones they kept sealed. */
  readonly shown: readonly string[];
  readonly sealed: readonly string[];
  readonly sentence: string | null;
  readonly outcomeStamp: OutcomeStamp;
  readonly inclusion: { readonly batch: number; readonly anchored: boolean } | null;
}

function disclosure<V>(document: ReceiptDocument, path: string): V | null {
  const entry = document.disclosures?.[path] as ReceiptDisclosure<V> | undefined;
  return entry && typeof entry === "object" && "value" in entry ? (entry.value as V) : null;
}

/** Every group slot of a payload, in reading order. */
export function groupSlots(document: ReceiptDocument): string[] {
  return [
    "intent.request",
    "intent.plan",
    "intent.timing",
    "intent.outcome",
    ...document.payload.steps.flatMap((step) => [`steps.${step.id}.parties`, `steps.${step.id}.amounts`, `steps.${step.id}.evidence`]),
  ];
}

/** The request as one line: the sentence, or the structured actions. */
export function requestSentence(group: RequestGroup | null): string | null {
  if (!group) return null;
  const text = group.request.text?.trim();
  if (text) return text;
  const actions = group.request.actions ?? [];
  if (actions.length === 0) return null;
  return actions
    .map((action) => {
      const parts = [action.kind, action.amount, action.from].filter(Boolean).join(" ");
      const to = action.to ? ` to ${action.to}` : "";
      const toNetwork = action.toNetwork ? ` on ${action.toNetwork}` : "";
      return `${parts}${to}${toNetwork} from ${action.network}`.trim();
    })
    .join(", then ");
}

function outcomeStampOf(status: ReceiptIntentStatus, legs: readonly LegModel[]): OutcomeStamp {
  switch (status) {
    case "completed":
      return { state: "settled", detail: "FINAL", words: "Completed. Every leg settled and was seen on-chain. Final." };
    case "partially_completed":
      return { state: "held", detail: "PART SETTLED", words: "Partly completed. Some legs settled; a later issue may replace this one." };
    case "failed": {
      const code = legs.find((leg) => leg.failureCode)?.failureCode ?? "";
      return { state: "failed", detail: code.slice(0, 18), words: `Failed${code ? ` (${code})` : ""}. A failed step may still be retried, so a later issue may replace this one.` };
    }
    case "cancelled":
    default:
      return { state: "planned", detail: "CANCELLED · NOT RUN", words: "Cancelled before anything ran. Nothing was sent on-chain." };
  }
}

export function receiptModel(document: ReceiptDocument): ReceiptModel {
  const { payload } = document;
  const legs: LegModel[] = [...payload.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      const protocol = getProtocol(step.protocol);
      return {
        id: step.id,
        index: step.index,
        verb: kindVerb(step.kind),
        network: step.network,
        destination: step.settlement?.destinationNetwork && step.settlement.destinationNetwork !== step.network ? step.settlement.destinationNetwork : null,
        via: step.contract ? step.contract.integrator : protocol?.name ?? step.protocol,
        input: assetLabel(step.assets.input),
        output: assetLabel(step.assets.output),
        status: step.status,
        statusWords: stepStatusWords(step.status),
        mark: step.status === "settled" || step.status === "confirmed" ? "seen" : step.status === "failed" ? "failed" : step.status === "skipped" ? "skipped" : "other",
        failureCode: step.failure?.code ?? null,
        contract: step.contract,
        evidenceClass: step.evidenceClass,
        parties: disclosure<PartiesGroup>(document, `steps.${step.id}.parties`),
        amounts: disclosure<AmountsGroup>(document, `steps.${step.id}.amounts`),
        evidence: disclosure<EvidenceGroup>(document, `steps.${step.id}.evidence`),
      };
    });
  const request = disclosure<RequestGroup>(document, "intent.request");
  const slots = groupSlots(document);
  const shown = slots.filter((path) => document.disclosures?.[path] !== undefined);
  return {
    receiptId: payload.receiptId,
    sequence: payload.sequence,
    replaces: payload.supersedes !== null,
    issuedOn: payload.issuedOn,
    status: payload.intent.status,
    terminal: payload.intent.terminal,
    lane: payload.intent.lane,
    networks: payload.intent.networks,
    finishedOn: payload.intent.finishedOn,
    duration: formatDuration(payload.intent.durationSeconds),
    finalized: payload.intent.finality === "finalized",
    kid: document.signature.kid,
    legs,
    request,
    plan: disclosure<PlanGroup>(document, "intent.plan"),
    timing: disclosure<TimingGroup>(document, "intent.timing"),
    outcome: disclosure<OutcomeGroup>(document, "intent.outcome"),
    shown,
    sealed: slots.filter((path) => !shown.includes(path)),
    sentence: requestSentence(request),
    outcomeStamp: outcomeStampOf(payload.intent.status, legs),
    inclusion: document.inclusion ? { batch: document.inclusion.batch.seq, anchored: document.inclusion.anchor !== null } : null,
  };
}

/** "Issue 2. Replaces issue 1." and whether a newer issue exists. */
export function issueLine(model: Pick<ReceiptModel, "sequence" | "replaces">, supersededBy: string | null): string {
  const base = model.sequence > 1 ? `Issue ${model.sequence}. Replaces issue ${model.sequence - 1}.` : "Issue 1.";
  return supersededBy ? `${base} A newer issue replaces this one.` : base;
}
