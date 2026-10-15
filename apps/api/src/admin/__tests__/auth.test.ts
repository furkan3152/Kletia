/**
 * Admin sign-in and session security: allowlists (EVM and Solana), nonces,
 * origins, header, cookies, expiry, revocation, step-up confirmations and
 * the audit log.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getAddress } from "viem";
import { payloadSha256 } from "../auth/messages.js";
import { parseAdminConfig } from "../config.js";
import { MemoryAdminStore } from "../store/memory.js";
import {
  CORS_ORIGINS,
  call,
  cookieFrom,
  evmWallet,
  signInEvm,
  signInSolana,
  solanaWallet,
  startHarness,
  testConfig,
  type Harness,
} from "./helpers.js";

const OWNER_EVM = "0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a";
const OWNER_SOLANA = "D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm";

let open: Harness[] = [];
async function harness(env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof startHarness>[0]> = {}): Promise<Harness> {
  const started = await startHarness({ env, ...extra });
  open.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(open.map((entry) => entry.close()));
  open = [];
});

describe("admin configuration", () => {
  it("is disabled when both allowlists are unset or empty", () => {
    assert.equal(parseAdminConfig({ NODE_ENV: "test" }, CORS_ORIGINS).enabled, false);
    assert.equal(parseAdminConfig({ NODE_ENV: "test", KLETIA_ADMIN_ADDRESSES: " , ", KLETIA_ADMIN_SOLANA_ADDRESSES: "" }, CORS_ORIGINS).disabledReason, "no_allowlist");
  });

  it("enables with either list alone and accepts the owner's committed wallets", () => {
    const evmOnly = parseAdminConfig({ NODE_ENV: "test", KLETIA_ADMIN_ADDRESSES: OWNER_EVM }, CORS_ORIGINS);
    assert.equal(evmOnly.enabled, true);
    assert.ok(evmOnly.evmAddresses.has(OWNER_EVM));
    const solanaOnly = parseAdminConfig({ NODE_ENV: "test", KLETIA_ADMIN_SOLANA_ADDRESSES: OWNER_SOLANA }, CORS_ORIGINS);
    assert.equal(solanaOnly.enabled, true);
    assert.ok(solanaOnly.solanaAddresses.has(OWNER_SOLANA));
    const both = parseAdminConfig({ NODE_ENV: "test", KLETIA_ADMIN_ADDRESSES: OWNER_EVM, KLETIA_ADMIN_SOLANA_ADDRESSES: OWNER_SOLANA }, CORS_ORIGINS);
    assert.equal(both.enabled, true);
  });

  it("fails closed on any invalid entry in either list", () => {
    for (const env of [
      { KLETIA_ADMIN_ADDRESSES: `${OWNER_EVM},0x123` },
      { KLETIA_ADMIN_ADDRESSES: "0xFF3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A" }, // bad EIP-55 checksum
      { KLETIA_ADMIN_ADDRESSES: OWNER_EVM, KLETIA_ADMIN_SOLANA_ADDRESSES: "not-base58-0OIl" },
      { KLETIA_ADMIN_SOLANA_ADDRESSES: `${OWNER_SOLANA},${OWNER_EVM}` },
      { KLETIA_ADMIN_SOLANA_ADDRESSES: "1111" },
    ]) {
      const config = parseAdminConfig({ NODE_ENV: "test", ...env }, CORS_ORIGINS);
      assert.equal(config.enabled, false, JSON.stringify(env));
      assert.equal(config.disabledReason, "invalid_allowlist");
    }
  });

  it("is disabled in production without a database and keeps only same-site admin origins", () => {
    const config = parseAdminConfig({ NODE_ENV: "production", KLETIA_ADMIN_ADDRESSES: OWNER_EVM }, CORS_ORIGINS);
    assert.equal(config.disabledReason, "store_missing");
    const withDb = parseAdminConfig({ NODE_ENV: "production", KLETIA_ADMIN_ADDRESSES: OWNER_EVM, KLETIA_DATABASE_URL: "postgres://x", KLETIA_ADMIN_ORIGINS: "https://kletiaai.xyz,https://kletia-frontend.onrender.com,http://localhost:5174" }, CORS_ORIGINS);
    assert.equal(withDb.enabled, true);
    assert.deepEqual(withDb.origins, ["https://kletiaai.xyz"]);
  });

  it("refuses the memory store in production", () => {
    assert.throws(() => new MemoryAdminStore({ production: true }), /not allowed in production/u);
  });
});

describe("admin request guards", () => {
  it("answers 503 ADMIN_DISABLED for every route when admin is off", async () => {
    const h = await harness({});
    for (const [method, path] of [["POST", "/auth/nonce"], ["GET", "/auth/session"], ["GET", "/catalog"]] as const) {
      const reply = await call(h, method, path, { body: method === "POST" ? { address: OWNER_EVM, chainId: 8453 } : undefined });
      assert.equal(reply.status, 503);
      assert.equal(reply.body.error.code, "ADMIN_DISABLED");
      assert.match(reply.body.error.message, /KLETIA_ADMIN_SOLANA_ADDRESSES/u);
    }
  });

  it("refuses a missing header and a foreign or cross-site origin", async () => {
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: OWNER_EVM });
    const noHeader = await call(h, "POST", "/auth/nonce", { header: false, body: { address: OWNER_EVM, chainId: 8453 } });
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, "ADMIN_HEADER_REQUIRED");
    for (const origin of ["https://evil.example", "https://kletia-frontend.onrender.com", null]) {
      const reply = await call(h, "POST", "/auth/nonce", { origin, body: { address: OWNER_EVM, chainId: 8453 } });
      assert.equal(reply.status, 403, String(origin));
      assert.equal(reply.body.error.code, "ADMIN_ORIGIN_FORBIDDEN");
    }
  });

  it("requires JSON bodies and sets no-store and a request id", async () => {
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: OWNER_EVM });
    const reply = await call(h, "POST", "/auth/nonce", { body: "address=x", contentType: "application/x-www-form-urlencoded" });
    assert.equal(reply.status, 415);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.ok(reply.body.error.requestId);
  });

  it("asks for a session on protected routes", async () => {
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: OWNER_EVM });
    const reply = await call(h, "GET", "/catalog");
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error.code, "ADMIN_SESSION_REQUIRED");
  });
});

describe("EVM sign-in (EIP-4361)", () => {
  it("signs in an allowlisted EOA and sets a development cookie", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address.toLowerCase() });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 8453 } });
    assert.equal(nonce.status, 200);
    assert.match(nonce.body.message, /^localhost:5174 wants you to sign in with your Ethereum account:/u);
    assert.match(nonce.body.message, /Request ID: adm_login/u);
    assert.match(nonce.body.message, /URI: http:\/\/localhost:5174\/admin/u);
    const signature = await account.signMessage({ message: nonce.body.message });
    const verify = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.session.address, account.address);
    assert.equal(verify.body.session.walletKind, "evm");
    assert.equal(verify.body.session.chainId, 8453);
    assert.deepEqual(verify.body.session.evmActors, [account.address]);
    const setCookie = verify.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^kletia_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/u);
    assert.doesNotMatch(setCookie, /Domain=/u);
    const session = await call(h, "GET", "/auth/session", { cookie: cookieFrom(verify) });
    assert.equal(session.status, 200);
    assert.equal(session.body.session.address, account.address);
    const audit = await h.store.listAudit(10, null);
    assert.equal(audit[0]?.action, "auth.login");
  });

  it("sets a __Host- Secure cookie in production", async () => {
    const account = evmWallet();
    const env = { NODE_ENV: "production", KLETIA_ADMIN_ADDRESSES: account.address, KLETIA_DATABASE_URL: "postgres://unused" };
    const h = await harness(env, { config: parseAdminConfig(env, CORS_ORIGINS) });
    const nonce = await call(h, "POST", "/auth/nonce", { origin: "https://kletiaai.xyz", body: { address: account.address, chainId: 8453 } });
    assert.equal(nonce.status, 200);
    assert.match(nonce.body.message, /^kletiaai\.xyz wants you/u);
    const signature = await account.signMessage({ message: nonce.body.message });
    const verify = await call(h, "POST", "/auth/verify", { origin: "https://kletiaai.xyz", body: { message: nonce.body.message, signature } });
    assert.equal(verify.status, 200);
    assert.match(verify.headers.get("set-cookie") ?? "", /^__Host-kletia_admin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/u);
  });

  it("uses each nonce once, burns it on a failed attempt and binds origin, text, expiry and chain", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 8453 } });
    const signature = await account.signMessage({ message: nonce.body.message });
    const tampered = nonce.body.message.replace("Version: 1", "Version: 1 ");
    const bad = await call(h, "POST", "/auth/verify", { body: { message: tampered, signature } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, "ADMIN_NONCE_INVALID");
    // The failed attempt consumed the nonce: the genuine message no longer works.
    const replay = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
    assert.equal(replay.status, 401);

    const second = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 8453 } });
    const otherOrigin = await call(h, "POST", "/auth/verify", { origin: "http://127.0.0.1:5174", body: { message: second.body.message, signature: await account.signMessage({ message: second.body.message }) } });
    assert.equal(otherOrigin.status, 401);

    const third = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 8453 } });
    h.now = new Date(h.now.getTime() + 6 * 60 * 1000);
    const expired = await call(h, "POST", "/auth/verify", { body: { message: third.body.message, signature: await account.signMessage({ message: third.body.message }) } });
    assert.equal(expired.status, 401);

    const chain = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 56 } });
    assert.equal(chain.status, 400);
    assert.equal(chain.body.error.code, "ADMIN_INVALID_REQUEST");
  });

  it("audits replayed, altered and unknown sign-in messages as denied login attempts", async () => {
    const account = evmWallet();
    const wallet = solanaWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address, KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address });
    const { reply } = await signInEvm(h, account);
    assert.equal(reply.status, 200);
    const nonce = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: wallet.address } });
    const signature = wallet.sign(nonce.body.message);
    assert.equal((await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } })).status, 200);
    const replay = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
    assert.equal(replay.body.error.code, "ADMIN_NONCE_INVALID");
    // The harness clock is fixed: rows share a timestamp, so look them up by content.
    const denied = async () => (await h.store.listAudit(100, null)).filter((row) => row.action === "auth.login.denied");
    const [replayRow] = await denied();
    assert.equal(replayRow?.action, "auth.login.denied");
    assert.equal(replayRow?.outcome, "denied");
    assert.equal(replayRow?.address, wallet.address);
    assert.deepEqual(replayRow?.target, { reason: "nonce", walletKind: "solana", claimed: "true" });
    const garbage = await call(h, "POST", "/auth/verify", { body: { message: "Nonce: AAAAAAAAAAAAAAAAAAAAAAAA", signature: "x" } });
    assert.equal(garbage.status, 401);
    const rows = await denied();
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.address === null && row.target.reason === "nonce"));
  });

  it("refuses a valid signature from a wallet outside the allowlist and audits it", async () => {
    const admin = evmWallet();
    const stranger = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: admin.address });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { address: stranger.address, chainId: 8453 } });
    assert.equal(nonce.status, 200, "no allowlist oracle on nonce");
    const verify = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature: await stranger.signMessage({ message: nonce.body.message }) } });
    assert.equal(verify.status, 403);
    assert.equal(verify.body.error.code, "ADMIN_NOT_ALLOWED");
    assert.equal(verify.headers.get("set-cookie"), null);
    const [row] = await h.store.listAudit(1, null);
    assert.equal(row?.action, "auth.login.denied");
    assert.equal(row?.outcome, "denied");
    assert.equal(row?.address, stranger.address);
  });

  it("accepts a smart-account signature through ERC-1271 and never on an RPC failure", async () => {
    const signer = evmWallet();
    const safe = getAddress("0x84f19fdfd8c50c6349bfe86cd90be131387ab47d");
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: safe });
    const client = (await import("./helpers.js")).mockClient(8453);
    h.clients.set("base", client);
    let calls = 0;
    client.verifyMessage = async ({ address }: { address: string }) => {
      calls += 1;
      return address === safe;
    };
    const nonce = await call(h, "POST", "/auth/nonce", { body: { address: safe, chainId: 8453 } });
    const signature = await signer.signMessage({ message: nonce.body.message });
    const ok = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
    assert.equal(ok.status, 200);
    assert.equal(calls, 1);

    client.verifyMessage = async () => { throw new Error("rpc down"); };
    const second = await call(h, "POST", "/auth/nonce", { body: { address: safe, chainId: 8453 } });
    const down = await call(h, "POST", "/auth/verify", { body: { message: second.body.message, signature: await signer.signMessage({ message: second.body.message }) } });
    assert.equal(down.status, 502);
    assert.equal(down.body.error.code, "ADMIN_RPC_UNAVAILABLE");
    assert.equal(down.headers.get("set-cookie"), null);
  });
});

describe("Solana sign-in", () => {
  it("signs in an allowlisted Solana wallet; on-chain actors are the EVM allowlist", async () => {
    const wallet = solanaWallet();
    const evm = evmWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: evm.address });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: wallet.address } });
    assert.equal(nonce.status, 200);
    assert.equal(nonce.body.walletKind, "solana");
    const lines = String(nonce.body.message).split("\n");
    assert.equal(lines[0], "localhost:5174 wants you to sign in with your Solana account:");
    assert.equal(lines[1], wallet.address);
    for (const prefix of ["URI: http://localhost:5174/admin", "Version: 1", "Chain ID: mainnet", "Nonce: ", "Issued At: ", "Expiration Time: ", "Request ID: adm_login"]) {
      assert.ok(lines.some((line) => line.startsWith(prefix)), prefix);
    }
    const verify = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature: wallet.sign(nonce.body.message) } });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.session.walletKind, "solana");
    assert.equal(verify.body.session.address, wallet.address);
    assert.equal(verify.body.session.chainId, null);
    assert.deepEqual(verify.body.session.evmActors, [evm.address]);
  });

  it("accepts base64 signatures and works with the Solana list alone", async () => {
    const wallet = solanaWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: wallet.address } });
    const { sign } = await import("node:crypto");
    const signature = sign(null, Buffer.from(nonce.body.message, "utf8"), wallet.privateKey).toString("base64");
    const verify = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature } });
    assert.equal(verify.status, 200);
    assert.deepEqual(verify.body.session.evmActors, []);
  });

  it("refuses a wrong signature, a non-allowlisted wallet and a malformed address", async () => {
    const wallet = solanaWallet();
    const other = solanaWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address });
    const nonce = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: wallet.address } });
    const forged = await call(h, "POST", "/auth/verify", { body: { message: nonce.body.message, signature: other.sign(nonce.body.message) } });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error.code, "ADMIN_SIGNATURE_INVALID");

    const outsider = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: other.address } });
    const denied = await call(h, "POST", "/auth/verify", { body: { message: outsider.body.message, signature: other.sign(outsider.body.message) } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "ADMIN_NOT_ALLOWED");
    const audit = await h.store.listAudit(5, null);
    assert.ok(audit.some((row) => row.action === "auth.login.denied" && row.address === other.address));

    const malformed = await call(h, "POST", "/auth/nonce", { body: { walletKind: "solana", address: "0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a" } });
    assert.equal(malformed.status, 400);
  });

  it("does not let an EVM message be verified as Solana or the reverse", async () => {
    const wallet = solanaWallet();
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: account.address });
    const evmNonce = await call(h, "POST", "/auth/nonce", { body: { address: account.address, chainId: 8453 } });
    const crossed = await call(h, "POST", "/auth/verify", { body: { message: evmNonce.body.message, signature: wallet.sign(evmNonce.body.message) } });
    assert.equal(crossed.status, 401);
  });
});

describe("sessions", () => {
  it("expires on idle and absolute limits and when the allowlist shrinks", async () => {
    const account = evmWallet();
    const env = { KLETIA_ADMIN_ADDRESSES: account.address };
    const h = await harness(env);
    const { cookie } = await signInEvm(h, account);
    h.now = new Date(h.now.getTime() + 29 * 60 * 1000);
    assert.equal((await call(h, "GET", "/catalog", { cookie })).status, 200);
    h.now = new Date(h.now.getTime() + 31 * 60 * 1000);
    const idle = await call(h, "GET", "/catalog", { cookie });
    assert.equal(idle.status, 401);
    assert.match(idle.headers.get("set-cookie") ?? "", /Max-Age=0/u);

    const fresh = await signInEvm(h, account);
    for (let step = 0; step < 17; step += 1) {
      h.now = new Date(h.now.getTime() + 29 * 60 * 1000);
      await call(h, "GET", "/auth/session", { cookie: fresh.cookie });
    }
    assert.equal((await call(h, "GET", "/auth/session", { cookie: fresh.cookie })).status, 401, "8 h absolute limit");

    const third = await signInEvm(h, account);
    h.config = testConfig({ KLETIA_ADMIN_ADDRESSES: evmWallet().address });
    assert.equal((await call(h, "GET", "/auth/session", { cookie: third.cookie })).status, 401, "allowlist shrink revokes");
  });

  it("binds the session to its origin and logs out (one or all)", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const first = await signInEvm(h, account);
    const second = await signInEvm(h, account);
    assert.equal((await call(h, "GET", "/auth/session", { cookie: first.cookie, origin: "http://127.0.0.1:5174" })).status, 401);
    assert.equal((await call(h, "POST", "/auth/logout", { cookie: first.cookie })).status, 204);
    assert.equal((await call(h, "GET", "/auth/session", { cookie: first.cookie })).status, 401);
    assert.equal((await call(h, "GET", "/auth/session", { cookie: second.cookie })).status, 200);
    const third = await signInEvm(h, account);
    assert.equal((await call(h, "POST", "/auth/logout-all", { cookie: third.cookie })).status, 204);
    assert.equal((await call(h, "GET", "/auth/session", { cookie: second.cookie })).status, 401);
  });

  it("fails the request when the audit row cannot be written", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    h.store.failAuditWrites = true;
    const reply = await call(h, "POST", "/auth/logout", { cookie });
    assert.equal(reply.status, 503);
    assert.equal(reply.body.error.code, "ADMIN_STORE_UNAVAILABLE");
    h.store.failAuditWrites = false;
    assert.equal((await call(h, "GET", "/auth/session", { cookie })).status, 200, "nothing changed");
  });
});

describe("step-up confirmation", () => {
  const profile = { owner: null, guardian: null, treasury: "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC", eoaOwnerAcknowledged: false };

  it("requires a confirmation signed by the session wallet over the exact payload", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const missing = await call(h, "PUT", "/network-profiles/arbitrum", { cookie, body: { ...profile } });
    assert.equal(missing.status, 400);

    const confirmNonce = async (payload: unknown) => call(h, "POST", "/auth/nonce", {
      cookie, body: { address: account.address, purpose: "confirm", action: "network-profile.update", network: "arbitrum", payloadSha256: payloadSha256(payload) },
    });
    const otherPayload = await confirmNonce({ ...profile, treasury: account.address });
    const mismatched = await call(h, "PUT", "/network-profiles/arbitrum", {
      cookie, body: { ...profile, confirmation: { message: otherPayload.body.message, signature: await account.signMessage({ message: otherPayload.body.message }) } },
    });
    assert.equal(mismatched.status, 403);
    assert.equal(mismatched.body.error.code, "ADMIN_CONFIRMATION_REQUIRED");

    const good = await confirmNonce(profile);
    assert.match(good.body.message, /^Kletia admin confirmation\nAction: network-profile.update\nNetwork: arbitrum\nPayload-SHA256: [0-9a-f]{64}\n/u);
    const confirmation = { message: good.body.message, signature: await account.signMessage({ message: good.body.message }) };
    const ok = await call(h, "PUT", "/network-profiles/arbitrum", { cookie, body: { ...profile, confirmation } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile.treasury, profile.treasury);
    const replay = await call(h, "PUT", "/network-profiles/arbitrum", { cookie, body: { ...profile, confirmation } });
    assert.equal(replay.status, 403);

    const anonymous = await call(h, "POST", "/auth/nonce", { body: { address: account.address, purpose: "confirm", action: "network-profile.update", payloadSha256: "0".repeat(64) } });
    assert.equal(anonymous.status, 401, "confirm nonces need a session");
  });

  it("audits a refused confirmation (a session cookie alone cannot change defaults)", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const forged = await call(h, "PUT", "/network-profiles/arbitrum", { cookie, body: { ...profile, confirmation: { message: "Nonce: AAAAAAAAAAAAAAAAAAAAAAAA", signature: "0x00" } } });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.error.code, "ADMIN_CONFIRMATION_REQUIRED");
    const row = (await h.store.listAudit(100, null)).find((entry) => entry.action === "network_profile.update");
    assert.equal(row?.outcome, "denied");
    assert.equal(row?.address, getAddress(account.address));
    assert.deepEqual(row?.target, { network: "arbitrum", reason: "confirmation" });
    assert.equal((await h.store.listProfiles()).length, 0);
  });

  it("accepts a Solana session's own ed25519 confirmation", async () => {
    const wallet = solanaWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address });
    const { cookie } = await signInSolana(h, wallet);
    const nonce = await call(h, "POST", "/auth/nonce", {
      cookie, body: { walletKind: "solana", address: wallet.address, purpose: "confirm", action: "network-profile.update", network: "arc", payloadSha256: payloadSha256(profile) },
    });
    assert.equal(nonce.status, 200);
    const ok = await call(h, "PUT", "/network-profiles/arc", { cookie, body: { ...profile, confirmation: { message: nonce.body.message, signature: wallet.sign(nonce.body.message) } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile.updatedBy, wallet.address);
  });

  it("refuses a mainnet EOA owner without the acknowledgement", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const body = { ...profile, owner: account.address };
    const nonce = await call(h, "POST", "/auth/nonce", { cookie, body: { address: account.address, purpose: "confirm", action: "network-profile.update", network: "optimism", payloadSha256: payloadSha256(body) } });
    const reply = await call(h, "PUT", "/network-profiles/optimism", { cookie, body: { ...body, confirmation: { message: nonce.body.message, signature: await account.signMessage({ message: nonce.body.message }) } } });
    assert.equal(reply.status, 422);
    assert.equal(reply.body.error.details.eoaOwner, true);
  });
});
