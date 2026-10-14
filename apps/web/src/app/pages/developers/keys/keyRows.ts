/**
 * Rows of the Keys page (portal design 4.4.2 and PD-3): each key's kind and
 * depth in the key tree, a status from the shared tone table (active,
 * rotating, expiring within 24 h, revoked, expired), its lane (Sandbox or
 * Live), and the usage-by-route table with its 4xx share. Pure, so the node
 * tests load it directly.
 */
import { toneFor, type StatusEntry } from "../../../site/ui/statusTones.ts";
import { utcStamp } from "../webhooks/webhookModel.ts";

/** What `GET /v1/keys` returns per key (the SDK's `ApiKeySummary`); older APIs omit the optional fields. */
export interface KeyRowInput {
  readonly id: string;
  readonly name: string;
  readonly last4: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt?: string | null;
  readonly previousExpiresAt: string | null;
  readonly revokedAt: string | null;
  readonly current: boolean;
  readonly kind?: "project" | "agent" | "publishable";
  readonly parentId?: string | null;
  readonly depth?: number;
  readonly expiresAt?: string | null;
  readonly descendants?: number;
  readonly lane?: "testnet" | "production" | "any";
}

export type KeyKind = "developer" | "agent" | "publishable";
export type KeyState = "active" | "rotating" | "expiring" | "revoked" | "expired";

export interface KeyRowModel {
  readonly id: string;
  readonly name: string;
  readonly kind: KeyKind;
  /** `Developer`, `Agent · 2` (its level below the project key) or `Publishable`. */
  readonly kindLabel: string;
  /** Levels below the project key: 0 for developer keys. */
  readonly depth: number;
  readonly state: KeyState;
  readonly status: StatusEntry;
  /** When the state ends: `old secret until 15 Oct 2026, 13:50 UTC`, `expires …`; null when nothing is due. */
  readonly statusDetail: string | null;
  /** `Sandbox` (testnets only) or `Live`; `–` when the API did not say. */
  readonly lane: string;
  /** What the lane allows, for the cell's title. */
  readonly laneDetail: string;
  /** `••••xmr0`. */
  readonly secret: string;
  readonly created: string;
  readonly lastUsed: string;
  readonly current: boolean;
  /** Revoked and expired keys have no actions left. */
  readonly ended: boolean;
}

/** Expiry this close turns a key's status into a warning. */
export const KEY_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

const LANES: Readonly<Record<NonNullable<KeyRowInput["lane"]>, { readonly label: string; readonly detail: string }>> = {
  testnet: { label: "Sandbox", detail: "Testnets only: Arc Testnet, Arbitrum Sepolia and Solana Devnet" },
  production: { label: "Live", detail: "Mainnets only" },
  any: { label: "Live", detail: "Mainnets and testnets" },
};

function at(value: string | null | undefined): number {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NaN;
}

export function keyKindOf(item: Pick<KeyRowInput, "kind">): KeyKind {
  return item.kind === "agent" ? "agent" : item.kind === "publishable" ? "publishable" : "developer";
}

/** The state a key is in at `now`: revoked and expired end it; an open grace window is rotating; an expiry within 24 h is a warning. */
export function keyStateOf(item: KeyRowInput, now: number): KeyState {
  if (item.revokedAt) return "revoked";
  const expires = at(item.expiresAt);
  if (Number.isFinite(expires) && expires <= now) return "expired";
  if (Number.isFinite(at(item.previousExpiresAt)) && at(item.previousExpiresAt) > now) return "rotating";
  if (Number.isFinite(expires) && expires - now < KEY_EXPIRY_WARNING_MS) return "expiring";
  return "active";
}

export function keyRowModel(item: KeyRowInput, now: number): KeyRowModel {
  const kind = keyKindOf(item);
  const depth = kind === "developer" ? 0 : Math.max(1, Math.floor(item.depth ?? 1));
  const state = keyStateOf(item, now);
  const lane = item.lane ? LANES[item.lane] : null;
  const statusDetail =
    state === "revoked"
      ? `revoked ${utcStamp(item.revokedAt)}`
      : state === "expired"
        ? `expired ${utcStamp(item.expiresAt)}`
        : state === "rotating"
          ? `old secret until ${utcStamp(item.previousExpiresAt)}`
          : item.expiresAt && Number.isFinite(at(item.expiresAt))
            ? `expires ${utcStamp(item.expiresAt)}`
            : null;
  return {
    id: item.id,
    name: item.name,
    kind,
    kindLabel: kind === "developer" ? "Developer" : kind === "publishable" ? "Publishable" : `Agent · ${depth}`,
    depth,
    state,
    status: toneFor("key", state),
    statusDetail,
    lane: lane?.label ?? "–",
    laneDetail: lane?.detail ?? "This API does not report lanes.",
    secret: `••••${item.last4 ?? "????"}`,
    created: utcStamp(item.createdAt),
    lastUsed: item.lastUsedAt ? utcStamp(item.lastUsedAt) : "–",
    current: item.current,
    ended: state === "revoked" || state === "expired",
  };
}

/**
 * Keys in tree order: each developer key, then the keys issued under it
 * (agents and publishable keys, depth first), in the API's order within a
 * level. Keys whose parent is not listed (an agent key's own view) start the
 * list; nothing is dropped.
 */
export function orderKeyTree<T extends Pick<KeyRowInput, "id" | "parentId">>(items: readonly T[]): T[] {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const item of items) {
    const parent = item.parentId ?? null;
    if (parent && ids.has(parent) && parent !== item.id) {
      const list = children.get(parent) ?? [];
      list.push(item);
      children.set(parent, list);
    } else roots.push(item);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (item: T) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
    for (const child of children.get(item.id) ?? []) visit(child);
  };
  roots.forEach(visit);
  // A cycle in the data would leave keys unvisited: list them rather than hide them.
  for (const item of items) if (!seen.has(item.id)) out.push(item);
  return out;
}

/* ------------------------------------------------------------------- usage */

export interface UsageRouteInput {
  readonly route: string;
  readonly requests: number;
  readonly byStatusClass: Readonly<Record<string, number>>;
}

export interface UsageRouteRow {
  readonly route: string;
  readonly requests: number;
  readonly ok: number;
  readonly clientErrors: number;
  readonly serverErrors: number;
  /** Share of the route's requests answered 4xx, 0..1. */
  readonly clientShare: number;
  /** A 4xx share worth a look (at least a quarter and at least 2 requests): the row links to the errors reference. */
  readonly highlight: boolean;
}

/** Highlight a route when at least this share of its requests answered 4xx. */
export const USAGE_4XX_HIGHLIGHT = 0.25;

function count(record: Readonly<Record<string, number>> | undefined, name: string): number {
  const value = record?.[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Usage by route, busiest first (ties by route name), with the 2xx/4xx/5xx split. */
export function usageRouteRows(routes: readonly UsageRouteInput[], limit = 12): UsageRouteRow[] {
  return [...routes]
    .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route))
    .slice(0, limit)
    .map((route) => {
      const clientErrors = count(route.byStatusClass, "4xx");
      const share = route.requests > 0 ? clientErrors / route.requests : 0;
      return {
        route: route.route,
        requests: route.requests,
        ok: count(route.byStatusClass, "2xx"),
        clientErrors,
        serverErrors: count(route.byStatusClass, "5xx"),
        clientShare: share,
        highlight: clientErrors >= 2 && share >= USAGE_4XX_HIGHLIGHT,
      };
    });
}
