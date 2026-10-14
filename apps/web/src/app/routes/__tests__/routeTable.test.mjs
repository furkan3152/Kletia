// The route table's developer portal: prefix matching, per-path metadata, pre-rendered paths and the sitemap.
// Run with Node 22.18 or later:
//   node --test apps/web/src/app/routes/__tests__/routeTable.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { matchRoute, PORTAL_RECIPES, PORTAL_ROUTES, PRERENDER_PATHS, ROUTES } from "../routeTable.ts";

const sitemap = readFileSync(new URL("../../../../public/sitemap.xml", import.meta.url), "utf8");
const snippets = readFileSync(new URL("../../site/snippets.ts", import.meta.url), "utf8");
const metaFor = (path) => ROUTES.developers.metaFor(path);

test("every /developers path is the developers route; look-alikes are not", () => {
  for (const path of ["/developers", "/developers/", "/developers/keys", "/developers/contracts/ct_1", "/developers/no-such-page"]) {
    assert.equal(matchRoute(path).id, "developers", path);
  }
  for (const path of ["/developersx", "/developer", "/developers-keys", "/x/developers/keys"]) {
    assert.equal(matchRoute(path).id, "notFound", path);
  }
});

test("the developers route takes its canonical URL from the path and manages focus itself", () => {
  assert.equal(ROUTES.developers.canonicalFromPath, true);
  assert.equal(ROUTES.developers.ownsFocus, true);
  assert.equal(typeof ROUTES.developers.metaFor, "function");
});

test("metaFor gives every portal page and recipe a unique title and description", () => {
  const paths = [...PORTAL_ROUTES.map((page) => page.path), ...PORTAL_RECIPES.map((recipe) => `/developers/recipes/${recipe.id}`)];
  const titles = paths.map((path) => metaFor(path).title);
  const descriptions = paths.map((path) => metaFor(path).description);
  assert.equal(new Set(titles).size, paths.length, `duplicate titles: ${titles.join(" | ")}`);
  assert.equal(new Set(descriptions).size, paths.length);
  for (const path of paths) {
    const meta = metaFor(path);
    assert.equal(meta.robots, "index,follow", path);
    assert.ok(meta.title.length > 0 && meta.title.length <= 70, `${path}: ${meta.title}`);
    assert.ok(meta.description.length >= 50 && meta.description.length <= 170, `${path}: ${meta.description.length} characters`);
  }
  assert.equal(metaFor("/developers/webhooks").title, "Webhooks: Kletia developers");
  assert.equal(metaFor("/developers/recipes/nextjs").title, "Next.js recipe: Kletia developers");
  assert.equal(metaFor("/developers").title, ROUTES.developers.title);
});

test("detail and new pages are never indexed and never echo the path into the title", () => {
  const details = [
    "/developers/api/createIntent",
    "/developers/webhooks/new",
    "/developers/webhooks/wh_SUSPICIOUS_TEXT",
    "/developers/contracts/new",
    "/developers/contracts/ct_SUSPICIOUS_TEXT",
    "/developers/links/new",
    "/developers/links/lk_SUSPICIOUS_TEXT",
  ];
  for (const path of details) {
    const meta = metaFor(path);
    assert.equal(meta.robots, "noindex,nofollow", path);
    assert.ok(!meta.title.includes("SUSPICIOUS") && !meta.title.includes("createIntent"), meta.title);
  }
  assert.equal(metaFor("/developers/links/new").title, "New intent link: Kletia developers");
  assert.equal(metaFor("/developers/contracts/ct_1").title, "Contract: Kletia developers");
});

test("unknown portal paths and unknown recipes are not indexed; the alias names its canonical", () => {
  assert.deepEqual(
    { title: metaFor("/developers/nope").title, robots: metaFor("/developers/nope").robots },
    { title: "No page here: Kletia developers", robots: "noindex,follow" },
  );
  assert.equal(metaFor("/developers/recipes/zzz").robots, "noindex,follow");
  const alias = metaFor("/developers/embed-builder");
  assert.equal(alias.canonical, "/developers/embed");
  assert.equal(alias.robots, "noindex,follow");
  assert.equal(alias.title, metaFor("/developers/embed").title);
});

test("PRERENDER_PATHS covers /developers, every indexed portal page, each recipe and the builder alias", () => {
  const byPath = new Map(PRERENDER_PATHS.map((page) => [page.path, page]));
  assert.equal(byPath.size, PRERENDER_PATHS.length, "no path twice");
  for (const page of PORTAL_ROUTES.filter((item) => item.indexed)) {
    assert.ok(byPath.has(page.path), page.path);
    assert.equal(byPath.get(page.path).robots ?? "index,follow", "index,follow");
    assert.equal(byPath.get(page.path).title, metaFor(page.path).title);
  }
  assert.ok(byPath.has("/developers"));
  for (const recipe of PORTAL_RECIPES) assert.ok(byPath.has(`/developers/recipes/${recipe.id}`), recipe.id);
  assert.equal(byPath.get("/developers/embed-builder")?.robots, "noindex,follow");
  for (const path of ["/developers/webhooks/new", "/developers/contracts/new", "/developers/links/new"]) {
    assert.equal(byPath.get(path)?.robots, "noindex,nofollow", path);
  }
  for (const page of PRERENDER_PATHS) {
    // The guard write-route-pages.mjs applies before writing a file.
    assert.match(page.path, /^\/[a-z0-9][a-z0-9/_-]*$/u);
    assert.ok(!page.path.includes("//"));
    assert.equal(page.title, metaFor(page.path).title, page.path);
    assert.equal(page.robots ?? "index,follow", metaFor(page.path).robots, page.path);
  }
});

test("the sitemap lists exactly the indexed portal paths", () => {
  const listed = [...sitemap.matchAll(/<loc>https:\/\/kletiaai\.xyz(\/developers[^<]*)<\/loc>/gu)].map((match) => match[1]);
  const indexed = PRERENDER_PATHS.filter((page) => (page.robots ?? "index,follow") === "index,follow").map((page) => page.path);
  assert.deepEqual([...listed].sort(), [...indexed].sort());
});

test("recipe pages name recipes that exist in site/snippets.ts, with the same labels", () => {
  const start = snippets.indexOf("export const RECIPES");
  assert.ok(start > 0, "RECIPES not found in snippets.ts");
  const body = snippets.slice(start);
  const recipes = new Map([...body.matchAll(/\n {4}id: "([a-z0-9-]+)",\n {4}label: "([^"]+)",/gu)].map((match) => [match[1], match[2]]));
  assert.ok(recipes.size >= PORTAL_RECIPES.length);
  for (const recipe of PORTAL_RECIPES) assert.equal(recipes.get(recipe.id), recipe.label, recipe.id);
});
