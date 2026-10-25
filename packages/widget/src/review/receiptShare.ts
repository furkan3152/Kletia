/**
 * Receipt share profiles and links.
 */
import {
  RECEIPT_ID_PATTERN,
  RECEIPT_PROFILES,
  RECEIPT_SHARE_ID_PATTERN,
} from "@kletia/core";
import type { ApprovalLinkOptions } from "./policy.js";

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
