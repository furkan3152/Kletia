/**
 * Rows of the Contracts list and the facts of a contract page (portal
 * design 4.4.4, P-07, P-08, P-14): the title is the first entry's label (two
 * registrations of one integrator no longer read the same), the status is a
 * `statusTones` entry, a pending countdown always sits next to its absolute
 * UTC time, and source and domain verification are warning when unverified
 * (never danger). Pure, so the node tests load it directly.
 */
import { CONTRACT_ID_PATTERN, CONTRACT_LIMITS, type ContractView } from "@kletia/core";

import { toneFor, verificationTone, type StatusEntry } from "../../../site/ui/statusTones.ts";
import { durationText, hostOf, shortAddress } from "../portal/portalFormat.ts";

/** At most this many registrations per key. */
export const CONTRACT_REGISTRATION_LIMIT = CONTRACT_LIMITS.registrationsPerKey;

export type ContractRowInput = Pick<
  ContractView,
  "id" | "vm" | "network" | "address" | "origin" | "integrator" | "status" | "revision" | "activeRevision" | "pendingRevision" | "activatesAt" | "verification" | "actions" | "suspendedReason"
>;

export interface ContractRowModel {
  readonly id: string;
  /** The first entry's label ("Deposit into Acme Prime USDC"), or the integrator name without entries. */
  readonly title: string;
  readonly integrator: string;
  /** `0xbeeF…8183` or the Solana Action origin's host. */
  readonly target: string;
  readonly network: string;
  /** Entry ids, comma separated ("deposit, withdraw"). */
  readonly entries: string;
  readonly status: StatusEntry;
  /** `activates 14:42 UTC, in 1 min 43 s`, a pending revision, or why it is suspended; null when nothing is due. */
  readonly detail: string | null;
  readonly source: StatusEntry;
  readonly domain: StatusEntry;
}

const pad = (value: number) => String(value).padStart(2, "0");

function utcClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** `activates 14:42 UTC, in 1 min 43 s` (relative time only next to an absolute one, copy rules 5.6). */
export function activationText(activatesAt: string | null | undefined, now: number): string {
  const at = activatesAt ? Date.parse(activatesAt) : Number.NaN;
  if (!Number.isFinite(at)) return "waiting for activation";
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return `activating now (due ${utcClock(at)})`;
  return `activates ${utcClock(at)}, in ${durationText(seconds)}`;
}

const SUSPENSION: Readonly<Record<string, string>> = {
  pins_changed: "the deployed code changed since it was pinned",
  program_changed: "a pinned Solana program changed",
  outcome_mismatch: "a landed call did not match its declared outcome",
  domain_unverified: "the domain file is gone",
};

function suspensionReason(reason: string | null): string {
  if (!reason) return "suspended";
  if (reason.startsWith("operator:")) return `suspended by the operator: ${reason.slice("operator:".length).trim() || "no reason given"}`;
  return `suspended: ${SUSPENSION[reason] ?? reason}`;
}

/** Source verification: Sourcify for EVM, OtterSec for every pinned Solana program. */
export function sourceFact(contract: Pick<ContractView, "vm" | "verification">): StatusEntry {
  if (contract.vm === "svm") {
    const programs = contract.verification.programs ?? [];
    const verified = programs.length > 0 && programs.every((program) => program.verified === true);
    return { ...verificationTone(verified), label: verified ? "Programs verified" : "Programs not all verified" };
  }
  return toneFor("contract-source", contract.verification.source?.status ?? "unknown");
}

export function domainFact(contract: Pick<ContractView, "integrator">): StatusEntry {
  return toneFor("contract-domain", contract.integrator.domainVerified ? "verified" : "unverified");
}

export function contractRowModel(contract: ContractRowInput, now: number): ContractRowModel {
  let detail: string | null = null;
  if (contract.status === "pending") detail = activationText(contract.activatesAt, now);
  else if (contract.status === "suspended") detail = suspensionReason(contract.suspendedReason);
  else if (contract.pendingRevision !== null && contract.pendingRevision !== undefined) detail = `revision ${contract.pendingRevision} ${activationText(contract.activatesAt, now)}`;
  const first = contract.actions[0]?.label?.trim();
  return {
    id: contract.id,
    title: first || contract.integrator.name,
    integrator: contract.integrator.name,
    target: contract.vm === "evm" ? shortAddress(contract.address ?? "") : (hostOf(contract.origin) ?? contract.origin ?? ""),
    network: contract.network,
    entries: contract.actions.map((action) => action.id).join(", ") || "–",
    status: toneFor("contract", contract.status),
    detail,
    source: sourceFact(contract),
    domain: domainFact(contract),
  };
}

/**
 * The list's count line, `2 of 25 registrations`, only when the list was
 * read: absent before the first read and on error (never "0 of 25" above
 * "Could not list registrations", P-14).
 */
export function contractCountLine(list: { readonly status: string; readonly data: readonly unknown[] | undefined }, limit = CONTRACT_REGISTRATION_LIMIT): string | null {
  if (list.status === "error" || !list.data) return null;
  return `${list.data.length} of ${limit} registrations`;
}

/** Contract ids as the API issues them. */
export const CONTRACT_ID = CONTRACT_ID_PATTERN;

export type ContractTab = "overview" | "entries" | "test" | "pins" | "revisions" | "domain";

export const CONTRACT_TABS: readonly ContractTab[] = ["overview", "entries", "test", "pins", "revisions", "domain"];

/** `?tab=` of a contract page; anything else is the overview. */
export function contractTabOf(search: URLSearchParams): ContractTab {
  const value = search.get("tab");
  return CONTRACT_TABS.includes(value as ContractTab) ? (value as ContractTab) : "overview";
}

/** `?vm=` of the register page: `svm` for a Solana Action, anything else EVM. */
export function registerVmOf(search: URLSearchParams): "evm" | "svm" {
  return search.get("vm") === "svm" ? "svm" : "evm";
}
