// The admin HTTP client: the cookie and header on every call, the wire bodies
// of both sign-in families, and the error codes that decide the gate.
import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_HEADER, AdminApiError, createAdminClient, describeAdminError, exportFileName, gateFor, nonceBody } from "../api/adminClient.ts";
import { routePayloadSha256 } from "../model/confirm.ts";
import { ADMIN_EVM, ADMIN_SOLANA } from "./fixtures.mjs";

function recorder(responses) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  };
  return { calls, fetch };
}

const SESSION = { address: ADMIN_SOLANA, walletKind: "solana", chainId: null, expiresAt: "2026-10-15T18:00:00Z", idleExpiresAt: "2026-10-15T10:30:00Z", evmActors: [ADMIN_EVM] };

test("every call sends the session cookie and the X-Kletia-Admin header to /api/admin", async () => {
  const { calls, fetch } = recorder([{ status: 200, body: { session: SESSION } }, { status: 200, body: { profiles: [] } }]);
  const client = createAdminClient({ baseUrl: "https://api.kletiaai.xyz/", fetch });
  assert.deepEqual(await client.session(), SESSION);
  await client.profiles();
  for (const call of calls) {
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.headers[ADMIN_HEADER], "1");
    assert.equal(call.init.cache, "no-store");
  }
  assert.equal(calls[0].url, "https://api.kletiaai.xyz/api/admin/auth/session");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers["Content-Type"], undefined, "no body, no content type");
});

test("EVM and Solana nonce requests carry the wallet family; verify sends the exact text and signature", async () => {
  assert.deepEqual(nonceBody({ kind: "evm", address: ADMIN_EVM, chainId: 8453 }), { walletKind: "evm", address: ADMIN_EVM, chainId: 8453, purpose: "login" });
  assert.deepEqual(nonceBody({ kind: "solana", address: ADMIN_SOLANA }), { walletKind: "solana", address: ADMIN_SOLANA, purpose: "login" });
  const { calls, fetch } = recorder([
    { status: 200, body: { message: "m", nonce: "n", expiresAt: "e", walletKind: "solana" } },
    { status: 200, body: { session: SESSION } },
    { status: 200, body: { message: "c", nonce: "n2", expiresAt: "e", walletKind: "solana" } },
  ]);
  const client = createAdminClient({ baseUrl: "http://127.0.0.1:3161", fetch });
  await client.nonce({ kind: "solana", address: ADMIN_SOLANA });
  await client.verify("line 1\nline 2", "5sig");
  await client.confirmNonce({ walletKind: "solana", address: ADMIN_SOLANA, chainId: 8453, action: "network-profile.update", network: "arbitrum", payloadSha256: "ab" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { walletKind: "solana", address: ADMIN_SOLANA, purpose: "login" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { message: "line 1\nline 2", signature: "5sig" });
  assert.deepEqual(JSON.parse(calls[2].init.body), { walletKind: "solana", address: ADMIN_SOLANA, purpose: "confirm", action: "network-profile.update", network: "arbitrum", payloadSha256: "ab" }, "no chain id for Solana");
});

test("AdminErrorBody codes map to gate states", async () => {
  const cases = [
    [503, "ADMIN_DISABLED", "disabled"],
    [403, "ADMIN_ORIGIN_FORBIDDEN", "origin"],
    [503, "ADMIN_STORE_UNAVAILABLE", "store"],
    [401, "ADMIN_SESSION_REQUIRED", "signed-out"],
    [403, "ADMIN_NOT_ALLOWED", "not-allowed"],
    [409, "ADMIN_TX_PENDING", null],
  ];
  for (const [status, code, gate] of cases) {
    const { fetch } = recorder([{ status, body: { error: { code, message: `m ${code}`, requestId: "req_1" } } }]);
    const client = createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch });
    const error = await client.overview().then(() => null, (failure) => failure);
    assert.ok(error instanceof AdminApiError, code);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.requestId, "req_1");
    assert.equal(gateFor(error), gate, code);
  }
});

test("an API without the admin router, a network failure and a non-JSON error are told apart", async () => {
  const missing = recorder([{ status: 404, body: { message: "Not found" } }]);
  const notFound = await createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch: missing.fetch }).session().catch((error) => error);
  assert.equal(notFound.code, "ADMIN_ROUTE_MISSING");
  assert.equal(gateFor(notFound), "missing");
  const down = recorder([new TypeError("Failed to fetch")]);
  const unreachable = await createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch: down.fetch }).session().catch((error) => error);
  assert.equal(unreachable.status, 0);
  assert.equal(unreachable.retryable, true);
  assert.equal(gateFor(unreachable), "unreachable");
  assert.match(describeAdminError(unreachable), /unreachable/u);
  const html = recorder([{ status: 502, body: undefined }]);
  const bad = await createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch: html.fetch }).fees().catch((error) => error);
  assert.equal(bad.code, "ADMIN_HTTP_ERROR");
  assert.equal(bad.retryable, true);
  const off = new AdminApiError("ADMIN_DISABLED", "off", 503);
  assert.equal(off.retryable, false, "admin off is not fixed by a retry");
  assert.equal(gateFor(new Error("x")), null);
});

test("204 responses resolve, paths are encoded, audit limits are clamped", async () => {
  const { calls, fetch } = recorder([
    { status: 204 }, { status: 200, body: { entries: [], next: null } }, { status: 200, body: { artifact: { abi: [] } } },
    { status: 200, body: { message: "c", nonce: "n", expiresAt: "e", walletKind: "evm" } }, { status: 200, body: { record: {} } },
  ]);
  const client = createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch });
  client.setConfirmer({ walletKind: "evm", address: ADMIN_EVM, chainId: 8453, sign: async () => "0xsig" });
  assert.equal(await client.logout(), undefined);
  await client.audit({ limit: 500, before: "2026-10-15T10:00:00.000Z" });
  await client.artifact("base/KletiaIntentRouterV2");
  await client.reverify("dep_../x");
  assert.equal(calls[1].url, "https://api.kletiaai.xyz/api/admin/audit?limit=100&before=2026-10-15T10%3A00%3A00.000Z");
  assert.equal(calls[2].url, "https://api.kletiaai.xyz/api/admin/artifacts/base/KletiaIntentRouterV2");
  assert.equal(calls[4].url, "https://api.kletiaai.xyz/api/admin/deployments/dep_..%2Fx/reverify");
  assert.equal(exportFileName("2026-10-15T10:00:00.000Z"), "kletia-deployments-2026-10-15.json");
});

test("every write first signs a route-bound confirmation with the session's wallet; logout does not", async () => {
  const { calls, fetch } = recorder([
    { status: 200, body: { message: "Kletia admin confirmation\nNonce: n1", nonce: "n1", expiresAt: "e", walletKind: "solana" } },
    { status: 201, body: { proposal: { id: "sfp_1" } } },
    { status: 200, body: { message: "Kletia admin confirmation\nNonce: n2", nonce: "n2", expiresAt: "e", walletKind: "solana" } },
    { status: 202, body: { deploy: { id: "dep-1" } } },
    { status: 204 },
  ]);
  const signed = [];
  const client = createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch });
  client.setConfirmer({ walletKind: "solana", address: ADMIN_SOLANA, chainId: null, sign: async (message) => { signed.push(message); return "5sig"; } });
  const proposal = { network: "base", safe: ADMIN_EVM, to: ADMIN_EVM, value: "0", data: "0x", description: "d", actionId: null };
  await client.proposeSafe(proposal);
  await client.redeploy("api", true);
  await client.logoutAll();
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    walletKind: "solana", address: ADMIN_SOLANA, purpose: "confirm", action: "safe.propose", network: "base",
    payloadSha256: routePayloadSha256("POST", "/safe-proposals", proposal),
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), { ...proposal, confirmation: { message: "Kletia admin confirmation\nNonce: n1", signature: "5sig" } });
  assert.equal(JSON.parse(calls[2].init.body).payloadSha256, routePayloadSha256("POST", "/services/api/deploy", { clearCache: true }));
  assert.equal(JSON.parse(calls[2].init.body).action, "render.deploy");
  assert.equal(JSON.parse(calls[2].init.body).network, undefined);
  assert.deepEqual(JSON.parse(calls[3].init.body).confirmation, { message: "Kletia admin confirmation\nNonce: n2", signature: "5sig" });
  assert.deepEqual(signed, ["Kletia admin confirmation\nNonce: n1", "Kletia admin confirmation\nNonce: n2"]);
  assert.equal(calls[4].url, "https://api.kletiaai.xyz/api/admin/auth/logout-all");
  assert.equal(calls[4].init.body, undefined, "logout needs no confirmation");
});

test("a write without a session wallet to confirm fails before any request", async () => {
  const { calls, fetch } = recorder([]);
  const client = createAdminClient({ baseUrl: "https://api.kletiaai.xyz", fetch });
  const error = await client.rescanFees("k").catch((failure) => failure);
  assert.ok(error instanceof AdminApiError);
  assert.equal(error.code, "ADMIN_CONFIRMATION_REQUIRED");
  assert.equal(calls.length, 0);
  client.setConfirmer({ walletKind: "evm", address: ADMIN_EVM, chainId: 8453, sign: async () => { throw new Error("User rejected the request."); } });
  const rejected = await client.cancelSafe("sfp_1").catch((failure) => failure);
  assert.match(rejected.message, /rejected/u);
  assert.equal(calls.length, 1, "only the nonce was requested; the write was never sent");
});
