// Developer account rules of the portal (keys/accountModel.ts) and the tab's session store
// (keys/accountSessionStore.ts). Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/keys/__tests__/accountModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  accountChainId,
  accountErrorText,
  accountKeyStatus,
  accountMessageProblems,
  projectKeyId,
  sortAccountKeys,
} from "../accountModel.ts";
import { clearAccountSession, getAccountSession, setAccountSession, subscribeAccountSession } from "../accountSessionStore.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function evmMessage({ host = "kletiaai.xyz", uri = "https://kletiaai.xyz/developers/keys", address = EVM, chainId = 8453, requestId = "dev_login", expires = "2026-10-22T12:05:00.000Z" } = {}) {
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to the Kletia developer portal to manage your projects. This signature does not move funds or approve a transaction.",
    "",
    `URI: ${uri}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    "Nonce: abcdefgh12345678",
    "Issued At: 2026-10-22T12:00:00.000Z",
    `Expiration Time: ${expires}`,
    `Request ID: ${requestId}`,
  ].join("\n");
}

const expected = { kind: "evm", host: "kletiaai.xyz", origin: "https://kletiaai.xyz", address: EVM, chainId: 8453, now: NOW };

test("accepts the developer portal sign-in message it asked for", () => {
  assert.deepEqual(accountMessageProblems(evmMessage(), expected), []);
  assert.deepEqual(accountMessageProblems(evmMessage({ address: EVM.toLowerCase() }), expected), []);
});

test("refuses messages for another site, wallet, chain, purpose or time", () => {
  assert.equal(accountMessageProblems(evmMessage({ host: "evil.example" }), expected).length, 1);
  assert.match(accountMessageProblems(evmMessage({ address: "0x0000000000000000000000000000000000000001" }), expected)[0], /another address/u);
  assert.match(accountMessageProblems(evmMessage({ chainId: 1 }), expected)[0], /another chain/u);
  assert.deepEqual(accountMessageProblems(evmMessage({ requestId: "adm_login", uri: "https://kletiaai.xyz/admin" }), expected), [
    "The message is not a developer portal sign-in.",
    "The message names another page than this portal.",
  ]);
  assert.match(accountMessageProblems(evmMessage({ expires: "2026-10-22T11:59:00.000Z" }), expected)[0], /expired/u);
  assert.deepEqual(accountMessageProblems("hello", expected), ["The API sent a sign-in message the portal cannot read."]);
});

test("names a supported chain for EVM sign-in", () => {
  assert.equal(accountChainId(42161), 42161);
  assert.equal(accountChainId(421614), 8453);
  assert.equal(accountChainId(undefined), 8453);
});

test("orders keys: live project keys, live children, then revoked or expired", () => {
  const key = (id, kind, createdAt, extra = {}) => ({ id, kind, createdAt, revokedAt: null, expiresAt: null, previousExpiresAt: null, ...extra });
  const keys = [
    key("key_a", "project", "2026-10-01T00:00:00Z", { revokedAt: "2026-10-02T00:00:00Z" }),
    key("key_b", "agent", "2026-10-03T00:00:00Z"),
    key("key_c", "project", "2026-10-04T00:00:00Z", { previousExpiresAt: "2026-10-23T00:00:00Z" }),
    key("key_d", "agent", "2026-10-05T00:00:00Z", { expiresAt: "2026-10-06T00:00:00Z" }),
    key("key_e", "project", "2026-10-06T00:00:00Z"),
  ];
  assert.deepEqual(sortAccountKeys(keys, NOW).map((entry) => entry.id), ["key_e", "key_c", "key_b", "key_a", "key_d"]);
  assert.equal(accountKeyStatus(keys[0], NOW), "revoked");
  assert.equal(accountKeyStatus(keys[2], NOW), "grace");
  assert.equal(accountKeyStatus(keys[3], NOW), "expired");
  assert.equal(accountKeyStatus(keys[4], NOW), "active");
});

test("reads owned project ids and explains account errors", () => {
  assert.equal(projectKeyId("prj_key_2dce0f6a1b2c3d4e5f6a7b8c"), "key_2dce0f6a1b2c3d4e5f6a7b8c");
  assert.equal(projectKeyId("prj_other"), null);
  assert.match(accountErrorText("ACCOUNT_SESSION_REQUIRED", "x"), /projects stay yours/u);
  assert.equal(accountErrorText("SOMETHING_ELSE", "fallback"), "fallback");
});

test("holds the session token in memory only, and only in its shape", () => {
  let changes = 0;
  const stop = subscribeAccountSession(() => {
    changes += 1;
  });
  const session = { token: `kl_acs_${"a".repeat(43)}`, walletKind: "evm", address: EVM, expiresAt: "2026-10-22T20:00:00Z" };
  setAccountSession(session);
  assert.equal(getAccountSession(), session);
  setAccountSession({ ...session, token: "kl_dev_notasession" });
  assert.equal(getAccountSession(), null);
  setAccountSession(session);
  clearAccountSession();
  assert.equal(getAccountSession(), null);
  stop();
  assert.equal(changes, 4);
});
