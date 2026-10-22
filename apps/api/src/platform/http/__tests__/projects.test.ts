/**
 * Project settings over HTTP (integrator design 4.8): GET and the If-Match
 * merge patch (PROJECT_SETTINGS_INVALID, PROJECT_CONFLICT), who may write,
 * flows dry-run and saved by the caller, domain verification through the
 * test seam and the daily re-check, the logo (PNG / WebP header checks,
 * refusals, fixed headers, served only while the domain is verified), and
 * the memory and (with KLETIA_TEST_DATABASE_URL) Postgres project stores.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/projects.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PROJECT_SCHEMA, projectSettingsHash, type ProjectProfile, type ProjectView } from "@kletia/core";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();

const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { apiKeyStore, issueDeveloperKey, issueAgentKey } = await import("../auth.js");
const projects = await import("../projects.js");
const { checkLogo } = await import("../projects/logo.js");
const { publishableAddressLimiter } = await import("../limits.js");

let server: TestServer;
const verifiedProjects = new Set<string>();
const checkedWebsites: string[] = [];

async function projectKey(name: string, sibling?: { id: string }): Promise<{ id: string; key: string }> {
  const issued = await issueDeveloperKey(name, sibling ? { id: sibling.id, maxActive: 5 } : undefined);
  return { id: issued.id, key: issued.key };
}

async function read(key: string): Promise<ProjectView> {
  const reply = await call<{ project: ProjectView }>(server, "GET", "/projects/current", { key });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.project;
}

function patch(key: string, body: unknown, hash: string | null) {
  return call<{ project: ProjectView }>(server, "PATCH", "/projects/current", { key, body, headers: hash === null ? {} : { "if-match": `"${hash}"` } });
}

async function settle(key: string, body: Record<string, unknown>): Promise<ProjectView> {
  const reply = await patch(key, body, (await read(key)).hash);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.project;
}

/* ------------------------------------------------------------ image bytes */

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

/** A PNG made of headers only (the API never decodes pixels). */
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", Buffer.alloc(8)), chunk("IEND", Buffer.alloc(0))]);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "latin1"), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Lossless WebP header: signature 0x2f, then 14-bit width-1 and height-1. */
function webpLossless(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff([webpChunk("VP8L", data)]);
}

/** Extended WebP (VP8X) with the animation flag set or not. */
function webpExtended(width: number, height: number, animated: boolean): Buffer {
  const data = Buffer.alloc(10);
  data[0] = animated ? 0x02 : 0x10;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff([webpChunk("VP8X", data), ...(animated ? [webpChunk("ANIM", Buffer.alloc(6))] : []), webpChunk("VP8L", Buffer.from([0x2f, 0, 0, 0, 0]))]);
}

async function upload(key: string, bytes: Buffer, type: string) {
  const response = await fetch(`${server.base}/projects/current/logo`, { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": type }, body: new Uint8Array(bytes) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as { project?: ProjectView; error?: { code: string } } : {} };
}

/* ------------------------------------------------------------ setup */

before(async () => {
  resetEngine();
  projects.configureProjectChecks({
    domain: async (website, projectId) => {
      checkedWebsites.push(website);
      return verifiedProjects.has(projectId);
    },
  });
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  projects.configureProjectChecks(null);
  await server.close();
});

beforeEach(() => {
  publishableAddressLimiter.reset();
});

describe("project settings", () => {
  it("starts empty at version 0 and saves a merge patch under If-Match", async () => {
    const owner = await projectKey("settings");
    const empty = await read(owner.key);
    assert.equal(empty.id, `prj_${owner.id}`);
    assert.equal(empty.version, 0);
    assert.deepEqual(empty.settings, { schema: PROJECT_SCHEMA });
    assert.equal(empty.hash, projectSettingsHash({ schema: PROJECT_SCHEMA }));
    assert.deepEqual(JSON.parse(empty.domain.file), { projects: [empty.id] });
    const saved = await patch(owner.key, { allowedOrigins: ["https://shop.example"], brand: { name: "Acme Store", website: "https://acme.example" }, defaults: { lane: "production", sourceNetwork: "auto" } }, empty.hash);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.headers.get("etag"), `"${saved.body.project.hash}"`);
    assert.equal(saved.body.project.version, 1);
    assert.equal(saved.body.project.updatedBy, owner.id);
    assert.deepEqual(saved.body.project.domain, { host: "acme.example", verified: false, checkedAt: null, file: empty.domain.file });
    const next = await patch(owner.key, { brand: null, allowedOrigins: ["https://shop.example", "http://localhost:5173"] }, saved.body.project.hash);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.project.settings.brand, undefined, "null removes a field");
    assert.equal(next.body.project.domain.host, null);
    assert.deepEqual((await read(owner.key)).settings.allowedOrigins, ["https://shop.example", "http://localhost:5173"]);
  });

  it("accepts lane \"any\" (both lanes) and names lanes as key lists do", async () => {
    const owner = await projectKey("lanes");
    const sandbox = await settle(owner.key, { allowedOrigins: ["https://shop.example"], defaults: { lane: "testnet" } });
    assert.equal(sandbox.settings.defaults?.lane, "testnet");
    const any = await patch(owner.key, { defaults: { lane: "any" } }, sandbox.hash);
    assert.equal(any.status, 200, JSON.stringify(any.body));
    assert.equal(any.body.project.settings.defaults?.lane, undefined, "any is stored as no lane");
    assertError(await patch(owner.key, { defaults: { lane: "mainnet" } }, any.body.project.hash), 400, "PROJECT_SETTINGS_INVALID");
    const pub = await call<{ key: { id: string; key: string } }>(server, "POST", "/projects/current/publishable-keys", { key: owner.key, body: { label: "site" } });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const profile = await call<{ profile: ProjectProfile }>(server, "GET", "/publishable/profile", { key: pub.body.key.key, headers: { origin: "https://shop.example" } });
    assert.equal(profile.body.profile.lane, "any");
    const keys = await call<{ keys: { id: string; lane: string }[] }>(server, "GET", "/keys", { key: owner.key });
    assert.equal(keys.body.keys.find((key) => key.id === pub.body.key.id)?.lane, profile.body.profile.lane, "the key list and the profile agree");
  });

  it("answers 409 PROJECT_CONFLICT on a stale hash and 400 without If-Match", async () => {
    const owner = await projectKey("conflict");
    const first = await read(owner.key);
    await settle(owner.key, { allowedOrigins: ["https://a.example"] });
    assertError(await patch(owner.key, { allowedOrigins: ["https://b.example"] }, first.hash), 409, "PROJECT_CONFLICT");
    assertError(await patch(owner.key, { allowedOrigins: ["https://b.example"] }, null), 400, "INVALID_REQUEST");
    assertError(await patch(owner.key, {}, "nothex"), 400, "INVALID_REQUEST");
    assert.deepEqual((await read(owner.key)).settings.allowedOrigins, ["https://a.example"]);
  });

  it("refuses invalid settings with PROJECT_SETTINGS_INVALID and the issues", async () => {
    const owner = await projectKey("invalid");
    const hash = (await read(owner.key)).hash;
    const origins = assertError(await patch(owner.key, { allowedOrigins: ["http://shop.example", "https://ok.example"] }, hash), 400, "PROJECT_SETTINGS_INVALID");
    assert.deepEqual(origins.error.issues?.map((issue) => issue.path), ["allowedOrigins[0]"]);
    const brand = assertError(await patch(owner.key, { brand: { name: "Jupiter Pay", website: "https://acme.example" } }, hash), 400, "PROJECT_SETTINGS_INVALID");
    assert.deepEqual(brand.error.issues?.map((issue) => issue.path), ["brand.name"]);
    const many = assertError(await patch(owner.key, { allowedOrigins: Array.from({ length: 21 }, (_, index) => `https://s${index}.example`) }, hash), 400, "PROJECT_SETTINGS_INVALID");
    assert.deepEqual(many.error.issues?.map((issue) => issue.path), ["allowedOrigins"]);
    const appearance = assertError(await patch(owner.key, { defaults: { appearance: { font: "Comic Sans" } } }, hash), 400, "PROJECT_SETTINGS_INVALID");
    assert.deepEqual(appearance.error.issues?.map((issue) => issue.path), ["defaults.appearance.font"]);
  });

  it("lets every key of the project read, and only project keys with the current secret write", async () => {
    const owner = await projectKey("writers");
    const sibling = await projectKey("sibling", owner);
    await settle(sibling.key, { allowedOrigins: ["https://shop.example"] });
    const parent = await apiKeyStore().findById(owner.id);
    assert.ok(parent);
    const agent = await issueAgentKey("bot", parent, new Date(Date.now() + 3_600_000).toISOString(), 100);
    const view = await read(agent.key);
    assert.deepEqual(view.settings.allowedOrigins, ["https://shop.example"]);
    assertError(await patch(agent.key, { allowedOrigins: [] }, view.hash), 403, "AGENT_KEY_FORBIDDEN");
    assertError(await call(server, "POST", "/projects/current/domain/verify", { key: agent.key, body: {} }), 403, "AGENT_KEY_FORBIDDEN");
    const rotated = await call<{ key: { key: string } }>(server, "POST", `/keys/${owner.id}/rotate`, { key: owner.key, body: { graceSeconds: 600 } });
    assert.equal(rotated.status, 200);
    assertError(await patch(owner.key, { allowedOrigins: [] }, view.hash), 403, "KEY_SECRET_ROTATED");
    assertError(await call(server, "GET", "/projects/current"), 401, "API_KEY_REQUIRED");
  });

  it("dry-runs a new flow as its saver and keeps the saver of an unchanged flow", async () => {
    const owner = await projectKey("flows");
    const sibling = await projectKey("flows-sibling", owner);
    const swap = { id: "swap", label: "Swap SOL", actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }] };
    const saved = await settle(owner.key, { flows: [swap] });
    assert.equal(saved.settings.flows?.[0]?.ownerKeyId, owner.id);
    // The sibling changes something else and sends the flows back as GET returned them.
    const again = await settle(sibling.key, { allowedOrigins: ["https://shop.example"], flows: saved.settings.flows });
    assert.equal(again.settings.flows?.[0]?.ownerKeyId, owner.id, "an unchanged flow keeps its saver (its contract authority)");
    const changed = await settle(sibling.key, { flows: [{ ...swap, label: "Swap some SOL" }] });
    assert.equal(changed.settings.flows?.[0]?.ownerKeyId, sibling.id, "a changed flow is saved by the caller");
    const unknown = assertError(
      await patch(owner.key, { flows: [{ id: "deposit", label: "Deposit", actions: [{ kind: "call", network: "base", contract: `ct_${"0".repeat(24)}`, entry: "deposit", amount: "10" }] }] }, changed.hash),
      400,
      "PROJECT_SETTINGS_INVALID",
    );
    assert.match(unknown.error.issues?.[0]?.path ?? "", /^flows\[0\]/u);
    assert.match(unknown.error.issues?.[0]?.message ?? "", /^CONTRACT_UNKNOWN/u);
  });
});

describe("domain verification", () => {
  it("verifies through the guarded fetcher seam, resets on a new website and re-checks daily", async () => {
    const owner = await projectKey("domain");
    assertError(await call(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} }), 400, "PROJECT_SETTINGS_INVALID");
    const saved = await settle(owner.key, { brand: { name: "Acme Store", website: "https://acme.example" }, allowedOrigins: ["https://shop.example"] });
    const failed = await call<{ project: ProjectView }>(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} });
    assert.equal(failed.body.project.domain.verified, false);
    assert.ok(failed.body.project.domain.checkedAt);
    verifiedProjects.add(saved.id);
    const verified = await call<{ project: ProjectView }>(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} });
    assert.equal(verified.body.project.domain.verified, true);
    assert.equal(checkedWebsites.at(-1), "https://acme.example");
    // A publishable key now sees the verified brand.
    const pub = await call<{ key: { key: string } }>(server, "POST", "/projects/current/publishable-keys", { key: owner.key, body: { label: "site" } });
    const profile = await call<{ profile: ProjectProfile }>(server, "GET", "/publishable/profile", { key: pub.body.key.key, headers: { origin: "https://shop.example" } });
    assert.deepEqual(profile.body.profile.brand, { name: "Acme Store", host: "acme.example", verified: true, logo: null });
    // The daily re-check: the file no longer lists the project.
    verifiedProjects.delete(saved.id);
    assert.ok((await projects.recheckProjectDomains(0, 500)) >= 1);
    assert.equal((await read(owner.key)).domain.verified, false);
    // A new website starts unverified.
    verifiedProjects.add(saved.id);
    await call(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} });
    const moved = await settle(owner.key, { brand: { name: "Acme Store", website: "https://acme.shop" } });
    assert.deepEqual([moved.domain.host, moved.domain.verified, moved.domain.checkedAt], ["acme.shop", false, null]);
  });

  it("never lets a proof on a non-default port verify the host on 443 (review R6-1)", async () => {
    const owner = await projectKey("domain-port");
    // A port is refused at the door.
    const refused = assertError(await patch(owner.key, { brand: { name: "Victim", website: "https://victim.example:8443" } }, (await read(owner.key)).hash), 400, "PROJECT_SETTINGS_INVALID");
    assert.equal(refused.error.issues?.[0]?.path, "brand.website");
    // A record saved before the rule (website on :8443) is keyed by host:port and its proof never moves to :443.
    const saved = await settle(owner.key, { schema: PROJECT_SCHEMA, brand: { name: "Victim", website: "https://victim.example" } });
    const projectId = saved.id.slice(4);
    const store = projects.projectStore();
    const current = await store.get(projectId);
    assert.ok(current);
    const legacy = { ...current, version: current.version + 1, settings: { ...current.settings, brand: { name: "Victim", website: "https://victim.example:8443" } }, domain: { host: "victim.example:8443", verified: false, checkedAt: null } };
    assert.ok(await store.put(legacy, current.version));
    verifiedProjects.add(saved.id);
    const before = checkedWebsites.length;
    const verify = await call<{ project: ProjectView }>(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    assert.deepEqual([verify.body.project.domain.host, verify.body.project.domain.verified], ["victim.example:8443", true], "the port stays part of the domain record");
    // Switching to the default port starts unverified: nothing was ever proven on :443.
    const moved = await settle(owner.key, { brand: { name: "Victim", website: "https://victim.example" } });
    assert.deepEqual([moved.domain.host, moved.domain.verified, moved.domain.checkedAt], ["victim.example", false, null]);
    assert.ok(checkedWebsites.slice(before).every((website) => website === "https://victim.example:8443"));
    const pub = await call<{ key: { key: string } }>(server, "POST", "/projects/current/publishable-keys", { key: owner.key, body: { label: "site" } });
    await settle(owner.key, { allowedOrigins: ["https://shop.example"] });
    const profile = await call<{ profile: ProjectProfile }>(server, "GET", "/publishable/profile", { key: pub.body.key.key, headers: { origin: "https://shop.example" } });
    assert.equal(profile.body.profile.brand?.verified, false);
    verifiedProjects.delete(saved.id);
  });
});

describe("logo", () => {
  it("checks PNG and WebP headers and refuses SVG, GIF, APNG, animated WebP, bad sizes and ratios", async () => {
    assert.deepEqual(checkLogo(png(256, 128), "image/png").width, 256);
    assert.deepEqual([checkLogo(webpLossless(64, 64), "image/webp").height, checkLogo(webpExtended(400, 100, false), "image/webp").width], [64, 400]);
    const refused = (bytes: Buffer, type: string) => assert.throws(() => checkLogo(bytes, type), (error: { code?: string }) => error.code === "PROJECT_LOGO_INVALID");
    refused(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml");
    refused(Buffer.from("GIF89a\x01\x00\x01\x00"), "image/gif");
    refused(png(64, 64, [chunk("acTL", Buffer.alloc(8))]), "image/png");
    refused(webpExtended(64, 64, true), "image/webp");
    refused(png(64, 64), "image/webp");
    refused(png(16, 16), "image/png");
    refused(png(600, 300), "image/png");
    refused(png(500, 100), "image/png");
    refused(png(64, 128), "image/png");
    refused(Buffer.concat([png(64, 64), Buffer.alloc(70_000)]), "image/png");
    refused(png(64, 64).subarray(0, 40), "image/png");
  });

  it("stores the logo, serves it with fixed headers only while the domain is verified, and deletes it", async () => {
    const owner = await projectKey("logo");
    const saved = await settle(owner.key, { brand: { name: "Acme Store", website: "https://logo.example" } });
    const bytes = png(128, 64);
    const put = await upload(owner.key, bytes, "image/png");
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const logo = put.body.project?.logo;
    assert.ok(logo);
    assert.equal(logo.contentType, "image/png");
    assert.deepEqual([logo.width, logo.height], [128, 64]);
    assert.equal(logo.url, `/v1/projects/${saved.id}/logo/${logo.sha256}.png`);
    const path = logo.url.replace(/^\/v1/u, "");
    assertError(await call(server, "GET", path), 404, "NOT_FOUND");
    verifiedProjects.add(saved.id);
    await call(server, "POST", "/projects/current/domain/verify", { key: owner.key, body: {} });
    const served = await fetch(`${server.base}${path}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.equal(served.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
    assertError(await call(server, "GET", path.replace(".png", ".webp")), 404, "NOT_FOUND");
    assertError(await call(server, "GET", `/projects/${saved.id}/logo/${"0".repeat(64)}.png`), 404, "NOT_FOUND");
    assert.equal((await upload(owner.key, Buffer.from("<svg/>"), "image/svg+xml")).body.error?.code, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal((await upload(owner.key, png(64, 64, [chunk("acTL", Buffer.alloc(8))]), "image/png")).body.error?.code, "PROJECT_LOGO_INVALID");
    assert.equal((await upload(owner.key, webpExtended(64, 64, true), "image/webp")).body.error?.code, "PROJECT_LOGO_INVALID");
    assert.equal((await call(server, "DELETE", "/projects/current/logo", { key: owner.key })).status, 204);
    assert.equal((await read(owner.key)).logo, null);
    assertError(await call(server, "GET", path), 404, "NOT_FOUND");
  });
});

/* ------------------------------------------------------------ stores */

function storeContract(name: string, make: () => import("../projects.js").ProjectStore): void {
  describe(`${name} project store`, () => {
    it("writes from the expected version only, tracks domain checks and keeps the logo", async () => {
      const store = make();
      const projectId = `key_${randomBytes(12).toString("hex")}`;
      const record = {
        projectId,
        version: 1,
        settings: { schema: PROJECT_SCHEMA, brand: { name: "Acme", website: "https://acme.example" } },
        domain: { host: "acme.example", verified: false, checkedAt: null },
        logo: null,
        updatedAt: new Date().toISOString(),
        updatedBy: projectId,
      } as const;
      assert.equal(await store.put(record, 1), false, "no row yet: only version 0 is expected");
      assert.equal(await store.put(record, 0), true);
      assert.equal(await store.put(record, 0), false, "a second creation loses");
      assert.equal(await store.put({ ...record, version: 2 }, 1), true);
      assert.equal(await store.put({ ...record, version: 3 }, 1), false, "a stale version loses");
      await store.setDomain(projectId, "other.example", true, new Date().toISOString());
      assert.equal((await store.get(projectId))?.domain.verified, false, "a check of another host is ignored");
      const due = await store.dueForDomainCheck(new Date(Date.now() + 1_000).toISOString(), 1_000);
      assert.ok(due.some((entry) => entry.projectId === projectId));
      const checkedAt = new Date().toISOString();
      await store.setDomain(projectId, "acme.example", true, checkedAt);
      assert.deepEqual((await store.get(projectId))?.domain, { host: "acme.example", verified: true, checkedAt });
      const bytes = png(64, 64);
      const logo = checkLogo(bytes, "image/png");
      await store.setLogo(projectId, logo, new Date().toISOString(), projectId);
      assert.deepEqual((await store.get(projectId))?.logo, { sha256: logo.sha256, contentType: "image/png", width: 64, height: 64 });
      assert.deepEqual((await store.logoBytes(projectId, logo.sha256))?.bytes, bytes);
      assert.equal(await store.logoBytes(projectId, "0".repeat(64)), null);
      // Settings writes keep the logo.
      assert.equal(await store.put({ ...record, version: 3 }, 2), true);
      assert.equal((await store.get(projectId))?.logo?.sha256, logo.sha256);
      await store.setLogo(projectId, null, new Date().toISOString(), projectId);
      assert.equal((await store.get(projectId))?.logo, null);
      assert.equal(await store.logoBytes(projectId, logo.sha256), null);
    });
  });
}

storeContract("memory", () => new projects.MemoryProjectStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL;
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      const { closePlatformDatabase } = await import("../db.js");
      await closePlatformDatabase();
      delete process.env.KLETIA_DATABASE_URL;
    });
    storeContract("postgres", () => new projects.PostgresProjectStore());
  });
}
