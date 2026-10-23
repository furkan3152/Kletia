// Agents page model (docs/platform/subagents.md): tree rows with cap and use
// bars, approval cards beside the parent, the check of a wallet message
// before the portal asks a wallet to sign it, status lines and the desk notice.
//   node --test apps/web/src/app/pages/developers/__tests__/agentTreeModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { subagentApprovalMessage } from "@kletia/core";

import {
  approvalCards,
  approvalMessageProblems,
  deskApprovalNotice,
  durationText,
  formatUsd,
  requestStatusText,
  treeRows,
  usageBars,
} from "../agents/agentTreeModel.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");

function node(id, extra = {}) {
  return {
    id,
    name: id,
    kind: "agent",
    parentId: null,
    depth: 1,
    expiresAt: null,
    mode: "live",
    chainMode: "live",
    policyVersion: 1,
    caps: null,
    usage: { dayUsd: "0.00", weekUsd: "0.00" },
    children: [],
    ...extra,
  };
}

const REQUEST = {
  id: `sar_${"a".repeat(32)}`,
  status: "pending",
  parentKeyId: `key_${"b".repeat(24)}`,
  name: "invoice-payer",
  purpose: "Pays invoices.",
  policyHash: `sha256:${"c".repeat(64)}`,
  keyExpiresAt: "2026-10-30T12:00:00.000Z",
  createdAt: "2026-10-23T11:00:00.000Z",
  expiresAt: "2026-10-23T15:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  childKeyId: null,
  claimBy: null,
  reason: null,
  grant: [
    { path: "mode", label: "Mode", child: "live", parent: "live", same: true },
    { path: "networks.allow", label: "Networks", child: "base", parent: "base, solana", same: false },
    { path: "caps.dailyUsd", label: "Per 24 h", child: "$250", parent: "$1000", same: false },
    { path: "permissions", label: "Permissions", child: "storeIntents", parent: "createChildKeys, storeIntents", same: false },
  ],
};

test("tree rows indent depth-first and mark a subtree paused from above", () => {
  const child = node("key_child", { chainMode: "paused", caps: { dailyUsd: "100" }, usage: { dayUsd: "85.00", weekUsd: "85.00" } });
  const parent = node("key_parent", { mode: "paused", chainMode: "paused", children: [child] });
  const rows = treeRows([node("key_root", { kind: "project", depth: 0, children: [parent] })]);
  assert.deepEqual(rows.map((row) => [row.node.id, row.indent, row.descendants]), [["key_root", 0, 2], ["key_parent", 1, 1], ["key_child", 2, 0]]);
  assert.equal(rows[1].pausedAbove, false, "paused by its own rule book");
  assert.equal(rows[2].pausedAbove, true);
  const [day, week] = rows[2].bars;
  assert.deepEqual([day.percent, day.tone, day.capUsd], [85, "warn", "100"]);
  assert.deepEqual([week.capUsd, week.percent], [null, 0], "no weekly cap of its own");
  assert.deepEqual(usageBars(node("x", { caps: { dailyUsd: "50" }, usage: { dayUsd: "80.00", weekUsd: "0.00" } }))[0].percent, 100, "clamped at full");
  assert.equal(usageBars(node("x", { caps: { dailyUsd: "50" }, usage: { dayUsd: "80.00", weekUsd: "0.00" } }))[0].tone, "full");
});

test("approval cards list open requests oldest first, narrower lines apart from equal ones", () => {
  const later = { ...REQUEST, id: `sar_${"d".repeat(32)}`, createdAt: "2026-10-23T11:30:00.000Z" };
  const lapsed = { ...REQUEST, id: `sar_${"e".repeat(32)}`, expiresAt: "2026-10-23T11:59:00.000Z" };
  const cards = approvalCards([later, { ...REQUEST, status: "denied" }, lapsed, REQUEST], NOW);
  assert.deepEqual(cards.map((card) => card.request.id), [REQUEST.id, later.id]);
  assert.equal(cards[0].expiresIn, "expires in 3 h");
  assert.deepEqual(cards[0].narrower.map((line) => line.path), ["networks.allow", "caps.dailyUsd"]);
  assert.deepEqual(cards[0].same.map((line) => line.path), ["mode"]);
  assert.equal(cards[0].permissions, "storeIntents");
  assert.equal(durationText(5 * 60_000), "5 min");
  assert.equal(durationText(3 * 86_400_000), "3 days");
});

test("the portal signs only a message naming this site, wallet, decision, request and rule book", () => {
  const address = "0x4F183e308f24c81C05303821AD025812fBFd807D";
  const base = {
    origin: "https://kletiaai.xyz",
    walletKind: "evm",
    address,
    chainId: 8453,
    decision: "approve",
    requestId: REQUEST.id,
    projectId: `prj_key_${"f".repeat(24)}`,
    parentKeyId: REQUEST.parentKeyId,
    name: REQUEST.name,
    policyHash: REQUEST.policyHash,
    document: { schema: "kletia.policy/v1", caps: { dailyUsd: "250" }, permissions: { storeIntents: true } },
    keyExpiresAt: REQUEST.keyExpiresAt,
    nonce: "N0nceN0nceN0nceN0nce1234",
    issuedAt: "2026-10-23T12:00:00.000Z",
    expiresAt: "2026-10-23T12:10:00.000Z",
  };
  const expected = { host: "kletiaai.xyz", origin: "https://kletiaai.xyz", address: address.toLowerCase(), decision: "approve", request: REQUEST, now: NOW };
  assert.deepEqual(approvalMessageProblems(subagentApprovalMessage(base), expected), []);
  const problems = (input, extra = {}) => approvalMessageProblems(subagentApprovalMessage({ ...base, ...input }), { ...expected, ...extra });
  assert.deepEqual(problems({ origin: "https://evil.example" }), ["The message names another site.", "The message names another page than this portal."]);
  assert.deepEqual(problems({ decision: "deny" }), ["The message does not approve this request."]);
  assert.deepEqual(problems({ policyHash: `sha256:${"0".repeat(64)}` }), ["The message names another rule book than the one shown."]);
  assert.deepEqual(problems({ address: "0x1111111111111111111111111111111111111111" }), ["The message names another wallet."]);
  assert.deepEqual(problems({}, { now: Date.parse(base.expiresAt) }), ["The message has expired; ask for a new one."]);
  assert.deepEqual(problems({ keyExpiresAt: "2027-10-30T12:00:00.000Z" }), ["The message names another key expiry."]);
});

test("status lines and the desk notice", () => {
  const approved = { ...REQUEST, status: "approved", decidedBy: { kind: "wallet", id: "0x4F18…807D" }, claimBy: "2026-10-23T12:10:00.000Z" };
  assert.equal(requestStatusText(approved, NOW), "Approved by wallet 0x4F18…807D; the agent claims it within 10 min");
  assert.equal(requestStatusText({ ...REQUEST, status: "expired", reason: "claim_window" }, NOW), "Lapsed: not claimed within 15 minutes");
  assert.equal(requestStatusText({ ...REQUEST, status: "cancelled", reason: "parent_inactive" }, NOW), "Cancelled: the parent stopped");
  assert.equal(deskApprovalNotice(0), null);
  assert.deepEqual(deskApprovalNotice(1), { text: "A sub-agent request waits for your approval.", href: "/developers/agent-tree" });
  assert.equal(deskApprovalNotice(3)?.text, "3 sub-agent requests wait for your approval.");
  assert.equal(formatUsd("1234.5"), "$1,234.50");
});
