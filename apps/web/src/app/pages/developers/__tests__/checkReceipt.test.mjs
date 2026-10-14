// "Check a receipt" on the Receipts page (portal design 4.4.7): a share link
// becomes the route path only, JSON goes to verification, junk gets a
// message, and the fragment never leaves the browser. Run with Node 22.18+:
//   node --test apps/web/src/app/pages/developers/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { classifyReceiptInput, MAX_RECEIPT_JSON } from "../receipts/checkReceipt.ts";

const ID = `rcpt_${"3e7a91c0".repeat(4)}`;
const SHARE = `rsh_${"ab12".repeat(6)}`;
const KEY = "A".repeat(43);

test("a share link becomes the route path only; its fragment stays apart, for the in-tab router", () => {
  const result = classifyReceiptInput(`  https://evil.example:8443/r/${ID}?utm=x&k=leak#s=${SHARE}&k=${KEY}  `);
  assert.equal(result.kind, "link");
  assert.equal(result.path, `/r/${ID}`, "no origin, no query");
  assert.equal(result.fragment, `#s=${SHARE}&k=${KEY}`);
  assert.equal(result.note, null);
  // The path is all that could ever be requested from a server: it carries no key.
  assert.ok(!result.path.includes("#") && !result.path.includes(KEY) && !result.path.includes("evil"));

  assert.deepEqual(classifyReceiptInput(`https://kletiaai.xyz/r/${ID}`), { kind: "link", path: `/r/${ID}`, fragment: "", note: null });
  assert.deepEqual(classifyReceiptInput(`/r/${ID}/`), { kind: "link", path: `/r/${ID}`, fragment: "", note: null });
  assert.deepEqual(classifyReceiptInput(ID), { kind: "link", path: `/r/${ID}`, fragment: "", note: null });
  assert.deepEqual(classifyReceiptInput(`https://kletiaai.xyz/r/${ID}#section`), { kind: "link", path: `/r/${ID}`, fragment: "", note: null }, "an anchor is not a share");
});

test("a malformed share part is dropped with a note, never passed on", () => {
  for (const hash of [`#s=${SHARE}&k=short`, `#s=${SHARE}&k=${KEY}&x=1`, `#s=${SHARE}&s=${SHARE}&k=${KEY}`]) {
    const result = classifyReceiptInput(`https://kletiaai.xyz/r/${ID}${hash}`);
    assert.equal(result.kind, "link", hash);
    assert.equal(result.fragment, "", hash);
    assert.match(result.note, /malformed/u, hash);
  }
});

test("receipt JSON is recognised for verification, with its id when well formed", () => {
  const document = { payload: { spec: "kletia.receipt/v1", receiptId: ID }, digest: "sha256:x", signature: { alg: "Ed25519", kid: "k1", value: "v" } };
  const result = classifyReceiptInput(JSON.stringify(document, null, 2));
  assert.equal(result.kind, "json");
  assert.deepEqual(result.document, document);
  assert.equal(result.receiptId, ID);
  const noId = classifyReceiptInput(JSON.stringify({ ...document, payload: { receiptId: "../../x" } }));
  assert.equal(noId.kind, "json");
  assert.equal(noId.receiptId, null);
});

test("junk gets a message", () => {
  const cases = {
    "{not json": /does not parse/u,
    '{"payload": 1, "digest": "x"}': /not a Kletia receipt/u,
    "[1,2]": /Paste a receipt link/u,
    "hello world": /Paste a receipt link/u,
    "https://kletiaai.xyz/go/lk_123": /not a receipt page/u,
    [`javascript:alert(1)//r/${ID}`]: /Paste a receipt link/u,
    [`https://kletiaai.xyz/r/${ID.toUpperCase()}`]: /not a receipt page/u,
  };
  for (const [input, message] of Object.entries(cases)) {
    const result = classifyReceiptInput(input);
    assert.equal(result.kind, "junk", input);
    assert.match(result.message, message, input);
  }
  assert.equal(classifyReceiptInput("   ").kind, "empty");
  assert.match(classifyReceiptInput(`{"a":"${"x".repeat(MAX_RECEIPT_JSON)}"}`).message, /larger/u);
});
