/**
 * Developer account flows over HTTP, shared by the memory (accounts.test.ts)
 * and Postgres (accountsPg.test.ts) runs: wallet sign-in (EVM and Solana),
 * origin and session guards, ownership, key issuance, rotation, revocation
 * and recovery on a new device.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { assertError, call, type TestServer } from "./support.js";

export const PORTAL_ORIGIN = "http://localhost:5174";

export interface Wallet {
  readonly kind: "evm" | "solana";
  readonly address: string;
  sign(message: string): Promise<string>;
}

export function evmWallet(): Wallet & { readonly account: PrivateKeyAccount } {
  const account = privateKeyToAccount(generatePrivateKey());
  return { kind: "evm", address: account.address, account, sign: (message) => account.signMessage({ message }) };
}

export function solanaWallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const address = getBase58Decoder().decode(raw);
  return {
    kind: "solana",
    address,
    sign: async (message) => getBase58Decoder().decode(signEd25519(null, Buffer.from(message, "utf8"), privateKey)),
  };
}

export interface NonceReply {
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly walletKind: string;
}

export async function nonceFor(server: TestServer, wallet: Wallet, origin = PORTAL_ORIGIN): Promise<NonceReply> {
  const reply = await call<NonceReply>(server, "POST", "/accounts/nonce", {
    headers: { origin },
    body: wallet.kind === "evm" ? { walletKind: "evm", address: wallet.address, chainId: 8453 } : { walletKind: "solana", address: wallet.address },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body;
}

export async function signIn(server: TestServer, wallet: Wallet, origin = PORTAL_ORIGIN): Promise<string> {
  const { message } = await nonceFor(server, wallet, origin);
  const reply = await call<{ token: string; session: { address: string } }>(server, "POST", "/accounts/session", {
    headers: { origin },
    body: { message, signature: await wallet.sign(message) },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  assert.match(reply.body.token, /^kl_acs_[A-Za-z0-9_-]{43}$/u);
  return reply.body.token;
}

export function as(token: string, origin = PORTAL_ORIGIN): Record<string, string> {
  return { origin, "kletia-account-session": token };
}

interface ProjectView {
  readonly id: string;
  readonly activeKeys: number;
  readonly source: string;
}

interface KeyView {
  readonly id: string;
  readonly kind: string;
  readonly revokedAt: string | null;
}

async function projectsOf(server: TestServer, token: string): Promise<ProjectView[]> {
  const reply = await call<{ projects: ProjectView[] }>(server, "GET", "/accounts/projects", { headers: as(token) });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.projects;
}

async function authenticates(server: TestServer, key: string): Promise<boolean> {
  const reply = await call(server, "GET", "/keys", { key });
  if (reply.status === 401) return false;
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return true;
}

async function anonymousProject(server: TestServer, name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

/** Registers the shared flows; `server()` is read when each test runs. */
export function accountFlows(server: () => TestServer): void {
  it("refuses account routes without a first-party Origin", async () => {
    const wallet = evmWallet();
    const body = { walletKind: "evm", address: wallet.address, chainId: 8453 };
    assertError(await call(server(), "POST", "/accounts/nonce", { body }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
    assertError(await call(server(), "POST", "/accounts/nonce", { body, headers: { origin: "https://evil.example" } }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
    assertError(await call(server(), "GET", "/accounts/projects", { headers: { origin: "https://evil.example", "kletia-account-session": `kl_acs_${"a".repeat(43)}` } }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
  });

  it("signs an EVM wallet in with EIP-4361, once per message", async () => {
    const wallet = evmWallet();
    const { message } = await nonceFor(server(), wallet);
    assert.match(message, /^localhost:5174 wants you to sign in with your Ethereum account:\n/u);
    assert.match(message, /Sign in to the Kletia developer portal to manage your projects\./u);
    assert.match(message, /\nURI: http:\/\/localhost:5174\/developers\/keys\n/u);
    assert.match(message, /\nChain ID: 8453\n/u);
    const signature = await wallet.sign(message);
    const first = await call<{ token: string; session: { address: string; walletKind: string } }>(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.session.address, wallet.address);
    assert.equal(first.body.session.walletKind, "evm");
    // A replay of the same signed message is refused: the nonce was used.
    assertError(await call(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature } }), 401, "ACCOUNT_NONCE_INVALID");
    const session = await call<{ session: { address: string } }>(server(), "GET", "/accounts/session", { headers: as(first.body.token) });
    assert.equal(session.status, 200);
    assert.equal(session.body.session.address, wallet.address);
  });

  it("refuses a signature from another wallet and burns the nonce", async () => {
    const wallet = evmWallet();
    const intruder = evmWallet();
    const { message } = await nonceFor(server(), wallet);
    assertError(await call(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await intruder.sign(message) } }), 401, "ACCOUNT_SIGNATURE_INVALID");
    assertError(await call(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await wallet.sign(message) } }), 401, "ACCOUNT_NONCE_INVALID");
  });

  it("refuses an altered message and a message from another origin", async () => {
    const wallet = evmWallet();
    const { message } = await nonceFor(server(), wallet);
    const altered = message.replace("localhost:5174", "localhost:5173");
    assertError(await call(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message: altered, signature: await wallet.sign(altered) } }), 401, "ACCOUNT_NONCE_INVALID");
    const other = await nonceFor(server(), wallet);
    assertError(
      await call(server(), "POST", "/accounts/session", { headers: { origin: "http://localhost:5173" }, body: { message: other.message, signature: await wallet.sign(other.message) } }),
      401,
      "ACCOUNT_NONCE_INVALID",
    );
  });

  it("signs a Solana wallet in with the Sign In With Solana text", async () => {
    const wallet = solanaWallet();
    const { message } = await nonceFor(server(), wallet);
    assert.match(message, /^localhost:5174 wants you to sign in with your Solana account:\n/u);
    const bad = await call(server(), "POST", "/accounts/session", { headers: { origin: PORTAL_ORIGIN }, body: { message, signature: await solanaWallet().sign(message) } });
    assertError(bad, 401, "ACCOUNT_SIGNATURE_INVALID");
    const token = await signIn(server(), wallet);
    const session = await call<{ session: { address: string; walletKind: string; chainId: number | null } }>(server(), "GET", "/accounts/session", { headers: as(token) });
    assert.equal(session.body.session.address, wallet.address);
    assert.equal(session.body.session.walletKind, "solana");
    assert.equal(session.body.session.chainId, null);
  });

  it("validates the nonce request", async () => {
    const wallet = evmWallet();
    const headers = { origin: PORTAL_ORIGIN };
    assertError(await call(server(), "POST", "/accounts/nonce", { headers, body: { walletKind: "evm", address: wallet.address, chainId: 421614 } }), 400, "INVALID_REQUEST");
    assertError(await call(server(), "POST", "/accounts/nonce", { headers, body: { walletKind: "evm", address: "0x1234", chainId: 8453 } }), 400, "INVALID_REQUEST");
    assertError(await call(server(), "POST", "/accounts/nonce", { headers, body: { walletKind: "bitcoin", address: wallet.address } }), 400, "INVALID_REQUEST");
    assertError(await call(server(), "POST", "/accounts/nonce", { headers, body: { walletKind: "solana", address: solanaWallet().address, chainId: 1 } }), 400, "INVALID_REQUEST");
  });

  it("requires a live session from the origin that signed in", async () => {
    const token = await signIn(server(), evmWallet());
    assertError(await call(server(), "GET", "/accounts/projects", { headers: { origin: PORTAL_ORIGIN } }), 401, "ACCOUNT_SESSION_REQUIRED");
    assertError(await call(server(), "GET", "/accounts/projects", { headers: as(`kl_acs_${"b".repeat(43)}`) }), 401, "ACCOUNT_SESSION_REQUIRED");
    assertError(await call(server(), "GET", "/accounts/projects", { headers: as(token, "http://localhost:5173") }), 401, "ACCOUNT_SESSION_REQUIRED");
    // An API key is not a session.
    const project = await anonymousProject(server(), "not-a-session");
    assertError(await call(server(), "GET", "/accounts/projects", { headers: { origin: PORTAL_ORIGIN }, key: project.key }), 401, "ACCOUNT_SESSION_REQUIRED");
  });

  it("creates a project owned by the wallet and keeps it from other wallets", async () => {
    const owner = await signIn(server(), evmWallet());
    const created = await call<{ project: ProjectView; key: { id: string; key: string; lane: string } }>(server(), "POST", "/accounts/projects", {
      headers: as(owner),
      body: { name: "owned", sandbox: true },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.id, `prj_${created.body.key.id}`);
    assert.equal(created.body.project.source, "created");
    assert.equal(created.body.project.activeKeys, 1);
    assert.equal(created.body.key.lane, "testnet");
    assert.ok(await authenticates(server(), created.body.key.key));
    assert.deepEqual((await projectsOf(server(), owner)).map((project) => project.id), [created.body.project.id]);

    const stranger = await signIn(server(), solanaWallet());
    assert.deepEqual(await projectsOf(server(), stranger), []);
    assertError(await call(server(), "GET", `/accounts/projects/${created.body.project.id}/keys`, { headers: as(stranger) }), 404, "PROJECT_NOT_FOUND");
    assertError(await call(server(), "POST", `/accounts/projects/${created.body.project.id}/keys`, { headers: as(stranger), body: { name: "takeover" } }), 404, "PROJECT_NOT_FOUND");
    assertError(
      await call(server(), "DELETE", `/accounts/projects/${created.body.project.id}/keys/${created.body.key.id}`, { headers: as(stranger) }),
      404,
      "PROJECT_NOT_FOUND",
    );
    assertError(await call(server(), "GET", "/accounts/projects/prj_nope/keys", { headers: as(owner) }), 400, "INVALID_REQUEST");
  });

  it("claims an existing project with one of its project keys, once and for one wallet", async () => {
    const project = await anonymousProject(server(), "anonymous");
    const owner = await signIn(server(), evmWallet());
    assertError(await call(server(), "POST", "/accounts/projects/claim", { headers: as(owner) }), 401, "API_KEY_REQUIRED");
    const claimed = await call<{ project: ProjectView; claimed: boolean }>(server(), "POST", "/accounts/projects/claim", { headers: as(owner), key: project.key });
    assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
    assert.equal(claimed.body.claimed, true);
    assert.equal(claimed.body.project.id, `prj_${project.id}`);
    assert.equal(claimed.body.project.source, "claimed");
    const again = await call<{ claimed: boolean }>(server(), "POST", "/accounts/projects/claim", { headers: as(owner), key: project.key });
    assert.equal(again.status, 200);
    assert.equal(again.body.claimed, false);
    const other = await signIn(server(), evmWallet());
    assertError(await call(server(), "POST", "/accounts/projects/claim", { headers: as(other), key: project.key }), 409, "PROJECT_ALREADY_OWNED");
    assert.deepEqual(await projectsOf(server(), other), []);
  });

  it("refuses a claim with a rotated-out secret", async () => {
    const project = await anonymousProject(server(), "rotated");
    const rotated = await call(server(), "POST", `/keys/${project.id}/rotate`, { key: project.key, body: { graceSeconds: 3600 } });
    assert.equal(rotated.status, 200);
    const token = await signIn(server(), evmWallet());
    assertError(await call(server(), "POST", "/accounts/projects/claim", { headers: as(token), key: project.key }), 403, "KEY_SECRET_ROTATED");
  });

  it("rotates and revokes keys of an owned project, and recovers access after every key is gone", async () => {
    const wallet = evmWallet();
    const token = await signIn(server(), wallet);
    const created = await call<{ project: ProjectView; key: { id: string; key: string } }>(server(), "POST", "/accounts/projects", { headers: as(token), body: { name: "first" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const first = created.body.key;

    // Rotation: same id, new secret, the old one stops at once with graceSeconds 0.
    const rotated = await call<{ key: { id: string; key: string; previousExpiresAt: string | null } }>(server(), "POST", `/accounts/projects/${projectId}/keys/${first.id}/rotate`, {
      headers: as(token),
      body: { graceSeconds: 0 },
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.key.id, first.id);
    assert.equal(rotated.body.key.previousExpiresAt, null);
    assert.equal(await authenticates(server(), first.key), false);
    assert.ok(await authenticates(server(), rotated.body.key.key));
    assertError(await call(server(), "POST", `/accounts/projects/${projectId}/keys/key_${"0".repeat(24)}/rotate`, { headers: as(token), body: {} }), 404, "KEY_NOT_FOUND");
    assertError(await call(server(), "POST", `/accounts/projects/${projectId}/keys/${first.id}/rotate`, { headers: as(token), body: { graceSeconds: -1 } }), 400, "INVALID_REQUEST");

    // A key of another project is not reachable through this one.
    const foreign = await anonymousProject(server(), "foreign");
    assertError(await call(server(), "DELETE", `/accounts/projects/${projectId}/keys/${foreign.id}`, { headers: as(token) }), 404, "KEY_NOT_FOUND");
    assert.ok(await authenticates(server(), foreign.key));

    // Revocation: the key stops; the project stays the wallet's with no key left.
    const revoked = await call(server(), "DELETE", `/accounts/projects/${projectId}/keys/${first.id}`, { headers: as(token) });
    assert.equal(revoked.status, 204);
    assert.equal(await authenticates(server(), rotated.body.key.key), false);
    const [listed] = await projectsOf(server(), token);
    assert.equal(listed?.id, projectId);
    assert.equal(listed?.activeKeys, 0);

    // Recovery on a new device: sign in again (a new session) and issue a key in the same project.
    const signedOut = await call(server(), "DELETE", "/accounts/session", { headers: as(token) });
    assert.equal(signedOut.status, 204);
    assertError(await call(server(), "GET", "/accounts/projects", { headers: as(token) }), 401, "ACCOUNT_SESSION_REQUIRED");
    const device = await signIn(server(), wallet);
    assert.deepEqual((await projectsOf(server(), device)).map((project) => project.id), [projectId]);
    const issued = await call<{ key: { id: string; key: string } }>(server(), "POST", `/accounts/projects/${projectId}/keys`, { headers: as(device), body: { name: "recovered" } });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const keys = await call<{ keys: KeyView[] }>(server(), "GET", "/keys", { key: issued.body.key.key });
    assert.equal(keys.status, 200);
    assert.deepEqual(keys.body.keys.map((key) => key.id).sort(), [first.id, issued.body.key.id].sort(), "the recovered key belongs to the same project");
    const owned = await call<{ keys: KeyView[] }>(server(), "GET", `/accounts/projects/${projectId}/keys`, { headers: as(device) });
    assert.equal(owned.status, 200);
    assert.ok(owned.body.keys.find((key) => key.id === first.id)?.revokedAt);
    assert.deepEqual(Object.keys(owned.body.keys[0] ?? {}).sort(), ["createdAt", "expiresAt", "id", "kind", "last4", "lastUsedAt", "name", "parentId", "previousExpiresAt", "revokedAt", "rotatedAt"]);

    // The audit trail of the wallet.
    const activity = await call<{ activity: { action: string; outcome: string }[] }>(server(), "GET", "/accounts/activity", { headers: as(device) });
    assert.equal(activity.status, 200);
    const actions = activity.body.activity.map((row) => `${row.action}:${row.outcome}`);
    for (const expected of ["account.sign_in:ok", "account.project.create:ok", "account.key.rotate:ok", "account.key.revoke:ok", "account.sign_out:ok", "account.key.issue:ok"]) {
      assert.ok(actions.includes(expected), `activity lists ${expected}: ${actions.join(", ")}`);
    }
  });

  it("caps active project keys like POST /v1/keys", async () => {
    const token = await signIn(server(), evmWallet());
    const created = await call<{ project: ProjectView }>(server(), "POST", "/accounts/projects", { headers: as(token), body: { name: "capped" } });
    const projectId = created.body.project.id;
    for (let index = 0; index < 4; index += 1) {
      const issued = await call(server(), "POST", `/accounts/projects/${projectId}/keys`, { headers: as(token), body: { name: `k${index}` } });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
    }
    assertError(await call(server(), "POST", `/accounts/projects/${projectId}/keys`, { headers: as(token), body: { name: "sixth" } }), 409, "KEY_LIMIT_REACHED");
  });
}
