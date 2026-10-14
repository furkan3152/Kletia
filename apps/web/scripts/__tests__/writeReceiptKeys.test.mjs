// The receipt key mirror is generated at build time from the API's public
// configuration: the same keys, kids and notBefore days the API lists,
// never private material, and a release build fails without an active
// key.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { receiptKeyId } from "@kletia/core";

import { buildReceiptMirror, ReceiptMirrorError, writeReceiptKeys } from "../write-receipt-keys.mjs";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { x: publicKey.export({ format: "jwk" }).x, jwk: privateKey.export({ format: "jwk" }), pem: privateKey.export({ format: "pem", type: "pkcs8" }) };
}

const active = keyPair();
const retired = keyPair();
const revoked = keyPair();
const ATTESTER = { type: "eas", chain: "eip155:8453", address: `0x${"ab".repeat(20)}`, schemaUid: `0x${"cd".repeat(32)}`, status: "active" };

test("without any variable the mirror is empty (the development placeholder)", () => {
  assert.deepEqual(buildReceiptMirror({}).document, { keys: [], attesters: [] });
});

test("the active public key, the key set and the attesters become the mirror, in the API's order and shape", () => {
  const env = {
    KLETIA_RECEIPT_PUBLIC_KEY: JSON.stringify({ x: active.x, notBefore: "2026-10-01" }),
    KLETIA_RECEIPT_KEYSET: JSON.stringify([
      { x: retired.x, status: "retired", notBefore: "2026-01-01" },
      { x: revoked.x, status: "revoked", notBefore: "2025-06-01", revokedOn: "2026-02-01" },
    ]),
    KLETIA_RECEIPT_ATTESTERS: JSON.stringify([ATTESTER]),
  };
  const { document, warnings } = buildReceiptMirror(env);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    document.keys.map((key) => [key.status, key.kid, key.notBefore, key.revokedOn ?? null]),
    [
      ["active", receiptKeyId(active.x), "2026-10-01", null],
      ["retired", receiptKeyId(retired.x), "2026-01-01", null],
      ["revoked", receiptKeyId(revoked.x), "2025-06-01", "2026-02-01"],
    ],
  );
  assert.deepEqual(Object.keys(document.keys[0]), ["kty", "crv", "x", "kid", "alg", "use", "status", "notBefore"]);
  assert.deepEqual(document.attesters, [ATTESTER]);
  const distDir = mkdtempSync(join(tmpdir(), "kletia-receipt-mirror-"));
  try {
    writeReceiptKeys({ distDir, env });
    assert.deepEqual(JSON.parse(readFileSync(join(distDir, ".well-known/kletia-receipt-keys.json"), "utf8")), document);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("a bare x takes KLETIA_RECEIPT_KEY_NOT_BEFORE, like the API's active key; without a day the build fails", () => {
  const { document } = buildReceiptMirror({ KLETIA_RECEIPT_PUBLIC_KEY: active.x, KLETIA_RECEIPT_KEY_NOT_BEFORE: "2026-10-01" });
  assert.equal(document.keys[0].notBefore, "2026-10-01");
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_PUBLIC_KEY: active.x }), ReceiptMirrorError);
});

test("the key set is read exactly as the API reads it: entries that are not retired or revoked are ignored", () => {
  const { document, warnings } = buildReceiptMirror({
    KLETIA_RECEIPT_KEYSET: JSON.stringify([{ x: retired.x, status: "active", notBefore: "2026-01-01" }, { x: revoked.x, status: "revoked", notBefore: "2026-01-01" }]),
  });
  assert.deepEqual(document.keys, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /revoked key needs revokedOn/u);
});

test("private material fails the build: a d member, a PEM block or a private key variable in the environment", () => {
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_PUBLIC_KEY: JSON.stringify({ ...active.jwk, notBefore: "2026-10-01" }) }), /private key member \(d\)/u);
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_KEYSET: JSON.stringify([{ ...retired.jwk, status: "retired", notBefore: "2026-01-01" }]) }), /private key member/u);
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_PUBLIC_KEY: active.pem }), /PEM/u);
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_SIGNING_KEY: "seed" }), /belongs to the API only/u);
  assert.throws(() => buildReceiptMirror({ KLETIA_EAS_ATTESTER_KEY: `0x${"11".repeat(32)}` }), /belongs to the API only/u);
});

test("KLETIA_RELEASE=1 fails without an active key or when an input had to be ignored", () => {
  assert.throws(() => buildReceiptMirror({ KLETIA_RELEASE: "1" }), /KLETIA_RELEASE=1 but KLETIA_RECEIPT_PUBLIC_KEY is not set/u);
  assert.throws(
    () => buildReceiptMirror({ KLETIA_RELEASE: "1", KLETIA_RECEIPT_PUBLIC_KEY: active.x, KLETIA_RECEIPT_KEY_NOT_BEFORE: "2026-10-01", KLETIA_RECEIPT_KEYSET: "{}" }),
    /have problems/u,
  );
  const { document } = buildReceiptMirror({ KLETIA_RELEASE: "1", KLETIA_RECEIPT_PUBLIC_KEY: active.x, KLETIA_RECEIPT_KEY_NOT_BEFORE: "2026-10-01" });
  assert.equal(document.keys[0].status, "active");
});

test("an active key also listed in the key set fails (the API refuses to sign with it)", () => {
  assert.throws(
    () =>
      buildReceiptMirror({
        KLETIA_RECEIPT_PUBLIC_KEY: JSON.stringify({ x: active.x, notBefore: "2026-10-01" }),
        KLETIA_RECEIPT_KEYSET: JSON.stringify([{ x: active.x, status: "retired", notBefore: "2026-01-01" }]),
      }),
    /also listed in KLETIA_RECEIPT_KEYSET/u,
  );
});

test("the next key is mirrored only with an explicit notBefore; malformed attesters fail", () => {
  const next = keyPair();
  const withDay = buildReceiptMirror({ KLETIA_RECEIPT_NEXT_KEY: JSON.stringify({ x: next.x, notBefore: "2027-01-01" }) });
  assert.deepEqual(withDay.document.keys.map((key) => key.status), ["next"]);
  const bare = buildReceiptMirror({ KLETIA_RECEIPT_NEXT_KEY: next.x });
  assert.deepEqual(bare.document.keys, []);
  assert.equal(bare.warnings.length, 1);
  assert.throws(() => buildReceiptMirror({ KLETIA_RECEIPT_ATTESTERS: JSON.stringify([{ ...ATTESTER, address: "0x12" }]) }), /address/u);
});
