/**
 * Sub-agents (docs/platform/subagents.md): an agent key with
 * `permissions.createChildKeys` asks for a child agent key; the project's
 * owner wallet or a project key approves it. This module is the pure part:
 *
 * - `checkSubagentPolicy`: the requested rule book must be a subset of every
 *   level of the parent's effective chain (project, ancestors, parent), field
 *   by field, and never grant a management permission; it returns the
 *   document to mint, with every permission written out;
 * - `describeSubagentGrant`: what is granted in plain words, and a diff
 *   against the parent's own rule book (portal, MCP, the request view);
 * - `subagentApprovalMessage`: the Sign-In-With-Ethereum / Solana shaped
 *   text the owner's wallet signs to approve or deny a request.
 *
 * Fails closed: anything the checker cannot prove narrower is an issue.
 */
import { parseAccountId } from "./caip.js";
import {
  AGENT_POLICY_DEFAULTS,
  formatUsdMicros,
  normalizeAccountPattern,
  OBSERVER_POLICY,
  POLICY_LIMITS,
  POLICY_MODES,
  POLICY_PERMISSIONS,
  policyUsdMicros,
  RECIPIENT_MODES,
  RECIPIENT_NAME_RULES,
  scheduleBitmap,
  type PolicyDefaults,
  type PolicyDocument,
  type PolicyPermission,
} from "./policy.js";
import { effectivePermissions, effectivePerps } from "./policyEvaluate.js";

export const SUBAGENT_LIMITS = Object.freeze({
  /** Agent keys below a project key (the limit of every agent key). */
  maxDepth: POLICY_LIMITS.maxAgentDepth,
  /** Active children and open requests of one parent, together. */
  childrenPerParent: 10,
  openRequestsPerParent: 5,
  /** How long a request stays open for a decision. */
  requestTtlSeconds: 86_400,
  /** How long after the approval the requester may claim the key. */
  claimWindowSeconds: 900,
  /** Lifetime of a wallet approval message. */
  challengeTtlSeconds: 600,
  defaultTtlSeconds: 604_800,
  nameLength: 64,
  purposeLength: 280,
});

/** Request ids: `sar_` + 32 hex (128 bits). */
export const SUBAGENT_REQUEST_ID_PATTERN = /^sar_[0-9a-f]{32}$/u;
/** Claim tokens: `kl_scl_` + 32 random bytes, base64url. */
export const SUBAGENT_CLAIM_TOKEN_PATTERN = /^kl_scl_[A-Za-z0-9_-]{43}$/u;
/** Permissions a sub-agent never gets: it never manages webhooks, contracts, sessions, links or automations. */
export const SUBAGENT_NEVER_PERMISSIONS: readonly PolicyPermission[] = Object.freeze(["webhooks", "registerContracts", "sessions", "links", "automations"]);

export type SubagentRequestStatus = "pending" | "approved" | "claimed" | "denied" | "expired" | "cancelled";
export const SUBAGENT_REQUEST_STATUSES: readonly SubagentRequestStatus[] = Object.freeze(["pending", "approved", "claimed", "denied", "expired", "cancelled"]);
export type SubagentDecision = "approve" | "deny";

/** One level of the parent's chain, root first (the parent last). */
export interface SubagentChainLevel {
  readonly policy: PolicyDocument | null;
  readonly defaults: PolicyDefaults;
  /** Key id or `prj_…`, named in issues. */
  readonly id?: string;
}

export interface SubagentIssue {
  readonly path: string;
  /** The level the child would be wider than (null: not about one level). */
  readonly levelId: string | null;
  readonly message: string;
}

export interface SubagentCheckInput {
  readonly child: PolicyDocument;
  /** The parent's effective chain, root first. */
  readonly chain: readonly SubagentChainLevel[];
  /** Levels below the project key the child would sit at. */
  readonly childDepth: number;
  readonly childExpiresAt?: string;
  /** The parent's expiry (null: none). */
  readonly parentExpiresAt?: string | null;
}

export type SubagentCheckResult =
  | { readonly ok: true; readonly issues: readonly []; readonly document: PolicyDocument }
  | { readonly ok: false; readonly issues: readonly SubagentIssue[]; readonly document: null };

/* ============================================================ effective */

type ContractEntry = { readonly id: string; readonly entries?: readonly string[] };

const modeOf = (policy: PolicyDocument | null, defaults: PolicyDefaults) => policy?.mode ?? (defaults === "agent" && !policy ? "dry-run" : "live");
const recipientModeOf = (policy: PolicyDocument | null, defaults: PolicyDefaults) => policy?.recipients?.mode ?? (defaults === "agent" ? "own" : "any");
const unlistedOf = (policy: PolicyDocument | null, defaults: PolicyDefaults) => policy?.assets?.unlisted ?? (defaults === "agent" ? "deny" : "allow");
const contractsOf = (policy: PolicyDocument | null, defaults: PolicyDefaults): readonly ContractEntry[] | null =>
  policy?.contracts?.allow ?? (defaults === "agent" ? AGENT_POLICY_DEFAULTS.contractsAllow : null);
const pinOf = (policy: PolicyDocument | null, defaults: PolicyDefaults) => policy?.execution?.pinNonce ?? (defaults === "agent" ? AGENT_POLICY_DEFAULTS.pinNonce : false);
const namesRank = (rule: string | undefined) => RECIPIENT_NAME_RULES.length - 1 - RECIPIENT_NAME_RULES.indexOf((rule ?? "resolve") as never);
const recipientRank = (mode: string) => RECIPIENT_MODES.length - 1 - RECIPIENT_MODES.indexOf(mode as never);

/** Account and recipient patterns: equal, or an exact account covered by `<namespace>:*:<address>`. */
function accountCovered(entry: string, by: string): boolean {
  if (entry === by) return true;
  const wildcard = /^(eip155|solana):\*:(.+)$/u.exec(by);
  if (!wildcard || entry.includes(":*:")) return false;
  const parsed = parseAccountId(entry);
  if (!parsed || parsed.chain.namespace !== wildcard[1]) return false;
  const address = parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
  return normalizeAccountPattern(by) === `${wildcard[1]}:*:${address}`;
}

/** Asset entries: equal, or `SYMBOL@network` covered by `SYMBOL`. */
function assetCovered(entry: string, by: string): boolean {
  if (entry === by) return true;
  const at = entry.lastIndexOf("@");
  return at > 0 && !entry.includes("/") && entry.slice(0, at) === by;
}

const exact = (entry: string, by: string) => entry === by;

/* ============================================================== checker */

class Issues {
  readonly list: SubagentIssue[] = [];
  add(path: string, levelId: string | null, message: string): void {
    if (!this.list.some((issue) => issue.path === path && issue.levelId === levelId)) this.list.push({ path, levelId, message });
  }
}

function levelName(level: SubagentChainLevel, index: number): string {
  return level.id ?? (level.defaults === "project" && index === 0 ? "the project" : `level ${index}`);
}

/** null = everything. */
function subsetOf(issues: Issues, path: string, levelId: string, child: readonly string[] | null, level: readonly string[] | null, covered = exact): void {
  if (level === null) return;
  if (child === null) {
    issues.add(path, levelId, `${levelId} allows only ${level.length === 0 ? "nothing" : level.join(", ")}; list a subset (absent means every value).`);
    return;
  }
  const extra = child.filter((entry) => !level.some((by) => covered(entry, by)));
  if (extra.length > 0) issues.add(path, levelId, `${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not allowed by ${levelId}.`);
}

function supersetOf(issues: Issues, path: string, levelId: string, child: readonly string[], level: readonly string[]): void {
  const missing = level.filter((entry) => !child.includes(entry));
  if (missing.length > 0) issues.add(path, levelId, `Keep ${levelId}'s ${missing.join(", ")} in the list.`);
}

/** Lower is tighter; undefined = unlimited. */
function atMost(issues: Issues, path: string, levelId: string, child: bigint | undefined, level: bigint | undefined, show: (value: bigint) => string = String): void {
  if (level === undefined) return;
  if (child === undefined) issues.add(path, levelId, `${levelId} sets ${path} to ${show(level)}; set it here too, at most that.`);
  else if (child > level) issues.add(path, levelId, `${show(child)} is above ${levelId}'s ${show(level)}.`);
}

const usdOf = (value: string | undefined) => (value === undefined ? undefined : policyUsdMicros(value));
const intOf = (value: number | undefined) => (value === undefined ? undefined : BigInt(value));
const dollarsOf = (micros: bigint) => `$${formatUsdMicros(micros).replace(/\.00$/u, "")}`;

function contractsCovered(child: readonly ContractEntry[], level: readonly ContractEntry[]): string[] {
  return child
    .filter((entry) => {
      const match = level.find((candidate) => candidate.id === entry.id);
      if (!match) return true;
      if (!match.entries) return false;
      return entry.entries === undefined || entry.entries.some((name) => !match.entries?.includes(name));
    })
    .map((entry) => entry.id);
}

function checkLevel(issues: Issues, child: PolicyDocument, level: SubagentChainLevel, levelId: string): void {
  const defaults = level.defaults;
  // An agent without a rule book is the observer; a project level without one restricts nothing.
  const own = level.policy ?? (defaults === "agent" ? OBSERVER_POLICY : null);
  if (!own) return;
  if (POLICY_MODES.indexOf(child.mode ?? "live") < POLICY_MODES.indexOf(modeOf(own, defaults))) {
    issues.add("mode", levelId, `${levelId} is ${modeOf(own, defaults)}; the sub-agent cannot be ${child.mode ?? "live"}.`);
  }
  subsetOf(issues, "networks.allow", levelId, child.networks?.allow ?? null, own.networks?.allow ?? null);
  subsetOf(issues, "networks.lanes", levelId, child.networks?.lanes ?? null, own.networks?.lanes ?? null);
  subsetOf(issues, "kinds.allow", levelId, child.kinds?.allow ?? null, own.kinds?.allow ?? null);
  subsetOf(issues, "protocols.allow", levelId, child.protocols?.allow ?? null, own.protocols?.allow ?? null);
  supersetOf(issues, "protocols.deny", levelId, child.protocols?.deny ?? [], own.protocols?.deny ?? []);
  const levelContracts = contractsOf(own, defaults);
  if (levelContracts !== null) {
    const wider = contractsCovered(contractsOf(child, "agent") ?? [], levelContracts);
    if (wider.length > 0) issues.add("contracts.allow", levelId, `${wider.join(", ")} (or those entries) are not allowed by ${levelId}.`);
  }
  subsetOf(issues, "assets.allow", levelId, child.assets?.allow ?? null, own.assets?.allow ?? null, assetCovered);
  subsetOf(issues, "assets.categories", levelId, child.assets?.categories ?? null, own.assets?.categories ?? null);
  if (unlistedOf(own, defaults) === "deny" && unlistedOf(child, "agent") !== "deny") issues.add("assets.unlisted", levelId, `${levelId} denies unlisted assets.`);
  subsetOf(issues, "accounts.allow", levelId, child.accounts?.allow ?? null, own.accounts?.allow ?? null, accountCovered);
  const levelMode = recipientModeOf(own, defaults);
  const childMode = recipientModeOf(child, "agent");
  if (recipientRank(childMode) < recipientRank(levelMode)) issues.add("recipients.mode", levelId, `${levelId} allows recipients "${levelMode}"; "${childMode}" is wider.`);
  else if (levelMode === "allowlist" && childMode === "allowlist") {
    subsetOf(issues, "recipients.allow", levelId, child.recipients?.allow ?? [], own.recipients?.allow ?? [], accountCovered);
  }
  supersetOf(issues, "recipients.deny", levelId, child.recipients?.deny ?? [], own.recipients?.deny ?? []);
  if (namesRank(child.recipients?.names) < namesRank(own.recipients?.names)) {
    issues.add("recipients.names", levelId, `${levelId} treats names as "${own.recipients?.names ?? "resolve"}"; "${child.recipients?.names ?? "resolve"}" is wider.`);
  }
  for (const field of ["maxSteps", "maxSlippageBps", "maxSeconds"] as const) {
    atMost(issues, `limits.${field}`, levelId, intOf(child.limits?.[field]), intOf(own.limits?.[field]));
  }
  for (const field of ["maxExtraCostUsd", "maxFeeUsd"] as const) {
    atMost(issues, `limits.${field}`, levelId, usdOf(child.limits?.[field]), usdOf(own.limits?.[field]), dollarsOf);
  }
  for (const cap of ["perStepUsd", "perIntentUsd", "dailyUsd", "weeklyUsd"] as const) {
    atMost(issues, `caps.${cap}`, levelId, usdOf(child.caps?.[cap]), usdOf(own.caps?.[cap]), dollarsOf);
  }
  if (own.schedule) {
    if (!child.schedule) issues.add("schedule", levelId, `${levelId} has a timetable (${own.schedule.timezone}); set one inside it.`);
    else if (child.schedule.timezone !== own.schedule.timezone) issues.add("schedule", levelId, `Use ${levelId}'s time zone (${own.schedule.timezone}).`);
    else {
      const allowed = scheduleBitmap(own.schedule);
      const wanted = scheduleBitmap(child.schedule);
      if (wanted.some((open, minute) => open === 1 && allowed[minute] !== 1)) issues.add("schedule", levelId, `The timetable opens outside ${levelId}'s windows.`);
    }
  }
  atMost(issues, "confirm.aboveUsd", levelId, usdOf(child.confirm?.aboveUsd), usdOf(own.confirm?.aboveUsd), dollarsOf);
  supersetOf(issues, "confirm.when", levelId, child.confirm?.when ?? [], own.confirm?.when ?? []);
  if (own.confirm?.approvers?.requireWallet && !child.confirm?.approvers?.requireWallet) issues.add("confirm.approvers.requireWallet", levelId, `${levelId} requires a wallet approver.`);
  const ttl = (document: PolicyDocument) => BigInt(document.confirm?.ttlSeconds ?? POLICY_LIMITS.defaultConfirmTtlSeconds);
  if (ttl(child) > ttl(own)) issues.add("confirm.ttlSeconds", levelId, `Approvals wait at most ${ttl(own)} s under ${levelId}.`);
  if (pinOf(own, defaults) && !pinOf(child, "agent")) issues.add("execution.pinNonce", levelId, `${levelId} pins nonces.`);
  if ((child.amendments?.delaySeconds ?? 0) < (own.amendments?.delaySeconds ?? 0)) {
    issues.add("amendments.delaySeconds", levelId, `${levelId} delays loosening by ${own.amendments?.delaySeconds} s; use at least that.`);
  }
}

/** Approver identities the child may name: only ones some level of the chain already lists. */
function checkApprovers(issues: Issues, child: PolicyDocument, chain: readonly SubagentChainLevel[]): void {
  const wallets = new Set(chain.flatMap((level) => level.policy?.confirm?.approvers?.wallets ?? []));
  const keys = new Set(chain.flatMap((level) => level.policy?.confirm?.approvers?.keys ?? []));
  const strangers = (child.confirm?.approvers?.wallets ?? []).filter((wallet) => ![...wallets].some((by) => accountCovered(wallet, by)));
  if (strangers.length > 0) issues.add("confirm.approvers.wallets", null, `Only approver wallets the chain already lists may be named (${strangers.join(", ")} is new).`);
  const newKeys = (child.confirm?.approvers?.keys ?? []).filter((key) => !keys.has(key));
  if (newKeys.length > 0) issues.add("confirm.approvers.keys", null, `Only approver keys the chain already lists may be named (${newKeys.join(", ")} is new).`);
}

/**
 * The permissions the minted rule book carries: each one written out,
 * `true` only when asked for (absent: the agent default, which grants
 * `storeIntents` only), granted by the parent's chain, never a management
 * permission, and `createChildKeys` only above the depth limit. Asking for
 * one the chain cannot give is an issue.
 */
function permissionsOf(issues: Issues, child: PolicyDocument, chain: readonly SubagentChainLevel[], childDepth: number): Record<PolicyPermission, boolean> {
  const parent = effectivePermissions(chain.map((level) => ({ policy: level.policy, defaults: level.defaults })));
  const out = {} as Record<PolicyPermission, boolean>;
  for (const permission of POLICY_PERMISSIONS) {
    const asked = child.permissions?.[permission];
    const wanted = asked ?? AGENT_POLICY_DEFAULTS.permissions[permission];
    let allowed = parent[permission];
    let reason = "the parent's chain does not grant it";
    if (SUBAGENT_NEVER_PERMISSIONS.includes(permission)) {
      allowed = false;
      reason = "sub-agents never manage webhooks, contracts, sessions, links or automations";
    } else if (permission === "createChildKeys" && childDepth >= SUBAGENT_LIMITS.maxDepth) {
      allowed = false;
      reason = `a key at depth ${childDepth} cannot have children (limit ${SUBAGENT_LIMITS.maxDepth})`;
    }
    if (asked === true && !allowed) issues.add(`permissions.${permission}`, null, `permissions.${permission} cannot be granted: ${reason}.`);
    out[permission] = wanted && allowed;
  }
  return out;
}

/**
 * Checks a requested sub-agent rule book against the parent's effective
 * chain. On success `document` is what gets minted: the request with every
 * permission written out. Pure; the server reads the chain fresh both when
 * the request is filed and when it is approved.
 */
export function checkSubagentPolicy(input: SubagentCheckInput): SubagentCheckResult {
  const issues = new Issues();
  const { child, chain } = input;
  if (chain.length === 0) issues.add("", null, "The parent's chain could not be read.");
  if (input.childDepth > SUBAGENT_LIMITS.maxDepth) issues.add("depth", null, `Agent keys sit at most ${SUBAGENT_LIMITS.maxDepth} levels below a project key.`);
  chain.forEach((level, index) => checkLevel(issues, child, level, levelName(level, index)));
  checkApprovers(issues, child, chain);
  const permissions = permissionsOf(issues, child, chain, input.childDepth);
  checkPerps(issues, child, chain);
  if (input.childExpiresAt !== undefined) {
    const at = Date.parse(input.childExpiresAt);
    if (Number.isNaN(at)) issues.add("expiresAt", null, "The expiry is not a time.");
    else if (input.parentExpiresAt && at > Date.parse(input.parentExpiresAt)) issues.add("expiresAt", null, `The sub-agent cannot outlive its parent (${input.parentExpiresAt}).`);
  }
  if (issues.list.length > 0) return { ok: false, issues: issues.list, document: null };
  return { ok: true, issues: [], document: { ...child, permissions } };
}

/**
 * Perps (Rule Book `perps`): a sub-agent may trade perps only where its
 * parent's chain does, at no higher leverage and on no other venue. The
 * runtime intersects the whole chain anyway; this refuses the request up
 * front so the approver never sees a grant that would not hold.
 */
function checkPerps(issues: Issues, child: PolicyDocument, chain: readonly SubagentChainLevel[]): void {
  const perps = child.perps;
  if (!perps?.enabled) return;
  const parent = effectivePerps(chain.map((level) => ({ policy: level.policy, defaults: level.defaults })));
  if (!parent.enabled) {
    issues.add("perps.enabled", null, `perps cannot be enabled: ${parent.reason ?? "the parent's chain does not trade perps"}`);
    return;
  }
  if (perps.maxLeverage === undefined || perps.maxLeverage > parent.maxLeverage) {
    issues.add("perps.maxLeverage", null, `perps.maxLeverage must be set and at most ${parent.maxLeverage} (the parent's cap).`);
  }
  const outside = (perps.venues ?? []).filter((venue) => !parent.venues.includes(venue));
  if (!perps.venues || outside.length > 0) {
    issues.add("perps.venues", null, `perps.venues must list only venues the parent may use (${parent.venues.join(", ") || "none"}).`);
  }
}

/* =========================================================== description */

export interface SubagentGrantLine {
  readonly path: string;
  readonly label: string;
  /** What the sub-agent gets. */
  readonly child: string;
  /** What its parent has (its own rule book with agent defaults). */
  readonly parent: string;
  /** True when the sub-agent gets exactly what the parent has. */
  readonly same: boolean;
}

const listText = (values: readonly string[] | undefined, none = "any") => (values === undefined ? none : values.length === 0 ? "none" : values.join(", "));
const usdLabel = (value: string | undefined) => (value === undefined ? "no cap" : `$${value}`);

/** Plain facts of one rule book (agent defaults filled), keyed by path, in display order. */
function facts(document: PolicyDocument | null, defaults: PolicyDefaults): [string, string, string][] {
  const policy = document ?? (defaults === "agent" ? OBSERVER_POLICY : null);
  const permissions = POLICY_PERMISSIONS.filter((permission) => policy?.permissions?.[permission] ?? (defaults === "agent" ? AGENT_POLICY_DEFAULTS.permissions[permission] : true));
  return [
    ["mode", "Mode", modeOf(policy, defaults)],
    ["networks.allow", "Networks", listText(policy?.networks?.allow)],
    ["networks.lanes", "Lanes", listText(policy?.networks?.lanes)],
    ["kinds.allow", "Actions", listText(policy?.kinds?.allow)],
    ["protocols.allow", "Venues", listText(policy?.protocols?.allow)],
    ["assets.allow", "Assets", listText(policy?.assets?.allow, policy?.assets?.categories ? `categories ${policy.assets.categories.join(", ")}` : "any")],
    ["recipients.mode", "Recipients", `${recipientModeOf(policy, defaults)}${policy?.recipients?.allow ? ` (${policy.recipients.allow.length} listed)` : ""}`],
    ["caps.perStepUsd", "Per step", usdLabel(policy?.caps?.perStepUsd)],
    ["caps.perIntentUsd", "Per intent", usdLabel(policy?.caps?.perIntentUsd)],
    ["caps.dailyUsd", "Per 24 h", usdLabel(policy?.caps?.dailyUsd)],
    ["caps.weeklyUsd", "Per 7 days", usdLabel(policy?.caps?.weeklyUsd)],
    ["schedule", "Timetable", policy?.schedule ? `${policy.schedule.windows.length} window(s), ${policy.schedule.timezone}` : "always"],
    ["confirm.aboveUsd", "Approval above", usdLabel(policy?.confirm?.aboveUsd).replace("no cap", "never")],
    ["permissions", "Permissions", permissions.length === 0 ? "none" : permissions.join(", ")],
  ];
}

/** What a request grants, line by line, with the parent's value beside it. */
export function describeSubagentGrant(child: PolicyDocument, parent: PolicyDocument | null): SubagentGrantLine[] {
  const parentFacts = new Map(facts(parent, "agent").map(([path, , value]) => [path, value]));
  return facts(child, "agent").map(([path, label, value]) => {
    const parentValue = parentFacts.get(path) ?? "";
    return { path, label, child: value, parent: parentValue, same: value === parentValue };
  });
}

/** Caps of a rule book in one line (the approval message and notifications). */
export function subagentCapsText(document: PolicyDocument): string {
  const caps = document.caps ?? {};
  const parts = [
    caps.perStepUsd ? `$${caps.perStepUsd} per step` : null,
    caps.perIntentUsd ? `$${caps.perIntentUsd} per intent` : null,
    caps.dailyUsd ? `$${caps.dailyUsd} per 24 h` : null,
    caps.weeklyUsd ? `$${caps.weeklyUsd} per 7 days` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "none of its own (the parent's caps apply)";
}

/* ============================================================== message */

export interface SubagentApprovalMessageInput {
  /** The portal origin, e.g. `https://kletiaai.xyz`. */
  readonly origin: string;
  readonly walletKind: "evm" | "solana";
  /** As displayed (EIP-55 checksum for EVM). */
  readonly address: string;
  /** EVM chain id; null for Solana. */
  readonly chainId: number | null;
  readonly decision: SubagentDecision;
  readonly requestId: string;
  /** `prj_…` */
  readonly projectId: string;
  readonly parentKeyId: string;
  readonly name: string;
  readonly policyHash: string;
  /** The rule book being granted (permissions written out). */
  readonly document: PolicyDocument;
  readonly keyExpiresAt: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const oneLine = (value: string) => value.replace(/[\r\n]+/gu, " ").trim();

/**
 * The text an owner's wallet signs to decide a request (EIP-191
 * personal_sign or Solana signMessage). It follows the Sign-In-With-Ethereum
 * layout (domain, address, statement, URI, version, chain, nonce, times) so
 * wallets show it as a sign-in style request bound to the portal's domain,
 * and names exactly what is granted.
 */
export function subagentApprovalMessage(input: SubagentApprovalMessageInput): string {
  const host = new URL(input.origin).host;
  const account = input.walletKind === "evm" ? "Ethereum" : "Solana";
  const permissions = POLICY_PERMISSIONS.filter((permission) => input.document.permissions?.[permission] === true);
  const verb = input.decision === "approve" ? "Approve" : "Deny";
  return [
    `${host} wants you to decide a Kletia sub-agent request with your ${account} account:`,
    input.address,
    "",
    `${verb} sub-agent "${oneLine(input.name)}" under agent key ${input.parentKeyId}.`,
    "",
    `Decision: ${input.decision}`,
    `Request: ${input.requestId}`,
    `Project: ${input.projectId}`,
    `Parent: ${input.parentKeyId}`,
    `Rule book: ${input.policyHash}`,
    `Caps: ${subagentCapsText(input.document)}`,
    `Networks: ${listText(input.document.networks?.allow)}`,
    `Actions: ${listText(input.document.kinds?.allow)}`,
    `Permissions: ${permissions.length > 0 ? permissions.join(", ") : "none"}`,
    `Key expires: ${input.keyExpiresAt}`,
    `URI: ${input.origin}/developers/agent-tree`,
    "Version: 1",
    `Chain ID: ${input.chainId === null ? "mainnet" : input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
  ].join("\n");
}

/** The nonce line of an approval message, or null. */
export function subagentMessageNonce(message: string): string | null {
  const match = /^Nonce: ([A-Za-z0-9]{16,64})$/mu.exec(message);
  return match?.[1] ?? null;
}
