// The portal's pages, path matching and legacy redirects (shell/portalRoutes.ts). Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/portalRoutes.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { classifyHealth, SLOW_HEALTH_MS } from "../shell/healthModel.ts";
import { GET_KEY_HREF, legacyHashTarget, matchPortal, PORTAL_GROUPS, PORTAL_PAGES } from "../shell/portalRoutes.ts";

const CONTRACT_ID = "ct_02d4b1c6e8f04a7b9c3d5e6f7a8b9c0d";
const LINK_ID = "lk_0123456789abcdef01234567";
const WEBHOOK_ID = "wh_26cf9e0a1b2c3d4e5f6a7b8c";

/** Every portal path: path, page, param, robots. */
const ROUTES = [
  ["/developers", "overview", null, "index,follow"],
  ["/developers/", "overview", null, "index,follow"],
  ["/developers/api", "api", null, "index,follow"],
  ["/developers/api/createIntent", "api", "createIntent", "noindex,nofollow"],
  ["/developers/api/prepareStep", "api", "prepareStep", "noindex,nofollow"],
  ["/developers/embed", "embed", null, "index,follow"],
  ["/developers/recipes", "recipes", null, "index,follow"],
  ["/developers/recipes/nextjs", "recipes", "nextjs", "index,follow"],
  ["/developers/recipes/mcp-agent", "recipes", "mcp-agent", "index,follow"],
  ["/developers/keys", "keys", null, "index,follow"],
  ["/developers/project", "project", null, "index,follow"],
  ["/developers/webhooks", "webhooks", null, "index,follow"],
  ["/developers/webhooks/new", "webhooks", "new", "noindex,nofollow"],
  [`/developers/webhooks/${WEBHOOK_ID}`, "webhooks", WEBHOOK_ID, "noindex,nofollow"],
  ["/developers/contracts", "contracts", null, "index,follow"],
  ["/developers/contracts/new", "contracts", "new", "noindex,nofollow"],
  [`/developers/contracts/${CONTRACT_ID}`, "contracts", CONTRACT_ID, "noindex,nofollow"],
  ["/developers/rule-book", "rule-book", null, "index,follow"],
  ["/developers/links", "links", null, "index,follow"],
  ["/developers/links/new", "links", "new", "noindex,nofollow"],
  [`/developers/links/${LINK_ID}`, "links", LINK_ID, "noindex,nofollow"],
  ["/developers/receipts", "receipts", null, "index,follow"],
  ["/developers/events", "events", null, "index,follow"],
  ["/developers/errors", "errors", null, "index,follow"],
  ["/developers/venues", "venues", null, "index,follow"],
  ["/developers/agents", "agents", null, "index,follow"],
];

test("every portal path matches its page, its object id and its robots", () => {
  for (const [path, id, param, robots] of ROUTES) {
    const match = matchPortal(path);
    assert.equal(match.page.id, id, path);
    assert.equal(match.param, param, path);
    assert.equal(match.robots, robots, path);
    assert.equal(match.redirect, undefined, path);
  }
});

test("the builder's alias moves to /developers/embed and is never indexed", () => {
  const match = matchPortal("/developers/embed-builder");
  assert.equal(match.page.id, "embed");
  assert.equal(match.redirect, "/developers/embed");
  assert.equal(match.robots, "noindex,follow");
});

test("unknown portal paths render the missing page, never another page with a strange id", () => {
  for (const path of [
    "/developers/nope",
    "/developers/overview",
    "/developers/missing",
    "/developers/keys/extra",
    "/developers/receipts/rcpt_1",
    "/developers/contracts/a/b",
    "/developers/api/bad%20id",
    "/developers/api/1startsWithADigit",
    "/developers/webhooks/%3Cscript%3E",
    "/developers/links/..",
    "/developers//keys",
    "/developers/Keys",
  ]) {
    const match = matchPortal(path);
    assert.equal(match.page.id, "missing", path);
    assert.equal(match.param, null, path);
    assert.equal(match.robots, "noindex,follow", path);
  }
});

test("an unknown recipe id still lands on the recipes page, unindexed", () => {
  const match = matchPortal("/developers/recipes/not-a-recipe");
  assert.equal(match.page.id, "recipes");
  assert.equal(match.param, "not-a-recipe");
  assert.equal(match.robots, "noindex,follow");
});

/** The legacy hash table, row by row. */
const LEGACY = [
  ["#error-POLICY_VIOLATION", "/developers/errors#error-POLICY_VIOLATION"],
  ["#error-NOT_IN_THE_CATALOG", "/developers/errors#error-NOT_IN_THE_CATALOG"],
  ["#error-", "/developers/errors"],
  ["#error-%3Cimg%3E", "/developers/errors"],
  ["#recipe-nextjs", "/developers/recipes/nextjs"],
  ["#recipe-web-component", "/developers/recipes/web-component"],
  ["#recipe-unknown", "/developers/recipes"],
  ["#op-createIntent", "/developers/api/createIntent"],
  ["#op-", "/developers/api"],
  ["#quickstart", "/developers#start"],
  ["#start", "/developers#start"],
  ["#keys", "/developers/keys"],
  ["#auth", "/developers/keys"],
  ["#rulebook", "/developers/rule-book"],
  ["#contracts", "/developers/contracts"],
  ["#links", "/developers/links"],
  ["#receipts", "/developers/receipts"],
  ["#explorer", "/developers/api"],
  ["#reference", "/developers/api"],
  ["#recipes", "/developers/recipes"],
  ["#embed", "/developers/embed"],
  ["#events", "/developers/events"],
  ["#venues", "/developers/venues"],
  ["#errors", "/developers/errors"],
  ["#agents", "/developers/agents"],
  ["#nope", null],
  ["#start-key", null],
  ["#constructor", null],
  ["#", null],
  ["", null],
];

test("legacy anchors redirect to their page; anything else stays on the Overview", () => {
  for (const [hash, target] of LEGACY) assert.equal(legacyHashTarget(hash), target, hash || "(empty)");
  assert.equal(legacyHashTarget(undefined), null);
});

test("every legacy target is a portal path the shell can render", () => {
  for (const [hash, target] of LEGACY) {
    if (!target) continue;
    const path = target.split("#")[0];
    assert.notEqual(matchPortal(path).page.id, "missing", `${hash} -> ${target}`);
  }
});

test("the sidebar lists every page once, grouped in order, and each page matches its own path", () => {
  const ids = PORTAL_PAGES.map((page) => page.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(PORTAL_PAGES.map((page) => page.path)).size, ids.length);
  assert.equal(new Set(PORTAL_PAGES.map((page) => page.label)).size, ids.length);
  assert.deepEqual(ids, [
    "overview",
    "api",
    "embed",
    "recipes",
    "keys",
    "project",
    "webhooks",
    "contracts",
    "rule-book",
    "links",
    "receipts",
    "events",
    "errors",
    "venues",
    "agents",
    "data",
  ]);
  const groupOrder = PORTAL_GROUPS.map((group) => group.id);
  let last = 0;
  for (const page of PORTAL_PAGES) {
    const index = groupOrder.indexOf(page.group);
    assert.ok(index >= last, `${page.id} is out of group order`);
    last = index;
    assert.equal(matchPortal(page.path).page.id, page.id, page.path);
    assert.equal(typeof page.load, "function");
  }
});

test("only Your project pages need a key, and the key pages never take agent keys for key management", () => {
  for (const page of PORTAL_PAGES) assert.equal(page.needsKey, page.group === "project", page.id);
  const byId = Object.fromEntries(PORTAL_PAGES.map((page) => [page.id, page]));
  assert.equal(byId.keys.agentKeys, false);
  assert.equal(byId.project.agentKeys, false);
  for (const id of ["webhooks", "contracts", "rule-book", "links"]) assert.equal(byId[id].agentKeys, true, id);
  assert.deepEqual(
    PORTAL_PAGES.filter((page) => page.wide).map((page) => page.id),
    ["api", "embed", "rule-book"],
  );
});

test("Get a key leads to the key form on the Overview", () => {
  assert.equal(GET_KEY_HREF, "/developers#start-key");
  assert.equal(matchPortal(GET_KEY_HREF.split("#")[0]).page.id, "overview");
  assert.equal(legacyHashTarget("#start-key"), null, "the anchor is not redirected away");
});

const networks = (up, total) => Array.from({ length: total }, (_, index) => ({ ok: index < up }));

test("the portal bar's API status never invents numbers it did not read", () => {
  const checking = classifyHealth({ report: null, status: "loading", error: null, latencyMs: null });
  assert.equal(checking.state, "checking");
  assert.equal(checking.tone, "neutral");
  assert.equal(checking.networksUp, null);
  const down = classifyHealth({ report: null, status: "error", error: { status: 0, unreachable: true }, latencyMs: 9000 });
  assert.equal(down.state, "unreachable");
  assert.equal(down.tone, "danger");
  assert.equal(down.networksTotal, null);
  // A fresh failure wins over the last good report.
  const stale = classifyHealth({ report: { status: "ok", networks: networks(9, 9) }, status: "error", error: { status: 502, unreachable: false }, latencyMs: 40 });
  assert.equal(stale.state, "unreachable");
});

test("the API status counts networks and flags slow answers", () => {
  const ok = classifyHealth({ report: { status: "ok", networks: networks(9, 9) }, status: "success", error: null, latencyMs: 120 });
  assert.deepEqual([ok.state, ok.tone, ok.label], ["ok", "success", "API ok · 9/9"]);
  const slow = classifyHealth({ report: { status: "ok", networks: networks(9, 9) }, status: "success", error: null, latencyMs: SLOW_HEALTH_MS + 1 });
  assert.deepEqual([slow.state, slow.tone], ["slow", "warning"]);
  const degraded = classifyHealth({ report: { status: "degraded", networks: networks(7, 9) }, status: "success", error: null, latencyMs: 80 });
  assert.deepEqual([degraded.state, degraded.tone, degraded.label, degraded.networksUp], ["degraded", "warning", "7/9 networks", 7]);
  const none = classifyHealth({ report: { status: "down", networks: networks(0, 9) }, status: "success", error: null, latencyMs: 80 });
  assert.deepEqual([none.state, none.tone], ["down", "danger"]);
  // Reloading keeps the last report on screen instead of falling back to "checking".
  const reloading = classifyHealth({ report: { status: "ok", networks: networks(9, 9) }, status: "loading", error: null, latencyMs: 120 });
  assert.equal(reloading.state, "ok");
});
