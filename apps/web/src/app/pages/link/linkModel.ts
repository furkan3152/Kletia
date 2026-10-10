/**
 * What the intent link page prints and accepts, derived from the public link
 * view (`GET /v1/links/{id}`). Pure (node --test loads it).
 *
 * Publisher names, titles and descriptions are user content: the page renders
 * them as text only. The URL may prefill a funding choice
 * (`?from=arbitrum&asset=USDC&amount=250`), never a recipient or a contract,
 * and a prefilled amount still has to sit inside the publisher's bounds.
 */
import { CHAINS, isNetworkKey, linkFundingOptions, type IntentPreview, type LinkView, type NetworkKey } from "@kletia/core";

export interface FundingOption {
  /** "arbitrum:USDC" */
  readonly key: string;
  readonly network: NetworkKey;
  readonly networkName: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly asset: string;
}

/** Every (network, asset) a visitor may start from, in the publisher's order. */
export function fundingOptions(view: Pick<LinkView, "funding">): FundingOption[] {
  return linkFundingOptions(view.funding).map((option) => ({
    key: `${option.network}:${option.symbol}`,
    network: option.network,
    networkName: CHAINS[option.network].name,
    symbol: option.symbol,
    decimals: option.asset.decimals,
    asset: option.asset.id,
  }));
}

export interface AmountBounds {
  readonly min: string;
  readonly max: string;
  readonly default?: string;
}

export function boundsFor(view: Pick<LinkView, "funding">, symbol: string): AmountBounds | null {
  const amount = view.funding.amount;
  if (amount.mode !== "input") return null;
  const entry = Object.entries(amount.bounds).find(([key]) => key.toUpperCase() === symbol.toUpperCase());
  return entry ? entry[1] : null;
}

function scaled(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`);
}

export type AmountCheck = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

/** A decimal amount inside the bounds, with at most `decimals` fraction digits. */
export function checkAmount(raw: string, bounds: AmountBounds, decimals: number, symbol: string): AmountCheck {
  const value = raw.trim().replace(/^\+/u, "");
  if (!value) return { ok: false, message: `Enter an amount from ${bounds.min} to ${bounds.max} ${symbol}.` };
  if (!/^\d{1,30}(?:\.\d{1,36})?$/u.test(value)) return { ok: false, message: "Use digits and one decimal point, like 25.5." };
  const fraction = value.split(".")[1] ?? "";
  if (fraction.length > decimals) return { ok: false, message: `${symbol} has ${decimals} decimals at most.` };
  const width = Math.max(decimals, (bounds.min.split(".")[1] ?? "").length, (bounds.max.split(".")[1] ?? "").length);
  const amount = scaled(value, width);
  if (amount < scaled(bounds.min, width)) return { ok: false, message: `The publisher set a minimum of ${bounds.min} ${symbol}.` };
  if (amount > scaled(bounds.max, width)) return { ok: false, message: `The publisher set a maximum of ${bounds.max} ${symbol}.` };
  return { ok: true, value: value.replace(/^0+(?=\d)/u, "") };
}

export interface Prefill {
  readonly optionKey: string | null;
  readonly amount: string | null;
  /** What the page ignored from the URL, said plainly. */
  readonly ignored: readonly string[];
}

/** Reads `?from=&asset=&amount=`: only choices the publisher allows, amounts inside the bounds. */
export function readPrefill(search: string, view: Pick<LinkView, "funding">): Prefill {
  const params = new URLSearchParams(search);
  const from = params.get("from")?.trim().toLowerCase() ?? "";
  const asset = params.get("asset")?.trim().toUpperCase() ?? "";
  const rawAmount = params.get("amount")?.trim() ?? "";
  const options = fundingOptions(view);
  const ignored: string[] = [];
  let option: FundingOption | null = null;
  if (from || asset) {
    option = options.find((candidate) => (!from || candidate.network === from) && (!asset || candidate.symbol.toUpperCase() === asset)) ?? null;
    if (!option) ignored.push("The link's address names a starting point this link does not offer.");
  }
  let amount: string | null = null;
  if (rawAmount) {
    const target = option ?? options[0] ?? null;
    const bounds = target ? boundsFor(view, target.symbol) : null;
    if (!target || !bounds) ignored.push("This link has a fixed amount, so the amount in the address was ignored.");
    else {
      const checked = checkAmount(rawAmount, bounds, target.decimals, target.symbol);
      if (checked.ok) amount = checked.value;
      else ignored.push(`The amount in the address was ignored: ${checked.message}`);
    }
  }
  return { optionKey: option?.key ?? null, amount, ignored };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** ISO time → "08 Nov 2026" (UTC). */
export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** ISO time → "14:05 UTC". */
export function formatClock(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "L-B02C·6F69" printed on the ticket. */
export function linkSerial(id: string): string {
  const hex = id.replace(/^lk_/u, "").toUpperCase();
  return `L-${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

/** The sentence the link fills in, from the destination actions Kletia labelled. */
export function linkSentence(view: Pick<LinkView, "destination">): string {
  return view.destination.actions.map((action) => action.label).join(", then ");
}

export interface BoundRow {
  readonly label: string;
  readonly value: string;
}

/** "Bounds Kletia enforces" on the ticket. */
export function boundRows(view: Pick<LinkView, "funding" | "destination" | "fixed">): BoundRow[] {
  const rows: BoundRow[] = [];
  const amount = view.funding.amount;
  if (amount.mode === "deliver") {
    const first = view.destination.actions[0];
    const payee = view.fixed.recipients[0];
    rows.push({ label: "Delivers", value: first ? first.label.replace(/ on [A-Za-z ]+$/u, "") : "A fixed amount" });
    if (payee) rows.push({ label: "To", value: payee.name ?? `${payee.address.slice(0, 6)}…${payee.address.slice(-4)}` });
  } else {
    for (const [symbol, bounds] of Object.entries(amount.bounds)) rows.push({ label: symbol, value: `${bounds.min} to ${bounds.max}` });
  }
  rows.push({ label: "Arrives on", value: isNetworkKey(view.destination.network) ? CHAINS[view.destination.network].name : view.destination.network });
  return rows;
}

/** Networks on the ticket: where the money may start, then where it arrives. */
export function ticketNetworks(view: Pick<LinkView, "funding" | "destination">): NetworkKey[] {
  const out: NetworkKey[] = [];
  for (const network of [...view.funding.networks, view.destination.network]) if (isNetworkKey(network) && !out.includes(network)) out.push(network);
  return out;
}

export interface LinkStateView {
  /** New intents may start from this link now. */
  readonly usable: boolean;
  readonly tone: "ok" | "held" | "void";
  readonly title: string;
  readonly detail: string;
  /** Small print of the stamp. */
  readonly stamp: string;
}

export function linkState(view: Pick<LinkView, "status" | "activatesAt" | "expiresAt">, now = Date.now()): LinkStateView {
  const expired = Number.isFinite(Date.parse(view.expiresAt)) && Date.parse(view.expiresAt) <= now;
  const status = expired && view.status !== "deleted" && view.status !== "suspended" ? "expired" : view.status;
  switch (status) {
    case "active":
      return { usable: true, tone: "ok", title: "Open", detail: "Choose where your money starts, check the fare, then sign in your own wallet.", stamp: "OPEN" };
    case "pending": {
      const at = view.activatesAt ? Date.parse(view.activatesAt) : Number.NaN;
      const minutes = Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 60_000)) : null;
      return {
        usable: false,
        tone: "held",
        title: minutes ? `Activates in ${minutes} min` : "Not active yet",
        detail: "Links that pay a fixed third party or call a custom contract wait 15 minutes after they are published, so the publisher hears about them before anyone can use them.",
        stamp: view.activatesAt ? `ACTIVATES ${formatClock(view.activatesAt)}` : "NOT ACTIVE YET",
      };
    }
    case "paused":
      return { usable: false, tone: "held", title: "Paused by the publisher", detail: "Nobody can start from this link until the publisher resumes it. Intents already started can finish.", stamp: "PAUSED" };
    case "exhausted":
      return { usable: false, tone: "void", title: "All uses taken", detail: "Every use of this link is taken. A use comes back when someone abandons theirs, so try again later.", stamp: "ALL USES TAKEN" };
    case "suspended":
      return { usable: false, tone: "void", title: "Suspended by Kletia", detail: "Kletia suspended this link. Do not send money to its recipients.", stamp: "SUSPENDED BY KLETIA" };
    case "deleted":
      return { usable: false, tone: "void", title: "Withdrawn", detail: "The publisher withdrew this link.", stamp: "WITHDRAWN" };
    case "expired":
    default:
      return { usable: false, tone: "void", title: "Expired", detail: `This link expired on ${formatDate(view.expiresAt)}. Ask the publisher for a new one.`, stamp: "EXPIRED" };
  }
}

/** One account per virtual machine the route signs on: which wallets the visitor connects. */
export function namespacesFor(intent: { readonly steps: readonly { readonly network: string; readonly mode: string }[] }): ("eip155" | "solana")[] {
  const out = new Set<"eip155" | "solana">();
  for (const step of intent.steps) {
    if (step.mode !== "wallet" || !isNetworkKey(step.network)) continue;
    out.add(CHAINS[step.network].namespace === "solana" ? "solana" : "eip155");
  }
  return [...out];
}

/** An https URL or null: the page links nothing else (publisher websites, explorers). */
export function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * The visitor's accounts for `POST /v1/links/{id}/intents`: one per virtual
 * machine the route signs on, placed on the chain where that VM first signs
 * (the funding network when it matches), so a wallet connected to another
 * network still counts on the link's lane.
 */
export function visitorAccounts(
  needed: readonly ("eip155" | "solana")[],
  source: NetworkKey,
  intent: { readonly steps: readonly { readonly network: string; readonly mode: string; readonly index: number }[] },
  wallets: { readonly evm: string | null; readonly solana: string | null },
): string[] {
  const out: string[] = [];
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  for (const namespace of needed) {
    const address = namespace === "eip155" ? wallets.evm : wallets.solana;
    if (!address) continue;
    const sourceMatches = CHAINS[source].namespace === namespace;
    const firstStep = steps.find((step) => step.mode === "wallet" && isNetworkKey(step.network) && CHAINS[step.network].namespace === namespace);
    const network = sourceMatches ? source : firstStep && isNetworkKey(firstStep.network) ? firstStep.network : null;
    if (!network) continue;
    out.push(`${CHAINS[network].id}:${address}`);
  }
  return out;
}

/**
 * Issues an indicative quote reports about its stand-in account rather than
 * about the route: the stand-in holds nothing, so its balance is short and a
 * simulation of its first spend reverts.
 */
const STAND_IN_ISSUES = new Set(["INSUFFICIENT_BALANCE", "SIMULATION_FAILED", "PREVIEW_GAS_ON_ARRIVAL"]);

/**
 * The fare of an indicative quote (`POST /v1/links/{id}/quote` without
 * accounts), as the page prints it: what the route pays, gets and costs, but
 * nothing about the stand-in account's balances ("you have 0 USDC", gas to
 * bring, "would fail on-chain"), which would describe nobody. The visitor's
 * own quote, after connecting, is shown in full and approved before signing.
 */
export function indicativeFare(preview: IntentPreview): IntentPreview {
  const steps = preview.steps.map((step) => ({ ...step, issues: step.issues.filter((issue) => issue.severity === "block" || !STAND_IN_ISSUES.has(issue.code)) }));
  return {
    ...preview,
    // Kletia could not simulate the stand-in's spend; the numbers are the venues' quotes.
    basis: preview.basis === "unavailable" ? "quoted" : preview.basis,
    needs: [],
    warnings: preview.warnings.filter((warning) => !/^PREVIEW_GAS_ON_ARRIVAL:/u.test(warning)),
    steps,
  };
}
