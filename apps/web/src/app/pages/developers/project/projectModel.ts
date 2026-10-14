/**
 * The Project page's pure parts: the edit draft and the JSON merge patch it
 * sends, inline origin checks, the domain proof state, the diff shown after
 * a stale If-Match, network chips by lane, the publishable-key warnings (a
 * key's rule book refusing a network the widget offers), flows built from a
 * registration, the test session a flow opens in the portal, and the logo
 * pre-check.
 *
 * The API stays the authority on every rule mirrored here: it validates the
 * merged settings again, dry-runs flows and reads the logo header itself.
 * Only `@kletia/core` and the status table are imported, so the node tests
 * load this file directly.
 */
import {
  CHAINS,
  flowNetworks,
  isNetworkKey,
  mergeProjectPatch,
  NETWORK_KEYS,
  normalizeProjectOrigin,
  PROJECT_ACTIONS,
  PROJECT_DOMAIN_FILE,
  PROJECT_LIMITS,
  PROJECT_SCHEMA,
  validateAppearance,
  validateProjectSettings,
  type NetworkKey,
  type ProjectAction,
  type ProjectFlow,
  type ProjectLane,
  type ProjectSettingsInput,
  type ProjectView,
  type SessionCreateRequest,
} from "@kletia/core";

import { toneFor, verificationTone, type StatusEntry } from "../../../site/ui/statusTones.ts";

export type ProjectSettings = ProjectView["settings"];
export type StoredFlow = NonNullable<ProjectSettings["flows"]>[number];

/** A stored flow without the server-set saver (what a PATCH sends back). */
export function flowContent(flow: StoredFlow | ProjectFlow): ProjectFlow {
  const copy: Record<string, unknown> = { ...flow };
  delete copy.ownerKeyId;
  return copy as unknown as ProjectFlow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key-sorted JSON, so two documents compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The RFC 7386 merge patch that turns `before` into `after`: changed or new
 * members are sent, removed members are sent as `null`, objects recurse and
 * arrays replace. An empty object means "nothing changed".
 */
export function mergeDiff(before: unknown, after: unknown): Record<string, unknown> {
  const from = isRecord(before) ? before : {};
  const to = isRecord(after) ? after : {};
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(from)) {
    if (from[key] !== undefined && to[key] === undefined) patch[key] = null;
  }
  for (const [key, value] of Object.entries(to)) {
    if (value === undefined) continue;
    const previous = from[key];
    if (stableJson(previous) === stableJson(value)) continue;
    if (isRecord(value) && isRecord(previous)) {
      const nested = mergeDiff(previous, value);
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else patch[key] = value;
  }
  return patch;
}

/* ================================================================ draft */

/** What the Brand, Allowed origins and Defaults sections edit (flows and the logo save on their own). */
export interface ProjectDraft {
  readonly brandName: string;
  readonly website: string;
  readonly origins: readonly string[];
  /** "" leaves the lane unset (the widget offers both lanes). */
  readonly lane: "" | ProjectLane;
  readonly networks: readonly NetworkKey[];
  /** "" (not set), "auto" or one of `networks`. */
  readonly sourceNetwork: string;
  readonly actions: readonly ProjectAction[];
  /** One example per line. */
  readonly examples: string;
  /** Appearance tokens as JSON text ("" for none). */
  readonly appearance: string;
}

export type DraftField = keyof ProjectDraft;

export function draftFromSettings(settings: ProjectSettings | null | undefined): ProjectDraft {
  const defaults = settings?.defaults ?? {};
  return {
    brandName: settings?.brand?.name ?? "",
    website: settings?.brand?.website ?? "",
    origins: [...(settings?.allowedOrigins ?? [])],
    lane: defaults.lane ?? "",
    networks: [...(defaults.networks ?? [])],
    sourceNetwork: defaults.sourceNetwork ?? "",
    actions: [...(defaults.actions ?? [])],
    examples: (defaults.examples ?? []).join("\n"),
    appearance: defaults.appearance ? JSON.stringify(defaults.appearance, null, 2) : "",
  };
}

export interface DraftIssue {
  readonly field: DraftField | "flows" | "form";
  /** The API's path (`allowedOrigins[1]`), for the issue list. */
  readonly path: string;
  readonly message: string;
}

/** Which draft field an API issue path belongs to (unknown paths go to the form). */
export function fieldOfPath(path: string): DraftIssue["field"] {
  if (path.startsWith("brand.website")) return "website";
  if (path.startsWith("brand")) return "brandName";
  if (path.startsWith("allowedOrigins")) return "origins";
  if (path.startsWith("defaults.lane")) return "lane";
  if (path.startsWith("defaults.networks")) return "networks";
  if (path.startsWith("defaults.sourceNetwork")) return "sourceNetwork";
  if (path.startsWith("defaults.actions")) return "actions";
  if (path.startsWith("defaults.examples")) return "examples";
  if (path.startsWith("defaults.appearance") || path.startsWith("defaults.light") || path.startsWith("defaults.dark") || /^defaults\.(colorScheme|radius|border|shadow|font|density|header)/u.test(path)) {
    return "appearance";
  }
  if (path.startsWith("flows")) return "flows";
  return "form";
}

export type DraftResult =
  | { readonly ok: true; readonly patch: Record<string, unknown>; readonly next: ProjectSettingsInput }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

/**
 * The draft as settings (flows kept as stored), and the merge patch from the
 * stored settings to it. Checked with the same validator the API runs; the
 * patch is empty when nothing changed.
 */
export function draftPatch(base: ProjectSettings | null | undefined, draft: ProjectDraft): DraftResult {
  const issues: DraftIssue[] = [];
  let appearance: unknown;
  if (draft.appearance.trim()) {
    try {
      appearance = JSON.parse(draft.appearance);
    } catch {
      issues.push({ field: "appearance", path: "defaults.appearance", message: "Not valid JSON. Paste the appearance object, for example { \"light\": { \"accent\": \"#0E7C66\" } }." });
    }
  }
  const examples = draft.examples
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const name = draft.brandName.trim();
  const website = draft.website.trim();
  if (!name && website) issues.push({ field: "brandName", path: "brand.name", message: "Name the brand to prove a website for it." });
  if (issues.length > 0) return { ok: false, issues };

  const defaults: Record<string, unknown> = {
    ...(draft.lane ? { lane: draft.lane } : {}),
    ...(draft.networks.length > 0 ? { networks: [...draft.networks] } : {}),
    ...(draft.sourceNetwork ? { sourceNetwork: draft.sourceNetwork } : {}),
    ...(draft.actions.length > 0 ? { actions: [...draft.actions] } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    ...(appearance !== undefined ? { appearance } : {}),
  };
  const stored: Record<string, unknown> = { ...(base ?? { schema: PROJECT_SCHEMA }) };
  delete stored.flows;
  const next: Record<string, unknown> = {
    schema: PROJECT_SCHEMA,
    ...(name ? { brand: { name, ...(website ? { website } : {}) } } : {}),
    ...(draft.origins.length > 0 ? { allowedOrigins: [...draft.origins] } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
  };
  const patch = mergeDiff(stored, next);
  const merged = mergeProjectPatch(base && Object.keys(base).length > 0 ? (base as ProjectSettingsInput) : null, patch);
  if (!merged.ok) return { ok: false, issues: merged.issues.map((issue) => ({ field: fieldOfPath(issue.path), path: issue.path, message: issue.message })) };
  return { ok: true, patch, next: merged.value };
}

/** Draft fields that differ from the stored settings (the save bar's count). */
export function changedFields(base: ProjectSettings | null | undefined, draft: ProjectDraft): DraftField[] {
  const stored = draftFromSettings(base);
  return (Object.keys(stored) as DraftField[]).filter((field) => stableJson(stored[field]) !== stableJson(draft[field]));
}

/**
 * After a stale If-Match: the edits move onto the newer version. Fields the
 * reader changed (against the version they started from) keep the reader's
 * value; every other field takes the newer version's, so someone else's
 * change is never overwritten by a field the reader did not touch.
 */
export function rebaseDraft(from: ProjectSettings | null | undefined, latest: ProjectSettings | null | undefined, draft: ProjectDraft): ProjectDraft {
  const mine = new Set(changedFields(from, draft));
  const theirs = draftFromSettings(latest);
  const out: Record<string, unknown> = {};
  for (const field of Object.keys(theirs) as DraftField[]) out[field] = mine.has(field) ? draft[field] : theirs[field];
  return out as unknown as ProjectDraft;
}

/* ============================================================== origins */

export type OriginCheck = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly message: string };

/** An origin typed into "Add origin": normalised, not a duplicate, within the limit. */
export function checkOrigin(input: string, list: readonly string[]): OriginCheck {
  const value = input.trim().replace(/\/+$/u, "");
  if (!value) return { ok: false, message: "Type an origin such as https://acme.example." };
  if (list.length >= PROJECT_LIMITS.allowedOrigins) return { ok: false, message: `A project allows at most ${PROJECT_LIMITS.allowedOrigins} origins.` };
  if (/^https?:\/\/[^/]+\/./u.test(value)) return { ok: false, message: "An origin has no path: keep only the scheme, host and port (https://acme.example)." };
  if (/^http:\/\//u.test(value) && !/^http:\/\/localhost(?::\d{1,5})?$/u.test(value)) {
    return { ok: false, message: "Use https. Plain http is allowed only for http://localhost:<port> during development." };
  }
  const origin = normalizeProjectOrigin(value);
  if (!origin) return { ok: false, message: "Must be an https origin with a public host name (https://acme.example), or http://localhost:<port>." };
  if (list.includes(origin)) return { ok: false, message: `${origin} is already allowed.` };
  return { ok: true, origin };
}

/* =============================================================== domain */

export type DomainState = "none" | "unchecked" | "verified" | "failed";

export interface DomainStatus {
  readonly state: DomainState;
  readonly status: StatusEntry;
  /** `https://acme.example/.well-known/kletia.json`, or null without a website. */
  readonly fileUrl: string | null;
  /** The JSON to publish there. */
  readonly file: string;
  /** One sentence: what the state means and what to do. */
  readonly message: string;
}

/**
 * The domain proof of the stored settings. Unverified is a warning, never
 * danger; a failed check says what Kletia looked for.
 */
export function domainStatus(view: Pick<ProjectView, "domain" | "id"> & { readonly settings: Pick<ProjectSettings, "brand"> }, checkedLabel: (iso: string) => string = (iso) => iso): DomainStatus {
  const website = view.settings.brand?.website ?? null;
  const host = view.domain.host ?? (website ? new URL(website).host : null);
  const fileUrl = host ? `https://${host}${PROJECT_DOMAIN_FILE}` : null;
  const file = view.domain.file;
  if (!website || !fileUrl) {
    return {
      state: "none",
      status: { tone: "neutral", glyph: "ring", label: "No website" },
      fileUrl: null,
      file,
      message: "Add your website to the brand, save, then publish the domain file there. The brand name, header and logo show in the widget only after the domain is verified.",
    };
  }
  if (view.domain.verified) {
    return {
      state: "verified",
      status: toneFor("contract-domain", "verified"),
      fileUrl,
      file,
      message: `${fileUrl} lists ${view.id}${view.domain.checkedAt ? ` (checked ${checkedLabel(view.domain.checkedAt)})` : ""}. Kletia re-checks it daily: keep the file published.`,
    };
  }
  if (!view.domain.checkedAt) {
    return {
      state: "unchecked",
      status: toneFor("contract-domain", "unknown"),
      fileUrl,
      file,
      message: `Publish the file below at ${fileUrl}, then Check now.`,
    };
  }
  return {
    state: "failed",
    status: verificationTone(false),
    fileUrl,
    file,
    message: `The check at ${checkedLabel(view.domain.checkedAt)} did not find ${view.id} in ${fileUrl}. Kletia fetches it over https without redirects (at most 16 KB, public hosts only) and needs "projects" to list this id.`,
  };
}

/* ================================================================= diff */

export interface SettingsChange {
  /** `brand.name`, `allowedOrigins`, `defaults.networks`, `flows.deposit`. */
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

function shown(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.length > 0 ? value.join(", ") : "(none)";
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function leaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isRecord(value) && !(prefix === "defaults.appearance")) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined || key === "schema") continue;
      leaves(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.set(prefix, value);
}

/**
 * What changed between two versions of the settings, field by field (flows
 * by id, without who saved them): shown after a stale If-Match so the change
 * is reapplied knowingly.
 */
export function settingsDiff(before: ProjectSettings | null | undefined, after: ProjectSettings | null | undefined): SettingsChange[] {
  const flat = (settings: ProjectSettings | null | undefined) => {
    const out = new Map<string, unknown>();
    const rest: Record<string, unknown> = { ...(settings ?? { schema: PROJECT_SCHEMA }) };
    delete rest.flows;
    leaves(rest, "", out);
    for (const flow of settings?.flows ?? []) out.set(`flows.${flow.id}`, flowContent(flow));
    return out;
  };
  const a = flat(before);
  const b = flat(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths
    .filter((path) => stableJson(a.get(path)) !== stableJson(b.get(path)))
    .map((path) => ({ path, before: shown(a.get(path)), after: shown(b.get(path)) }));
}

/* ============================================================= networks */

export interface NetworkChip {
  readonly key: NetworkKey;
  readonly name: string;
  readonly lane: ProjectLane;
}

/** The nine networks grouped by lane, mainnets first. */
export function networksByLane(): readonly { readonly lane: ProjectLane; readonly label: string; readonly networks: readonly NetworkChip[] }[] {
  const chips = NETWORK_KEYS.map((key) => ({ key, name: CHAINS[key].name, lane: CHAINS[key].lane as ProjectLane }));
  return [
    { lane: "production", label: "Mainnets", networks: chips.filter((chip) => chip.lane === "production") },
    { lane: "testnet", label: "Testnets", networks: chips.filter((chip) => chip.lane === "testnet") },
  ];
}

/** Picking a lane keeps only its networks (and the start network when it stays offered). */
export function withLane(draft: ProjectDraft, lane: ProjectDraft["lane"]): ProjectDraft {
  if (!lane) return { ...draft, lane };
  const networks = draft.networks.filter((network) => CHAINS[network].lane === lane);
  const source = draft.sourceNetwork === "auto" || (isNetworkKey(draft.sourceNetwork) && networks.includes(draft.sourceNetwork)) ? draft.sourceNetwork : "";
  return { ...draft, lane, networks, sourceNetwork: source };
}

/** Toggling a network chip; removing the start network resets "Start on". */
export function toggleNetwork(draft: ProjectDraft, network: NetworkKey): ProjectDraft {
  const on = draft.networks.includes(network);
  const networks = on ? draft.networks.filter((item) => item !== network) : NETWORK_KEYS.filter((key) => key === network || draft.networks.includes(key));
  return { ...draft, networks, sourceNetwork: on && draft.sourceNetwork === network ? "" : draft.sourceNetwork };
}

export function toggleAction(draft: ProjectDraft, action: ProjectAction): ProjectDraft {
  const actions = draft.actions.includes(action) ? draft.actions.filter((item) => item !== action) : PROJECT_ACTIONS.filter((item) => item === action || draft.actions.includes(item));
  return { ...draft, actions };
}

/** Networks the widget offers with these settings: the default networks, or every network of the lane (all nine without one). */
export function offeredNetworks(settings: ProjectSettings | null | undefined): NetworkKey[] {
  const defaults = settings?.defaults;
  if (defaults?.networks && defaults.networks.length > 0) return [...defaults.networks];
  return NETWORK_KEYS.filter((key) => !defaults?.lane || CHAINS[key].lane === defaults.lane);
}

/** A rule book level as `effective.levels[].document` carries it (only the network rules matter here). */
export interface NetworkRules {
  readonly networks?: { readonly allow?: readonly string[]; readonly lanes?: readonly string[] } | null;
}

/** Why a chain of rule books refuses a network, or null when every level lets it through. */
export function networkRefusal(network: NetworkKey, levels: readonly (NetworkRules | null | undefined)[]): string | null {
  for (const level of levels) {
    const rules = level?.networks;
    if (!rules) continue;
    if (rules.allow && !rules.allow.includes(network)) return "networks.allow";
    if (rules.lanes && !rules.lanes.includes(CHAINS[network].lane)) return "networks.lanes";
  }
  return null;
}

/**
 * Warnings for one publishable key: each network the widget offers (or a
 * stored flow runs on) that the key's rule book chain refuses. The API
 * refuses those intents with POLICY_VIOLATION; the page says so first.
 */
export function publishableWarnings(settings: ProjectSettings | null | undefined, levels: readonly (NetworkRules | null | undefined)[]): string[] {
  const warnings: string[] = [];
  for (const network of offeredNetworks(settings)) {
    const rule = networkRefusal(network, levels);
    if (rule) warnings.push(`The widget offers ${CHAINS[network].name} but this key's rule book refuses it (${rule}).`);
  }
  for (const flow of settings?.flows ?? []) {
    for (const network of flowNetworks(flow)) {
      const rule = networkRefusal(network, levels);
      if (rule) warnings.push(`Flow ${flow.id} runs on ${CHAINS[network].name}, which this key's rule book refuses (${rule}).`);
    }
  }
  return warnings;
}

/* ================================================================ flows */

/** A registration as the flow editor offers it (from `GET /v1/contracts`). */
export interface FlowSource {
  readonly id: string;
  readonly vm: "evm" | "svm";
  readonly network: NetworkKey;
  readonly status: string;
  readonly integrator: { readonly name: string };
  readonly actions: readonly { readonly id: string; readonly label: string }[];
}

export interface FlowDraft {
  readonly id: string;
  readonly label: string;
  readonly contract: string;
  readonly entry: string;
  /** The amount (the default one when the visitor chooses). */
  readonly amount: string;
  readonly visitorAmount: boolean;
  readonly min: string;
  readonly max: string;
}

export type FlowField = keyof FlowDraft;

export const EMPTY_FLOW_DRAFT: FlowDraft = Object.freeze({ id: "", label: "", contract: "", entry: "", amount: "", visitorAmount: false, min: "", max: "" });

/** Registrations a flow can use: active or pending (pending ones activate before any visitor runs them; the API dry-runs either). */
export function flowSources<T extends FlowSource>(contracts: readonly T[]): T[] {
  return contracts.filter((contract) => (contract.status === "active" || contract.status === "pending") && contract.actions.length > 0);
}

/** A flow id from an entry id: `supply`, then `supply-2` when taken. */
export function suggestFlowId(entry: string, taken: readonly string[]): string {
  const base =
    entry
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^[^a-z]+/u, "")
      .replace(/-+$/u, "")
      .slice(0, 28) || "flow";
  if (!taken.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) if (!taken.includes(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-x`;
}

export function flowFieldOfPath(path: string): FlowField | "form" {
  const local = path.replace(/^flows\[\d+\]\.?/u, "");
  if (local.startsWith("id")) return "id";
  if (local.startsWith("label")) return "label";
  if (/^actions\[0\]\.amount/u.test(local)) return "amount";
  if (local.startsWith("actions[0].contract")) return "contract";
  if (local.startsWith("actions[0].entry")) return "entry";
  if (local.startsWith("amount.min")) return "min";
  if (local.startsWith("amount.max")) return "max";
  return "form";
}

export type FlowBuild =
  | { readonly ok: true; readonly flow: ProjectFlow }
  | { readonly ok: false; readonly issues: readonly { readonly field: FlowField | "form"; readonly message: string }[] };

/**
 * A one-step flow calling a registration's entry, checked like the API's
 * session template (structured actions, amount bounds). `editing` is the id
 * of the flow being replaced, which may keep its id.
 */
export function buildFlow(draft: FlowDraft, source: FlowSource | null, existing: readonly Pick<ProjectFlow, "id">[], editing: string | null = null): FlowBuild {
  const issues: { field: FlowField | "form"; message: string }[] = [];
  if (!source) issues.push({ field: "contract", message: "Pick a registration." });
  else if (!source.actions.some((action) => action.id === draft.entry)) issues.push({ field: "entry", message: "Pick one of the registration's entries." });
  const id = draft.id.trim();
  if (id !== editing && existing.some((flow) => flow.id === id)) issues.push({ field: "id", message: `A flow named ${id} exists. Pick another id.` });
  if (!editing && existing.length >= PROJECT_LIMITS.flows) issues.push({ field: "form", message: `A project stores at most ${PROJECT_LIMITS.flows} flows.` });
  if (issues.length > 0 || !source) return { ok: false, issues };
  const amount = draft.amount.trim();
  const flow: ProjectFlow = {
    id,
    label: draft.label.trim(),
    actions: [{ kind: source.vm === "svm" ? "action" : "call", network: source.network, contract: source.id, entry: draft.entry, ...(amount ? { amount } : {}) }],
    ...(draft.visitorAmount ? { amount: { action: 0, min: draft.min.trim(), max: draft.max.trim() } } : {}),
  };
  const checked = validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [flow] });
  if (!checked.ok) {
    return { ok: false, issues: checked.issues.map((issue) => ({ field: flowFieldOfPath(issue.path), message: issue.message })) };
  }
  return { ok: true, flow: checked.value.flows?.[0] ?? flow };
}

/** The editor's fields for a stored one-step contract flow (null when the flow is not one: it is shown, not edited here). */
export function flowDraftOf(flow: ProjectFlow): FlowDraft | null {
  const action = flow.actions[0];
  if (flow.actions.length !== 1 || !action || (action.kind !== "call" && action.kind !== "action") || !action.contract || !action.entry) return null;
  return {
    id: flow.id,
    label: flow.label,
    contract: action.contract,
    entry: action.entry,
    amount: action.amount ?? "",
    visitorAmount: Boolean(flow.amount),
    min: flow.amount?.min ?? "",
    max: flow.amount?.max ?? "",
  };
}

/** `Arbitrum Sepolia · ct_10a2… supply · 1-100` for a flow's row. */
export function flowSummary(flow: ProjectFlow): string {
  const parts = flowNetworks(flow).map((network) => CHAINS[network].name);
  const steps = flow.actions.map((action) => {
    if (action.contract) return `${action.contract.length > 12 ? `${action.contract.slice(0, 9)}…` : action.contract} ${action.entry ?? ""}`.trim();
    return [action.kind, action.amount, action.from, action.to ? `to ${action.to}` : null].filter(Boolean).join(" ");
  });
  const amount = flow.amount ? `visitor picks ${flow.amount.min}-${flow.amount.max}` : flow.actions[0]?.amount ? `amount ${flow.actions[0].amount}` : null;
  return [parts.join(", "), steps.join(" then "), amount].filter(Boolean).join(" · ");
}

/** The flows list with one flow replaced (or added at the end), without who saved them (the API keeps or sets that). */
export function flowsWith(flows: readonly StoredFlow[] | undefined, flow: ProjectFlow, replacing: string | null): ProjectFlow[] {
  const list = (flows ?? []).map(flowContent);
  const index = replacing ? list.findIndex((item) => item.id === replacing) : -1;
  if (index >= 0) list[index] = flow;
  else list.push(flow);
  return list;
}

export function flowsWithout(flows: readonly StoredFlow[] | undefined, id: string): ProjectFlow[] {
  return (flows ?? []).filter((flow) => flow.id !== id).map(flowContent);
}

/**
 * The single-use session "Test" opens in the portal: the flow's template,
 * owned by the developer key in this tab, for this page's origin only, 10
 * minutes, one intent. Nothing is signed unless the tester approves it in a
 * wallet.
 */
export function testSessionRequest(flow: ProjectFlow, pageOrigin: string): SessionCreateRequest {
  return {
    actions: flow.actions,
    ...(flow.amount ? { amount: flow.amount } : {}),
    ...(flow.constraints ? { constraints: flow.constraints } : {}),
    allowedOrigins: [pageOrigin],
    expiresInSeconds: PROJECT_LIMITS.flowSessionTtlSeconds,
    maxIntents: 1,
    metadata: { flow: flow.id, purpose: "portal-test" },
  };
}

/* ======================================================== appearance */

/** Appearance JSON text: null when valid (or empty), else the first problem. */
export function appearanceIssue(text: string): string | null {
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "Not valid JSON.";
  }
  const result = validateAppearance(value);
  return result.ok ? null : (result.issues[0] ? `${result.issues[0].path}: ${result.issues[0].message}` : "Not valid appearance tokens.");
}

/* ================================================================= logo */

export type LogoCheck =
  | { readonly ok: true; readonly contentType: "image/png" | "image/webp"; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly message: string };

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const u32le = (bytes: Uint8Array, at: number) => ((bytes[at + 3]! << 24) >>> 0) + (bytes[at + 2]! << 16) + (bytes[at + 1]! << 8) + bytes[at]!;
const u24le = (bytes: Uint8Array, at: number) => (bytes[at + 2]! << 16) + (bytes[at + 1]! << 8) + bytes[at]!;
const u16le = (bytes: Uint8Array, at: number) => (bytes[at + 1]! << 8) + bytes[at]!;

function pngSize(bytes: Uint8Array): { width: number; height: number } | string {
  if (bytes.length < 33 || ascii(bytes, 1, 4) !== "PNG" || bytes[0] !== 0x89) return "The file is not a PNG image.";
  if (ascii(bytes, 12, 16) !== "IHDR") return "The PNG does not start with its IHDR header.";
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return "Animated PNG (APNG) logos are not accepted.";
    if (type === "IEND") return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    offset += 12 + u32be(bytes, offset);
  }
  return "The PNG is truncated (no IEND chunk).";
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | string {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return "The file is not a WebP image.";
  let offset = 12;
  const chunks: { type: string; start: number }[] = [];
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, offset + 4);
    const length = u32le(bytes, offset + 4);
    chunks.push({ type, start: offset + 8 });
    offset += 8 + length + (length % 2);
  }
  if (chunks.some((chunk) => chunk.type === "ANIM" || chunk.type === "ANMF")) return "Animated WebP logos are not accepted.";
  const first = chunks[0];
  if (!first || first.start + 10 > bytes.length) return "The WebP has no image chunk.";
  const at = first.start;
  if (first.type === "VP8X") return (bytes[at]! & 0x02) !== 0 ? "Animated WebP logos are not accepted." : { width: u24le(bytes, at + 4) + 1, height: u24le(bytes, at + 7) + 1 };
  if (first.type === "VP8 ") return { width: u16le(bytes, at + 6) & 0x3fff, height: u16le(bytes, at + 8) & 0x3fff };
  if (first.type === "VP8L") {
    const bits = u32le(bytes, at + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return "The WebP has no VP8, VP8L or VP8X image chunk first.";
}

/**
 * The logo rules before upload (the API checks the same header again): PNG
 * or WebP by their bytes, at most 64 KB, 32-512 px per side, width 1 to 4
 * times the height, no animation. SVG, GIF and anything else are refused.
 */
export function checkLogoBytes(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, message: "The file is empty." };
  if (bytes.length > PROJECT_LIMITS.logoBytes) return { ok: false, message: `The file is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${PROJECT_LIMITS.logoBytes / 1024} KB.` };
  const png = bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG";
  const webp = ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
  if (!png && !webp) return { ok: false, message: "Upload a PNG or WebP image. SVG, GIF, JPEG and other formats are not accepted." };
  const size = png ? pngSize(bytes) : webpSize(bytes);
  if (typeof size === "string") return { ok: false, message: size };
  const { logoMinPx: min, logoMaxPx: max, logoMaxAspect: aspect } = PROJECT_LIMITS;
  if (size.width < min || size.height < min || size.width > max || size.height > max) {
    return { ok: false, message: `The logo is ${size.width}x${size.height} px; each side must be ${min}-${max} px.` };
  }
  if (size.width < size.height || size.width > size.height * aspect) {
    return { ok: false, message: `The logo is ${size.width}x${size.height} px; the width must be 1 to ${aspect} times the height.` };
  }
  return { ok: true, contentType: png ? "image/png" : "image/webp", ...size };
}
