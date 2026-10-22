/**
 * API key self-management: projects, sibling keys, listing, rotation with a
 * grace window, revocation, immediate cache purges on the answering
 * instance, and immutable operator keys.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { configurePlatform } from "../../index.js";
import { ACCOUNTS, EVM_ADDRESS, OTHER_EVM_ADDRESS, resetEngine, SOL_ACCOUNT } from "../../engine/__tests__/helpers.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");

interface IssuedKey {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly createdAt: string;
}

interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly last4: string | null;
  readonly current: boolean;
  readonly revokedAt: string | null;
  readonly rotatedAt: string | null;
  readonly previousExpiresAt: string | null;
  readonly lastUsedAt: string | null;
}

/** A fresh router per call: key issuance is limited to 5 per hour per IP and router. */
function servePlatform(): Promise<TestServer> {
  return serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
}

async function issue(server: TestServer, name: string, key?: string): Promise<IssuedKey> {
  const reply = await call<{ key: IssuedKey }>(server, "POST", "/keys", { body: { name }, ...(key ? { key } : {}) });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function list(server: TestServer, key: string): Promise<KeyView[]> {
  const reply = await call<{ keys: KeyView[] }>(server, "GET", "/keys", { key });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.keys;
}

async function authenticates(server: TestServer, key: string): Promise<boolean> {
  const reply = await call(server, "GET", "/protocols", { key });
  if (reply.status === 401) return false;
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return true;
}

let server: TestServer;

before(() => {
  resetEngine();
});

// A fresh router (and key issuance window) per test.
beforeEach(async () => {
  server = await servePlatform();
});

afterEach(async () => {
  await server.close();
});

after(() => {
  configurePlatform({ adapters: null });
});

describe("API key projects", () => {
  it("lists the caller's project without secrets and marks the calling key", async () => {
    const root = await issue(server, "root");
    const sibling = await issue(server, "sibling", root.key);
    const keys = await list(server, root.key);
    assert.deepEqual(keys.map((key) => key.id).sort(), [root.id, sibling.id].sort());
    const self = keys.find((key) => key.id === root.id);
    assert.equal(self?.current, true);
    assert.equal(self?.last4, root.key.slice(-4));
    assert.equal(keys.find((key) => key.id === sibling.id)?.current, false);
    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes(root.key) && !serialized.includes(sibling.key), "secrets are never listed");
    assert.deepEqual(Object.keys(self ?? {}).sort(), [
      "createdAt", "current", "depth", "descendants", "expiresAt", "id", "kind", "lane", "last4", "lastUsedAt", "name", "parentId", "policyVersion",
      "previousExpiresAt", "revokedAt", "rotatedAt", "tier",
    ]);
    assert.equal((self as unknown as { kind?: string }).kind, "project");
    // A key issued without a key starts its own project.
    const stranger = await issue(server, "stranger");
    assert.deepEqual((await list(server, stranger.key)).map((key) => key.id), [stranger.id]);
  });

  it("caps a project at 5 active keys", async () => {
    const first = await servePlatform();
    const second = await servePlatform();
    try {
      const root = await issue(first, "cap-root");
      for (let index = 0; index < 4; index += 1) await issue(first, `cap-${index}`, root.key);
      assertError(await call(second, "POST", "/keys", { key: root.key, body: { name: "sixth" } }), 409, "KEY_LIMIT_REACHED");
      const keys = await list(second, root.key);
      assert.equal(keys.length, 5);
      const victim = keys.find((key) => !key.current);
      assert.ok(victim);
      assert.equal((await call(second, "DELETE", `/keys/${victim.id}`, { key: root.key })).status, 204);
      await issue(second, "replacement", root.key);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("requires a key and validates ids and bodies", async () => {
    const owner = await issue(server, "validation");
    assertError(await call(server, "GET", "/keys"), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", `/keys/${owner.id}/rotate`), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", "/keys/key_123/rotate", { key: owner.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "DELETE", "/keys/nope", { key: owner.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/keys/${owner.id}/rotate`, { key: owner.key, body: { graceSeconds: -1 } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/keys/${owner.id}/rotate`, { key: owner.key, body: { graceSeconds: 604_801 } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/keys/${owner.id}/rotate`, { key: owner.key, body: { graceSeconds: 10, extra: true } }), 400, "INVALID_REQUEST");
  });

  it("never manages another project's keys", async () => {
    const mine = await issue(server, "mine");
    const theirs = await issue(server, "theirs");
    assertError(await call(server, "POST", `/keys/${theirs.id}/rotate`, { key: mine.key }), 404, "KEY_NOT_FOUND");
    assertError(await call(server, "DELETE", `/keys/${theirs.id}`, { key: mine.key }), 404, "KEY_NOT_FOUND");
    assertError(await call(server, "DELETE", `/keys/key_${"0".repeat(24)}`, { key: mine.key }), 404, "KEY_NOT_FOUND");
    assert.ok(await authenticates(server, theirs.key));
  });
});

describe("rotation", () => {
  it("keeps the id, issues a new secret and honours the old one during the grace window only for reads", async () => {
    const key = await issue(server, "rotating");
    const created = await call<{ intent: { id: string } }>(server, "POST", "/intents", { key: key.key, body: { text: "swap 1 SOL to USDC", accounts: ACCOUNTS } });
    assert.equal(created.status, 201);
    assert.ok(await authenticates(server, key.key), "old secret cached before rotation");
    const rotated = await call<{ key: IssuedKey & { rotatedAt: string; previousExpiresAt: string | null } }>(server, "POST", `/keys/${key.id}/rotate`, {
      key: key.key,
      body: { graceSeconds: 3600 },
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.key.id, key.id, "the key id survives rotation");
    assert.notEqual(rotated.body.key.key, key.key);
    assert.match(rotated.body.key.key, /^kl_dev_[0-9A-Za-z]{32}$/u);
    assert.ok(rotated.body.key.previousExpiresAt && Date.parse(rotated.body.key.previousExpiresAt) > Date.now() + 3_500_000);

    assert.ok(await authenticates(server, rotated.body.key.key), "new secret works");
    assert.ok(await authenticates(server, key.key), "old secret works during the grace window");
    // Intents stay attached to the key id.
    const listed = await call<{ intents: { id: string }[] }>(server, "GET", "/intents", { key: rotated.body.key.key });
    assert.deepEqual(listed.body.intents.map((intent) => intent.id), [created.body.intent.id]);
    // A rotated-out secret cannot take the key over.
    assertError(await call(server, "POST", `/keys/${key.id}/rotate`, { key: key.key }), 403, "KEY_SECRET_ROTATED");
    assertError(await call(server, "DELETE", `/keys/${key.id}`, { key: key.key }), 403, "KEY_SECRET_ROTATED");
    assertError(await call(server, "GET", "/keys", { key: key.key }), 403, "KEY_SECRET_ROTATED");
    assertError(await call(server, "POST", "/keys", { key: key.key, body: { name: "takeover" } }), 403, "KEY_SECRET_ROTATED");

    const view = (await list(server, rotated.body.key.key)).find((entry) => entry.id === key.id);
    assert.equal(view?.last4, rotated.body.key.key.slice(-4));
    assert.equal(view?.rotatedAt, rotated.body.key.rotatedAt);
    assert.equal(view?.previousExpiresAt, rotated.body.key.previousExpiresAt);

    // Rotating again without grace ends every earlier secret at once, even ones this instance has cached.
    const again = await call<{ key: IssuedKey & { previousExpiresAt: string | null } }>(server, "POST", `/keys/${key.id}/rotate`, {
      key: rotated.body.key.key,
      body: { graceSeconds: 0 },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.key.previousExpiresAt, null);
    assert.equal(await authenticates(server, key.key), false, "first secret");
    assert.equal(await authenticates(server, rotated.body.key.key), false, "second secret");
    assert.ok(await authenticates(server, again.body.key.key));
  });

  it("stops the previous secret when its grace window ends, despite the verification cache", async () => {
    const key = await issue(server, "short-grace");
    const rotated = await call<{ key: IssuedKey }>(server, "POST", `/keys/${key.id}/rotate`, { key: key.key, body: { graceSeconds: 1 } });
    assert.equal(rotated.status, 200);
    assert.ok(await authenticates(server, key.key), "inside the window (and now cached)");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await authenticates(server, key.key), false);
    assert.ok(await authenticates(server, rotated.body.key.key));
  });
});

describe("revocation", () => {
  it("revokes at once on this instance, is idempotent and can target the calling key", async () => {
    const root = await issue(server, "revoker");
    const leaked = await issue(server, "leaked", root.key);
    assert.ok(await authenticates(server, leaked.key), "cached before revocation");
    assert.equal((await call(server, "DELETE", `/keys/${leaked.id}`, { key: root.key })).status, 204);
    assert.equal(await authenticates(server, leaked.key), false);
    assert.equal((await call(server, "DELETE", `/keys/${leaked.id}`, { key: root.key })).status, 204, "idempotent");
    assertError(await call(server, "POST", `/keys/${leaked.id}/rotate`, { key: root.key }), 404, "KEY_NOT_FOUND");
    const view = (await list(server, root.key)).find((entry) => entry.id === leaked.id);
    assert.ok(view?.revokedAt, "revoked keys stay listed");
    assert.equal((await call(server, "DELETE", `/keys/${root.id}`, { key: root.key })).status, 204, "a key may revoke itself");
    assert.equal(await authenticates(server, root.key), false);
  });
});

describe("operator keys", () => {
  it("are immutable and never listed; issuing with one starts a new project", async () => {
    assertError(await call(server, "GET", "/keys", { key: OPERATOR_KEY }), 409, "KEY_NOT_MANAGEABLE");
    assertError(await call(server, "DELETE", "/keys/op_0123456789abcdef", { key: OPERATOR_KEY }), 409, "KEY_NOT_MANAGEABLE");
    const developer = await issue(server, "dev");
    assertError(await call(server, "POST", "/keys/op_0123456789abcdef/rotate", { key: developer.key }), 409, "KEY_NOT_MANAGEABLE");
    const issued = await issue(server, "provisioned", OPERATOR_KEY);
    assert.deepEqual((await list(server, issued.key)).map((key) => key.id), [issued.id]);
  });
});

/* ------------------------------------------------------------ store contract */

const auth = await import("../auth.js");
const { closePlatformDatabase } = await import("../db.js");

function keyContract(name: string, make: () => import("../auth.js").ApiKeyStore): void {
  describe(`${name} API key store`, () => {
    const record = (id: string, projectId: string): import("../auth.js").ApiKeyRecord => ({
      id,
      name: id,
      tier: "developer",
      createdAt: new Date().toISOString(),
      revokedAt: null,
      projectId,
      last4: "abcd",
      rotatedAt: null,
      previousExpiresAt: null,
      lastUsedAt: null,
    });
    const id = () => `key_${randomBytes(12).toString("hex")}`;
    const hash = () => randomBytes(32).toString("hex");

    it("finds keys by current and unexpired previous secret, rotates and revokes within a project", async () => {
      const store = make();
      const rootId = id();
      const rootHash = hash();
      await store.insert(record(rootId, rootId), rootHash);
      const siblingId = id();
      await store.insert(record(siblingId, rootId), hash(), 2);
      await assert.rejects(store.insert(record(id(), rootId), hash(), 2), (error: { code?: string }) => error.code === "KEY_LIMIT_REACHED");
      await assert.rejects(store.insert(record(id(), rootId), rootHash), (error: { code?: string }) => error.code === "KEY_COLLISION");
      assert.deepEqual((await store.listByProject(rootId)).map((entry) => entry.id).sort(), [rootId, siblingId].sort());

      const now = Date.now();
      assert.equal((await store.findByHash(rootHash, now))?.viaPrevious, false);
      const newHash = hash();
      const graceEnd = new Date(now + 60_000).toISOString();
      const rotated = await store.rotate(rootId, rootId, newHash, "wxyz", new Date(now).toISOString(), graceEnd);
      assert.equal(rotated?.last4, "wxyz");
      assert.equal(rotated?.previousExpiresAt, graceEnd);
      assert.equal((await store.findByHash(newHash, now))?.viaPrevious, false);
      assert.equal((await store.findByHash(rootHash, now))?.viaPrevious, true);
      assert.equal(await store.findByHash(rootHash, now + 61_000), null, "the previous secret expires");
      assert.equal(await store.rotate(rootId, `key_${"0".repeat(24)}`, hash(), "zzzz", new Date().toISOString(), null), null, "other projects cannot rotate");

      const latest = hash();
      await store.rotate(rootId, rootId, latest, "last", new Date(now).toISOString(), null);
      assert.equal(await store.findByHash(rootHash, now), null, "a rotation without grace ends the earlier window");
      assert.equal(await store.findByHash(newHash, now), null);

      await store.touch(new Map([[rootId, new Date(now).toISOString()]]));
      await store.touch(new Map([[rootId, new Date(now - 60_000).toISOString()]]));
      assert.equal((await store.listByProject(rootId)).find((entry) => entry.id === rootId)?.lastUsedAt, new Date(now).toISOString(), "never moves backwards");

      assert.equal(await store.revoke(siblingId, `key_${"0".repeat(24)}`, new Date().toISOString()), "missing");
      assert.equal(await store.revoke(siblingId, rootId, new Date().toISOString()), "revoked");
      assert.equal(await store.revoke(siblingId, rootId, new Date().toISOString()), "already_revoked");
      assert.ok((await store.listByProject(rootId)).find((entry) => entry.id === siblingId)?.revokedAt);
      assert.ok((await store.findById(siblingId))?.revokedAt, "found by id once revoked");
      assert.equal((await store.findById(rootId))?.revokedAt, null);
      assert.equal(await store.findById(id()), null);
      assert.equal(await store.rotate(siblingId, rootId, hash(), "nope", new Date().toISOString(), null), null, "revoked keys cannot rotate");
      // Revoked keys free a slot in the project.
      await store.insert(record(id(), rootId), hash(), 2);
    });

    it("inserts publishable keys under a project key, at most `maxActive` live ones, revoked with their parent", async () => {
      const store = make();
      const rootId = id();
      await store.insert(record(rootId, rootId), hash());
      const publishable = (keyId: string): import("../auth.js").ApiKeyRecord => ({ ...record(keyId, rootId), kind: "publishable", parentId: rootId, lineage: [rootId], expiresAt: null });
      const first = id();
      const firstHash = hash();
      await store.insertPublishable(publishable(first), firstHash, 2, Date.now());
      await store.insertPublishable(publishable(id()), hash(), 2, Date.now());
      await assert.rejects(store.insertPublishable(publishable(id()), hash(), 2, Date.now()), (error: { code?: string }) => error.code === "KEY_LIMIT_REACHED");
      const match = await store.findByHash(firstHash, Date.now());
      assert.equal(match?.record.kind, "publishable");
      assert.deepEqual(match?.record.lineage, [rootId]);
      assert.equal(match?.active, true);
      // Project keys and agents are counted apart: the project key cap is untouched.
      await store.insert(record(id(), rootId), hash(), 2);
      const revoked = await store.revokeSubtree(rootId, rootId, new Date().toISOString());
      assert.ok(revoked.cascade.includes(first), "revoking the parent revokes its publishable keys");
      assert.equal((await store.findByHash(firstHash, Date.now()))?.active, false);
    });
  });
}

keyContract("memory", () => new auth.MemoryApiKeyStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    });
    keyContract("postgres", () => new auth.PostgresApiKeyStore());
  });
} else {
  describe("postgres API key store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}

describe("sandbox keys", () => {
  const SEPOLIA_ACCOUNT = `eip155:421614:${EVM_ADDRESS}`;

  it("issues a key kept on the testnet lane by its rule book: arbitrum-sepolia plans, base is refused", async () => {
    const reply = await call<{ key: IssuedKey & { lane: string } }>(server, "POST", "/keys", { body: { name: "sandbox", sandbox: true } });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const sandbox = reply.body.key;
    assert.equal(sandbox.lane, "testnet");
    assert.match(sandbox.key, /^kl_dev_/u);
    const testnet = await call<{ intent: { id: string; status: string } }>(server, "POST", "/intents", {
      key: sandbox.key,
      body: { text: `send 5 USDC to ${OTHER_EVM_ADDRESS} on arbitrum sepolia`, accounts: [SEPOLIA_ACCOUNT] },
    });
    assert.equal(testnet.status, 201, JSON.stringify(testnet.body));
    const refused = assertError(
      await call(server, "POST", "/intents", { key: sandbox.key, body: { text: `send 5 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS } }),
      403,
      "POLICY_VIOLATION",
    );
    assert.match(JSON.stringify(refused), /networks\.lanes/u);
    // The rule book is an ordinary key-level rule book.
    const policy = await call<{ policy: { status: string; document: { label: string; networks: { lanes: string[] } } } }>(server, "GET", `/keys/${sandbox.id}/policy`, { key: sandbox.key });
    assert.equal(policy.status, 200, JSON.stringify(policy.body));
    assert.equal(policy.body.policy.status, "active");
    assert.deepEqual(policy.body.policy.document.networks.lanes, ["testnet"]);
    assert.equal(policy.body.policy.document.label, "Sandbox");
  });

  it("refuses a mainnet route of a sandbox key before any provider is quoted", async () => {
    const reply = await call<{ key: IssuedKey & { lane: string } }>(server, "POST", "/keys", { body: { name: "sandbox-quote", sandbox: true } });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const previous = globalThis.fetch;
    const upstream: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/jup\.ag|jupiter/iu.test(url)) {
        upstream.push(url);
        return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
      }
      return previous(input, init);
    }) as typeof fetch;
    try {
      for (const dryRun of [true, false]) {
        const refused = assertError(
          await call(server, "POST", dryRun ? "/intents?dryRun=true" : "/intents", { key: reply.body.key.key, body: { text: "swap 1 SOL to USDC", accounts: [SOL_ACCOUNT] } }),
          403,
          "POLICY_VIOLATION",
        );
        assert.match(JSON.stringify(refused), /Solana is on the production lane; this key may use the testnet lane only/u);
        assert.equal(refused.error.issues?.[0]?.path, "steps[0].network");
      }
    } finally {
      globalThis.fetch = previous;
    }
    assert.deepEqual(upstream, [], "no provider was asked for a route the rule book refuses");
  });

  it("lists each key's lane, also for a sandbox sibling", async () => {
    const root = await issue(server, "lanes-root");
    const sibling = await call<{ key: IssuedKey & { lane: string } }>(server, "POST", "/keys", { key: root.key, body: { name: "lanes-sandbox", sandbox: true } });
    assert.equal(sibling.status, 201, JSON.stringify(sibling.body));
    assert.equal(sibling.body.key.lane, "testnet");
    const live = await call<{ key: IssuedKey & { lane: string } }>(server, "POST", "/keys", { key: root.key, body: { name: "lanes-live", sandbox: false } });
    assert.equal(live.body.key.lane, "any");
    const keys = (await list(server, root.key)) as unknown as { id: string; lane: string }[];
    assert.deepEqual(Object.fromEntries(keys.map((key) => [key.id, key.lane])), { [root.id]: "any", [sibling.body.key.id]: "testnet", [live.body.key.id]: "any" });
    // A production-only key rule book reads as production.
    const put = await call(server, "PUT", `/keys/${live.body.key.id}/policy`, {
      key: root.key,
      headers: { "if-match": "none" },
      body: { schema: "kletia.policy/v1", networks: { lanes: ["production"] } },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const after = (await list(server, root.key)) as unknown as { id: string; lane: string }[];
    assert.equal(after.find((key) => key.id === live.body.key.id)?.lane, "production");
  });

  it("validates sandbox", async () => {
    const refused = assertError(await call(server, "POST", "/keys", { body: { name: "typed", sandbox: "yes" } }), 400, "INVALID_REQUEST");
    assert.equal(refused.error.issues?.[0]?.path, "sandbox");
  });
});

describe("key issuance budget", () => {
  it("does not count issuances refused with 4xx against the 5 per hour", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      assertError(await call(server, "POST", "/keys", { body: {} }), 400, "INVALID_REQUEST");
    }
    for (let index = 0; index < 5; index += 1) await issue(server, `budget-${index}`);
    const limited = assertError(await call(server, "POST", "/keys", { body: { name: "sixth" } }), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /5 API keys/u);
    // A refused request after the budget is spent stays refused (429 is not given back either).
    assertError(await call(server, "POST", "/keys", { body: { name: "seventh" } }), 429, "RATE_LIMITED");
  });
});
