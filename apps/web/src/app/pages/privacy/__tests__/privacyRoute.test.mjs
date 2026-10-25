// /privacy: an indexed site route stating what Kletia stores, for how long, who
// receives what and how to delete it, linked from both footers. Its periods come
// from @kletia/core, the constants the API's retention sweep uses. Run with
//   node --test apps/web/src/app/pages/privacy/__tests__/privacyRoute.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { INTENT_RETENTION } from "@kletia/core";

import { matchRoute, ROUTES } from "../../../routes/routeTable.ts";
import { PRIVACY_SECTIONS, privacyAnchors, RETENTION_WORDS } from "../privacyContent.ts";

const sitemap = readFileSync(new URL("../../../../../public/sitemap.xml", import.meta.url), "utf8");
const all = PRIVACY_SECTIONS.flatMap((section) => [section.lead, ...section.paragraphs, ...(section.rows ?? []).map((row) => `${row.what} ${row.detail}`)]).join(" ");

test("/privacy is an indexed site route with its own fixed path", () => {
  const route = matchRoute("/privacy");
  assert.equal(route.id, "privacy");
  assert.equal(route.kind, "site");
  assert.equal(route.robots, undefined);
  assert.ok(route.description.length >= 50 && route.description.length <= 170);
  assert.equal(ROUTES.privacy, route);
  assert.ok(sitemap.includes("<loc>https://kletiaai.xyz/privacy</loc>"));
});

test("the periods are the core retention constants, not typed numbers", () => {
  assert.equal(RETENTION_WORDS.text, `${INTENT_RETENTION.textGraceMs / 3_600_000} hours`);
  assert.equal(RETENTION_WORDS.intent, `${INTENT_RETENTION.purgeAfterMs / 86_400_000} days`);
  assert.ok(all.includes(RETENTION_WORDS.text) && all.includes(RETENTION_WORDS.intent));
});

test("it names every recipient and every way to delete, and keeps the honest caveats", () => {
  for (const name of ["Relay", "Across", "LI.FI", "deBridge", "Jupiter", "RPC", "WalletConnect", "OpenRouter", "Etherscan"]) assert.ok(all.includes(name), name);
  assert.match(all, /DELETE \/v1\/intents\/\{id\}/u);
  assert.match(all, /no automatic deletion/u, "records nothing deletes are named as such");
  assert.match(all, /unmasked/u, "the legacy planner's full prompt is stated");
  assert.match(all, /no separate legal privacy policy/u);
  assert.doesNotMatch(all, /guarantee|never stores|anonymous/iu, "no promise the code does not keep");
  const anchors = privacyAnchors();
  assert.equal(new Set(anchors).size, anchors.length);
});

test("both footers link to /privacy", () => {
  const footer = readFileSync(new URL("../../../site/SiteFooter.tsx", import.meta.url), "utf8");
  const home = readFileSync(new URL("../../home/HomeEnd.tsx", import.meta.url), "utf8");
  assert.match(footer, /\{ label: "Privacy & data", to: "\/privacy" \}/u);
  assert.match(home, /\{ label: "Privacy & data", to: "\/privacy" \}/u);
});
