/**
 * Projects, publishable keys and flows: the `kletia.project/v1` settings
 * shape, what the API returns for a project and what a publishable key
 * reveals to a browser, with the validators the API, the SDK and the
 * portal share: `validateProjectSettings`, `mergeProjectPatch` (JSON merge
 * patch, `null` removes), the canonical `projectSettingsHash` (the
 * If-Match value) and the domain proof file.
 */
import { CHAINS, isNetworkKey, type NetworkKey } from "./chains.js";
import { canonicalJson, hostMatches, normalizeWebOrigin, reservedIntegratorName, type SessionAmountBounds } from "./contracts.js";
import { bytesToHex, sha256 } from "./hash.js";
import type { IntentActionSpec, IntentConstraints, SourceNetwork } from "./intent.js";
import { validateAppearance, type KletiaAppearance } from "./appearance.js";
import { validateSessionCreateRequest, type ValidationIssue, type ValidationResult } from "./validation.js";

export const PROJECT_SCHEMA = "kletia.project/v1";

/** Publishable keys: `kl_pub_` + 32 base62 (a third key kind beside `kl_dev_` and `kl_agt_`). */
export const PUBLISHABLE_KEY_PREFIX = "kl_pub_";
export const PUBLISHABLE_KEY_PATTERN = /^kl_pub_[0-9A-Za-z]{32}$/u;

/** Request header the `/embed` frame sends with the bridge-proven host origin. */
export const HOST_ORIGIN_HEADER = "Kletia-Host-Origin";

/** Where a project proves its website: `{ "projects": ["prj_…"] }`. */
export const PROJECT_DOMAIN_FILE = "/.well-known/kletia.json";

/** Stored flow ids. */
export const PROJECT_FLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export const PROJECT_ACTIONS = Object.freeze(["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] as const);
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export type ProjectLane = "production" | "testnet";

export const PROJECT_LIMITS = Object.freeze({
  allowedOrigins: 20,
  examples: 6,
  exampleLength: 120,
  flows: 20,
  flowLabel: 80,
  activePublishableKeys: 5,
  /** Requests per minute per publishable key (the public per-IP limit counts too). */
  publishableRatePerMinute: 120,
  /** A session minted from a flow. */
  flowSessionTtlSeconds: 600,
  flowSessionMaxIntents: 1,
  /** Domain proof file read by the guarded fetcher. */
  domainFileBytes: 16_384,
  logoBytes: 65_536,
  logoMinPx: 32,
  logoMaxPx: 512,
  /** Width / height between 1:1 and 4:1. */
  logoMaxAspect: 4,
});

/** Logo content types (PNG and WebP only: no SVG, no GIF, no animation). */
export const PROJECT_LOGO_TYPES = Object.freeze(["image/png", "image/webp"] as const);
export type ProjectLogoType = (typeof PROJECT_LOGO_TYPES)[number];

export interface ProjectDefaults {
  readonly lane?: ProjectLane;
  readonly networks?: readonly NetworkKey[];
  /** Where the money starts by default: a network or "auto" (console departure). */
  readonly sourceNetwork?: SourceNetwork;
  readonly actions?: readonly ProjectAction[];
  /** At most 6 examples of at most 120 characters. */
  readonly examples?: readonly string[];
  readonly appearance?: KletiaAppearance;
}

/** A stored session template: structured actions only, validated like POST /v1/sessions. */
export interface ProjectFlow {
  /** ^[a-z][a-z0-9-]{0,31}$ */
  readonly id: string;
  /** At most 80 characters. */
  readonly label: string;
  readonly actions: readonly IntentActionSpec[];
  readonly amount?: SessionAmountBounds;
  readonly constraints?: IntentConstraints;
}

export interface ProjectSettingsInput {
  readonly schema: typeof PROJECT_SCHEMA;
  /** Same name rules as integrator.name; website is an https origin. */
  readonly brand?: { readonly name: string; readonly website?: string };
  /** At most 20: https origins, http://localhost:<port> for development. */
  readonly allowedOrigins?: readonly string[];
  readonly defaults?: ProjectDefaults;
  /** At most 20 stored session templates. */
  readonly flows?: readonly ProjectFlow[];
  /** Model-assisted reading for this project's keys (opt-in per request too; default disabled). */
  readonly modelReading?: "disabled" | "enabled";
}

export interface ProjectDomain {
  readonly host: string | null;
  readonly verified: boolean;
  readonly checkedAt: string | null;
  /** The JSON to publish at PROJECT_DOMAIN_FILE. */
  readonly file: string;
}

/** The brand logo (PNG or WebP, header-checked, immutable URL per content hash). */
export interface ProjectLogoView {
  /** `/v1/projects/{projectId}/logo/{sha256}.{png|webp}` (served while the domain is verified). */
  readonly url: string;
  readonly sha256: string;
  readonly contentType: ProjectLogoType;
  readonly width: number;
  readonly height: number;
}

export interface ProjectView {
  readonly id: string;
  readonly version: number;
  /** sha256 of the canonical settings (the If-Match value). */
  readonly hash: string;
  readonly settings: Omit<ProjectSettingsInput, "flows"> & {
    readonly flows?: readonly (ProjectFlow & { readonly ownerKeyId: string })[];
  };
  readonly domain: ProjectDomain;
  /** The uploaded logo (shown in the frame header only while the domain is verified); null when none. */
  readonly logo?: ProjectLogoView | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** What a publishable key reveals (GET /v1/publishable/profile). */
export interface ProjectProfile {
  readonly projectId: string;
  readonly brand: {
    readonly name: string;
    readonly host: string | null;
    readonly verified: boolean;
    /** Only while the domain is verified (the frame header, next to the verified name). */
    readonly logo?: ProjectLogoView | null;
  } | null;
  readonly allowedOrigins: readonly string[];
  /** The default lane; `any` when the project sets none (both lanes), as key lists name it. */
  readonly lane: ProjectLane | "any";
  readonly defaults: Omit<ProjectDefaults, "lane">;
  readonly flows: readonly { readonly id: string; readonly label: string; readonly networks: readonly NetworkKey[] }[];
}

/* ============================================================ validators */

const SETTINGS_KEYS = ["schema", "brand", "allowedOrigins", "defaults", "flows", "modelReading"] as const;
const DEFAULTS_KEYS = ["lane", "networks", "sourceNetwork", "actions", "examples", "appearance"] as const;
/** `ownerKeyId` is what GET returns for a flow; it is accepted and ignored (the API sets it). */
const FLOW_KEYS = ["id", "label", "actions", "amount", "constraints", "ownerKeyId"] as const;
/** Origin used for the flow dry validation (flows take the project's allowed origins when they run). */
const FLOW_PLACEHOLDER_ORIGIN = "https://flow.kletia.example";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key.slice(0, 40)}` : key.slice(0, 40), message: "Unknown field." });
  }
}

/** Printable text: no control or format characters, trimmed, single spaces not required. */
function printable(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

/** An allowed origin: an https origin with a public host (any port), or http://localhost:<port> for development. */
export function normalizeProjectOrigin(value: unknown): string | null {
  if (typeof value === "string" && /^http:\/\/localhost(?::\d{1,5})?\/?$/u.test(value)) {
    return normalizeWebOrigin(value, { allowPort: true, allowLocalhost: true });
  }
  if (typeof value === "string" && value.startsWith("http:")) return null;
  return normalizeWebOrigin(value, { allowPort: true });
}

function validateBrand(value: unknown, issues: ValidationIssue[]): ProjectSettingsInput["brand"] {
  if (!isPlainRecord(value)) {
    issues.push({ path: "brand", message: "Must be { name, website? }." });
    return undefined;
  }
  unknownKeys(value, ["name", "website"], "brand", issues);
  const { name, website } = value;
  let ok = true;
  // The same name rules as a contract registration's integrator.name.
  if (typeof name !== "string" || name.length < 2 || name.length > 40 || !/^[A-Za-z0-9 .,&'()-]+$/u.test(name) || name !== name.trim() || /\s{2}/u.test(name) || !/[A-Za-z]/u.test(name)) {
    issues.push({ path: "brand.name", message: "Must be 2-40 characters of A-Z a-z 0-9 space . , & ' ( ) -, with a letter and single spaces." });
    ok = false;
  }
  let origin: string | null = null;
  if (website !== undefined) {
    // The default https port only: a proof served on another port proves nothing about the host's site.
    origin = normalizeWebOrigin(website);
    if (!origin) {
      issues.push({ path: "brand.website", message: "Must be an https origin with a public host name, no port and no path (e.g. https://acme.example)." });
      ok = false;
    }
  }
  if (typeof name === "string") {
    const reserved = reservedIntegratorName(name);
    if (reserved) {
      const host = origin ? new URL(origin).hostname : "";
      if (!host || !hostMatches(host, reserved.hosts)) {
        issues.push({ path: "brand.name", message: `"${reserved.word}" is a reserved name; only ${reserved.hosts.join(", ")} (with a verified domain) may use it.` });
        ok = false;
      }
    }
  }
  if (!ok || typeof name !== "string") return undefined;
  return { name, ...(origin ? { website: origin } : {}) };
}

function validateOrigins(value: unknown, issues: ValidationIssue[]): string[] | undefined {
  if (!Array.isArray(value) || value.length > PROJECT_LIMITS.allowedOrigins) {
    issues.push({ path: "allowedOrigins", message: `List at most ${PROJECT_LIMITS.allowedOrigins} origins (https, or http://localhost:<port> for development).` });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    const origin = normalizeProjectOrigin(entry);
    if (!origin) issues.push({ path: `allowedOrigins[${index}]`, message: "Must be an https origin such as https://acme.example (no path), or http://localhost:<port>." });
    else if (!out.includes(origin)) out.push(origin);
  });
  return out;
}

function validateDefaults(value: unknown, issues: ValidationIssue[]): ProjectDefaults | undefined {
  if (!isPlainRecord(value)) {
    issues.push({ path: "defaults", message: "Must be an object." });
    return undefined;
  }
  unknownKeys(value, DEFAULTS_KEYS, "defaults", issues);
  const out: { -readonly [K in keyof ProjectDefaults]: ProjectDefaults[K] } = {};
  const before = issues.length;
  if (value.lane !== undefined) {
    if (value.lane !== "production" && value.lane !== "testnet") issues.push({ path: "defaults.lane", message: "Must be production or testnet." });
    else out.lane = value.lane;
  }
  if (value.networks !== undefined) {
    if (!Array.isArray(value.networks) || value.networks.length === 0 || value.networks.length > Object.keys(CHAINS).length) {
      issues.push({ path: "defaults.networks", message: "List 1 or more network keys." });
    } else {
      const networks: NetworkKey[] = [];
      value.networks.forEach((network, index) => {
        if (!isNetworkKey(network)) issues.push({ path: `defaults.networks[${index}]`, message: "Unknown network key." });
        else if (out.lane && CHAINS[network].lane !== out.lane) issues.push({ path: `defaults.networks[${index}]`, message: `${CHAINS[network].name} is not on the ${out.lane} lane.` });
        else if (!networks.includes(network)) networks.push(network);
      });
      out.networks = networks;
    }
  }
  if (value.sourceNetwork !== undefined) {
    const source = value.sourceNetwork;
    if (source === "auto") out.sourceNetwork = "auto";
    else if (!isNetworkKey(source)) issues.push({ path: "defaults.sourceNetwork", message: "Must be a network key or auto." });
    else if (out.networks && !out.networks.includes(source)) issues.push({ path: "defaults.sourceNetwork", message: "Must be one of defaults.networks." });
    else if (out.lane && CHAINS[source].lane !== out.lane) issues.push({ path: "defaults.sourceNetwork", message: `${CHAINS[source].name} is not on the ${out.lane} lane.` });
    else out.sourceNetwork = source;
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length === 0) issues.push({ path: "defaults.actions", message: `List 1 or more of ${PROJECT_ACTIONS.join(", ")}.` });
    else {
      const actions: ProjectAction[] = [];
      value.actions.forEach((action, index) => {
        if (typeof action !== "string" || !(PROJECT_ACTIONS as readonly string[]).includes(action)) issues.push({ path: `defaults.actions[${index}]`, message: `Must be one of ${PROJECT_ACTIONS.join(", ")}.` });
        else if (!actions.includes(action as ProjectAction)) actions.push(action as ProjectAction);
      });
      out.actions = actions;
    }
  }
  if (value.examples !== undefined) {
    if (!Array.isArray(value.examples) || value.examples.length > PROJECT_LIMITS.examples) {
      issues.push({ path: "defaults.examples", message: `List at most ${PROJECT_LIMITS.examples} examples.` });
    } else {
      value.examples.forEach((example, index) => {
        if (!printable(example, PROJECT_LIMITS.exampleLength)) issues.push({ path: `defaults.examples[${index}]`, message: `Must be 1-${PROJECT_LIMITS.exampleLength} printable characters.` });
      });
      out.examples = value.examples.filter((example): example is string => printable(example, PROJECT_LIMITS.exampleLength));
    }
  }
  if (value.appearance !== undefined) {
    const appearance = validateAppearance(value.appearance);
    if (!appearance.ok) for (const issue of appearance.issues) issues.push({ path: `defaults.${issue.path}`, message: issue.message });
    else out.appearance = appearance.value;
  }
  return issues.length > before ? undefined : out;
}

/** The networks a flow touches (its actions' networks and destinations). */
export function flowNetworks(flow: Pick<ProjectFlow, "actions">): NetworkKey[] {
  return [...new Set(flow.actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])]))];
}

function validateFlows(value: unknown, issues: ValidationIssue[]): ProjectFlow[] | undefined {
  if (!Array.isArray(value) || value.length > PROJECT_LIMITS.flows) {
    issues.push({ path: "flows", message: `List at most ${PROJECT_LIMITS.flows} flows.` });
    return undefined;
  }
  const out: ProjectFlow[] = [];
  const ids = new Set<string>();
  const before = issues.length;
  value.forEach((flow, index) => {
    const path = `flows[${index}]`;
    if (!isPlainRecord(flow)) {
      issues.push({ path, message: "Must be { id, label, actions, amount?, constraints? }." });
      return;
    }
    unknownKeys(flow, FLOW_KEYS, path, issues);
    const local = issues.length;
    if (typeof flow.id !== "string" || !PROJECT_FLOW_ID_PATTERN.test(flow.id)) issues.push({ path: `${path}.id`, message: `Must match ${PROJECT_FLOW_ID_PATTERN.source}.` });
    else if (ids.has(flow.id)) issues.push({ path: `${path}.id`, message: "Flow ids are unique." });
    else ids.add(flow.id);
    if (!printable(flow.label, PROJECT_LIMITS.flowLabel)) issues.push({ path: `${path}.label`, message: `Must be 1-${PROJECT_LIMITS.flowLabel} printable characters.` });
    // Validated like POST /v1/sessions (structured actions only); the API also dry-runs it.
    const session = validateSessionCreateRequest({
      actions: flow.actions,
      allowedOrigins: [FLOW_PLACEHOLDER_ORIGIN],
      ...(flow.amount !== undefined ? { amount: flow.amount } : {}),
      ...(flow.constraints !== undefined ? { constraints: flow.constraints } : {}),
    });
    if (!session.ok) for (const issue of session.issues) issues.push({ path: issue.path ? `${path}.${issue.path}` : path, message: issue.message });
    if (issues.length > local || !session.ok) return;
    out.push({
      id: flow.id as string,
      label: flow.label as string,
      actions: session.value.actions,
      ...(session.value.amount ? { amount: session.value.amount } : {}),
      ...(session.value.constraints ? { constraints: session.value.constraints } : {}),
    });
  });
  return issues.length > before ? undefined : out;
}

/**
 * Validates `kletia.project/v1` settings (the whole document after a merge
 * patch). Origins and websites come back normalised, duplicates removed,
 * appearance colours as "#RRGGBB". Flows are checked like session templates;
 * whether their registrations are usable is the API's dry run.
 */
export function validateProjectSettings(input: unknown): ValidationResult<ProjectSettingsInput> {
  if (!isPlainRecord(input)) return { ok: false, issues: [{ path: "", message: "Project settings must be an object." }] };
  const issues: ValidationIssue[] = [];
  unknownKeys(input, SETTINGS_KEYS, "", issues);
  if (input.schema !== PROJECT_SCHEMA) issues.push({ path: "schema", message: `Must be "${PROJECT_SCHEMA}".` });
  const brand = input.brand === undefined ? undefined : validateBrand(input.brand, issues);
  const allowedOrigins = input.allowedOrigins === undefined ? undefined : validateOrigins(input.allowedOrigins, issues);
  const defaults = input.defaults === undefined ? undefined : validateDefaults(input.defaults, issues);
  const flows = input.flows === undefined ? undefined : validateFlows(input.flows, issues);
  if (input.modelReading !== undefined && input.modelReading !== "disabled" && input.modelReading !== "enabled") {
    issues.push({ path: "modelReading", message: "Must be disabled or enabled." });
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 50) };
  return {
    ok: true,
    value: {
      schema: PROJECT_SCHEMA,
      ...(brand ? { brand } : {}),
      ...(allowedOrigins ? { allowedOrigins } : {}),
      ...(defaults && Object.keys(defaults).length > 0 ? { defaults } : {}),
      ...(flows ? { flows } : {}),
      ...(input.modelReading === "enabled" ? { modelReading: "enabled" as const } : {}),
    },
  };
}

/** RFC 7386 JSON merge patch: objects merge recursively, `null` removes a member, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainRecord(patch)) return patch;
  const out: Record<string, unknown> = isPlainRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/**
 * Applies a merge patch to stored settings (none yet: an empty document) and
 * validates the result. The schema may be left out of the patch.
 */
export function mergeProjectPatch(current: ProjectSettingsInput | null, patch: unknown): ValidationResult<ProjectSettingsInput> {
  if (!isPlainRecord(patch)) return { ok: false, issues: [{ path: "", message: "The patch must be a JSON object of project settings." }] };
  const merged = mergePatch(current ?? { schema: PROJECT_SCHEMA }, patch);
  const withSchema = isPlainRecord(merged) && merged.schema === undefined ? { ...merged, schema: PROJECT_SCHEMA } : merged;
  return validateProjectSettings(withSchema);
}

/** `sha256:<hex>` of the canonical settings as stored (flows with their ownerKeyId): the If-Match value. */
export function projectSettingsHash(settings: ProjectView["settings"]): string {
  return `sha256:${bytesToHex(sha256(canonicalJson(settings)))}`;
}

/** The JSON a project publishes at PROJECT_DOMAIN_FILE to prove its website. */
export function projectDomainFile(projectId: string): string {
  return JSON.stringify({ projects: [projectId] });
}
