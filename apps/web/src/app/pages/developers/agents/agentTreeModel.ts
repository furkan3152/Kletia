/**
 * The Agents page's model (docs/platform/subagents.md): the agent tree as
 * indented rows with cap and use bars, open sub-agent requests as approval
 * cards (what is granted, beside the parent's own value), the check of a
 * wallet message before the portal asks the wallet to sign it, and the
 * desk's one-line notice. Pure, no relative imports: the node tests load it
 * directly.
 */
import { SUBAGENT_REQUEST_ID_PATTERN } from "@kletia/core";

export type AgentMode = "live" | "dry-run" | "paused";

/** `GET /v1/agents/tree` node. */
export interface AgentNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "project" | "agent";
  readonly parentId: string | null;
  readonly depth: number;
  readonly expiresAt: string | null;
  readonly mode: AgentMode;
  readonly chainMode: AgentMode;
  readonly policyVersion: number | null;
  readonly caps: { readonly perStepUsd?: string; readonly perIntentUsd?: string; readonly dailyUsd?: string; readonly weeklyUsd?: string } | null;
  readonly usage: { readonly dayUsd: string; readonly weekUsd: string };
  readonly children: readonly AgentNode[];
}

export interface GrantLine {
  readonly path: string;
  readonly label: string;
  readonly child: string;
  readonly parent: string;
  readonly same: boolean;
}

/** `GET /v1/agents/tree` request. */
export interface SubagentRequest {
  readonly id: string;
  readonly status: "pending" | "approved" | "claimed" | "denied" | "expired" | "cancelled";
  readonly parentKeyId: string;
  readonly name: string;
  readonly purpose: string;
  readonly policyHash: string;
  readonly keyExpiresAt: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly kind: "wallet" | "key"; readonly id: string } | null;
  readonly childKeyId: string | null;
  readonly claimBy: string | null;
  readonly reason: string | null;
  readonly grant: readonly GrantLine[];
}

export interface UsageBar {
  readonly label: string;
  readonly usedUsd: string;
  /** null: no cap of its own (an ancestor's cap still applies). */
  readonly capUsd: string | null;
  /** 0-100 (clamped). */
  readonly percent: number;
  readonly tone: "ok" | "warn" | "full";
}

export interface TreeRow {
  readonly node: AgentNode;
  readonly indent: number;
  readonly bars: readonly UsageBar[];
  /** Paused by the project or an ancestor, not by its own rule book. */
  readonly pausedAbove: boolean;
  readonly descendants: number;
}

/** `1234.5` → `$1,234.50`. */
export function formatUsd(value: string | number): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "—";
  return `$${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bar(label: string, used: string, cap: string | undefined): UsageBar {
  const usedNumber = Number(used) || 0;
  if (cap === undefined) return { label, usedUsd: used, capUsd: null, percent: 0, tone: "ok" };
  const capNumber = Number(cap);
  const ratio = capNumber > 0 ? (usedNumber / capNumber) * 100 : usedNumber > 0 ? 100 : 0;
  return { label, usedUsd: used, capUsd: cap, percent: Math.min(100, Math.round(ratio)), tone: ratio >= 100 ? "full" : ratio >= 80 ? "warn" : "ok" };
}

/** The 24 h and 7 d windows of a key against its own caps. */
export function usageBars(node: AgentNode): UsageBar[] {
  return [bar("Last 24 h", node.usage.dayUsd, node.caps?.dailyUsd), bar("Last 7 days", node.usage.weekUsd, node.caps?.weeklyUsd)];
}

function count(node: AgentNode): number {
  return node.children.reduce((total, child) => total + 1 + count(child), 0);
}

/** Depth-first rows, each indented by its level in the tree as shown. */
export function treeRows(nodes: readonly AgentNode[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: AgentNode, indent: number) => {
    rows.push({ node, indent, bars: usageBars(node), pausedAbove: node.chainMode === "paused" && node.mode !== "paused", descendants: count(node) });
    for (const child of node.children) walk(child, indent + 1);
  };
  for (const node of nodes) walk(node, 0);
  return rows;
}

/* ================================================================ requests */

export interface ApprovalCard {
  readonly request: SubagentRequest;
  /** "expires in 3 h", "expires in 12 min". */
  readonly expiresIn: string;
  /** Lines where the sub-agent gets less than its parent. */
  readonly narrower: readonly GrantLine[];
  /** Lines where it gets exactly what the parent has. */
  readonly same: readonly GrantLine[];
  readonly permissions: string;
  readonly hashShort: string;
}

export function durationText(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Open requests (not lapsed at `now`), oldest first: what waits for a decision. */
export function approvalCards(requests: readonly SubagentRequest[], now: number): ApprovalCard[] {
  return requests
    .filter((request) => request.status === "pending" && Date.parse(request.expiresAt) > now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((request) => ({
      request,
      expiresIn: `expires in ${durationText(Date.parse(request.expiresAt) - now)}`,
      narrower: request.grant.filter((line) => !line.same && line.path !== "permissions"),
      same: request.grant.filter((line) => line.same && line.path !== "permissions"),
      permissions: request.grant.find((line) => line.path === "permissions")?.child ?? "none",
      hashShort: `${request.policyHash.slice(0, 15)}…${request.policyHash.slice(-6)}`,
    }));
}

const REASONS: Readonly<Record<string, string>> = {
  not_decided: "nobody decided in time",
  parent_inactive: "the parent stopped",
  claim_window: "not claimed within 15 minutes",
  mint_failed: "the key could not be minted",
};

/** One line for a decided request. */
export function requestStatusText(request: SubagentRequest, now: number): string {
  const by = request.decidedBy ? ` by ${request.decidedBy.kind === "wallet" ? `wallet ${request.decidedBy.id}` : request.decidedBy.id}` : "";
  switch (request.status) {
    case "pending":
      return "Waiting for a decision";
    case "approved":
      return `Approved${by}; the agent claims it ${request.claimBy && Date.parse(request.claimBy) > now ? `within ${durationText(Date.parse(request.claimBy) - now)}` : "now or never"}`;
    case "claimed":
      return `Approved${by} and claimed`;
    case "denied":
      return `Denied${by}`;
    case "expired":
      return `Lapsed: ${REASONS[request.reason ?? ""] ?? "expired"}`;
    case "cancelled":
      return `Cancelled: ${REASONS[request.reason ?? ""] ?? "cancelled"}`;
  }
}

/* ================================================================ signing */

export interface MessageExpectation {
  readonly host: string;
  readonly origin: string;
  readonly address: string;
  readonly decision: "approve" | "deny";
  readonly request: Pick<SubagentRequest, "id" | "policyHash" | "parentKeyId" | "keyExpiresAt">;
  readonly now: number;
}

function field(message: string, name: string): string | null {
  const match = new RegExp(`^${name}: (.*)$`, "mu").exec(message);
  return match?.[1] ?? null;
}

/**
 * What is wrong with a message the API asks the wallet to sign; empty when
 * it names this portal, this wallet, this decision, this request and its
 * rule book hash, and has not expired. The portal never asks for a
 * signature over anything else.
 */
export function approvalMessageProblems(message: string, expected: MessageExpectation): string[] {
  const problems: string[] = [];
  const lines = message.split("\n");
  if (!(lines[0] ?? "").startsWith(`${expected.host} wants you to decide a Kletia sub-agent request`)) problems.push("The message names another site.");
  if ((lines[1] ?? "").toLowerCase() !== expected.address.toLowerCase()) problems.push("The message names another wallet.");
  if (field(message, "Decision") !== expected.decision) problems.push(`The message does not ${expected.decision === "approve" ? "approve" : "deny"} this request.`);
  const requestId = field(message, "Request");
  if (requestId !== expected.request.id || !SUBAGENT_REQUEST_ID_PATTERN.test(requestId ?? "")) problems.push("The message names another request.");
  if (field(message, "Rule book") !== expected.request.policyHash) problems.push("The message names another rule book than the one shown.");
  if (field(message, "Parent") !== expected.request.parentKeyId) problems.push("The message names another parent key.");
  if (field(message, "Key expires") !== expected.request.keyExpiresAt) problems.push("The message names another key expiry.");
  if (field(message, "URI") !== `${expected.origin}/developers/agent-tree`) problems.push("The message names another page than this portal.");
  const expires = Date.parse(field(message, "Expiration Time") ?? "");
  if (!Number.isFinite(expires) || expires <= expected.now) problems.push("The message has expired; ask for a new one.");
  return problems;
}

/* ================================================================== desk */

/** The desk's notice for the connected wallet, or null when nothing waits. */
export function deskApprovalNotice(pending: number): { readonly text: string; readonly href: string } | null {
  if (!Number.isInteger(pending) || pending <= 0) return null;
  return {
    text: pending === 1 ? "A sub-agent request waits for your approval." : `${pending} sub-agent requests wait for your approval.`,
    href: "/developers/agent-tree",
  };
}
