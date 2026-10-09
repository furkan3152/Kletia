/**
 * Cross-network intent links, `lk_…` (intent-links design L1).
 *
 * A link is a publisher-fixed template, never a payment request: fixed
 * destination actions (recipients and contracts pinned at creation) plus
 * bounded funding choices. Every visitor plans, reviews and signs in their
 * own wallet. This module holds the static validator, the deterministic
 * expansion of (link, visitor choice) into structured intent actions with
 * the envelope the API re-checks after planning, blink eligibility, the
 * deliver-sizing arithmetic and the departure-board text folding shared by
 * the share card and the page. Pure and dependency-free.
 */
import { ASSETS, findAssetBySymbol, getAsset, type AssetDescriptor } from "./assets.js";
import { CHAINS, isNetworkKey, type NetworkKey, type VirtualMachine } from "./chains.js";
import { parseAccountId, parseAssetId, isAddressForNamespace, type AccountId, type AssetId } from "./caip.js";
import { canonicalJson, CONTRACT_ENTRY_ID_PATTERN, CONTRACT_REFERENCE_PATTERN, hostMatches, normalizeWebOrigin, reservedIntegratorName } from "./contracts.js";
import { fromBaseUnits, isDecimalAmount, toBaseUnits } from "./amounts.js";
import type { AssetRef, IntentActionKind, IntentActionSpec, IntentConstraints } from "./intent.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
import type { ValidationIssue } from "./validation.js";

/* ================================================================ constants */

/** `lk_` + 24 hex. */
export const LINK_ID_PATTERN = /^lk_[0-9a-f]{24}$/u;

export function isLinkId(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_PATTERN.test(value);
}

export const LINK_LIMITS = Object.freeze({
  maxActions: 6,
  maxFundingNetworks: 9,
  maxFundingAssets: 6,
  titleMinLength: 3,
  titleMaxLength: 80,
  descriptionMaxLength: 280,
  publisherNameMinLength: 2,
  publisherNameMaxLength: 40,
  maxSlippageBps: 300,
  defaultTtlSeconds: 30 * 86_400,
  maxTtlSeconds: 365 * 86_400,
  maxUses: 1_000_000,
  perAccountMaxUses: 100,
  /** Kletia adds `linkId`. */
  metadataEntries: 19,
  definitionBytes: 16_384,
  /** Active links per key. */
  activeLinksPerKey: 200,
  creationsPerHourPerKey: 60,
  quotePerMinutePerIp: 20,
  quotePerMinutePerLink: 300,
  intentsPerMinutePerIp: 10,
  intentsPerMinutePerLink: 120,
  intentsPer10MinutesPerAccount: 5,
  reportsPerHourPerIp: 5,
  pagePerMinutePerLink: 600,
  blinkPostPerMinutePerIp: 10,
  /** Steps of a blink flow, each one Solana transaction. */
  blinkMaxSteps: 3,
  /** KLETIA_LINK_UNVERIFIED_MAX_USD. */
  unverifiedMaxUsd: 1_000,
  /** KLETIA_LINK_ACTIVATION_DELAY_SECONDS (production lane, third-party payee or custom contract). */
  activationDelaySeconds: 900,
  quoteCacheSeconds: 20,
  /** Deliver sizing (§3.5): first guess assumes 30 bps of costs; accept a surplus up to 50 bps; at most 3 auction runs. */
  deliverFirstGuessBps: 30,
  deliverMaxSurplusBps: 50,
  deliverSecondMarginBps: 2,
  deliverThirdMarginBps: 5,
  deliverMaxRuns: 3,
});

/** Kinds a destination action may have. */
export const LINK_ACTION_KINDS: readonly IntentActionKind[] = Object.freeze(["transfer", "swap", "bridge", "stake", "deposit", "call", "action"]);

export const LINK_EVENT_REASONS = Object.freeze(["recipient_changed", "contract_changed", "domain_unverified", "operator", "abuse_reports"] as const);

/** Copy printed on every link view and page. */
export function linkNotices(publisherName: string): readonly string[] {
  return [
    "Kletia does not vouch for publishers. Check the domain and the fixed recipients before you sign.",
    `${publisherName} can see the wallet addresses of intents created from this link.`,
  ];
}

/* ==================================================================== types */

export type LinkStatus = "pending" | "active" | "paused" | "suspended" | "exhausted" | "expired" | "deleted";

export interface LinkAmountBounds {
  /** Decimal, human units. */
  readonly min: string;
  readonly max: string;
  readonly default?: string;
}

export type LinkFundingAmount =
  /** The visitor chooses how much to send, within per-asset bounds (keyed by funding asset symbol). */
  | { readonly mode: "input"; readonly bounds: Readonly<Record<string, LinkAmountBounds>> }
  /** The recipient receives at least the destination transfer's fixed amount; the input is sized by inverse quoting. */
  | { readonly mode: "deliver" };

export interface LinkFunding {
  readonly networks: readonly NetworkKey[];
  /** Registry symbols. */
  readonly assets: readonly string[];
  readonly amount: LinkFundingAmount;
}

export interface LinkPublisher {
  readonly name: string;
  /** https origin; required on the production lane. */
  readonly website?: string;
}

export type LinkConstraints = Pick<IntentConstraints, "maxSlippageBps" | "maxSeconds" | "avoidProtocols" | "preferProtocols">;

/** The normalised create body (`POST /v1/links`). */
export interface LinkDefinition {
  readonly title: string;
  readonly description?: string;
  readonly publisher: LinkPublisher;
  readonly destination: { readonly actions: readonly IntentActionSpec[] };
  readonly funding: LinkFunding;
  readonly constraints?: LinkConstraints;
  /** ISO time; default 30 days after creation. */
  readonly expiresAt: string;
  readonly maxUses?: number;
  readonly perAccount?: { readonly maxUses: number };
  readonly blink: boolean;
  /** Accept links whose intents are held for Rule Book approval (the page says so). */
  readonly allowHolds?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** What the API pins at creation (names resolved, registrations bound, the destination asset). */
export interface LinkPins {
  /** Destination action index → the account its recipient resolved to (and the name it came from). */
  readonly recipients: readonly { readonly action: number; readonly account: AccountId; readonly name?: string }[];
  /** Destination action index → the registration revision it calls. */
  readonly contracts: readonly {
    readonly action: number;
    readonly contract: string;
    readonly revision: number;
    readonly definitionHash: string;
    readonly entry: string;
    readonly target: string;
  }[];
  /** The first destination action's input asset (for call/action: the entry's input asset). */
  readonly destinationAsset: AssetRef;
}

export interface StoredLinkDefinition {
  readonly definition: LinkDefinition;
  readonly pins: LinkPins;
}

/** A visitor's funding choice (`source` + `amount` of POST /v1/links/{id}/intents). */
export interface LinkFundingChoice {
  readonly network: NetworkKey;
  /** Funding asset symbol (or CAIP-19 id) on `network`. */
  readonly asset: string;
  /** Decimal, input mode only. */
  readonly amount?: string;
}

export interface LinkEnvelope {
  /** Every network a planned step or destination may use. */
  readonly networks: readonly NetworkKey[];
  /** Pinned recipients (the API adds the visitor's accounts). */
  readonly recipients: readonly AccountId[];
  readonly contracts: readonly { readonly contract: string; readonly revision: number; readonly definitionHash: string }[];
  /** The root step must spend exactly this. */
  readonly root: { readonly network: NetworkKey; readonly asset: AssetId; readonly amount: string };
}

export type LinkExpansionCase = "direct" | "swap" | "bridge" | "deliver-direct" | "deliver-bridge";

export interface LinkExpansion {
  readonly case: LinkExpansionCase;
  /** Structured actions for `createIntentDetailed` (aliases, names and assets pinned). */
  readonly actions: readonly IntentActionSpec[];
  /** One visitor account per VM. */
  readonly requiredVms: readonly VirtualMachine[];
  readonly envelope: LinkEnvelope;
  readonly destination: { readonly network: NetworkKey; readonly asset: AssetRef };
  readonly source: { readonly network: NetworkKey; readonly asset: AssetRef };
}

export type LinkErrorCode = "LINK_INPUT_OUT_OF_BOUNDS" | "LINK_SOURCE_NOT_ALLOWED" | "LINK_ACCOUNTS_REQUIRED" | "LINK_PLAN_OUT_OF_BOUNDS";

export class LinkExpansionError extends Error {
  readonly code: LinkErrorCode;
  readonly issues: readonly ValidationIssue[];

  constructor(code: LinkErrorCode, message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = "LinkExpansionError";
    this.code = code;
    this.issues = issues;
  }
}

/* --------------------------------------------------------------- views */

export interface LinkPublisherView {
  readonly name: string;
  readonly website?: string;
  readonly domain?: string;
  readonly domainVerified: boolean;
  readonly checkedAt?: string;
}

export interface LinkView {
  readonly id: string;
  readonly status: LinkStatus;
  readonly revision: number;
  readonly title: string;
  readonly description?: string;
  readonly publisher: LinkPublisherView;
  readonly destination: {
    readonly network: NetworkKey;
    readonly asset: AssetRef;
    readonly actions: readonly {
      readonly kind: IntentActionKind;
      readonly network: NetworkKey;
      readonly label: string;
      readonly contract?: { readonly id: string; readonly address: string; readonly integrator: string; readonly source?: string; readonly domainVerified: boolean; readonly revision: number };
    }[];
  };
  readonly fixed: {
    readonly recipients: readonly { readonly network: NetworkKey; readonly address: string; readonly name?: string }[];
    readonly contracts: readonly { readonly network: NetworkKey; readonly address: string; readonly label: string }[];
  };
  readonly funding: LinkFunding;
  readonly expiresAt: string;
  readonly activatesAt: string | null;
  readonly uses: { readonly max: number | null; readonly left: number | null };
  readonly perAccount: { readonly maxUses: number } | null;
  readonly blink: { readonly enabled: boolean; readonly eligible: boolean; readonly reason: string | null };
  readonly urls: { readonly page: string; readonly card: string; readonly square: string };
  readonly notices: readonly string[];
}

export interface LinkOwnerView extends LinkView {
  readonly definition: LinkDefinition;
  readonly pins: LinkPins;
  readonly ownerKeyId: string;
  readonly pausedReason: string | null;
  readonly suspendedReason: string | null;
  readonly stats?: LinkStatsTotals;
}

export type LinkMetric =
  | "pageView"
  | "unfurl"
  | "blinkView"
  | "quote"
  | "intent"
  | "prepared"
  | "submitted"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "overflow"
  | "report"
  | "unpriced";

export const LINK_METRICS: readonly LinkMetric[] = Object.freeze([
  "pageView",
  "unfurl",
  "blinkView",
  "quote",
  "intent",
  "prepared",
  "submitted",
  "completed",
  "failed",
  "expired",
  "cancelled",
  "overflow",
  "report",
  "unpriced",
]);

export type LinkStatsTotals = Readonly<Partial<Record<LinkMetric, number>>> & { readonly volumeUsd?: string };

/** `GET /v1/links/{id}/stats`: additive counters, nothing per visitor. */
export interface LinkStats {
  readonly linkId: string;
  readonly window: "7d" | "30d" | "90d";
  readonly totals: LinkStatsTotals;
  readonly daily: readonly ({ readonly day: string } & LinkStatsTotals)[];
  /** `network:asset` → counters. */
  readonly bySource: readonly ({ readonly source: string } & LinkStatsTotals)[];
  readonly conversion: { readonly intentPerPageView: number | null; readonly completedPerIntent: number | null };
}

export interface LinkIntentRequest {
  readonly accounts: readonly AccountId[];
  readonly source: { readonly network: NetworkKey; readonly asset: string };
  readonly amount?: string;
}

/* ============================================================== text rules */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}‒–—―]/u;
const PUBLISHER_NAME = /^[A-Za-z0-9 .,&'()-]+$/u;
const RECIPIENT_NAME = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:eth|sns|sol)$/u;
const METADATA_KEY = /^[A-Za-z0-9_.:-]{1,40}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/gu, "i").toLowerCase();
}

function linkText(value: unknown, path: string, min: number, max: number, issues: ValidationIssue[], options: { readonly noKletia?: boolean } = {}): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path, message: "Must be a string." });
    return undefined;
  }
  const normalized = value.normalize("NFKC").trim();
  const length = [...normalized].length;
  if (length < min || length > max) issues.push({ path, message: `Must be ${min}-${max} characters.` });
  else if (FORBIDDEN_TEXT.test(normalized)) issues.push({ path, message: "Control, invisible formatting characters and em or en dashes are not allowed." });
  else if (options.noKletia && fold(normalized).replace(/[^a-z0-9]/gu, "").includes("kletia")) issues.push({ path, message: "May not contain \"Kletia\": links are published by integrators." });
  else return normalized;
  return undefined;
}

/** Registry spelling of a symbol (first match, case-insensitive), or null. */
function registrySymbol(symbol: unknown): string | null {
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 32) return null;
  const wanted = symbol.toUpperCase();
  return ASSETS.find((asset) => asset.symbol.toUpperCase() === wanted)?.symbol ?? null;
}

/** A funding asset (symbol or CAIP-19 id) on a network, or null. */
export function linkFundingAsset(network: NetworkKey, asset: string): AssetDescriptor | null {
  if (asset.includes("/")) {
    const parsed = parseAssetId(asset);
    if (!parsed || parsed.chain.key !== network) return null;
    return ASSETS.find((candidate) => candidate.network === network && candidate.id.toLowerCase() === parsed.id.toLowerCase()) ?? null;
  }
  return findAssetBySymbol(network, asset);
}

/** Every (network, asset) funding pair that resolves in the registry, in definition order. */
export function linkFundingOptions(funding: Pick<LinkFunding, "networks" | "assets">): { readonly network: NetworkKey; readonly asset: AssetDescriptor; readonly symbol: string }[] {
  const out: { network: NetworkKey; asset: AssetDescriptor; symbol: string }[] = [];
  for (const network of funding.networks) {
    for (const symbol of funding.assets) {
      const asset = linkFundingAsset(network, symbol);
      if (asset) out.push({ network, asset, symbol });
    }
  }
  return out;
}

function assetRef(asset: AssetDescriptor): AssetRef {
  return { asset: asset.id, symbol: asset.symbol, decimals: asset.decimals };
}

/** The first destination action's input asset when it is static (not call/action), or null. */
export function linkDestinationAsset(definition: Pick<LinkDefinition, "destination">): AssetRef | null {
  const first = definition.destination.actions[0];
  if (!first || first.kind === "call" || first.kind === "action" || typeof first.from !== "string") return null;
  const asset = linkFundingAsset(first.network, first.from);
  return asset ? assetRef(asset) : null;
}

function decimalsOf(value: string): number {
  return value.includes(".") ? (value.split(".")[1] as string).length : 0;
}

function compareDecimal(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const width = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(width, "0"));
  const right = BigInt(bWhole + bFraction.padEnd(width, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Positive decimal text of a sane length (amounts never need more than 40 characters). */
const isPositiveDecimal = (value: unknown): value is string => isDecimalAmount(value) && value.length <= 40 && !/^0(?:\.0*)?$/u.test(value);

/* ============================================================== validation */

export type LinkValidationResult =
  | { readonly ok: true; readonly value: LinkDefinition }
  | { readonly ok: false; readonly code: "LINK_DEFINITION_INVALID" | "LINK_SOURCE_NOT_ALLOWED"; readonly issues: readonly (ValidationIssue & { readonly code?: "LINK_SOURCE_NOT_ALLOWED" })[] };

export interface LinkValidationOptions {
  /** Clock for expiresAt (default now). */
  readonly now?: number;
}

function validateRecipient(value: unknown, network: NetworkKey): boolean {
  if (typeof value !== "string" || value.length > 160) return false;
  if (RECIPIENT_NAME.test(value.trim().toLowerCase())) return true;
  const account = parseAccountId(value);
  if (account) return account.chain.namespace === CHAINS[network].namespace;
  return isAddressForNamespace(CHAINS[network].namespace, value);
}

function validateAction(value: unknown, index: number, mode: "input" | "deliver" | null, issues: ValidationIssue[]): IntentActionSpec | null {
  const path = `destination.actions[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: "Each action is a structured intent action." });
    return null;
  }
  const allowedKeys = ["kind", "network", "from", "to", "amount", "toNetwork", "recipient", "protocol", "params", "contract", "entry"];
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) issues.push({ path: `${path}.${key}`, message: `Unknown field. Allowed: ${allowedKeys.join(", ")}.` });
  const kind = value.kind as IntentActionKind;
  const start = issues.length;
  if (!(LINK_ACTION_KINDS as readonly unknown[]).includes(kind)) issues.push({ path: `${path}.kind`, message: `Must be one of ${LINK_ACTION_KINDS.join(", ")}.` });
  if (!isNetworkKey(value.network)) issues.push({ path: `${path}.network`, message: "Unknown network." });
  if (value.toNetwork !== undefined && !isNetworkKey(value.toNetwork)) issues.push({ path: `${path}.toNetwork`, message: "Unknown network." });
  for (const key of ["from", "to"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > 128)) {
      issues.push({ path: `${path}.${key}`, message: "Must be an asset symbol or CAIP-19 id up to 128 characters." });
    }
  }
  if (value.protocol !== undefined && (typeof value.protocol !== "string" || !getProtocol(value.protocol))) issues.push({ path: `${path}.protocol`, message: "Unknown protocol." });
  let params: Record<string, string | number | boolean> | undefined;
  if (value.params !== undefined) {
    if (!isRecord(value.params) || Object.keys(value.params).length > 8 || Object.values(value.params).some((entry) => !["string", "number", "boolean"].includes(typeof entry))) {
      issues.push({ path: `${path}.params`, message: "Up to 8 string, number or boolean values." });
    } else {
      params = value.params as Record<string, string | number | boolean>;
      const portion = params.portionBps;
      if (portion !== undefined && (typeof portion !== "number" || !Number.isInteger(portion) || portion < 1 || portion > 10_000)) {
        issues.push({ path: `${path}.params.portionBps`, message: "Must be an integer between 1 and 10000." });
      }
    }
  }
  // Amounts: the first action spends "$amount" (input) or a fixed amount (deliver); later actions only route what arrived.
  const amount = value.amount;
  if (index === 0) {
    if (mode === "input" && amount !== "$amount") issues.push({ path: `${path}.amount`, message: "The first action spends the visitor's amount: \"$amount\"." });
    if (mode === "deliver" && !isPositiveDecimal(amount)) issues.push({ path: `${path}.amount`, message: "A deliver link fixes the delivered amount as a positive decimal." });
  } else if (!(amount === "max" || (amount === undefined && params?.portionBps !== undefined))) {
    issues.push({ path: `${path}.amount`, message: "Later actions spend \"max\" or a params.portionBps share of the previous output, never a fixed amount." });
  }
  const contractKind = kind === "call" || kind === "action";
  if (contractKind) {
    if (typeof value.contract !== "string" || value.contract.length > 64 || !CONTRACT_REFERENCE_PATTERN.test(value.contract)) {
      issues.push({ path: `${path}.contract`, message: "Required for call and action: a registration id (ct_…) or alias usable by the creating key." });
    }
    if (typeof value.entry !== "string" || !CONTRACT_ENTRY_ID_PATTERN.test(value.entry)) issues.push({ path: `${path}.entry`, message: "Required for call and action: the registration's entry id." });
  } else {
    for (const key of ["contract", "entry"] as const) if (value[key] !== undefined) issues.push({ path: `${path}.${key}`, message: "Only call and action steps reference a registration." });
  }
  if (value.recipient !== undefined) {
    if (kind !== "transfer" && !contractKind) {
      issues.push({ path: `${path}.recipient`, message: "Only transfer actions and registered entries with recipient \"any\" may name a recipient; every other action pays the visitor." });
    } else if (isNetworkKey(value.network) && !validateRecipient(value.recipient, value.network)) {
      issues.push({ path: `${path}.recipient`, message: "Must be an address or CAIP-10 account on the action's network, or an ENS, Basenames or SNS name." });
    }
  } else if (kind === "transfer") {
    issues.push({ path: `${path}.recipient`, message: "A transfer needs a fixed recipient." });
  }
  if (kind === "bridge" && value.toNetwork === undefined) issues.push({ path: `${path}.toNetwork`, message: "A bridge names its destination network." });
  if (issues.length > start) return null;
  return {
    kind,
    network: value.network as NetworkKey,
    ...(typeof value.from === "string" ? { from: value.from.trim() } : {}),
    ...(typeof value.to === "string" ? { to: value.to.trim() } : {}),
    ...(typeof amount === "string" ? { amount } : {}),
    ...(value.toNetwork !== undefined ? { toNetwork: value.toNetwork as NetworkKey } : {}),
    ...(typeof value.recipient === "string" ? { recipient: value.recipient.trim() } : {}),
    ...(value.protocol !== undefined ? { protocol: value.protocol as ProtocolId } : {}),
    ...(params ? { params } : {}),
    ...(typeof value.contract === "string" ? { contract: value.contract } : {}),
    ...(typeof value.entry === "string" ? { entry: value.entry } : {}),
  };
}

/**
 * Static validation of a link create body (intent-links design §3.3).
 * Routability by an adapter, registration usability, name resolution and
 * domain verification are the API's job (they need I/O); everything else is
 * checked here, identically in the API, SDK, CLI and the portal builder.
 */
export function validateLinkDefinition(input: unknown, options: LinkValidationOptions = {}): LinkValidationResult {
  const issues: (ValidationIssue & { code?: "LINK_SOURCE_NOT_ALLOWED" })[] = [];
  const source = (path: string, message: string) => issues.push({ path, message, code: "LINK_SOURCE_NOT_ALLOWED" });
  if (!isRecord(input)) return { ok: false, code: "LINK_DEFINITION_INVALID", issues: [{ path: "", message: "Request body must be an object." }] };
  const topKeys = ["title", "description", "publisher", "destination", "funding", "constraints", "expiresAt", "maxUses", "perAccount", "blink", "allowHolds", "metadata"];
  for (const key of Object.keys(input)) if (!topKeys.includes(key)) issues.push({ path: key, message: `Unknown field. Allowed: ${topKeys.join(", ")}.` });

  const title = linkText(input.title, "title", LINK_LIMITS.titleMinLength, LINK_LIMITS.titleMaxLength, issues, { noKletia: true });
  const description = input.description === undefined ? undefined : linkText(input.description, "description", 1, LINK_LIMITS.descriptionMaxLength, issues);

  // Funding first: the amount mode decides how actions are read.
  const fundingIn = input.funding;
  let mode: "input" | "deliver" | null = null;
  let networks: NetworkKey[] = [];
  let assets: string[] = [];
  let boundsIn: Record<string, unknown> | null = null;
  if (!isRecord(fundingIn)) issues.push({ path: "funding", message: "Must be { networks, assets, amount }." });
  else {
    for (const key of Object.keys(fundingIn)) if (!["networks", "assets", "amount"].includes(key)) issues.push({ path: `funding.${key}`, message: "Unknown field." });
    if (!Array.isArray(fundingIn.networks) || fundingIn.networks.length === 0 || fundingIn.networks.length > LINK_LIMITS.maxFundingNetworks) {
      issues.push({ path: "funding.networks", message: `List 1-${LINK_LIMITS.maxFundingNetworks} network keys.` });
    } else {
      fundingIn.networks.forEach((network, index) => {
        if (!isNetworkKey(network)) issues.push({ path: `funding.networks[${index}]`, message: "Unknown network." });
        else if (networks.includes(network)) issues.push({ path: `funding.networks[${index}]`, message: "Duplicate network." });
        else networks.push(network);
      });
    }
    if (!Array.isArray(fundingIn.assets) || fundingIn.assets.length === 0 || fundingIn.assets.length > LINK_LIMITS.maxFundingAssets) {
      issues.push({ path: "funding.assets", message: `List 1-${LINK_LIMITS.maxFundingAssets} asset symbols.` });
    } else {
      fundingIn.assets.forEach((symbol, index) => {
        const spelled = registrySymbol(symbol);
        if (!spelled) issues.push({ path: `funding.assets[${index}]`, message: "Unknown asset symbol." });
        else if (assets.includes(spelled)) issues.push({ path: `funding.assets[${index}]`, message: "Duplicate asset." });
        else assets.push(spelled);
      });
    }
    const amount = fundingIn.amount;
    if (!isRecord(amount) || (amount.mode !== "input" && amount.mode !== "deliver")) {
      issues.push({ path: "funding.amount", message: "Must be { mode: \"input\", bounds } or { mode: \"deliver\" }." });
    } else {
      mode = amount.mode;
      const allowed = mode === "input" ? ["mode", "bounds"] : ["mode"];
      for (const key of Object.keys(amount)) if (!allowed.includes(key)) issues.push({ path: `funding.amount.${key}`, message: "Unknown field." });
      if (mode === "input") {
        if (!isRecord(amount.bounds)) issues.push({ path: "funding.amount.bounds", message: "List { min, max, default? } for every funding asset symbol." });
        else boundsIn = amount.bounds;
      }
    }
  }

  const actionsIn = isRecord(input.destination) ? input.destination.actions : undefined;
  if (isRecord(input.destination)) {
    for (const key of Object.keys(input.destination)) if (key !== "actions") issues.push({ path: `destination.${key}`, message: "Unknown field." });
  }
  const actions: IntentActionSpec[] = [];
  if (!Array.isArray(actionsIn) || actionsIn.length === 0 || actionsIn.length > LINK_LIMITS.maxActions) {
    issues.push({ path: "destination.actions", message: `List 1-${LINK_LIMITS.maxActions} structured actions.` });
  } else {
    actionsIn.forEach((action, index) => {
      const validated = validateAction(action, index, mode, issues);
      if (validated) actions.push(validated);
    });
  }
  const first = actions[0];
  const destinationNetwork = first?.network;

  // Lanes: every destination and funding network on one capital lane.
  const laneNetworks = [...networks, ...actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])])];
  const environments = new Set(laneNetworks.map((network) => CHAINS[network].environment));
  if (environments.size > 1) issues.push({ path: "funding.networks", message: "Keep every destination and funding network on mainnet, or every one on testnet." });
  const production = environments.has("mainnet");

  // Publisher.
  let publisher: LinkPublisher | undefined;
  if (!isRecord(input.publisher)) issues.push({ path: "publisher", message: "Must be { name, website }." });
  else {
    for (const key of Object.keys(input.publisher)) if (!["name", "website"].includes(key)) issues.push({ path: `publisher.${key}`, message: "Unknown field." });
    const name = typeof input.publisher.name === "string" ? input.publisher.name.trim() : "";
    const website = input.publisher.website === undefined ? undefined : normalizeWebOrigin(input.publisher.website);
    if (name.length < LINK_LIMITS.publisherNameMinLength || name.length > LINK_LIMITS.publisherNameMaxLength || !PUBLISHER_NAME.test(name)) {
      issues.push({ path: "publisher.name", message: "2-40 characters of letters, digits, spaces and . , & ' ( ) -." });
    } else {
      const reserved = reservedIntegratorName(name);
      const host = website ? new URL(website).hostname : null;
      if (reserved && !(host && hostMatches(host, reserved.hosts))) {
        issues.push({ path: "publisher.name", message: `"${reserved.word}" is reserved; only ${reserved.hosts.join(", ")} (verified) may publish under it.` });
      }
    }
    if (input.publisher.website !== undefined && !website) issues.push({ path: "publisher.website", message: "Must be an https origin such as https://acme.example." });
    if (input.publisher.website === undefined && production) issues.push({ path: "publisher.website", message: "Required on the production lane (domain verification)." });
    publisher = { name, ...(website ? { website } : {}) };
  }

  // Funding pairs and amounts.
  const options_ = linkFundingOptions({ networks, assets });
  for (const symbol of assets) {
    if (!options_.some((option) => option.symbol === symbol)) source(`funding.assets`, `${symbol} exists on none of the funding networks.`);
  }
  for (const network of assets.length > 0 ? networks : []) {
    if (!options_.some((option) => option.network === network)) source(`funding.networks`, `None of the funding assets exists on ${CHAINS[network].name}.`);
  }
  let bounds: Record<string, LinkAmountBounds> | undefined;
  if (mode === "input" && boundsIn) {
    bounds = {};
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(boundsIn)) {
      const symbol = registrySymbol(key);
      const path = `funding.amount.bounds.${key}`;
      if (!symbol || !assets.includes(symbol)) {
        issues.push({ path, message: "Bounds are keyed by funding asset symbols." });
        continue;
      }
      seen.add(symbol);
      if (!isRecord(entry) || Object.keys(entry).some((field) => !["min", "max", "default"].includes(field))) {
        issues.push({ path, message: "Must be { min, max, default? }." });
        continue;
      }
      const { min, max } = entry;
      const fallback = entry.default;
      if (!isPositiveDecimal(min) || !isPositiveDecimal(max) || (fallback !== undefined && !isPositiveDecimal(fallback))) {
        issues.push({ path, message: "min, max and default are positive decimal strings." });
        continue;
      }
      if (compareDecimal(min, max) > 0 || (fallback !== undefined && (compareDecimal(fallback, min) < 0 || compareDecimal(fallback, max) > 0))) {
        issues.push({ path, message: "Must satisfy min ≤ default ≤ max." });
        continue;
      }
      const decimals = Math.min(...options_.filter((option) => option.symbol === symbol).map((option) => option.asset.decimals));
      if (Number.isFinite(decimals) && [min, max, fallback].some((value) => value !== undefined && decimalsOf(value) > decimals)) {
        issues.push({ path, message: `${symbol} has ${decimals} decimals on one of the funding networks.` });
        continue;
      }
      bounds[symbol] = { min, max, ...(fallback !== undefined ? { default: fallback } : {}) };
    }
    for (const symbol of assets) if (!seen.has(symbol)) issues.push({ path: `funding.amount.bounds.${symbol}`, message: "Every funding asset needs bounds." });
  }
  if (mode === "deliver" && first) {
    if (actions.length !== 1 || first.kind !== "transfer") {
      issues.push({ path: "destination.actions", message: "A deliver link has exactly one action: a transfer of a fixed amount to a fixed recipient." });
    } else {
      const delivered = typeof first.from === "string" ? linkFundingAsset(first.network, first.from) : null;
      if (!delivered) issues.push({ path: "destination.actions[0].from", message: "Name the delivered asset (a listed symbol or CAIP-19 id on the action's network)." });
      else {
        if (!delivered.group) issues.push({ path: "destination.actions[0].from", message: "Deliver links need an asset with a cross-network group (e.g. USDC)." });
        if (first.amount && decimalsOf(first.amount) > delivered.decimals) issues.push({ path: "destination.actions[0].amount", message: `${delivered.symbol} has ${delivered.decimals} decimals.` });
        for (const option of options_) {
          if (option.network === first.network && option.asset.id !== delivered.id) {
            source("funding.assets", `On ${CHAINS[option.network].name} only ${delivered.symbol} itself can fund a deliver link (${option.symbol} cannot).`);
          } else if (delivered.group && option.asset.group !== delivered.group) {
            source("funding.assets", `${option.symbol} is not in the ${delivered.group} group of the delivered asset.`);
          }
        }
      }
    }
  }
  if (mode === "input" && first && destinationNetwork && first.kind !== "call" && first.kind !== "action") {
    if (typeof first.from !== "string" || !linkFundingAsset(first.network, first.from)) {
      issues.push({ path: "destination.actions[0].from", message: "Name the destination asset (a listed symbol or CAIP-19 id on the action's network)." });
    }
  }

  // Constraints.
  let constraints: LinkConstraints | undefined;
  if (input.constraints !== undefined) {
    const value = input.constraints;
    if (!isRecord(value)) issues.push({ path: "constraints", message: "Must be an object." });
    else {
      const out: { -readonly [K in keyof LinkConstraints]: LinkConstraints[K] } = {};
      for (const key of Object.keys(value)) if (!["maxSlippageBps", "maxSeconds", "avoidProtocols", "preferProtocols"].includes(key)) issues.push({ path: `constraints.${key}`, message: "Links take maxSlippageBps, maxSeconds, avoidProtocols and preferProtocols." });
      if (value.maxSlippageBps !== undefined) {
        const bps = value.maxSlippageBps;
        if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 1 || bps > LINK_LIMITS.maxSlippageBps) issues.push({ path: "constraints.maxSlippageBps", message: `Must be an integer between 1 and ${LINK_LIMITS.maxSlippageBps}.` });
        else out.maxSlippageBps = bps;
      }
      if (value.maxSeconds !== undefined) {
        const seconds = value.maxSeconds;
        if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 10 || seconds > 86_400) issues.push({ path: "constraints.maxSeconds", message: "Must be an integer between 10 and 86400." });
        else out.maxSeconds = seconds;
      }
      for (const key of ["avoidProtocols", "preferProtocols"] as const) {
        const list = value[key];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.length > 40 || list.some((id) => typeof id !== "string" || !getProtocol(id))) issues.push({ path: `constraints.${key}`, message: "Must be a list of known protocol ids." });
        else out[key] = [...new Set(list as ProtocolId[])];
      }
      constraints = out;
    }
  }

  // Lifetime and uses.
  const now = options.now ?? Date.now();
  let expiresAt = new Date(now + LINK_LIMITS.defaultTtlSeconds * 1000).toISOString();
  if (input.expiresAt !== undefined) {
    const time = typeof input.expiresAt === "string" && ISO_TIME.test(input.expiresAt) ? Date.parse(input.expiresAt) : Number.NaN;
    if (!Number.isFinite(time)) issues.push({ path: "expiresAt", message: "Must be an ISO 8601 UTC time." });
    else if (time <= now) issues.push({ path: "expiresAt", message: "Must be in the future." });
    else if (time > now + LINK_LIMITS.maxTtlSeconds * 1000) issues.push({ path: "expiresAt", message: "Must be at most 365 days ahead." });
    else expiresAt = new Date(time).toISOString();
  }
  let maxUses: number | undefined;
  if (input.maxUses !== undefined) {
    if (typeof input.maxUses !== "number" || !Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > LINK_LIMITS.maxUses) issues.push({ path: "maxUses", message: `Must be an integer between 1 and ${LINK_LIMITS.maxUses}.` });
    else maxUses = input.maxUses;
  }
  let perAccount: { maxUses: number } | undefined;
  if (input.perAccount !== undefined) {
    const value = input.perAccount;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "maxUses") || typeof value.maxUses !== "number" || !Number.isInteger(value.maxUses) || value.maxUses < 1 || value.maxUses > LINK_LIMITS.perAccountMaxUses) {
      issues.push({ path: "perAccount", message: `Must be { maxUses } with 1-${LINK_LIMITS.perAccountMaxUses}.` });
    } else perAccount = { maxUses: value.maxUses };
  }
  for (const key of ["blink", "allowHolds"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") issues.push({ path: key, message: "Must be a boolean." });
  }
  let metadata: Record<string, string> | undefined;
  if (input.metadata !== undefined) {
    const value = input.metadata;
    if (
      !isRecord(value) ||
      Object.keys(value).length > LINK_LIMITS.metadataEntries ||
      Object.entries(value).some(([key, entry]) => !METADATA_KEY.test(key) || key === "linkId" || typeof entry !== "string" || entry.length > 500)
    ) {
      issues.push({ path: "metadata", message: `Up to ${LINK_LIMITS.metadataEntries} string pairs (keys [A-Za-z0-9_.:-] up to 40 characters, not linkId; values up to 500).` });
    } else metadata = { ...(value as Record<string, string>) };
  }

  if (issues.length > 0 || !title || !publisher || !mode || !first) {
    if (issues.length === 0) issues.push({ path: "", message: "Incomplete link definition." });
    return { ok: false, code: issues.every((issue) => issue.code === "LINK_SOURCE_NOT_ALLOWED") ? "LINK_SOURCE_NOT_ALLOWED" : "LINK_DEFINITION_INVALID", issues };
  }
  const value: LinkDefinition = {
    title,
    ...(description !== undefined ? { description } : {}),
    publisher,
    destination: { actions },
    funding: { networks, assets, amount: mode === "input" ? { mode, bounds: bounds ?? {} } : { mode } },
    ...(constraints && Object.keys(constraints).length > 0 ? { constraints } : {}),
    expiresAt,
    ...(maxUses !== undefined ? { maxUses } : {}),
    ...(perAccount ? { perAccount } : {}),
    blink: input.blink === true,
    ...(input.allowHolds === true ? { allowHolds: true } : {}),
    ...(metadata ? { metadata } : {}),
  };
  const bytes = new TextEncoder().encode(canonicalJson(value)).length;
  if (bytes > LINK_LIMITS.definitionBytes) {
    return { ok: false, code: "LINK_DEFINITION_INVALID", issues: [{ path: "", message: `The definition is ${bytes} bytes; the limit is ${LINK_LIMITS.definitionBytes}.` }] };
  }
  return { ok: true, value };
}

/** Validates `POST /v1/links/{id}/intents` (and the quote body, where accounts are optional). */
export function validateLinkIntentRequest(input: unknown, options: { readonly accountsOptional?: boolean } = {}): { readonly ok: true; readonly value: LinkIntentRequest } | { readonly ok: false; readonly issues: readonly ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  for (const key of Object.keys(input)) if (!["accounts", "source", "amount"].includes(key)) issues.push({ path: key, message: "Unknown field. Allowed: accounts, source, amount." });
  const accounts: AccountId[] = [];
  if (input.accounts === undefined && options.accountsOptional) {
    // Indicative quote with placeholder accounts.
  } else if (!Array.isArray(input.accounts) || input.accounts.length === 0 || input.accounts.length > 2) {
    issues.push({ path: "accounts", message: "Provide 1-2 CAIP-10 accounts (one per virtual machine)." });
  } else {
    input.accounts.forEach((account, index) => {
      const parsed = parseAccountId(account);
      if (!parsed) issues.push({ path: `accounts[${index}]`, message: "Invalid CAIP-10 account id." });
      else accounts.push(parsed.id);
    });
  }
  const sourceIn = input.source;
  if (!isRecord(sourceIn) || !isNetworkKey(sourceIn.network) || typeof sourceIn.asset !== "string" || !sourceIn.asset || sourceIn.asset.length > 128 || Object.keys(sourceIn).some((key) => key !== "network" && key !== "asset")) {
    issues.push({ path: "source", message: "Must be { network, asset }." });
  }
  if (input.amount !== undefined && !isPositiveDecimal(input.amount)) issues.push({ path: "amount", message: "Must be a positive decimal string." });
  if (issues.length > 0 || !isRecord(sourceIn)) return { ok: false, issues };
  return {
    ok: true,
    value: {
      accounts,
      source: { network: sourceIn.network as NetworkKey, asset: sourceIn.asset as string },
      ...(typeof input.amount === "string" ? { amount: input.amount } : {}),
    },
  };
}

/* ================================================================ expansion */

function sameAsset(a: AssetId | string, b: AssetId | string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Ceil-scales base units between decimals. */
function scaleUnits(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  return (units + divisor - 1n) / divisor;
}

/**
 * First input guess for a deliver link bridged from another network:
 * x0 = ceil(T × 10⁴ / (10⁴ − 30)) in the funding asset's decimals (same
 * USD group: 1:1 plus 30 bps). Returns base units of the funding asset.
 */
export function linkDeliverFirstGuess(targetUnits: string | bigint, targetDecimals: number, inputDecimals: number): bigint {
  const target = scaleUnits(BigInt(targetUnits), targetDecimals, inputDecimals);
  const denominator = BigInt(10_000 - LINK_LIMITS.deliverFirstGuessBps);
  return (target * 10_000n + denominator - 1n) / denominator;
}

/** Next guess: ceil(x × T / m × (1 + marginBps)) (x in funding units; T and m in delivered units). */
export function linkDeliverRescale(inputUnits: string | bigint, targetUnits: string | bigint, minimumUnits: string | bigint, marginBps: number): bigint {
  const x = BigInt(inputUnits);
  const target = BigInt(targetUnits);
  const minimum = BigInt(minimumUnits);
  if (minimum <= 0n) throw new Error("The planned minimum must be positive.");
  const numerator = x * target * BigInt(10_000 + marginBps);
  const denominator = minimum * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}

/** A planned minimum m serves a deliver target T with an acceptable surplus: m ≥ T and (m − T) × 10⁴ ≤ 50 × T. */
export function linkDeliverAccepts(minimumUnits: string | bigint, targetUnits: string | bigint): boolean {
  const minimum = BigInt(minimumUnits);
  const target = BigInt(targetUnits);
  return minimum >= target && (minimum - target) * 10_000n <= BigInt(LINK_LIMITS.deliverMaxSurplusBps) * target;
}

/**
 * Deterministic expansion of a stored link and a visitor's funding choice
 * into structured intent actions (intent-links design §3.4). Recipients are
 * replaced by their pinned accounts and contract aliases by their pinned
 * registration ids, so the plan pays exactly what the publisher pinned.
 * Throws LinkExpansionError (LINK_INPUT_OUT_OF_BOUNDS, LINK_SOURCE_NOT_ALLOWED).
 *
 * `options.deliverInput`: the sized input of a deliver link bridged from
 * another network (engine §3.5; default: the first guess). Visitors never
 * choose the amount of a deliver link.
 */
export function expandLink(link: StoredLinkDefinition, choice: LinkFundingChoice, options: { readonly deliverInput?: string } = {}): LinkExpansion {
  const { definition, pins } = link;
  const first = definition.destination.actions[0];
  if (!first) throw new LinkExpansionError("LINK_PLAN_OUT_OF_BOUNDS", "The link has no destination action.");
  const destinationNetwork = first.network;
  const destinationAsset = pins.destinationAsset;
  const funding = definition.funding;

  if (!funding.networks.includes(choice.network)) {
    throw new LinkExpansionError("LINK_SOURCE_NOT_ALLOWED", `This link cannot be funded from ${CHAINS[choice.network]?.name ?? choice.network}.`, [{ path: "source.network", message: `Allowed: ${funding.networks.join(", ")}.` }]);
  }
  const resolved = linkFundingAsset(choice.network, choice.asset);
  const symbol = resolved ? funding.assets.find((entry) => linkFundingAsset(choice.network, entry)?.id === resolved.id) : undefined;
  if (!resolved || !symbol) {
    throw new LinkExpansionError("LINK_SOURCE_NOT_ALLOWED", `This link cannot be funded with ${choice.asset} on ${CHAINS[choice.network].name}.`, [{ path: "source.asset", message: `Allowed: ${funding.assets.join(", ")}.` }]);
  }
  const sourceRef = assetRef(resolved);
  const same = choice.network === destinationNetwork && sameAsset(resolved.id, destinationAsset.asset);

  const recipientPin = (index: number): AccountId => {
    const pin = pins.recipients.find((entry) => entry.action === index);
    if (!pin) throw new LinkExpansionError("LINK_PLAN_OUT_OF_BOUNDS", `Destination action ${index + 1} names a recipient that was not pinned.`);
    return pin.account;
  };
  const pinned = (action: IntentActionSpec, index: number): IntentActionSpec => {
    let out: IntentActionSpec = action;
    if (action.recipient !== undefined) out = { ...out, recipient: recipientPin(index) };
    if (action.kind === "call" || action.kind === "action") {
      const pin = pins.contracts.find((entry) => entry.action === index);
      if (!pin) throw new LinkExpansionError("LINK_PLAN_OUT_OF_BOUNDS", `Destination action ${index + 1} calls a registration that was not pinned.`);
      out = { ...out, contract: pin.contract, entry: pin.entry };
    }
    return out;
  };
  const rest = definition.destination.actions.slice(1).map((action, offset) => pinned(action, offset + 1));
  const head = pinned(first, 0);

  let actions: IntentActionSpec[];
  let rootAmount: string;
  let expansionCase: LinkExpansionCase;
  if (funding.amount.mode === "input") {
    const bounds = funding.amount.bounds[symbol];
    const amount = choice.amount ?? bounds?.default;
    if (!bounds || !amount || !isPositiveDecimal(amount)) {
      throw new LinkExpansionError("LINK_INPUT_OUT_OF_BOUNDS", `Choose an amount of ${symbol}.`, [{ path: "amount", message: bounds ? `Between ${bounds.min} and ${bounds.max} ${symbol}.` : "No bounds for this asset." }]);
    }
    if (decimalsOf(amount) > resolved.decimals || compareDecimal(amount, bounds.min) < 0 || compareDecimal(amount, bounds.max) > 0) {
      throw new LinkExpansionError("LINK_INPUT_OUT_OF_BOUNDS", `This link takes ${bounds.min} to ${bounds.max} ${symbol}.`, [{ path: "amount", message: `Between ${bounds.min} and ${bounds.max} ${symbol}, at most ${resolved.decimals} decimals.` }]);
    }
    rootAmount = amount;
    if (same) {
      expansionCase = "direct";
      actions = [{ ...head, amount }, ...rest];
    } else if (choice.network === destinationNetwork) {
      expansionCase = "swap";
      actions = [{ kind: "swap", network: choice.network, from: resolved.id, to: destinationAsset.asset, amount }, { ...head, amount: "max" }, ...rest];
    } else {
      expansionCase = "bridge";
      actions = [
        { kind: "bridge", network: choice.network, from: resolved.id, to: destinationAsset.asset, toNetwork: destinationNetwork, amount },
        { ...head, amount: "max" },
        ...rest,
      ];
    }
  } else {
    if (choice.amount !== undefined) {
      throw new LinkExpansionError("LINK_INPUT_OUT_OF_BOUNDS", "This link delivers a fixed amount; the visitor does not choose it.", [{ path: "amount", message: "Leave amount out." }]);
    }
    if (same) {
      expansionCase = "deliver-direct";
      rootAmount = head.amount as string;
      actions = [head];
    } else if (choice.network === destinationNetwork) {
      throw new LinkExpansionError("LINK_SOURCE_NOT_ALLOWED", `On ${CHAINS[destinationNetwork].name} only ${destinationAsset.symbol} itself can pay this link.`, [{ path: "source.asset", message: `Use ${destinationAsset.symbol}.` }]);
    } else {
      expansionCase = "deliver-bridge";
      let target: string;
      try {
        target = toBaseUnits(head.amount as string, destinationAsset.decimals);
      } catch {
        throw new LinkExpansionError("LINK_PLAN_OUT_OF_BOUNDS", "The delivered amount does not fit the pinned destination asset.");
      }
      rootAmount = options.deliverInput ?? fromBaseUnits(linkDeliverFirstGuess(target, destinationAsset.decimals, resolved.decimals), resolved.decimals);
      if (!isPositiveDecimal(rootAmount) || decimalsOf(rootAmount) > resolved.decimals) {
        throw new LinkExpansionError("LINK_PLAN_OUT_OF_BOUNDS", "The sized deliver input is not a valid amount.");
      }
      // The transfer is absorbed into the bridge: one signature, paid to the pinned recipient.
      actions = [
        {
          kind: "bridge",
          network: choice.network,
          from: resolved.id,
          to: destinationAsset.asset,
          toNetwork: destinationNetwork,
          recipient: recipientPin(0),
          amount: rootAmount,
        },
      ];
    }
  }

  const vms = new Set<VirtualMachine>(actions.map((action) => CHAINS[action.network].vm));
  const networks: NetworkKey[] = [];
  for (const action of actions) for (const network of [action.network, action.toNetwork]) if (network && !networks.includes(network)) networks.push(network);
  return {
    case: expansionCase,
    actions,
    requiredVms: [...vms].sort(),
    envelope: {
      networks,
      recipients: [...new Set(pins.recipients.map((pin) => pin.account))],
      contracts: pins.contracts.map((pin) => ({ contract: pin.contract, revision: pin.revision, definitionHash: pin.definitionHash })),
      root: { network: choice.network, asset: resolved.id, amount: rootAmount },
    },
    destination: { network: destinationNetwork, asset: destinationAsset },
    source: { network: choice.network, asset: sourceRef },
  };
}

/* ==================================================================== blinks */

export interface BlinkState {
  /** Publisher domain verified (`/.well-known/kletia.json` lists the link or its key). */
  readonly domainVerified?: boolean;
  readonly status?: LinkStatus;
  /** KLETIA_BLINKS_ENABLED. */
  readonly blinksEnabled?: boolean;
  /** POST /v1/links/{id}/blink-approval. */
  readonly operatorApproved?: boolean;
  /** KLETIA_LINK_BLINK_REQUIRE_APPROVAL (default true on mainnet). */
  readonly requireApproval?: boolean;
}

export interface BlinkEligibility {
  /** Static rules 1-3: a Solana-only visitor flow of at most 3 steps. */
  readonly eligible: boolean;
  /** Eligible and every runtime condition (rule 4) holds. */
  readonly enabled: boolean;
  /** First reason it is not enabled, in plain words; null when enabled. */
  readonly reason: string | null;
  /** Funding assets a blink offers (those on the Solana funding network). */
  readonly assets: readonly string[];
  /** CAIP-2 of the blink's cluster. */
  readonly chain: string | null;
}

/**
 * Blink eligibility (intent-links design §6.2): Solana is a funding network,
 * every Solana funding choice expands to Solana-only signatures, at most 3
 * steps; then domain verified, link active, `blink: true`, blinks enabled
 * and, for links paying a pinned third party or calling a custom contract,
 * an operator approval.
 */
export function blinkEligibility(link: StoredLinkDefinition, state: BlinkState = {}): BlinkEligibility {
  const { definition, pins } = link;
  const testnet = definition.funding.networks.some((network) => CHAINS[network].environment === "testnet");
  const solana: NetworkKey = testnet ? "solana-devnet" : "solana";
  const chain = CHAINS[solana].id;
  const result = (eligible: boolean, reason: string | null, assets: readonly string[]): BlinkEligibility => ({
    eligible,
    enabled: eligible && reason === null,
    reason,
    assets,
    chain: eligible ? chain : null,
  });
  if (!definition.funding.networks.includes(solana)) return result(false, "Solana is not a funding network of this link.", []);
  const choices = definition.funding.assets.filter((symbol) => linkFundingAsset(solana, symbol) !== null);
  if (choices.length === 0) return result(false, "None of the funding assets exists on Solana.", []);
  for (const symbol of choices) {
    let expansion: LinkExpansion;
    try {
      const bounds = definition.funding.amount.mode === "input" ? definition.funding.amount.bounds[symbol] : undefined;
      expansion = expandLink(link, { network: solana, asset: symbol, ...(bounds ? { amount: bounds.default ?? bounds.min } : {}) });
    } catch (error) {
      return result(false, error instanceof Error ? error.message : "The Solana choices do not expand.", []);
    }
    if (expansion.requiredVms.some((vm) => vm !== "svm")) {
      const other = expansion.actions.find((action) => CHAINS[action.network].vm !== "svm");
      return result(false, `Visitors starting on Solana with ${symbol} would also sign on ${other ? CHAINS[other.network].name : "an EVM network"}.`, []);
    }
    if (expansion.actions.length > LINK_LIMITS.blinkMaxSteps) return result(false, `Starting with ${symbol} takes more than ${LINK_LIMITS.blinkMaxSteps} steps.`, []);
  }
  const thirdParty = pins.recipients.length > 0 || pins.contracts.length > 0 || definition.destination.actions.some((action) => action.kind === "action" || action.kind === "call");
  const reason = !definition.blink
    ? "The publisher did not enable the blink."
    : state.blinksEnabled === false
      ? "Blinks are disabled on this deployment."
      : state.status !== undefined && state.status !== "active"
        ? `The link is ${state.status}.`
        : state.domainVerified !== true
          ? "The publisher's domain is not verified."
          : thirdParty && (state.requireApproval ?? !testnet) && state.operatorApproved !== true
            ? "Blinks that pay a fixed third party or call a custom contract need operator approval."
            : null;
  return result(true, reason, choices);
}

/* ============================================================ board alphabet */

/** Characters the 5×7 departure-board face draws (besides space). */
export const BOARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:-/>$%()'&?_+#!@=~";

/**
 * Folds text to the departure-board alphabet (share cards, the page's
 * boards): NFKD with marks removed, `ı` → I, upper case, invisible
 * formatting dropped, whitespace collapsed, anything else → "?".
 */
export function boardText(text: string, options: { readonly maxLength?: number } = {}): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/ı/gu, "I")
    .toUpperCase()
    .replace(/\s+/gu, " ")
    .trim();
  let out = "";
  for (const char of folded) out += char === " " || BOARD_ALPHABET.includes(char) ? char : "?";
  if (options.maxLength !== undefined && [...out].length > options.maxLength) {
    out = `${[...out].slice(0, Math.max(0, options.maxLength - 3)).join("").trimEnd()}...`;
  }
  return out;
}

/** The asset descriptor of a CAIP-19 id in the registry (case-insensitive EVM addresses), or null. */
export function linkRegistryAsset(asset: string): AssetDescriptor | null {
  return getAsset(asset) ?? ASSETS.find((candidate) => candidate.id.toLowerCase() === asset.toLowerCase()) ?? null;
}
