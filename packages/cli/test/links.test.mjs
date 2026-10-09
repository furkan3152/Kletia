import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { previewDigest } from "@kletia/core";
import { cli, send, stubServer } from "./helpers.mjs";

const API_KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const keyed = { KLETIA_API_KEY: API_KEY };
const LINK = "lk_5f1c2a9b7e3d4c6a8b0e1f23";
const PAYEE = "eip155:8453:0x1111111111111111111111111111111111111111";
const USDC = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// A real 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const definition = () => ({
  title: "Pay 25 USDC to Acme Store",
  publisher: { name: "Acme Store", website: "https://shop.acme.example" },
  destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: PAYEE }] },
  funding: { networks: ["base", "arbitrum"], assets: ["USDC"], amount: { mode: "deliver" } },
  maxUses: 1,
  expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  blink: false,
});

const view = {
  id: LINK, status: "pending", revision: 1, title: "Pay 25 USDC to Acme Store",
  publisher: { name: "Acme Store", website: "https://shop.acme.example", domain: "shop.acme.example", domainVerified: false },
  destination: { network: "base", asset: { asset: USDC, symbol: "USDC", decimals: 6 }, actions: [{ kind: "transfer", network: "base", label: "Pay 25 USDC" }] },
  fixed: { recipients: [{ network: "base", address: "0x1111111111111111111111111111111111111111" }], contracts: [] },
  funding: { networks: ["base", "arbitrum"], assets: ["USDC"], amount: { mode: "deliver" } },
  expiresAt: "2026-10-14T00:00:00.000Z", activatesAt: "2026-10-09T22:15:00.000Z", uses: { max: 1, left: 1 }, perAccount: null,
  blink: { enabled: false, eligible: false, reason: "not requested" },
  urls: { page: `https://kletiaai.xyz/go/${LINK}`, card: `https://kletiaai.xyz/go/${LINK}/card.png?v=1`, square: `https://kletiaai.xyz/go/${LINK}/card.png?variant=square&v=1` },
  notices: ["Kletia does not vouch for publishers. Check the domain and the fixed recipients before you sign."],
  definition: definition(), pins: { recipients: [], contracts: [], destinationAsset: { asset: USDC, symbol: "USDC", decimals: 6 } }, ownerKeyId: "key_1", pausedReason: null, suspendedReason: null,
};

async function fare(intentId) {
  const row = { network: "base", account: "eip155:8453:0x000000000000000000000000000000000000c0de", asset: USDC, symbol: "USDC", decimals: 6, listed: true, expected: { amount: "-25000000", formatted: "-25", usd: -25 }, worst: { amount: "-25000000", formatted: "-25", usd: -25 }, certainty: "simulated-assumed-funds", steps: ["s1"], role: "you" };
  const body = {
    spec: "kletia.preview/v1", intentId, computedAt: "2026-10-09T12:00:00.000Z", stage: "plan", basis: "simulated", digest: "", rows: [row],
    payments: [{ stepId: "s1", network: "base", recipient: PAYEE, asset: USDC, symbol: "USDC", decimals: 6, expected: { amount: "25000000", formatted: "25", usd: 25 }, worst: { amount: "25000000", formatted: "25", usd: 25 }, certainty: "simulated-assumed-funds" }],
    fees: [{ stepId: "s1", network: "base", kind: "network", label: "Base network fee", paid: "on-top", certainty: "simulated" }], approvals: [], steps: [],
    totals: { youPayUsd: 25, youGetUsd: { expected: 0, worst: 0 }, paidToOthersUsd: { expected: 25, worst: 25 }, networkFeesUsd: null, venueFeesUsd: 0, extraCostsUsd: 0, costUsd: { expected: null, worst: null }, priceDifferenceUsd: null, unpriced: ["eip155:8453/slip44:60"] },
    needs: [], warnings: [],
  };
  return { ...body, digest: await previewDigest(body) };
}

let api;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kletia-cli-links-"));
  api = await stubServer(async (request, res) => {
    const route = `${request.method} ${request.path}`;
    if (route === "POST /v1/intents") {
      return send(res, 200, { intent: { spec: "kletia.intent/v1", id: "dry_1", status: "planned", request: { accounts: request.body.accounts }, summary: { title: "Send 25 USDC to 0x1111…1111", signaturesRequired: 1, totalFeesUsd: 0.01, estimatedSeconds: 5 }, warnings: [], steps: [] }, preview: await fare("dry_1") });
    }
    if (request.headers.authorization !== `Bearer ${API_KEY}` && !/^GET \/v1\/links\/lk_[0-9a-f]+(\/card\.png)?$/u.test(route)) return send(res, 401, { error: { code: "API_KEY_REQUIRED", message: "key" } });
    if (route === "POST /v1/links") return send(res, 201, { link: view });
    if (route === `GET /v1/links/${LINK}`) return send(res, 200, { link: view });
    if (route === `GET /v1/links/${LINK}/card.png`) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return undefined;
    }
    if (route === "GET /v1/links") return send(res, 200, { links: [{ ...view, status: "active" }] });
    if (route === `PATCH /v1/links/${LINK}`) return send(res, 200, { link: { ...view, status: request.body.status === "paused" ? "paused" : "active", revision: request.body.accept ? 2 : 1, activatesAt: null } });
    if (route === `DELETE /v1/links/${LINK}`) return send(res, 204);
    if (route === `GET /v1/links/${LINK}/stats`) return send(res, 200, { stats: { linkId: LINK, window: request.url.searchParams.get("window") ?? "7d", totals: { pageView: 40, intent: 4, completed: 3 }, daily: [], bySource: [{ source: "arbitrum:USDC", intent: 3, completed: 2, volumeUsd: "75.00" }], conversion: { intentPerPageView: 0.1, completedPerIntent: 0.75 } } });
    return false;
  });
});

after(() => api.close());

async function linkFile(value = definition()) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("links create --dry-run checks locally, plans one representative intent with its fare and creates nothing", async () => {
  const before = api.requests.length;
  const result = await cli(["links", "create", "--file", await linkFile(), "--dry-run"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /valid; representative choice USDC on base \(deliver-direct\)/u);
  assert.match(result.stdout, /Fare breakdown: stage plan/u);
  assert.match(result.stderr, /Dry run: nothing was created/u);
  const sent = api.requests.slice(before);
  assert.deepEqual(sent.map((request) => `${request.method} ${request.path}${request.url.search}`), ["POST /v1/intents?dryRun=true&preview=true"]);
  assert.deepEqual(sent[0].body.actions, [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: PAYEE }]);
  assert.deepEqual(sent[0].body.accounts, ["eip155:8453:0x000000000000000000000000000000000000c0de"], "placeholder accounts, never a real wallet");
});

test("links create refuses an invalid definition locally and needs a key to publish", async () => {
  const before = api.requests.length;
  const bad = await cli(["links", "create", "--file", await linkFile({ ...definition(), title: "Kletia — pay" })], { base: api.base, env: keyed });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /LINK_DEFINITION_INVALID/u);
  assert.match(bad.stderr, /title:/u);
  assert.equal(api.requests.length, before);
  assert.equal((await cli(["links", "create", "--file", await linkFile()], { base: api.base })).code, 64);
  const created = await cli(["links", "create", "--file", await linkFile()], { base: api.base, env: keyed });
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, new RegExp(`^${LINK}  pending until 2026-10-09 22:15:00Z  revision 1`, "mu"));
  assert.match(created.stdout, /fixed recipient 0x1111111111111111111111111111111111111111 on base/u);
  assert.match(created.stderr, /\.well-known\/kletia\.json/u);
  assert.match(api.requests.at(-1).headers["idempotency-key"], /^[0-9a-f-]{36}$/u);
});

test("links card writes a PNG; open prints the page URL; list, pause, resume, delete and stats", async () => {
  const out = join(dir, "card.png");
  const card = await cli(["links", "card", LINK, "--out", out, "--variant", "square"], { base: api.base });
  assert.equal(card.code, 0, card.stderr);
  const bytes = await readFile(out);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(api.requests.at(-1).url.search, "?variant=square");
  assert.equal((await cli(["links", "card", LINK, "--out", out], { base: api.base })).code, 64, "never overwrites");
  const open = await cli(["links", "open", LINK], { base: api.base });
  assert.equal(open.stdout.trim(), `https://kletiaai.xyz/go/${LINK}`);
  const list = await cli(["links", "list", "--status", "active"], { base: api.base, env: keyed });
  assert.match(list.stdout, new RegExp(`^${LINK}\\s+active\\s+1/1`, "mu"));
  assert.match((await cli(["links", "pause", LINK], { base: api.base, env: keyed })).stdout, /paused\./u);
  const resumed = await cli(["links", "resume", LINK, "--accept", "recipient_changed"], { base: api.base, env: keyed });
  assert.match(resumed.stdout, /active \(revision 2\)/u);
  assert.deepEqual(api.requests.at(-1).body, { status: "active", accept: ["recipient_changed"] });
  assert.equal((await cli(["links", "resume", LINK, "--accept", "anything"], { base: api.base, env: keyed })).code, 64);
  assert.equal((await cli(["links", "delete", LINK], { base: api.base, env: keyed })).code, 64, "needs --yes");
  assert.equal((await cli(["links", "delete", LINK, "--yes"], { base: api.base, env: keyed })).code, 0);
  const stats = await cli(["links", "stats", LINK, "--window", "30d"], { base: api.base, env: keyed });
  assert.match(stats.stdout, /last 30d: pageView 40 {2}intent 4 {2}completed 3/u);
  assert.match(stats.stdout, /intents per page view 10\.0%, completed per intent 75\.0%/u);
  assert.equal((await cli(["links", "get", "lk_bad"], { base: api.base })).code, 64);
});
