/**
 * Intent links (links design §3, §4, §8): creation (static validation,
 * pins, the publisher key's Rule Book, a representative dry run, domain
 * verification, activation delay), public and owner views, tighten-only
 * PATCH, soft delete, visitor quotes and intents, stats, abuse reports and
 * the operator's suspension and blink approval.
 *
 * Every link intent is an ordinary intent of the publisher key, planned by
 * the engine's `planLinkIntent` (expansion, deliver sizing, envelope check,
 * the key's Rule Book and BYOC scoping): a link adds no code path that skips
 * `createIntentDetailed` or `prepareStep`.
 */
import { createHash } from "node:crypto";
import {
  blinkEligibility,
  CHAINS,
  CONTRACT_ACTION_KINDS,
  domainFileListsLink,
  expandLink,
  isDecimalAmount,
  LINK_LIMITS,
  linkDestinationAsset,
  LinkExpansionError,
  linkFundingAsset,
  linkFundingOptions,
  linkNotices,
  normalizeAddress,
  normalizeWebOrigin,
  parseAccountId,
  reservedIntegratorName,
  resolveContractAsset,
  validateLinkDefinition,
  validateLinkIntentRequest,
  type AccountId,
  type AssetRef,
  type IntentActionSpec,
  type IntentGraph,
  type IntentPreview,
  type LinkDefinition,
  type LinkOwnerView,
  type LinkPins,
  type LinkStatus,
  type LinkView,
  type NetworkKey,
  type StoredLinkDefinition,
} from "@kletia/core";
import { isPlatformError, PlatformError, type PlatformIssue } from "../../errors.js";
import {
  chainGoverns,
  contractDirectory,
  linkPolicyCheck,
  looksLikeName,
  planLinkIntent,
  policyErrorDetails,
  resolveRecipientName,
  type PlannedLinkIntent,
} from "../../index.js";
import { guardedJsonRequest } from "../actionTransport.js";
import { isKeyRevoked } from "../auth.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "../context.js";
import { KeyWindowLimiter } from "../limits.js";
import { rememberIntentOwner } from "../owners.js";
import { assertAgentPermission } from "../policies/agentGuard.js";
import { readKeyChain } from "../policies/chain.js";
import { randomHex } from "../secrets.js";
import { isTemplateError } from "../sessions.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { publishLinkEvent } from "./events.js";
import { countLink, linkStatsReport, type LinkStatsWindow } from "./stats.js";
import { linkStore, type LinkPublisherRecord, type LinkRecord } from "./store.js";

/* ================================================================ settings */

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return fallback;
}

export function linksEnabled(): boolean {
  return envFlag("KLETIA_LINKS_ENABLED", true);
}

export function blinksEnabled(): boolean {
  return envFlag("KLETIA_BLINKS_ENABLED", true);
}

/** KLETIA_LINK_BLINK_REQUIRE_APPROVAL (default: required on mainnet, core decides). */
export function blinkApprovalRequired(): boolean | undefined {
  const raw = process.env.KLETIA_LINK_BLINK_REQUIRE_APPROVAL?.trim().toLowerCase();
  return raw === "false" ? false : raw === "true" ? true : undefined;
}

function activationDelaySeconds(): number {
  const raw = Number(process.env.KLETIA_LINK_ACTIVATION_DELAY_SECONDS ?? LINK_LIMITS.activationDelaySeconds);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), 7 * 86_400) : LINK_LIMITS.activationDelaySeconds;
}

export function assertLinksEnabled(): void {
  if (!linksEnabled()) throw new PlatformError("LINKS_DISABLED", "Intent links are switched off on this deployment. Retry later.", 503);
}

/** 60 creations per hour per key (links design §8). */
export const linkCreationLimiter = new KeyWindowLimiter(LINK_LIMITS.creationsPerHourPerKey, 60 * 60_000, "link creations per hour");
/** 5 visitor intents per 10 minutes per account (links design §8), across links. */
export const linkAccountLimiter = new KeyWindowLimiter(LINK_LIMITS.intentsPer10MinutesPerAccount, 10 * 60_000, "link intents per 10 minutes from one account", 20_000, "");

/* ============================================================= test seams */

export interface LinkChecks {
  /** True when `https://<website>/.well-known/kletia.json` lists the link or its key. */
  domain(website: string | undefined, linkId: string, keyId: string): Promise<boolean>;
  now(): number;
}

async function domainListsLink(website: string | undefined, linkId: string, keyId: string): Promise<boolean> {
  const origin = website ? normalizeWebOrigin(website, { allowPort: true }) : null;
  if (!origin) return false;
  try {
    const response = await guardedJsonRequest(`${origin}/.well-known/kletia.json`, { method: "GET", maxBytes: 16_384, timeoutMs: 5_000 });
    return response.status === 200 && domainFileListsLink(response.json, linkId, keyId);
  } catch {
    return false;
  }
}

const DEFAULT_CHECKS: LinkChecks = { domain: domainListsLink, now: () => Date.now() };
let checks: LinkChecks = DEFAULT_CHECKS;

/** Replaces the domain check and/or the clock (tests); null restores the defaults. */
export function configureLinkChecks(next: Partial<LinkChecks> | null): void {
  checks = next ? { ...DEFAULT_CHECKS, ...next } : DEFAULT_CHECKS;
}

export function linkClock(): number {
  return checks.now();
}

export function linkDomainCheck(website: string | undefined, linkId: string, keyId: string): Promise<boolean> {
  return checks.domain(website, linkId, keyId);
}

/* ================================================================== errors */

function linkNotFound(): HttpError {
  return new HttpError(404, "LINK_NOT_FOUND", "No link with this id.");
}

function withRetryAfter(error: PlatformError, seconds: number): PlatformError {
  Object.defineProperty(error, "retryAfterSeconds", { value: Math.max(1, Math.ceil(seconds)), enumerable: false });
  return error;
}

/** The refusal for a link that cannot take visitors now (status as of `now`). */
export function linkStatusError(record: LinkRecord, status: LinkStatus, now: number): PlatformError | null {
  switch (status) {
    case "pending":
      return withRetryAfter(
        new PlatformError("LINK_PENDING", "This link activates after a short delay (it pays a fixed third party or calls a custom contract). Retry after Retry-After.", 409),
        record.activatesAt ? (Date.parse(record.activatesAt) - now) / 1000 : 60,
      );
    case "paused":
      return new PlatformError("LINK_PAUSED", record.pausedReason && record.pausedReason !== "publisher"
        ? `This link paused itself (${record.pausedReason.replace(/_/gu, " ")}); its publisher must review and resume it.`
        : "The publisher paused this link.", 409);
    case "suspended":
      return new PlatformError("LINK_SUSPENDED", "Kletia suspended this link. Funds of steps already completed are in your wallet.", 409);
    case "expired":
      return new PlatformError("LINK_EXPIRED", "This link expired.", 410);
    case "deleted":
      return new PlatformError("LINK_EXPIRED", "This link was withdrawn by its publisher.", 410);
    case "exhausted":
      return withRetryAfter(new PlatformError("LINK_EXHAUSTED", "Every use of this link is reserved or taken. Uses of abandoned intents are released, so retry later.", 409), 60);
    default:
      return null;
  }
}

/* ================================================================== status */

/** Status as of `now` (expired and exhausted are derived; a due pending link reads active). */
export function effectiveLinkStatus(record: LinkRecord, now: number): LinkStatus {
  if (record.status === "deleted" || record.status === "suspended" || record.status === "paused") return record.status;
  if (Date.parse(record.expiresAt) <= now) return "expired";
  if (record.status === "pending" && (record.activatesAt === null || Date.parse(record.activatesAt) > now)) return "pending";
  if (record.maxUses !== null && record.used >= record.maxUses) return "exhausted";
  return "active";
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** Lazily activates a due pending link (one instance wins and emits `link.activated`). */
export async function settleLink(record: LinkRecord, now: number): Promise<LinkRecord> {
  if (record.status !== "pending" || record.activatesAt === null || Date.parse(record.activatesAt) > now) return record;
  const next: LinkRecord = { ...record, status: "active", activatesAt: null, updatedAt: iso(now) };
  if (await linkStore().update(next, record.updatedAt)) {
    publishLinkEvent("link.activated", { linkId: record.id, ownerKeyId: record.ownerKeyId, revision: record.revision });
    return next;
  }
  return (await linkStore().get(record.id)) ?? record;
}

/**
 * Applies `change` to the freshest stored link with an optimistic write,
 * retrying when another writer (or a reservation's activation) moved it.
 * `change` returns null to leave the link as it is.
 */
export async function mutateLink(record: LinkRecord, change: (fresh: LinkRecord) => Promise<LinkRecord | null> | LinkRecord | null): Promise<{ readonly before: LinkRecord; readonly after: LinkRecord } | null> {
  let current = record;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = await change(current);
    if (!next) return null;
    const stamped: LinkRecord = { ...next, updatedAt: iso(Math.max(linkClock(), Date.parse(current.updatedAt) + 1)) };
    if (await linkStore().update(stamped, current.updatedAt)) return { before: current, after: stamped };
    const fresh = await linkStore().get(record.id);
    if (!fresh) throw new HttpError(404, "LINK_NOT_FOUND", "No link with this id.");
    current = fresh;
  }
  throw new PlatformError("STORE_UNAVAILABLE", "The link kept changing while this update was applied. Retry shortly.", 503);
}

/** A stored link a visitor or owner may address (a revoked publisher key takes its links with it). */
export async function loadLink(id: string, now = linkClock()): Promise<LinkRecord> {
  const record = await linkStore().get(id);
  if (!record || (await isKeyRevoked(record.ownerKeyId))) throw linkNotFound();
  return settleLink(record, now);
}

/* ==================================================================== pins */

function accountOn(network: NetworkKey, address: string): AccountId {
  return `${CHAINS[network].id}:${normalizeAddress(CHAINS[network].namespace, address)}` as AccountId;
}

function contractUnknown(index: number, reference: string, network: NetworkKey): PlatformError {
  return new PlatformError("CONTRACT_UNKNOWN", `Unknown contract "${reference.slice(0, 64)}" for this API key on ${network}.`, 422, [
    { path: `destination.actions[${index}].contract`, message: "Unknown contract." },
  ]);
}

function hostOf(website: string | undefined): string | null {
  const origin = website ? normalizeWebOrigin(website, { allowPort: true }) : null;
  return origin ? new URL(origin).hostname.toLowerCase() : null;
}

/**
 * Resolves and pins what a link fixes (§3.3): names to addresses, aliases to
 * registration ids with their revision and definition hash, and the
 * destination asset. Throws CONTRACT_UNKNOWN / CONTRACT_ACTION_UNKNOWN for
 * registrations the key cannot use, LINK_PUBLISHER_MISMATCH when the
 * publisher is not the registration's integrator.
 */
export async function pinLink(ownerKeyId: string, definition: LinkDefinition): Promise<{ pins: LinkPins; actions: IntentActionSpec[] }> {
  const recipients: { action: number; account: AccountId; name?: string }[] = [];
  const contracts: LinkPins["contracts"][number][] = [];
  const actions: IntentActionSpec[] = [...definition.destination.actions];
  let destinationAsset: AssetRef | null = linkDestinationAsset(definition);
  for (const [index, action] of definition.destination.actions.entries()) {
    const network = action.toNetwork ?? action.network;
    if (CONTRACT_ACTION_KINDS.includes(action.kind)) {
      const directory = contractDirectory();
      if (!directory) throw new PlatformError("CONTRACTS_DISABLED", "Custom contract and Solana Action steps are disabled on this deployment.", 503);
      const reference = action.contract ?? "";
      const registration = await directory.resolve(ownerKeyId, reference, action.network);
      if (!registration || registration.definition.network !== action.network) throw contractUnknown(index, reference, action.network);
      const entry = registration.definition.actions.find((candidate) => candidate.id === action.entry);
      if (!entry) {
        throw new PlatformError("CONTRACT_ACTION_UNKNOWN", `No action "${String(action.entry)}" in ${registration.id}.`, 422, [
          { path: `destination.actions[${index}].entry`, message: "Unknown action id." },
        ]);
      }
      if (registration.activeRevision === null) {
        throw new PlatformError("CONTRACT_UNKNOWN", `${registration.id} has no active revision yet; create the link once it activates.`, 422, [
          { path: `destination.actions[${index}].contract`, message: "Not active yet." },
        ]);
      }
      const integrator = registration.definition.integrator;
      const sameName = integrator.name.trim().toLowerCase() === definition.publisher.name.trim().toLowerCase();
      const sameHost = hostOf(integrator.website) === hostOf(definition.publisher.website);
      if (!sameName || !sameHost) {
        throw new PlatformError("LINK_PUBLISHER_MISMATCH", `The publisher must be the integrator of ${registration.id} (${integrator.name}${integrator.website ? `, ${integrator.website}` : ""}).`, 422, [
          { path: "publisher", message: "Must match the registration's integrator name and website host." },
        ]);
      }
      if (action.recipient !== undefined && !("recipient" in entry && entry.recipient === "any")) {
        throw new PlatformError("LINK_DEFINITION_INVALID", `Entry ${entry.id} of ${registration.id} pays the visitor only; it cannot name a recipient.`, 400, [
          { path: `destination.actions[${index}].recipient`, message: "The entry does not accept third-party recipients." },
        ]);
      }
      const target = registration.definition.vm === "evm" ? registration.definition.address.toLowerCase() : registration.definition.origin;
      contracts.push({ action: index, contract: registration.id, revision: registration.activeRevision, definitionHash: registration.definitionHash, entry: entry.id, target });
      actions[index] = { ...action, contract: registration.id };
      if (index === 0) {
        const token = "input" in entry && entry.input ? entry.input.token : undefined;
        const input = token ? resolveContractAsset(registration.definition.network, token) : null;
        if (!input) {
          throw new PlatformError("LINK_DEFINITION_INVALID", `Entry ${entry.id} spends no input token, so a link cannot fund it.`, 400, [
            { path: "destination.actions[0].entry", message: "The first action must spend an input." },
          ]);
        }
        destinationAsset = { asset: input.id, symbol: input.symbol, decimals: input.decimals };
      }
    }
    if (action.recipient !== undefined) {
      const raw = action.recipient.trim();
      if (looksLikeName(raw)) {
        const resolution = await resolveRecipientName(raw, network);
        recipients.push({ action: index, account: accountOn(network, resolution.address), name: raw.toLowerCase() });
      } else {
        const parsed = parseAccountId(raw);
        const account = parsed ? accountOn(parsed.chain.key, parsed.address) : accountOn(network, raw);
        recipients.push({ action: index, account });
      }
    }
  }
  if (!destinationAsset) {
    throw new PlatformError("LINK_DEFINITION_INVALID", "The first destination action's input asset is not in the registry.", 400, [
      { path: "destination.actions[0].from", message: "Unknown asset on this network." },
    ]);
  }
  return { pins: { recipients, contracts, destinationAsset }, actions };
}

/* =================================================================== views */

function linkUrls(record: LinkRecord): LinkView["urls"] {
  const page = `${kletiaWebOrigin()}/go/${record.id}`;
  return { page, card: `${page}/card.png?v=${record.revision}`, square: `${page}/card.png?variant=square&v=${record.revision}` };
}

function publisherView(publisher: LinkPublisherRecord): LinkView["publisher"] {
  return {
    name: publisher.name,
    ...(publisher.website ? { website: publisher.website } : {}),
    ...(publisher.domain ? { domain: publisher.domain } : {}),
    domainVerified: publisher.domainVerified,
    ...(publisher.checkedAt ? { checkedAt: publisher.checkedAt } : {}),
  };
}

function actionLabel(action: IntentActionSpec): string {
  const amount = action.amount === "$amount" ? "your amount of" : action.amount === "max" ? "all" : action.amount;
  const parts: string[] = [action.kind.charAt(0).toUpperCase() + action.kind.slice(1)];
  if (amount) parts.push(amount);
  if (action.from) parts.push(action.from);
  if (action.to) parts.push(`to ${action.to}`);
  parts.push(`on ${CHAINS[action.network].name}`);
  if (action.toNetwork && action.toNetwork !== action.network) parts.push(`to ${CHAINS[action.toNetwork].name}`);
  return parts.join(" ").slice(0, 160);
}

export function blinkStateOf(record: LinkRecord, now: number) {
  return blinkEligibility({ definition: record.definition, pins: record.pins }, {
    domainVerified: record.publisher.domainVerified,
    status: effectiveLinkStatus(record, now),
    blinksEnabled: blinksEnabled(),
    operatorApproved: record.blinkApprovedAt !== null,
    ...(blinkApprovalRequired() !== undefined ? { requireApproval: blinkApprovalRequired() as boolean } : {}),
  });
}

/** Public view (§3.6): what a visitor needs to judge the link; never the owner, pins beyond what is printed, or metadata. */
export async function publicLinkView(record: LinkRecord, now = linkClock()): Promise<LinkView> {
  const { definition, pins } = record;
  const directory = contractDirectory();
  const actions = await Promise.all(definition.destination.actions.map(async (action, index) => {
    const pin = pins.contracts.find((entry) => entry.action === index);
    let contract: LinkView["destination"]["actions"][number]["contract"];
    let label = actionLabel(action);
    if (pin) {
      const registration = directory ? await directory.current(pin.contract).catch(() => null) : null;
      const entry = registration?.definition.actions.find((candidate) => candidate.id === pin.entry);
      if (entry) label = entry.label;
      contract = {
        id: pin.contract,
        address: pin.target,
        integrator: registration?.definition.integrator.name ?? record.publisher.name,
        ...(registration?.verification.source?.status ? { source: registration.verification.source.status } : {}),
        domainVerified: registration?.verification.domain.verified ?? false,
        revision: pin.revision,
      };
    }
    return { kind: action.kind, network: action.network, label, ...(contract ? { contract } : {}) };
  }));
  const blink = blinkStateOf(record, now);
  const first = definition.destination.actions[0] as IntentActionSpec;
  return {
    id: record.id,
    status: effectiveLinkStatus(record, now),
    revision: record.revision,
    title: definition.title,
    ...(definition.description ? { description: definition.description } : {}),
    publisher: publisherView(record.publisher),
    destination: { network: first.network, asset: pins.destinationAsset, actions },
    fixed: {
      recipients: pins.recipients.map((pin) => {
        const account = parseAccountId(pin.account);
        return { network: account?.chain.key ?? first.network, address: account?.address ?? pin.account, ...(pin.name ? { name: pin.name } : {}) };
      }),
      contracts: pins.contracts.map((pin) => ({
        network: definition.destination.actions[pin.action]?.network ?? first.network,
        address: pin.target,
        label: actions[pin.action]?.label ?? pin.entry,
      })),
    },
    funding: definition.funding,
    expiresAt: definition.expiresAt,
    activatesAt: record.status === "pending" ? record.activatesAt : null,
    uses: { max: record.maxUses, left: record.maxUses === null ? null : Math.max(0, record.maxUses - record.used) },
    perAccount: definition.perAccount ?? null,
    blink: { enabled: blink.enabled, eligible: blink.eligible, reason: blink.reason },
    urls: linkUrls(record),
    notices: linkNotices(record.publisher.name),
  };
}

export async function ownerLinkView(record: LinkRecord, now = linkClock(), withStats = false): Promise<LinkOwnerView> {
  const view = await publicLinkView(record, now);
  const stats = withStats ? (await linkStatsReport(record.id, "7d", now)).totals : undefined;
  return {
    ...view,
    definition: record.definition,
    pins: record.pins,
    ownerKeyId: record.ownerKeyId,
    pausedReason: record.pausedReason,
    suspendedReason: record.suspendedReason,
    ...(stats ? { stats } : {}),
  };
}

/* ================================================================ owners */

function ownerKey(auth: AuthContext): string {
  if (!auth.keyId || auth.tier === "public") throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key.");
  return auth.keyId;
}

/** The owner key, an ancestor of it, or a project key of its project may manage a link; others read it as unknown. */
async function canManage(auth: AuthContext, record: LinkRecord): Promise<boolean> {
  if (!auth.keyId) return false;
  if (auth.keyId === record.ownerKeyId) return true;
  if (!auth.projectId || auth.projectId !== record.projectId) return false;
  if (auth.keyKind !== "agent") return true;
  const chain = await readKeyChain(record.ownerKeyId);
  return chain?.lineage.includes(auth.keyId) ?? false;
}

async function managedLink(auth: AuthContext, id: string): Promise<LinkRecord> {
  ownerKey(auth);
  const record = await loadLink(id);
  if (!(await canManage(auth, record))) throw linkNotFound();
  return record;
}

/* =============================================================== creation */

function definitionError(code: "LINK_DEFINITION_INVALID" | "LINK_SOURCE_NOT_ALLOWED", issues: readonly PlatformIssue[]): PlatformError {
  return code === "LINK_SOURCE_NOT_ALLOWED"
    ? new PlatformError("LINK_SOURCE_NOT_ALLOWED", "Some funding networks and assets cannot reach the destination; see issues.", 422, issues)
    : new PlatformError("LINK_DEFINITION_INVALID", "The link definition is invalid; fix the fields listed in issues (validateLinkDefinition in @kletia/core reports the same locally).", 400, issues);
}

function policyConflict(message: string, issues: readonly PlatformIssue[]): PlatformError {
  return new PlatformError("LINK_POLICY_CONFLICT", message, 422, issues);
}

/** The representative funding choice of a link (first funding network and asset, default or minimum amount). */
export function representativeChoice(definition: LinkDefinition): { network: NetworkKey; asset: string; amount?: string } | null {
  const option = linkFundingOptions(definition.funding)[0];
  if (!option) return null;
  if (definition.funding.amount.mode === "deliver") return { network: option.network, asset: option.symbol };
  const bounds = definition.funding.amount.bounds[option.symbol];
  return { network: option.network, asset: option.symbol, ...(bounds ? { amount: bounds.default ?? bounds.min } : {}) };
}

/** Every funding choice must expand (core) before anything is stored. */
function assertExpandable(stored: StoredLinkDefinition): void {
  const issues: PlatformIssue[] = [];
  for (const option of linkFundingOptions(stored.definition.funding)) {
    const bounds = stored.definition.funding.amount.mode === "input" ? stored.definition.funding.amount.bounds[option.symbol] : undefined;
    try {
      expandLink(stored, { network: option.network, asset: option.symbol, ...(bounds ? { amount: bounds.min } : {}) });
    } catch (error) {
      if (error instanceof LinkExpansionError) issues.push({ path: "funding", message: `${option.symbol} on ${option.network}: ${error.message}`.slice(0, 300) });
      else throw error;
    }
  }
  if (issues.length > 0) throw new PlatformError("LINK_SOURCE_NOT_ALLOWED", "Some funding networks and assets cannot reach the destination; see issues.", 422, issues);
}

/** POST /v1/links. */
export async function createLink(auth: AuthContext, body: unknown): Promise<LinkOwnerView> {
  assertLinksEnabled();
  const owner = ownerKey(auth);
  await assertAgentPermission(auth, "links");
  const now = linkClock();
  const validated = validateLinkDefinition(body, { now });
  if (!validated.ok) throw definitionError(validated.code, validated.issues.map((issue) => ({ path: issue.path, message: issue.message })));
  linkCreationLimiter.take(owner, now);
  const id = `lk_${randomHex(12)}`;
  const pinned = await pinLink(owner, validated.value);
  const definition: LinkDefinition = { ...validated.value, destination: { actions: pinned.actions } };
  const stored: StoredLinkDefinition = { definition, pins: pinned.pins };
  assertExpandable(stored);

  // The publisher key's Rule Book bounds the link (§8): statically, then on a representative plan.
  const chain = await readKeyChain(owner, now);
  if (!chain || !chain.keyActive) throw new HttpError(401, "API_KEY_REQUIRED", "This API key is revoked or expired.");
  if (chainGoverns(chain)) {
    const check = await linkPolicyCheck({ link: stored, levels: chain.levels, now });
    if (check.conflicts.length > 0) {
      throw policyConflict(
        `The rule book of this key refuses intents this link can produce (${[...new Set(check.conflicts.map((entry) => entry.rule))].join(", ")}). Tighten the link or use another key.`,
        check.conflicts.slice(0, 20).map((entry) => ({ path: entry.path ?? entry.rule, message: `${entry.message} (${entry.rule})`.slice(0, 300) })),
      );
    }
    if (check.holds.length > 0 && definition.allowHolds !== true) {
      throw policyConflict(
        "Intents from this link would be held for approval by the key's rule book; set allowHolds: true to publish it anyway (the page says so).",
        check.holds.slice(0, 20).map((entry) => ({ path: entry.path ?? entry.rule, message: `${entry.message} (${entry.rule})`.slice(0, 300) })),
      );
    }
  }
  const choice = representativeChoice(definition);
  if (choice) {
    try {
      await planLinkIntent({ link: stored, linkId: id, ownerKeyId: owner, choice, accounts: [], dryRun: true, indicative: true, publisherVerified: true });
    } catch (error) {
      const details = policyErrorDetails(error);
      if (details) {
        throw policyConflict(
          `The rule book of this key refuses the link's representative intent (${[...new Set(details.violations.map((entry) => entry.rule))].join(", ")}).`,
          details.violations.slice(0, 20).map((entry) => ({ path: entry.path ?? entry.rule, message: `${entry.message} (${entry.rule})`.slice(0, 300) })),
        );
      }
      if (isTemplateError(error) || (isPlatformError(error) && error.code.startsWith("LINK_") && error.code !== "LINK_DELIVERY_UNQUOTABLE")) throw error;
      // Quotes, providers and balances do not block a link: visitors get fresh quotes.
    }
  }

  const website = definition.publisher.website;
  const verified = website ? await linkDomainCheck(website, id, owner) : false;
  const reserved = reservedIntegratorName(definition.publisher.name);
  if (reserved && !verified) {
    throw new PlatformError("LINK_DEFINITION_INVALID", `"${definition.publisher.name}" uses a reserved name; publish it from ${reserved.hosts.join(" or ")} with a /.well-known/kletia.json that lists this key.`, 400, [
      { path: "publisher.name", message: "Reserved name without a verified domain." },
    ]);
  }
  const first = definition.destination.actions[0] as IntentActionSpec;
  const production = CHAINS[first.network].lane === "production";
  const thirdParty = pinned.pins.recipients.length > 0 || pinned.pins.contracts.length > 0;
  const delay = production && thirdParty ? activationDelaySeconds() : 0;
  const record: LinkRecord = {
    id,
    ownerKeyId: owner,
    projectId: auth.projectId ?? null,
    status: delay > 0 ? "pending" : "active",
    revision: 1,
    definition,
    pins: pinned.pins,
    publisher: {
      name: definition.publisher.name,
      ...(website ? { website, domain: hostOf(website) ?? undefined } : {}),
      domainVerified: verified,
      ...(website ? { checkedAt: iso(now) } : {}),
    } as LinkPublisherRecord,
    maxUses: definition.maxUses ?? null,
    used: 0,
    expiresAt: definition.expiresAt,
    activatesAt: delay > 0 ? iso(now + delay * 1000) : null,
    blinkApprovedAt: null,
    pausedReason: null,
    suspendedReason: null,
    flags: {},
    createdAt: iso(now),
    updatedAt: iso(now),
  };
  await linkStore().create(record, LINK_LIMITS.activeLinksPerKey, now);
  publishLinkEvent("link.created", { linkId: id, ownerKeyId: owner, revision: 1, ...(delay > 0 ? { reason: "activation_delay" } : {}) });
  return ownerLinkView(record, now);
}

/** GET /v1/links. */
export async function listLinks(auth: AuthContext, status: string | undefined, limit: number): Promise<LinkOwnerView[]> {
  const owner = ownerKey(auth);
  const stored = ["pending", "active", "paused", "suspended", "deleted"];
  if (status !== undefined && !stored.includes(status)) {
    throw invalidRequest(`status must be one of ${stored.join(", ")}.`, [{ path: "status", message: "Unknown status." }]);
  }
  const now = linkClock();
  const records = await linkStore().listByOwner(owner, { ...(status ? { status: status as LinkRecord["status"] } : {}), limit });
  return Promise.all(records.map(async (record) => ownerLinkView(await settleLink(record, now), now)));
}

/** GET /v1/links/{id}: the owner view for its managers, the public view for everyone else. */
export async function getLinkView(auth: AuthContext, id: string): Promise<LinkView | LinkOwnerView> {
  const now = linkClock();
  const record = await loadLink(id, now);
  if (auth.keyId && (await canManage(auth, record))) return ownerLinkView(record, now, true);
  if (record.status === "deleted") throw linkStatusError(record, "deleted", now) as PlatformError;
  return publicLinkView(record, now);
}

/* =================================================================== patch */

function immutable(path: string, message: string): PlatformError {
  return new PlatformError("LINK_IMMUTABLE_FIELD", `${message} Create a new link instead: a link's promise to people who reviewed it never grows.`, 422, [{ path, message }]);
}

function decimalCompare(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const width = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(width, "0"));
  const right = BigInt(bWhole + bFraction.padEnd(width, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

const PATCH_FIELDS = ["title", "description", "status", "accept", "funding", "maxUses", "perAccount", "expiresAt", "blink"];

/** PATCH /v1/links/{id}: tighten only (§3.8). */
export async function patchLink(auth: AuthContext, id: string, body: unknown): Promise<LinkOwnerView> {
  assertLinksEnabled();
  const initial = await managedLink(auth, id);
  const now = linkClock();
  if (!isRecord(body) || Object.keys(body).length === 0) throw invalidRequest("Send the fields to change.", [{ path: "", message: "Expected a non-empty object." }]);
  for (const key of Object.keys(body)) if (!PATCH_FIELDS.includes(key)) throw immutable(key, `${key} cannot change.`);
  if (initial.status === "deleted") throw linkStatusError(initial, "deleted", now) as PlatformError;
  if (initial.status === "suspended") throw linkStatusError(initial, "suspended", now) as PlatformError;
  const apply = async (record: LinkRecord): Promise<LinkRecord> => {
    const current = record.definition;
    let next: LinkDefinition = { ...current };
    let definitionChanged = false;

    if (body.title !== undefined || body.description !== undefined) {
      next = { ...next, ...(body.title !== undefined ? { title: body.title as string } : {}), ...(body.description !== undefined ? { description: body.description as string } : {}) };
      definitionChanged = true;
    }
    if (body.funding !== undefined) {
      if (!isRecord(body.funding)) throw invalidRequest("funding must be an object.", [{ path: "funding", message: "Expected an object." }]);
      const funding = body.funding;
      const networks = funding.networks === undefined ? current.funding.networks : funding.networks;
      const assets = funding.assets === undefined ? current.funding.assets : funding.assets;
      if (!Array.isArray(networks) || networks.some((network) => !current.funding.networks.includes(network as NetworkKey))) throw immutable("funding.networks", "Funding networks can only be removed.");
      if (!Array.isArray(assets) || assets.some((asset) => !current.funding.assets.includes(asset as string))) throw immutable("funding.assets", "Funding assets can only be removed.");
      let amount = current.funding.amount;
      if (funding.amount !== undefined) {
        if (!isRecord(funding.amount) || funding.amount.mode !== current.funding.amount.mode) throw immutable("funding.amount.mode", "The amount mode cannot change.");
        if (current.funding.amount.mode === "input") {
          const bounds = isRecord(funding.amount.bounds) ? funding.amount.bounds : {};
          const merged: Record<string, { min: string; max: string; default?: string }> = {};
          for (const symbol of assets as string[]) {
            const before = current.funding.amount.bounds[symbol];
            if (!before) continue;
            const update = isRecord(bounds[symbol]) ? (bounds[symbol] as Record<string, unknown>) : {};
            const min = typeof update.min === "string" ? update.min : before.min;
            const max = typeof update.max === "string" ? update.max : before.max;
            if (!isDecimalAmount(min) || !isDecimalAmount(max)) throw invalidRequest(`Bounds of ${symbol} must be decimals.`, [{ path: `funding.amount.bounds.${symbol}`, message: "Invalid decimal." }]);
            if (decimalCompare(min, before.min) < 0) throw immutable(`funding.amount.bounds.${symbol}.min`, "A minimum can only rise.");
            if (decimalCompare(max, before.max) > 0) throw immutable(`funding.amount.bounds.${symbol}.max`, "A maximum can only fall.");
            const fallback = before.default !== undefined && decimalCompare(before.default, min) >= 0 && decimalCompare(before.default, max) <= 0 ? before.default : undefined;
            const chosen = typeof update.default === "string" ? update.default : fallback;
            merged[symbol] = { min, max, ...(chosen !== undefined ? { default: chosen } : {}) };
          }
          amount = { mode: "input", bounds: merged };
        }
      } else if (current.funding.amount.mode === "input") {
        amount = { mode: "input", bounds: Object.fromEntries(Object.entries(current.funding.amount.bounds).filter(([symbol]) => (assets as string[]).includes(symbol))) };
      }
      next = { ...next, funding: { networks: networks as NetworkKey[], assets: assets as string[], amount } };
      definitionChanged = true;
    }
    let maxUses = record.maxUses;
    if (body.maxUses !== undefined) {
      if (typeof body.maxUses !== "number" || !Number.isInteger(body.maxUses) || body.maxUses < 1) throw invalidRequest("maxUses must be a positive integer.", [{ path: "maxUses", message: "Invalid." }]);
      if (record.maxUses !== null && body.maxUses > record.maxUses) throw immutable("maxUses", "maxUses can only fall.");
      if (body.maxUses < record.used) throw invalidRequest(`maxUses cannot fall below the ${record.used} uses already reserved or taken.`, [{ path: "maxUses", message: "Below used." }]);
      maxUses = body.maxUses;
      next = { ...next, maxUses };
      definitionChanged = true;
    }
    if (body.perAccount !== undefined) {
      const value = isRecord(body.perAccount) ? body.perAccount.maxUses : undefined;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalidRequest("perAccount.maxUses must be a positive integer.", [{ path: "perAccount.maxUses", message: "Invalid." }]);
      if (current.perAccount && value > current.perAccount.maxUses) throw immutable("perAccount.maxUses", "perAccount.maxUses can only fall.");
      next = { ...next, perAccount: { maxUses: value } };
      definitionChanged = true;
    }
    if (body.expiresAt !== undefined) {
      const at = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
      if (!Number.isFinite(at) || at <= now) throw invalidRequest("expiresAt must be a future ISO time.", [{ path: "expiresAt", message: "Invalid time." }]);
      if (at > Date.parse(current.expiresAt)) throw immutable("expiresAt", "A link can only expire earlier.");
      next = { ...next, expiresAt: iso(at) };
      definitionChanged = true;
    }
    if (body.blink !== undefined) {
      if (body.blink !== false && !(body.blink === true && current.blink)) throw immutable("blink", "A blink can only be turned off.");
      next = { ...next, blink: body.blink === true };
      definitionChanged = definitionChanged || body.blink !== current.blink;
    }
    if (definitionChanged) {
      // The merged definition passes the same static rules as a new link (bounds within decimals, defaults inside bounds).
      const { expiresAt: _expires, ...rest } = next;
      const revalidated = validateLinkDefinition({ ...rest, expiresAt: next.expiresAt }, { now });
      if (!revalidated.ok) throw definitionError(revalidated.code, revalidated.issues.map((issue) => ({ path: issue.path, message: issue.message })));
      next = { ...revalidated.value, destination: current.destination };
    }

    let status = record.status;
    let pausedReason = record.pausedReason;
    let pins = record.pins;
    let activatesAt = record.activatesAt;
    let repinned = false;
    if (body.status !== undefined) {
      if (body.status === "paused") {
        status = "paused";
        pausedReason = record.status === "paused" ? record.pausedReason : "publisher";
      } else if (body.status === "active") {
        if (record.status === "paused") {
          const auto = record.pausedReason === "recipient_changed" || record.pausedReason === "contract_changed";
          const accepted = Array.isArray(body.accept) && body.accept.includes(record.pausedReason);
          if (auto && !accepted) {
            const hint = `Resume with { "status": "active", "accept": ["${String(record.pausedReason)}"] } to pin the new state.`;
            if (record.pausedReason === "recipient_changed") throw new PlatformError("LINK_RECIPIENT_CHANGED", `This link paused itself (recipient changed). ${hint}`, 409);
            throw new PlatformError("LINK_CONTRACT_CHANGED", `This link paused itself (contract changed). ${hint}`, 409);
          }
          if (auto) {
            // Re-pin what changed: a new revision, and on mainnet a new activation delay.
            const fresh = await pinLink(record.ownerKeyId, { ...current, destination: { actions: current.destination.actions } });
            pins = fresh.pins;
            repinned = true;
          }
          const first = current.destination.actions[0] as IntentActionSpec;
          const delay = repinned && CHAINS[first.network].lane === "production" && (pins.recipients.length > 0 || pins.contracts.length > 0) ? activationDelaySeconds() : 0;
          status = delay > 0 ? "pending" : "active";
          activatesAt = delay > 0 ? iso(now + delay * 1000) : null;
          pausedReason = null;
        }
      } else {
        throw invalidRequest("status must be paused or active.", [{ path: "status", message: "Expected paused or active." }]);
      }
    } else if (body.accept !== undefined) {
      throw invalidRequest("accept goes with { \"status\": \"active\" }.", [{ path: "accept", message: "Only when resuming." }]);
    }
    const updated: LinkRecord = {
      ...record,
      status,
      pausedReason,
      pins,
      activatesAt,
      definition: definitionChanged ? next : record.definition,
      maxUses,
      expiresAt: definitionChanged ? next.expiresAt : record.expiresAt,
      revision: definitionChanged || repinned ? record.revision + 1 : record.revision,
    };
    return updated;
  };
  const result = await mutateLink(initial, apply);
  if (!result) return ownerLinkView(initial, now);
  const { before, after: updated } = result;
  if (updated.status === "paused" && before.status !== "paused") publishLinkEvent("link.paused", { linkId: id, ownerKeyId: before.ownerKeyId, revision: updated.revision, reason: "publisher" });
  else publishLinkEvent("link.updated", { linkId: id, ownerKeyId: before.ownerKeyId, revision: updated.revision, ...(updated.status !== before.status ? { reason: `status_${updated.status}` } : {}) });
  return ownerLinkView(updated, now);
}

/** DELETE /v1/links/{id}: soft delete (idempotent). */
export async function deleteLink(auth: AuthContext, id: string): Promise<void> {
  const record = await managedLink(auth, id);
  const result = await mutateLink(record, (fresh) => (fresh.status === "deleted" ? null : { ...fresh, status: "deleted" }));
  if (result) publishLinkEvent("link.deleted", { linkId: id, ownerKeyId: record.ownerKeyId, revision: record.revision });
}

/** Pauses a link whose pinned name or registration drifted (§3.7 step 4); idempotent. */
export async function pauseForDrift(record: LinkRecord, reason: "recipient_changed" | "contract_changed", now = linkClock()): Promise<void> {
  void now;
  const result = await mutateLink(record, (fresh) =>
    fresh.status === "paused" || fresh.status === "deleted" || fresh.status === "suspended" ? null : { ...fresh, status: "paused", pausedReason: reason });
  if (result) publishLinkEvent("link.paused", { linkId: record.id, ownerKeyId: record.ownerKeyId, revision: record.revision, reason });
}

/* ========================================================= visitor intents */

/** The visitor's funding choice and accounts (strips the optional clientReference). */
function parseVisitorBody(body: unknown, accountsOptional: boolean): { choice: { network: NetworkKey; asset: string; amount?: string }; accounts: readonly AccountId[]; clientReference?: string } {
  const input = isRecord(body) ? { ...body } : body;
  let clientReference: string | undefined;
  if (isRecord(input) && input.clientReference !== undefined) {
    if (typeof input.clientReference !== "string") throw invalidRequest("clientReference must be a string.", [{ path: "clientReference", message: "Invalid." }]);
    clientReference = input.clientReference;
    delete input.clientReference;
  }
  const validated = validateLinkIntentRequest(input, { accountsOptional });
  if (!validated.ok) throw invalidRequest("The request is invalid.", validated.issues);
  const { source, amount, accounts } = validated.value;
  return { choice: { network: source.network, asset: source.asset, ...(amount !== undefined ? { amount } : {}) }, accounts, ...(clientReference ? { clientReference } : {}) };
}

function sourceDimension(choice: { network: NetworkKey; asset: string }): string {
  const asset = linkFundingAsset(choice.network, choice.asset);
  return `${choice.network}:${asset?.symbol ?? choice.asset.slice(0, 40)}`;
}

/** Plans through the engine; pin drift pauses the link before the error leaves. */
async function plan(record: LinkRecord, input: Omit<Parameters<typeof planLinkIntent>[0], "link" | "linkId" | "ownerKeyId" | "publisherVerified">): Promise<PlannedLinkIntent> {
  try {
    return await planLinkIntent({
      link: { definition: record.definition, pins: record.pins },
      linkId: record.id,
      ownerKeyId: record.ownerKeyId,
      publisherVerified: record.publisher.domainVerified,
      ...input,
    });
  } catch (error) {
    const drift = (error as { readonly drift?: { readonly reason?: string } }).drift;
    if (isPlatformError(error) && (drift?.reason === "recipient_changed" || drift?.reason === "contract_changed")) {
      await pauseForDrift(record, drift.reason).catch((pauseError: unknown) => {
        console.warn(`[platform] pausing link ${record.id} failed:`, pauseError instanceof Error ? pauseError.message : pauseError);
      });
    }
    throw error;
  }
}

function assertVisitable(record: LinkRecord, now: number): void {
  assertLinksEnabled();
  const refusal = linkStatusError(record, effectiveLinkStatus(record, now), now);
  if (refusal) throw refusal;
}

/** Per-link salted pseudonym of the source account (only for links that set perAccount). */
export function accountHash(linkId: string, account: string): string {
  return createHash("sha256").update(`${linkId}:${account.toLowerCase()}`, "utf8").digest("hex");
}

const QUOTE_CACHE_MS = LINK_LIMITS.quoteCacheSeconds * 1000;
const quoteCache = new Map<string, { readonly value: { intent: IntentGraph; preview: IntentPreview }; readonly expiresAt: number }>();

/** POST /v1/links/{id}/quote (public): an indicative or account-specific dry run, cached 20 s. */
export async function quoteLink(id: string, body: unknown): Promise<{ intent: IntentGraph; preview: IntentPreview; cached: boolean }> {
  const now = linkClock();
  const record = await loadLink(id, now);
  assertVisitable(record, now);
  const { choice, accounts } = parseVisitorBody(body, true);
  countLink(record.id, "quote", { dimension: sourceDimension(choice) });
  const key = `${record.id}|${record.revision}|${choice.network}|${choice.asset.toLowerCase()}|${choice.amount ?? ""}|${[...accounts].sort().join(",")}`;
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > now) return { ...cached.value, cached: true };
  const planned = await plan(record, { choice, accounts, dryRun: true, ...(accounts.length === 0 ? { indicative: true } : {}) });
  const value = { intent: planned.intent, preview: planned.preview };
  quoteCache.set(key, { value, expiresAt: now + QUOTE_CACHE_MS });
  while (quoteCache.size > 2_000) {
    const oldest = quoteCache.keys().next().value;
    if (oldest === undefined) break;
    quoteCache.delete(oldest);
  }
  return { ...value, cached: false };
}

/** POST /v1/links/{id}/intents (public): the visitor's intent, owned by the publisher key. */
export async function createLinkIntent(id: string, body: unknown): Promise<PlannedLinkIntent> {
  const now = linkClock();
  const record = await loadLink(id, now);
  assertVisitable(record, now);
  const { choice, accounts, clientReference } = parseVisitorBody(body, false);
  for (const account of new Set(accounts.map((entry) => entry.toLowerCase()))) linkAccountLimiter.take(account, now);
  // The per-account limit is checked early (the reservation at prepare is authoritative).
  const perAccount = record.definition.perAccount?.maxUses;
  if (perAccount !== undefined) {
    const sourceVm = CHAINS[choice.network].vm;
    const source = accounts.find((account) => parseAccountId(account)?.chain.vm === sourceVm);
    if (source && (await linkStore().accountUses(record.id, accountHash(record.id, source))) >= perAccount) {
      throw new PlatformError("LINK_ACCOUNT_LIMIT", "This account reached the link's per-account limit.", 409);
    }
  }
  const planned = await plan(record, { choice, accounts, dryRun: false, ...(clientReference ? { clientReference } : {}) });
  if (!planned.replayed) {
    rememberIntentOwner(planned.intent.id, record.ownerKeyId);
    countLink(record.id, "intent", { dimension: sourceDimension(choice) });
  }
  return planned;
}

/* ============================================================ owner reads */

export async function linkStats(auth: AuthContext, id: string, window: string | undefined) {
  const record = await managedLink(auth, id);
  const chosen = (window ?? "7d") as LinkStatsWindow;
  if (!["7d", "30d", "90d"].includes(chosen)) throw invalidRequest("window must be 7d, 30d or 90d.", [{ path: "window", message: "Unknown window." }]);
  return linkStatsReport(record.id, chosen, linkClock());
}

/* ================================================================= reports */

const REPORT_REASONS = ["phishing", "impersonation", "broken", "other"] as const;

/** POST /v1/links/{id}/report (public): a counted reason, never free text or personal data. */
export async function reportLink(id: string, body: unknown): Promise<void> {
  const record = await loadLink(id);
  const reason = isRecord(body) ? body.reason : undefined;
  if (typeof reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(reason) || (isRecord(body) && Object.keys(body).length !== 1)) {
    throw invalidRequest(`Body must be { "reason": ${REPORT_REASONS.map((entry) => `"${entry}"`).join(" | ")} }.`, [{ path: "reason", message: "Unknown reason." }]);
  }
  countLink(record.id, "report", { dimension: reason });
}

/* ================================================================ operator */

function assertOperator(auth: AuthContext): void {
  if (auth.tier !== "operator") throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an operator API key.");
}

/** POST /v1/links/{id}/suspend (operator). */
export async function suspendLink(auth: AuthContext, id: string, body: unknown): Promise<LinkOwnerView> {
  assertOperator(auth);
  const reason = isRecord(body) && typeof body.reason === "string" && /^[a-z0-9_]{2,40}$/u.test(body.reason) ? body.reason : null;
  if (!reason) throw invalidRequest("Body must be { \"reason\": \"<lower_snake_case>\" }.", [{ path: "reason", message: "Required." }]);
  const record = await loadLink(id);
  if (record.status === "deleted") throw linkStatusError(record, "deleted", linkClock()) as PlatformError;
  const now = linkClock();
  const result = await mutateLink(record, (fresh) => (fresh.status === "deleted" ? null : { ...fresh, status: "suspended", suspendedReason: reason }));
  if (!result) throw linkStatusError(record, "deleted", now) as PlatformError;
  publishLinkEvent("link.suspended", { linkId: id, ownerKeyId: record.ownerKeyId, revision: record.revision, reason });
  return ownerLinkView(result.after, now);
}

/** POST /v1/links/{id}/blink-approval (operator): `{ "approved": true | false }`. */
export async function approveBlink(auth: AuthContext, id: string, body: unknown): Promise<LinkOwnerView> {
  assertOperator(auth);
  if (!isRecord(body) || typeof body.approved !== "boolean") throw invalidRequest("Body must be { \"approved\": true | false }.", [{ path: "approved", message: "Required boolean." }]);
  const record = await loadLink(id);
  const now = linkClock();
  if (body.approved) {
    const eligibility = blinkStateOf(record, now);
    if (!eligibility.eligible) throw new PlatformError("LINK_NOT_BLINK_ELIGIBLE", eligibility.reason ?? "This link cannot be a blink.", 422);
  }
  const approved = body.approved;
  const result = await mutateLink(record, (fresh) => ({ ...fresh, blinkApprovedAt: approved ? iso(now) : null }));
  publishLinkEvent("link.updated", { linkId: id, ownerKeyId: record.ownerKeyId, revision: record.revision, reason: approved ? "blink_approved" : "blink_revoked" });
  return ownerLinkView(result?.after ?? record, now);
}
