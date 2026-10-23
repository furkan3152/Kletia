/**
 * Model-assisted reading and route explanations on the desk (intent design
 * A.7.6, D.2): pure helpers the task body and its cards use.
 *
 * - `readingAvailable`: a refusal the person may have read once more with
 *   model help (`details.modelReading: "available"`).
 * - `readingPreference` / `rememberReadingPreference`: the desk setting
 *   (Off / Ask each time / On for this session), per browser tab.
 * - `mintReadingConsent`: `POST /v1/reading-consent` (once, session or
 *   confirm); a confirm token is minted only when the person clicked "Yes".
 * - `routeRows`, `providersLine`: the "Why this route" panel from
 *   `interpretation.routes` and `providersContacted`.
 * - `readAsChips`: "Read as" and "Ignored" chips from the assumptions.
 * Pure (fetch is passed in): node --test loads it.
 */
import type { ClarifyAssumption, IntentGraph, RouteChoice, RouteScore } from "@kletia/core";

export type ReadingPreference = "off" | "ask" | "session";
export type ReadingScope = "once" | "session" | "confirm";

const PREFERENCE_KEY = "kletia.desk.modelReading";

export const READING_COPY = Object.freeze({
  cardTitle: "Kletia could not read this on its own",
  cardBody:
    "Kletia can ask two independent models to propose a reading. Only Kletia's own words are sent: amounts, addresses, names and other words become placeholders. Kletia checks every part of the proposal and shows you the full plan before anything happens.",
  readOnce: "Read once",
  allowSession: "Allow for this session",
  rewrite: "Rewrite it",
  showSent: "Show what is sent",
  sentNote: "Sent: the sentence as numbered words from Kletia's vocabulary, with <amount_1>, <word_1> placeholders. Never sent: your wallet, balances, history or any other message.",
  settingsLabel: "Model-assisted reading",
  settings: { off: "Off", ask: "Ask each time", session: "On for this session" } as Record<ReadingPreference, string>,
  confirmNote: "Read with model assistance. Check every step before you plan it.",
  routeTitle: "Why this route",
  providersTitle: "Providers that saw your address",
  guaranteed: "guaranteed minimum (enforced on-chain)",
  quoted: "quoted minimum",
  estimate: "estimate",
});

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readingPreference(store: StorageLike | null = sessionStore()): ReadingPreference {
  try {
    const value = store?.getItem(PREFERENCE_KEY);
    return value === "off" || value === "session" ? value : "ask";
  } catch {
    return "ask";
  }
}

export function rememberReadingPreference(value: ReadingPreference, store: StorageLike | null = sessionStore()): void {
  try {
    store?.setItem(PREFERENCE_KEY, value);
  } catch {
    // Private mode: the setting lasts for this page only.
  }
}

/** A refusal the person may have read with model assistance. */
export function readingAvailable(failure: { readonly code: string; readonly details?: unknown } | null): boolean {
  if (!failure || failure.code !== "INTENT_UNSUPPORTED") return false;
  const details = failure.details as { modelReading?: unknown } | null | undefined;
  return details?.modelReading === "available";
}

/** The wallet address of an account id ("eip155:8453:0x…" -> "0x…"), the one a consent binds to. */
export function walletOfAccount(account: string | undefined): string | null {
  if (!account) return null;
  const address = account.slice(account.lastIndexOf(":") + 1);
  return address.length >= 20 ? address : null;
}

export interface ConsentRequest {
  readonly scope: ReadingScope;
  readonly wallet: string;
  readonly text?: string;
  readonly threadId?: string;
}

/** Mints a reading consent token; null when the API refuses or cannot be reached (the desk then keeps the refusal). */
export async function mintReadingConsent(origin: string, request: ConsentRequest, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${origin}/v1/reading-consent`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

const usd = (value: number) => `$${value.toFixed(value >= 100 ? 0 : 2)}`;

export interface RouteRow {
  readonly label: string;
  readonly detail: string;
  readonly chosen: boolean;
  readonly excluded?: string;
}

function scoreLine(score: RouteScore): string {
  const minimum = `${usd(score.minimumUsd)} ${score.minimumKind === "onchain" ? READING_COPY.guaranteed : READING_COPY.quoted}`;
  const parts = [`${usd(score.expectedUsd)} expected`, minimum, `${usd(score.gasUsd + score.feesUsd)} fees and gas`, `~${Math.max(1, Math.round(score.seconds))} s`, `${score.signatures} signature${score.signatures === 1 ? "" : "s"}`];
  return `${parts.join(" · ")}${score.estimate ? ` (${READING_COPY.estimate})` : ""}`;
}

/** The chosen route and what it was compared with, per leg. */
export function routeRows(intent: Pick<IntentGraph, "interpretation">): { readonly reason: string; readonly rows: readonly RouteRow[]; readonly alternatives: RouteChoice["alternatives"] }[] {
  const routes = intent.interpretation.routes ?? [];
  return routes.map((route) => ({
    reason: route.reason,
    rows: [
      { label: `${route.shape === "single" ? "Direct" : route.shape}${route.carrier ? ` via ${route.carrier}` : ""}${route.venues.length ? ` (${route.venues.join(", ")})` : ""}`, detail: scoreLine(route.score), chosen: true },
      ...route.compared.map((entry) => ({ label: entry.label, detail: entry.score ? scoreLine(entry.score) : "", chosen: false, ...(entry.excluded ? { excluded: entry.excluded } : {}) })),
    ],
    alternatives: route.alternatives,
  }));
}

export function providersLine(intent: Pick<IntentGraph, "interpretation">): string | null {
  const contacted = intent.interpretation.providersContacted ?? [];
  const saw = contacted.filter((entry) => entry.sawAccount).map((entry) => entry.provider);
  return saw.length > 0 ? saw.join(", ") : null;
}

/** "Read as" (material) and "Ignored" chips, in that order, from the turn's assumptions. */
export function readAsChips(assumptions: readonly ClarifyAssumption[]): { readonly label: string; readonly material: boolean }[] {
  const chips = assumptions.filter((entry) => /^(Read as|Ignored)/u.test(entry.label));
  return [...chips].sort((a, b) => Number(b.material) - Number(a.material)).map((entry) => ({ label: entry.label.slice(0, 48), material: entry.material }));
}

/** Whether a plan carries a model reading the person confirmed. */
export function modelRead(intent: Pick<IntentGraph, "interpretation"> | null): boolean {
  return intent?.interpretation.modelReading?.used === true;
}
