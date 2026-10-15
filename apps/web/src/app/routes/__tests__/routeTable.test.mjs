// The route table's developer portal: prefix matching, per-path metadata, pre-rendered paths and the sitemap.
// Run with Node 22.18 or later:
//   node --test apps/web/src/app/routes/__tests__/routeTable.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONSOLE_VIEW_PATHS, consoleMetaFor, matchRoute, PORTAL_RECIPES, PORTAL_ROUTES, PRERENDER_PATHS, ROUTES } from "../routeTable.ts";

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
  for (const page of PRERENDER_PATHS.filter((entry) => entry.path.startsWith("/developers"))) {
    // The guard write-route-pages.mjs applies before writing a file.
    assert.match(page.path, /^\/[a-z0-9][a-z0-9/_-]*$/u);
    assert.ok(!page.path.includes("//"));
    assert.equal(page.title, metaFor(page.path).title, page.path);
    assert.equal(page.robots ?? "index,follow", metaFor(page.path).robots, page.path);
  }
});

test("the sitemap lists exactly the indexed portal paths", () => {
  const listed = [...sitemap.matchAll(/<loc>https:\/\/kletiaai\.xyz(\/developers[^<]*)<\/loc>/gu)].map((match) => match[1]);
  const indexed = PRERENDER_PATHS.filter((page) => page.path.startsWith("/developers") && (page.robots ?? "index,follow") === "index,follow").map((page) => page.path);
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

test("the desk's views are the console route, pre-rendered, canonical /app and not indexed", () => {
  assert.deepEqual([...CONSOLE_VIEW_PATHS], ["/app/tasks", "/app/holdings", "/app/activity", "/app/tools"]);
  for (const path of ["/app", ...CONSOLE_VIEW_PATHS, "/app/tools/x402"]) assert.equal(matchRoute(path).id, "console", path);
  assert.equal(matchRoute("/app/classic").id, "console", "no classic route: the desk renders it");
  assert.ok(!PRERENDER_PATHS.some((page) => page.path === "/app/classic"), "there is no /app/classic page");
  const byPath = new Map(PRERENDER_PATHS.map((page) => [page.path, page]));
  for (const path of CONSOLE_VIEW_PATHS) {
    const page = byPath.get(path);
    assert.ok(page, `${path} is pre-rendered`);
    assert.match(page.path, /^\/[a-z0-9][a-z0-9/_-]*$/u);
    assert.equal(page.title, "Kletia Console");
    assert.equal(page.robots, "noindex,follow", path);
    assert.ok(!sitemap.includes(`<loc>https://kletiaai.xyz${path}</loc>`), `${path} is not in the sitemap`);
  }
  assert.deepEqual(consoleMetaFor("/app"), { title: "Kletia Console", description: ROUTES.console.description, robots: "index,follow", canonical: "/app" });
  assert.equal(consoleMetaFor("/app/holdings").canonical, "/app");
  assert.equal(consoleMetaFor("/app/holdings").robots, "noindex,follow");
  assert.equal(ROUTES.console.title, "Kletia Console");
  assert.ok(ROUTES.console.description.length >= 50 && ROUTES.console.description.length <= 170);
  assert.ok(/nine/u.test(ROUTES.console.description), "the console says it covers all nine networks");
});

test("/app renders the desk, entered before the first paint; the classic shell is not routed", () => {
  const consoleRoute = readFileSync(new URL("../ConsoleRoute.tsx", import.meta.url), "utf8");
  assert.match(consoleRoute, /import DeskApp from "\.\.\/console\/DeskApp"/u);
  assert.ok(!/from "\.\.\/App"/u.test(consoleRoute), "ConsoleRoute no longer imports the classic App shell");
  const main = readFileSync(new URL("../../../main.tsx", import.meta.url), "utf8");
  assert.match(main, /initialRouteKind === "console"\) \{\s*enterDeskMode\(\);/u, "main.tsx enters desk mode for /app before rendering");
  const router = readFileSync(new URL("../../router.tsx", import.meta.url), "utf8");
  const fallback = router.slice(router.indexOf("function ConsoleBootFallback"), router.indexOf("function EmbedBootFallback"));
  assert.ok(fallback.includes("bg-[#F4F1EA]") && !/bg-\[#0B1120\] font-black/u.test(fallback), "the console's loading plate is paper, not the old dark shell");
  const html = readFileSync(new URL("../../../../index.html", import.meta.url), "utf8");
  assert.match(html, /interactive-widget=resizes-content/u, "the sticky composer stays above the phone keyboard");
  assert.ok(!/\^\\\/app/u.test(html), "the desk gets the site's font preloads");
});

test("/admin is the operator panel: one prefix route, never indexed or in the sitemap", () => {
  for (const path of ["/admin", "/admin/", "/admin/anything"]) assert.equal(matchRoute(path).id, "admin", path);
  for (const path of ["/adminx", "/administrator", "/x/admin"]) assert.equal(matchRoute(path).id, "notFound", path);
  assert.equal(ROUTES.admin.kind, "admin");
  assert.equal(ROUTES.admin.robots, "noindex,nofollow");
  assert.equal(ROUTES.admin.title, "Kletia admin");
  assert.ok(!PRERENDER_PATHS.some((page) => page.path.startsWith("/admin")));
  assert.ok(!sitemap.includes("/admin"));
  assert.match(readFileSync(new URL("../../../../public/robots.txt", import.meta.url), "utf8"), /^Disallow: \/admin$/mu);
  const writer = readFileSync(new URL("../../../../scripts/write-route-pages.mjs", import.meta.url), "utf8");
  // Static hosts without rewrites need admin.html; it carries the route's noindex,nofollow tag.
  assert.doesNotMatch(writer, /route\.kind !== "admin"/u);
});
