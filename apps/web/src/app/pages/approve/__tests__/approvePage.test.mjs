// The approval gate's pure parts and the public routes' table entries. Run with
//   node --test apps/web/src/app/pages/approve/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { approvalMessageText, approvalTypedData } from "@kletia/core";

import { LINK_PATH_PATTERN, matchRoute, RECEIPT_PATH_PATTERN, ROUTES } from "../../../routes/routeTable.ts";
import {
  approvalSerial,
  approvalState,
  digestGroups,
  formatUsd,
  legLine,
  maskedMatches,
  parseApprovalFragment,
  recipientNetwork,
  timeLeft,
  triggerWords,
  walletFamily,
} from "../approveModel.ts";

const ID = `apr_${"ab".repeat(16)}`;

test("the approval id is read from the fragment only, in its exact shape", () => {
  assert.deepEqual(parseApprovalFragment(`#${ID}`), { kind: "approval", id: ID });
  assert.deepEqual(parseApprovalFragment(`#approval=${ID}`), { kind: "approval", id: ID });
  assert.deepEqual(parseApprovalFragment(""), { kind: "none" });
  assert.deepEqual(parseApprovalFragment("#"), { kind: "none" });
  for (const hash of [`#${ID}x`, `#${ID.toUpperCase()}`, "#apr_123", `#approval=${ID}&x=1`, "#javascript:alert(1)", `#${ID}#${ID}`]) {
    assert.deepEqual(parseApprovalFragment(hash), { kind: "invalid" }, hash);
  }
});

test("masked approver wallets: a hint to connect the right one, never a match by accident", () => {
  assert.equal(walletFamily("0x8aea…775d"), "evm");
  assert.equal(walletFamily("5ScwDv…jJF3"), "solana");
  assert.equal(maskedMatches("0x8aea…775d", "0x8AEa1111111111111111111111111111111D775D"), true, "EVM compares without case");
  assert.equal(maskedMatches("0x8aea…775d", "0x8AEa1111111111111111111111111111111D775E"), false);
  assert.equal(maskedMatches("0x8aea…775d", "0x8aea775d"), false, "not an address");
  assert.equal(maskedMatches("5ScwDv…jJF3", "5ScwDvQ8u1d9b2kq7Zt4jJF3"), true);
  assert.equal(maskedMatches("5ScwDv…jJF3", "5scwdvQ8u1d9b2kq7Zt4jjf3"), false, "base58 is case sensitive");
  assert.equal(maskedMatches("5ScwDv…jJF3", "0x5ScwDv00000000000000000000000000jJF3"), false);
});

test("decision states: pending past its expiry reads as expired, and decisions name who decided", () => {
  const base = { status: "pending", expiresAt: "2026-10-09T13:52:10Z", decidedAt: null, decidedBy: null };
  const now = Date.parse("2026-10-09T13:00:00Z");
  assert.equal(approvalState(base, now).open, true);
  assert.equal(approvalState(base, Date.parse("2026-10-09T14:00:00Z")).status, "expired");
  const approved = approvalState({ ...base, status: "approved", decidedAt: "2026-10-09T13:10:00Z", decidedBy: { kind: "wallet", id: "0x8AEa…775D" } }, now);
  assert.equal(approved.open, false);
  assert.match(approved.detail, /Approved by the wallet 0x8AEa…775D on 09 Oct 2026, 13:10 UTC/u);
  assert.match(approvalState({ ...base, status: "rejected", decidedBy: { kind: "key", id: "key_1" } }, now).detail, /cancelled the intent/u);
  assert.equal(timeLeft("2026-10-09T13:52:10Z", now), "in 53 min");
  assert.equal(timeLeft("2026-10-09T15:05:00Z", now), "in 2 h 5 min");
  assert.equal(timeLeft("2026-10-09T12:00:00Z", now), "now");
});

test("money, triggers, legs and the digest print as plain text", () => {
  assert.equal(formatUsd("5304.00"), "$5,304.00");
  assert.equal(formatUsd("5.1"), "$5.10");
  assert.equal(formatUsd("1234567"), "$1,234,567.00");
  assert.equal(formatUsd(null), null);
  assert.equal(triggerWords("confirm.aboveUsd"), "Its value is above the rule book's approval threshold.");
  assert.equal(triggerWords("custom.rule"), "custom.rule");
  const leg = legLine({ id: "s1", kind: "bridge", network: "base", destinationNetwork: "arbitrum", protocol: "relay", input: "100 USDC", output: "99.94 USDC", recipient: "eip155:42161:0x2211d1D0020DAEA8039E46Cf1367962070d77DA9", recipientName: "jesse.base.eth" });
  assert.equal(legLine({ id: "s2", kind: "transfer", network: "base", protocol: "erc20-transfer", recipient: "eip155:8453:0x2211d1D0020DAEA8039E46Cf1367962070d77DA9" }).via, "ERC-20 transfer");
  assert.equal(legLine({ id: "s3", kind: "call", network: "base", protocol: "unknown-venue", recipient: "eip155:8453:0x2211d1D0020DAEA8039E46Cf1367962070d77DA9" }).via, "unknown-venue");
  assert.deepEqual(leg, { verb: "Bridge", amounts: "100 USDC → 99.94 USDC", from: "base", to: "arbitrum", via: "Relay", recipient: "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9", recipientName: "jesse.base.eth" });
  assert.equal(recipientNetwork("eip155:42161:0x2211d1D0020DAEA8039E46Cf1367962070d77DA9"), "arbitrum");
  assert.equal(approvalSerial(ID), "AP-ABAB·ABAB");
  const digest = `0x${"9c".repeat(32)}`;
  assert.equal(digestGroups(digest).join("").replace(/^0x/u, ""), digest.slice(2));
  assert.ok(digestGroups(digest).every((group) => group.replace(/^0x/u, "").length <= 16));
});

test("what a wallet signs is exactly the @kletia/core typed data or message for the decision", () => {
  const input = { approvalId: ID, intentId: `int_${"cd".repeat(16)}`, digest: `0x${"9c".repeat(32)}`, ceilingUsdCents: "530400", decision: "approve", expiresAt: 1791597467 };
  const typed = approvalTypedData({ ...input, signer: "eip155:8453:0x8AEa1111111111111111111111111111111D775D" });
  assert.equal(typed.domain.name, "Kletia Approvals");
  assert.equal(typed.domain.chainId, 8453);
  assert.equal(typed.message.decision, "approve");
  const text = approvalMessageText({ ...input, decision: "reject" });
  assert.ok(text.startsWith("Kletia approval\n"));
  assert.ok(text.includes("\nup to: $5,304.00\n"));
  assert.ok(text.includes("\ndecision: reject\n"));
});

test("public object routes: pattern matched, never indexed, canonical from the path", () => {
  const receipt = `/r/rcpt_${"0f".repeat(16)}`;
  const link = `/go/lk_${"1a".repeat(12)}`;
  assert.equal(matchRoute(receipt).id, "receipt");
  assert.equal(matchRoute(link).id, "link");
  assert.equal(matchRoute("/approve").id, "approve");
  for (const path of ["/r", "/r/", "/r/rcpt_XYZ", `${receipt}/extra`, "/go", "/go/lk_123", `${link}/card.png`, "/approve/x", "/approvex"]) {
    assert.equal(matchRoute(path).id, "notFound", path);
  }
  assert.ok(RECEIPT_PATH_PATTERN.test(receipt) && LINK_PATH_PATTERN.test(link));
  for (const id of ["receipt", "link", "approve"]) {
    const route = ROUTES[id];
    assert.equal(route.kind, "site", `${id} renders in the site shell (no wallet SDK in its entry)`);
    assert.equal(route.robots, "noindex,nofollow", id);
  }
  assert.equal(ROUTES.receipt.canonicalFromPath, true);
  assert.equal(ROUTES.link.canonicalFromPath, true);
  assert.ok(!ROUTES.approve.canonicalFromPath, "the approval id lives in the fragment, so /approve is its canonical");
  assert.equal(ROUTES.embed.kind, "embed", "only /embed renders without the site shell (and may be framed)");
});
