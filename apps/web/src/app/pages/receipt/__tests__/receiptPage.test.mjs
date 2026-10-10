// The receipt page's pure parts: share links (the key stays in the fragment),
// the model printed on the ticket, and the recheck board rows. Run with
//   node --test apps/web/src/app/pages/receipt/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifyReceipt } from "@kletia/core";

import { BROWSER_REFUSED_RPCS, browserSources, plannedRows, RESULT_FLAPS, summarize } from "../recheck.ts";
import { parseReceiptFragment, receiptIdFromPath, receiptPageUrl, receiptSerial, REVERIFY_COMMAND, reverifyCommandFor } from "../receiptLink.ts";
import { httpsOnly, offlineVerdict, receiptModel } from "../receiptModel.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../../../../../packages/sdk/test/fixtures/receipt-v1-vectors.json", import.meta.url), "utf8"));
const KEY = { ...vectors.key.publicJwk, kid: vectors.key.kid, alg: "Ed25519", use: "sig", status: "active", notBefore: "2026-01-01" };
const SHARE = `rsh_${"a1".repeat(12)}`;
const SECRET = "A".repeat(43);

test("a share fragment is read only with exactly one share id and one 32-byte key", () => {
  assert.deepEqual(parseReceiptFragment(`#s=${SHARE}&k=${SECRET}`), { kind: "share", shareId: SHARE, key: SECRET });
  assert.deepEqual(parseReceiptFragment(`#k=${SECRET}&s=${SHARE}`), { kind: "share", shareId: SHARE, key: SECRET });
  assert.deepEqual(parseReceiptFragment(""), { kind: "none" });
  assert.deepEqual(parseReceiptFragment("#section"), { kind: "none" });
  for (const hash of [`#s=${SHARE}`, `#k=${SECRET}`, `#s=${SHARE}&k=${SECRET}&k=${SECRET}`, `#s=rsh_short&k=${SECRET}`, `#s=${SHARE}&k=${SECRET.slice(1)}`, `#s=${SHARE}&k=${SECRET}=`]) {
    assert.deepEqual(parseReceiptFragment(hash), { kind: "invalid" }, hash);
  }
});

test("a share fragment with any parameter besides s and k is invalid (text appended to a genuine link)", () => {
  for (const extra of ["&calc&mshta,https://attacker.example/x.hta&", "&x=1", "&calc", "&|calc", "&%26calc"]) {
    assert.deepEqual(parseReceiptFragment(`#s=${SHARE}&k=${SECRET}${extra}`), { kind: "invalid" }, extra);
    assert.deepEqual(parseReceiptFragment(`#k=${SECRET}${extra}&s=${SHARE}`), { kind: "invalid" }, extra);
  }
  for (const glued of [`;calc`, `|calc`, `%26calc`, `%22`]) {
    assert.deepEqual(parseReceiptFragment(`#s=${SHARE}&k=${SECRET}${glued}`), { kind: "invalid" }, glued);
  }
  assert.deepEqual(parseReceiptFragment(`#s=${SHARE}&k=${SECRET}&`), { kind: "share", shareId: SHARE, key: SECRET }, "an empty trailing separator adds no parameter");
});

test("the copied reverify command is rebuilt from checked parts and double-quoted for every common shell", () => {
  const id = `rcpt_${"0f".repeat(16)}`;
  const share = { shareId: SHARE, key: SECRET };
  const genuine = `npx @kletia/cli receipt reverify "https://kletiaai.xyz/r/${id}#s=${SHARE}&k=${SECRET}"`;
  assert.equal(reverifyCommandFor("https://kletiaai.xyz", id, share), genuine);
  assert.equal(reverifyCommandFor("https://kletiaai.xyz/", id, share), genuine);
  assert.equal(reverifyCommandFor("https://kletiaai.xyz", id), `npx @kletia/cli receipt reverify "https://kletiaai.xyz/r/${id}"`);
  assert.equal(reverifyCommandFor("http://127.0.0.1:3651", id, share), `npx @kletia/cli receipt reverify "http://127.0.0.1:3651/r/${id}#s=${SHARE}&k=${SECRET}"`);
  // Nothing outside the checked parts can reach the command.
  assert.equal(reverifyCommandFor("https://kletiaai.xyz", id, { shareId: SHARE, key: `${SECRET}&calc` }), null);
  assert.equal(reverifyCommandFor("https://kletiaai.xyz", `${id}&calc`, share), null);
  assert.equal(reverifyCommandFor("https://kletiaai.xyz", id, { shareId: `${SHARE}"`, key: SECRET }), null);
  for (const origin of ["http://kletiaai.xyz", "https://kletiaai.xyz/r/x#s=a&k=b", "https://evil.example\"&calc", "javascript:alert(1)", "https://a%22b", "", "file://x"]) {
    assert.equal(reverifyCommandFor(origin, id, share), null, origin);
  }
  // Inside the double quotes only characters no common shell treats specially.
  const command = reverifyCommandFor("https://kletiaai.xyz", id, share) ?? "";
  const quoted = command.slice(command.indexOf('"') + 1, -1);
  assert.match(quoted, /^[A-Za-z0-9:/.#=&_-]+$/u);
  assert.equal(command.endsWith('"'), true);
  assert.equal(command.includes("'"), false, "no single quotes: cmd.exe does not treat them as quotes");
  // A cmd.exe-style split on & outside double quotes leaves one command.
  const outside = command.split('"').filter((_, index) => index % 2 === 0).join("");
  assert.equal(outside.includes("&") || outside.includes("|"), false);
  assert.equal(REVERIFY_COMMAND, 'npx @kletia/cli receipt reverify "<this link>"');
});

test("receipt paths and the addresses the page shows never carry the key", () => {
  const id = `rcpt_${"0f".repeat(16)}`;
  assert.equal(receiptIdFromPath(`/r/${id}`), id);
  assert.equal(receiptIdFromPath(`/r/${id}/`), id);
  assert.equal(receiptIdFromPath("/r/rcpt_ABC"), null);
  assert.equal(receiptIdFromPath(`/r/${id}/x`), null);
  assert.equal(receiptPageUrl("https://kletiaai.xyz/", id), `https://kletiaai.xyz/r/${id}`);
  assert.equal(receiptSerial(id), "0F0F·0F0F");
});

test("only https explorer links are printed", () => {
  assert.equal(httpsOnly("https://basescan.org/tx/0x1"), "https://basescan.org/tx/0x1");
  for (const url of ["http://basescan.org/tx/0x1", "javascript:alert(1)", "https://user:pw@basescan.org/", "", null, undefined]) assert.equal(httpsOnly(url), null, String(url));
});

test("the published vector verifies, prints every detail, and lists one recheck row per anchor and source", async () => {
  const document = vectors.receipt;
  const verification = await verifyReceipt(document, { keys: [KEY] });
  assert.equal(verification.valid, true, JSON.stringify(verification.problems));
  assert.equal(offlineVerdict(verification).kind, "verified");
  const model = receiptModel(document);
  assert.equal(model.legs.length, 2);
  assert.equal(model.sealed.length, 0);
  const rows = plannedRows(document, model.legs, { base: ["https://mainnet.base.org", "https://base.drpc.org"], solana: ["https://api.mainnet-beta.solana.com"] }, (url) => new URL(url).host);
  assert.ok(rows.length >= 2, "anchors on Base and Solana");
  assert.ok(rows.every((row) => row.result === "ready" && /^\d{2}$/u.test(row.leg)));
  assert.equal(RESULT_FLAPS.unavailable, "NO DATA");
});

test("a tampered payload is VOID and names the problem", async () => {
  const document = structuredClone(vectors.receipt);
  document.payload.issuedOn = "2026-12-31";
  const verdict = offlineVerdict(await verifyReceipt(document, { keys: [KEY] }));
  assert.equal(verdict.kind, "void");
  assert.ok(verdict.problems.length > 0);
});

test("a sealed receipt (no disclosures) still verifies and shows the sealed groups", async () => {
  const { disclosures: _disclosures, ...sealed } = vectors.receipt;
  const verification = await verifyReceipt(sealed, { keys: [KEY] });
  assert.equal(verification.valid, true);
  const model = receiptModel(sealed);
  assert.equal(model.shown.length, 0);
  assert.ok(model.sealed.length > 0);
  assert.equal(plannedRows(sealed, model.legs, { base: ["https://mainnet.base.org"] }, (url) => url).length, 0, "nothing to recheck without evidence");
});

test("the recheck summary never calls missing data a mismatch", () => {
  const report = {
    verdict: "inconclusive",
    offline: { valid: true },
    anchors: [{ step: "s1", ref: "0x1", chain: "eip155:8453", result: "unavailable", mismatched: [], sources: [{ url: "https://base.drpc.org", result: "unavailable" }] }],
    bindings: [],
    anchoring: null,
    singleSource: true,
    sealedSteps: [],
  };
  const summary = summarize(report, [{ id: "s1", index: 0 }]);
  assert.match(summary.headline, /Not conclusive/u);
  assert.ok(summary.lines.some((line) => line.includes("Public nodes forget old transactions")));
  assert.equal(summary.agreeingSources, 0);
});

test("browserSources: nodes that refuse web pages are not asked from the browser; nothing else changes", () => {
  const defaults = {
    base: ["https://mainnet.base.org", "https://base.drpc.org"],
    solana: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
    "solana-devnet": ["https://api.devnet.solana.com"],
  };
  const sources = browserSources(defaults);
  assert.deepEqual(sources.base, defaults.base);
  assert.deepEqual(sources.solana, ["https://solana-rpc.publicnode.com"]);
  assert.deepEqual(sources["solana-devnet"], defaults["solana-devnet"]);
  assert.equal(BROWSER_REFUSED_RPCS.has("https://api.mainnet-beta.solana.com"), true);
  // A network whose only nodes refuse browsers keeps them (the board then says "no data").
  assert.deepEqual(browserSources({ solana: ["https://api.mainnet-beta.solana.com"] }).solana, ["https://api.mainnet-beta.solana.com"]);
});
