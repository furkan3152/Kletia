/**
 * The intent link calls the page makes, all public: the link view, an
 * indicative or account-specific quote, the visitor's own intent, and an
 * abuse report. Nothing here can change the link: recipients and contracts
 * are fixed by the publisher and never sent from the page.
 */
import type { LinkView } from "@kletia/core";
import { KletiaApiError, type LinkIntentResponse } from "@kletia/sdk";

import { getKletiaClient, sdkSignal } from "../../../shared/platform/kletiaClient";

export type LinkLoad =
  | { readonly kind: "ok"; readonly view: LinkView }
  /** Unknown id (or one nobody may see). */
  | { readonly kind: "missing" }
  /** Withdrawn or expired: 410 LINK_EXPIRED. */
  | { readonly kind: "gone"; readonly message: string };

function options(signal?: AbortSignal): { signal?: AbortSignal } {
  const usable = sdkSignal(signal);
  return usable ? { signal: usable } : {};
}

export async function loadLink(id: string, signal?: AbortSignal): Promise<LinkLoad> {
  try {
    return { kind: "ok", view: (await getKletiaClient().links.get(id, options(signal))) as LinkView };
  } catch (error) {
    if (error instanceof KletiaApiError && error.code === "LINK_NOT_FOUND") return { kind: "missing" };
    if (error instanceof KletiaApiError && (error.code === "LINK_EXPIRED" || error.status === 410)) return { kind: "gone", message: error.message };
    throw error;
  }
}

export interface FundingChoice {
  readonly network: LinkView["destination"]["network"];
  readonly asset: string;
  /** Input mode only. */
  readonly amount?: string;
}

export function quoteLink(id: string, choice: FundingChoice, accounts: readonly string[] | null, signal?: AbortSignal): Promise<LinkIntentResponse> {
  return getKletiaClient().links.quote(
    id,
    {
      source: { network: choice.network, asset: choice.asset },
      ...(choice.amount ? { amount: choice.amount } : {}),
      ...(accounts && accounts.length > 0 ? { accounts } : {}),
    },
    { ...options(signal), maxRetries: 0 },
  );
}

export function createLinkIntent(id: string, choice: FundingChoice, accounts: readonly string[], clientReference: string): Promise<LinkIntentResponse> {
  return getKletiaClient().links.createIntent(id, {
    source: { network: choice.network, asset: choice.asset },
    ...(choice.amount ? { amount: choice.amount } : {}),
    accounts,
    clientReference,
  });
}

export const REPORT_REASONS = [
  { value: "phishing", label: "Phishing or a scam" },
  { value: "impersonation", label: "It pretends to be someone else" },
  { value: "broken", label: "It does not work" },
  { value: "other", label: "Something else" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["value"];

export async function reportLink(id: string, reason: ReportReason): Promise<void> {
  await getKletiaClient().request("POST", `/links/${id}/report`, { reason }, { maxRetries: 0 });
}
