/**
 * What the approval gate prints, derived from the public approval view
 * (`GET /v1/policy/approvals/{id}`). Pure, so `node --test` loads it.
 *
 * The approval id is a capability: it travels in the fragment
 * (`/approve#apr_…`), which browsers never send to a server, and reading it
 * approves nothing. Only a signature from a listed wallet (or a project key
 * outside the requester's subtree) decides.
 */
import { CHAINS, getProtocol, isNetworkKey } from "@kletia/core";

/** `apr_` + 32 hex, as `APPROVAL_ID_PATTERN` in `@kletia/core`. */
export const APPROVAL_FRAGMENT_PATTERN = /^apr_[0-9a-f]{32}$/u;

export type ApprovalFragment =
  | { readonly kind: "none" }
  | { readonly kind: "approval"; readonly id: string }
  /** Something is there, but it is not an approval id. */
  | { readonly kind: "invalid" };

/** Reads `#apr_…` (also `#approval=apr_…`, the form some mail clients keep). */
export function parseApprovalFragment(hash: string): ApprovalFragment {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { kind: "none" };
  if (APPROVAL_FRAGMENT_PATTERN.test(raw)) return { kind: "approval", id: raw };
  const named = /^approval=(apr_[0-9a-f]{32})$/u.exec(raw);
  if (named?.[1]) return { kind: "approval", id: named[1] };
  return { kind: "invalid" };
}

/** Plain words for the rule ids that ask for an approval (unknown ids print as they are). */
const TRIGGER_WORDS: Readonly<Record<string, string>> = {
  "confirm.aboveUsd": "Its value is above the rule book's approval threshold.",
  "confirm.externalRecipient": "Money goes to an account that is not one of the intent's own.",
  "confirm.contractCall": "It calls a custom contract.",
  "confirm.crossNetwork": "It moves money between networks.",
};

export function triggerWords(ruleId: string): string {
  return TRIGGER_WORDS[ruleId] ?? ruleId;
}

/** "5304.00" → "$5,304.00"; anything that is not a plain decimal prints as given. */
export function formatUsd(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) return value;
  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/u, "").replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const cents = (match[2] ?? "").padEnd(2, "0").slice(0, 2);
  return `$${whole}.${cents}`;
}

export type WalletFamily = "evm" | "solana";

/** A masked approver wallet (`0x4b20…9cd1`, `7xKX…sgAsU`) and the family it belongs to. */
export function walletFamily(masked: string): WalletFamily {
  return /^0x/iu.test(masked) ? "evm" : "solana";
}

/**
 * Whether a connected address can be the masked approver wallet. The API
 * shows only the first six and last four characters, so this is a hint for
 * the page ("connect that wallet"); the API checks the full address.
 */
export function maskedMatches(masked: string, address: string): boolean {
  const parts = masked.split("…");
  if (parts.length !== 2) return walletFamily(masked) === "evm" ? masked.toLowerCase() === address.toLowerCase() : masked === address;
  const [head = "", tail = ""] = parts;
  if (walletFamily(masked) === "evm") {
    const lower = address.toLowerCase();
    return /^0x[0-9a-f]{40}$/u.test(lower) && lower.startsWith(head.toLowerCase()) && lower.endsWith(tail.toLowerCase());
  }
  return !address.startsWith("0x") && address.length > head.length + tail.length && address.startsWith(head) && address.endsWith(tail);
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalStateView {
  readonly status: ApprovalStatus;
  /** A decision can still be signed. */
  readonly open: boolean;
  readonly title: string;
  readonly detail: string;
}

/** The stamp's words and what the page says next to it. */
export function approvalState(
  view: { readonly status: ApprovalStatus; readonly expiresAt: string; readonly decidedAt: string | null; readonly decidedBy: { readonly kind: "key" | "wallet"; readonly id: string } | null },
  now = Date.now(),
): ApprovalStateView {
  const expiry = Date.parse(view.expiresAt);
  const status: ApprovalStatus = view.status === "pending" && Number.isFinite(expiry) && expiry <= now ? "expired" : view.status;
  const by = view.decidedBy ? (view.decidedBy.kind === "wallet" ? `the wallet ${view.decidedBy.id}` : `the project key ${view.decidedBy.id}`) : null;
  const when = view.decidedAt ? ` on ${formatStamp(view.decidedAt)}` : "";
  switch (status) {
    case "approved":
      return { status, open: false, title: "Approved", detail: `Approved by ${by ?? "an approver"}${when}. The intent can now be prepared and signed, within the ceiling below.` };
    case "rejected":
      return { status, open: false, title: "Rejected", detail: `Rejected by ${by ?? "an approver"}${when}. Kletia cancelled the intent; nothing more can be prepared for it.` };
    case "expired":
      return { status, open: false, title: "Expired", detail: "Nobody decided in time, so the intent cannot go ahead. Plan a new intent to ask again." };
    case "pending":
    default:
      return {
        status: "pending",
        open: true,
        title: "Waiting for a decision",
        detail: `Held at the gate until someone listed below approves or rejects it, or until ${formatStamp(view.expiresAt)}.`,
      };
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** ISO time → "09 Oct 2026, 13:52 UTC". */
export function formatStamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** "in 42 min", "in 2 h 5 min", "now". */
export function timeLeft(iso: string, now = Date.now()): string {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left) || left <= 0) return "now";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

export function networkName(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].name : network;
}

const KIND_VERBS: Readonly<Record<string, string>> = {
  transfer: "Send",
  swap: "Swap",
  bridge: "Bridge",
  stake: "Stake",
  unstake: "Unstake",
  deposit: "Deposit",
  withdraw: "Withdraw",
  call: "Call",
  action: "Run",
  wrap: "Wrap",
  unwrap: "Unwrap",
};

export interface ApprovalStepView {
  readonly id: string;
  readonly kind: string;
  readonly network: string;
  readonly destinationNetwork?: string;
  readonly protocol: string;
  readonly input?: string;
  readonly output?: string;
  readonly recipient: string;
  readonly recipientName?: string;
}

export interface LegLine {
  readonly verb: string;
  /** "100 USDC → 99.94 USDC" */
  readonly amounts: string;
  readonly from: string;
  readonly to: string | null;
  readonly via: string;
  /** Full recipient address (never shortened at the gate). */
  readonly recipient: string;
  readonly recipientName: string | null;
}

/** One printed leg per step: verb, amounts, networks, venue and the full recipient. */
export function legLine(step: ApprovalStepView): LegLine {
  const verb = KIND_VERBS[step.kind] ?? step.kind.charAt(0).toUpperCase() + step.kind.slice(1);
  const amounts = [step.input, step.output].filter(Boolean).join(" → ");
  const recipient = step.recipient.split(":").length >= 3 ? (step.recipient.split(":").pop() ?? step.recipient) : step.recipient;
  return {
    verb,
    amounts,
    from: step.network,
    to: step.destinationNetwork && step.destinationNetwork !== step.network ? step.destinationNetwork : null,
    // The venue's display name ("ERC-20 transfer", "Relay"); an id the registry does not know prints as sent.
    via: getProtocol(step.protocol)?.name ?? step.protocol,
    recipient,
    recipientName: step.recipientName ?? null,
  };
}

/** The network a CAIP-10 recipient lives on (for its line bullet), or null. */
export function recipientNetwork(caip10: string): string | null {
  const parts = caip10.split(":");
  if (parts.length < 3) return null;
  const chain = `${parts[0]}:${parts[1]}`;
  const found = Object.values(CHAINS).find((candidate) => candidate.id === chain);
  return found ? found.key : null;
}

/** "AP-9C1E·4B20" printed on the ticket. */
export function approvalSerial(id: string): string {
  const hex = id.replace(/^apr_/u, "").toUpperCase();
  return `AP-${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

/** Digest shown in mono, wrapped every 16 characters so it never overflows a phone. */
export function digestGroups(digest: string): string[] {
  const body = digest.replace(/^0x/u, "");
  const groups: string[] = [];
  for (let index = 0; index < body.length; index += 16) groups.push(body.slice(index, index + 16));
  return groups.length ? [`0x${groups[0]}`, ...groups.slice(1)] : [digest];
}
