/**
 * Pure helpers of the desk's answer card (POST /v1/assistant/ask): the
 * answer checked before it is shown, source names, chart bars, the short
 * wallet address and the session's model-help consent (sessionStorage, per
 * tab, never the answer itself). No React: node --test loads it.
 */
import type { AssistantAnswer, AssistantChart, AssistantLink } from "@kletia/core";

const STATUSES = new Set(["answered", "partial", "unknown", "refused", "needs-model"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** A link the card can follow: a History row id, or a deposit sentence for the composer. */
export function isLink(value: unknown): value is AssistantLink {
  if (!isRecord(value)) return false;
  if (value.kind === "transaction") return typeof value.id === "string" && value.id.length <= 140;
  return value.kind === "deposit" && typeof value.sentence === "string" && value.sentence.length <= 500;
}

/** The answer of `{ answer }`, or null when it does not have the shape the card needs (never shown half-read). */
export function parseAnswer(body: unknown): AssistantAnswer | null {
  const answer = isRecord(body) ? body.answer : null;
  if (!isRecord(answer) || typeof answer.text !== "string" || !STATUSES.has(answer.status as string)) return null;
  if (!Array.isArray(answer.facts) || !answer.facts.every((fact) => isRecord(fact) && typeof fact.label === "string" && typeof fact.value === "string")) return null;
  if (!strings(answer.followUps) || !strings(answer.assumptions) || !strings(answer.gaps) || !Array.isArray(answer.wallets)) return null;
  if (answer.action !== undefined && !(isRecord(answer.action) && strings(answer.action.sentences))) return null;
  if (!answer.facts.every((fact) => isRecord(fact) && (fact.link === undefined || isLink(fact.link)))) return null;
  const table = answer.table;
  if (table !== undefined && isRecord(table) && table.links !== undefined && !(Array.isArray(table.links) && table.links.every((link) => link === null || isLink(link)))) return null;
  return answer as unknown as AssistantAnswer;
}

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  "usd-par": "USD par", jupiter: "Jupiter", chainlink: "Chainlink", pyth: "Pyth", "venue-rate": "venue rate", testnet: "test network", unpriced: "no price",
  adapter: "on-chain read", "aave-oracle": "Aave oracle", "lending-metrics": "venue rate reader", "health-probe": "network probe",
  snapshot: "Kletia's readings", kletia: "Kletia", chain: "on-chain history",
};

export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source;
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  /** Bar length as a percentage of the largest absolute value (0..100). */
  readonly width: number;
  readonly negative: boolean;
  readonly text: string;
}

/** Bars of a chart, scaled to the largest absolute value; USD or share labels as printed. */
export function barRows(chart: AssistantChart): BarRow[] {
  const max = Math.max(0, ...chart.points.map((point) => Math.abs(point.value)));
  return chart.points.map((point) => ({
    label: point.label,
    value: point.value,
    width: max > 0 ? Math.max(2, Math.round((Math.abs(point.value) / max) * 100)) : 0,
    negative: point.value < 0,
    text: chart.unit === "fraction"
      ? `${(point.value * 100).toFixed(1)}%`
      : `${point.value < 0 ? "-" : ""}$${Math.abs(point.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  }));
}

/** "0x4f18…6e5C". */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CONSENT_KEY = "kletia.desk.assistantConsent";

function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The model-help consent of this tab for `wallet`, while it lasts; null otherwise. */
export function readConsent(wallet: string, now = Date.now(), store: StorageLike | null = sessionStore()): string | null {
  try {
    const raw = store?.getItem(CONSENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { wallet?: unknown; token?: unknown; expiresAt?: unknown }) : null;
    if (!parsed || typeof parsed.token !== "string" || typeof parsed.wallet !== "string" || typeof parsed.expiresAt !== "string") return null;
    if (parsed.wallet.toLowerCase() !== wallet.toLowerCase() || Date.parse(parsed.expiresAt) <= now) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

export function rememberConsent(wallet: string, token: string, expiresAt: string, store: StorageLike | null = sessionStore()): void {
  try {
    store?.setItem(CONSENT_KEY, JSON.stringify({ wallet, token, expiresAt }));
  } catch {
    // Private mode: the consent lasts for this page only.
  }
}
