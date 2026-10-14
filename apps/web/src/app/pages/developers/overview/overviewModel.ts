/**
 * "Your project" on the Overview: one tile per tool, each built from its
 * own API payload. Rules: a number the page did not read is "–", never 0;
 * one tile's error never blanks another; failing webhook deliveries, held
 * approvals, pending or suspended registrations and failed intents raise
 * the tile's attention line; agent keys are counted apart from project
 * keys. Pure: the node tests load it directly.
 */

export type SourceStatus = "idle" | "loading" | "success" | "error";

/** One API read as the page holds it. */
export interface TileSource<T> {
  readonly status: SourceStatus;
  readonly data?: T | undefined;
  readonly error?: { readonly status: number; readonly code: string; readonly message: string } | null;
}

export interface TileLine {
  /** "4", "–". */
  readonly value: string;
  /** "active", "agent keys". */
  readonly label: string;
}

export type TileId = "keys" | "intents" | "webhooks" | "contracts" | "links" | "rule-book";

export interface GlanceTile {
  readonly id: TileId;
  readonly title: string;
  readonly href: string;
  /** The tile's link text ("Manage keys"). */
  readonly action: string;
  readonly state: "loading" | "error" | "ready";
  readonly lines: readonly TileLine[];
  /** Something needs a look ("2 approvals held"); null when nothing does or the count is unknown. */
  readonly attention: string | null;
  /** Why the tile has no numbers ("403 AGENT_KEY_FORBIDDEN"), when it failed. */
  readonly error: string | null;
}

/** A count the page read, or "–" when it did not. */
export function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "–";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function stateOf(source: TileSource<unknown>): GlanceTile["state"] {
  if (source.status === "success" && source.data !== undefined) return "ready";
  if (source.status === "error") return "error";
  return "loading";
}

function errorText(source: TileSource<unknown>): string | null {
  if (source.status !== "error") return null;
  const error = source.error;
  if (!error) return "Could not read this.";
  if (error.status === 0) return "The API did not answer.";
  return `${error.status} ${error.code}`;
}

/** Fields of GET /v1/keys this page reads. */
export interface KeyRow {
  readonly revokedAt: string | null;
  readonly kind?: string;
  readonly current?: boolean;
  readonly policyVersion?: number | null;
  readonly lane?: "testnet" | "production" | "any";
}

export function keysTile(source: TileSource<readonly KeyRow[]>): GlanceTile {
  const base = { id: "keys" as const, title: "Keys", href: "/developers/keys", action: "Manage keys" };
  const rows = source.status === "success" ? source.data : undefined;
  const active = rows?.filter((row) => !row.revokedAt);
  const agents = active?.filter((row) => row.kind === "agent").length;
  const project = active?.filter((row) => row.kind !== "agent" && row.kind !== "publishable").length;
  return {
    ...base,
    state: stateOf(source),
    lines: [
      { value: count(project), label: "project keys" },
      { value: count(agents), label: "agent keys" },
    ],
    attention: null,
    error: errorText(source),
  };
}

/** Fields of GET /v1/usage?window=7d this page reads. */
export interface UsageRow {
  readonly intents?: { readonly created: number; readonly byStatus: Readonly<Record<string, number>> };
}

const FAILED_STATUSES = ["failed", "partially_failed"];

export function intentsTile(source: TileSource<UsageRow>): GlanceTile {
  const base = { id: "intents" as const, title: "Intents, 7 days", href: "/developers/keys", action: "Usage" };
  const intents = source.status === "success" ? source.data?.intents : undefined;
  const failed = intents ? FAILED_STATUSES.reduce((total, status) => total + (intents.byStatus?.[status] ?? 0), 0) : undefined;
  return {
    ...base,
    state: stateOf(source),
    lines: [
      { value: count(intents?.created), label: "created" },
      { value: count(failed), label: "failed" },
    ],
    attention: failed ? `${plural(failed, "intent", "intents")} failed` : null,
    error: errorText(source),
  };
}

/** Webhook deliveries are read for at most this many endpoints. */
export const DELIVERY_ENDPOINTS = 3;

export interface DeliveryRow {
  readonly status: string;
}

export function webhooksTile(
  source: TileSource<readonly { readonly id: string }[]>,
  deliveries: Readonly<Record<string, TileSource<readonly DeliveryRow[]>>>,
): GlanceTile {
  const base = { id: "webhooks" as const, title: "Webhooks", href: "/developers/webhooks", action: "Deliveries" };
  const hooks = source.status === "success" ? source.data : undefined;
  const checked = hooks?.slice(0, DELIVERY_ENDPOINTS) ?? [];
  const reads = checked.map((hook) => deliveries[hook.id]);
  const allRead = hooks !== undefined && reads.every((read) => read?.status === "success" && read.data !== undefined);
  const failing = reads.reduce(
    (total, read) => total + (read?.status === "success" ? (read.data ?? []).filter((row) => row.status === "failed" || row.status === "dropped").length : 0),
    0,
  );
  return {
    ...base,
    state: stateOf(source),
    lines: [
      { value: count(hooks?.length), label: hooks?.length === 1 ? "endpoint" : "endpoints" },
      // Failures seen are reported even when another endpoint's log could not be read; a clean count needs every log.
      { value: allRead || failing > 0 ? count(failing) : "–", label: "failed deliveries" },
    ],
    attention: failing > 0 ? `${plural(failing, "delivery", "deliveries")} failed` : null,
    error: errorText(source),
  };
}

export interface StatusRow {
  readonly status?: string;
}

export function contractsTile(source: TileSource<readonly StatusRow[]>): GlanceTile {
  const base = { id: "contracts" as const, title: "Contracts", href: "/developers/contracts", action: "Open contracts" };
  const rows = source.status === "success" ? source.data : undefined;
  const active = rows?.filter((row) => row.status === "active").length;
  const pending = rows?.filter((row) => row.status === "pending").length;
  const suspended = rows?.filter((row) => row.status === "suspended").length ?? 0;
  const attention = suspended > 0 ? `${suspended} suspended` : pending ? `${pending} waiting to activate` : null;
  return {
    ...base,
    state: stateOf(source),
    lines: [
      { value: count(active), label: "active" },
      { value: count(pending), label: "pending" },
    ],
    attention,
    error: errorText(source),
  };
}

export function linksTile(source: TileSource<readonly StatusRow[]>): GlanceTile {
  const base = { id: "links" as const, title: "Links", href: "/developers/links", action: "Open links" };
  const rows = source.status === "success" ? source.data?.filter((row) => row.status !== "deleted") : undefined;
  const paused = rows?.filter((row) => row.status === "paused").length;
  const suspended = rows?.filter((row) => row.status === "suspended").length ?? 0;
  return {
    ...base,
    state: stateOf(source),
    lines: [
      { value: count(rows?.length), label: rows?.length === 1 ? "link" : "links" },
      { value: count(paused), label: "paused" },
    ],
    attention: suspended > 0 ? `${suspended} suspended` : null,
    error: errorText(source),
  };
}

export function ruleBookTile(keys: TileSource<readonly KeyRow[]>, approvals: TileSource<readonly StatusRow[]>): GlanceTile {
  const base = { id: "rule-book" as const, title: "Rule Book", href: "/developers/rule-book", action: "Decisions" };
  const current = keys.status === "success" ? keys.data?.find((row) => row.current) : undefined;
  const edition = current ? (current.policyVersion ?? null) : undefined;
  const held = approvals.status === "success" ? approvals.data?.filter((row) => row.status === "pending").length : undefined;
  // The tile stands when either read worked; it fails only when both did.
  const state: GlanceTile["state"] =
    stateOf(keys) === "ready" || stateOf(approvals) === "ready" ? "ready" : keys.status === "error" && approvals.status === "error" ? "error" : "loading";
  return {
    ...base,
    state,
    lines: [
      { value: edition === undefined ? "–" : edition === null ? "none" : `v${edition}`, label: "this key's rule book" },
      { value: count(held), label: "held for approval" },
    ],
    attention: held ? `${plural(held, "approval", "approvals")} waiting` : null,
    error: state === "error" ? errorText(approvals) : null,
  };
}

export interface GlanceSources {
  readonly keys: TileSource<readonly KeyRow[]>;
  readonly usage: TileSource<UsageRow>;
  readonly webhooks: TileSource<readonly { readonly id: string }[]>;
  readonly deliveries: Readonly<Record<string, TileSource<readonly DeliveryRow[]>>>;
  readonly contracts: TileSource<readonly StatusRow[]>;
  readonly links: TileSource<readonly StatusRow[]>;
  readonly approvals: TileSource<readonly StatusRow[]>;
}

/** The six tiles, in the order the Overview shows them. */
export function projectGlance(sources: GlanceSources): readonly GlanceTile[] {
  return [
    keysTile(sources.keys),
    intentsTile(sources.usage),
    webhooksTile(sources.webhooks, sources.deliveries),
    contractsTile(sources.contracts),
    linksTile(sources.links),
    ruleBookTile(sources.keys, sources.approvals),
  ];
}

/** The key in this tab's lane, when GET /v1/keys says it (sandbox keys run the first call on the public tier). */
export function currentKeyLane(keys: TileSource<readonly KeyRow[]>): "testnet" | "production" | "any" | null {
  if (keys.status !== "success") return null;
  return keys.data?.find((row) => row.current)?.lane ?? null;
}
