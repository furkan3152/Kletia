// /help (GAPS 3.14): an indexed site route for people using the console, written as HTML by
// write-route-pages and listed in the sitemap, covering connecting a wallet, previews, failed
// steps and test versus live networks. Run with
//   node --test apps/web/src/app/pages/help/__tests__/helpRoute.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHAINS } from "@kletia/core";

import { matchRoute, ROUTES } from "../../../routes/routeTable.ts";
import { HELP_SECTIONS, helpAnchors, listNames, networkNames } from "../helpContent.ts";

const sitemap = readFileSync(new URL("../../../../../public/sitemap.xml", import.meta.url), "utf8");

test("/help is an indexed site route with its own fixed path", () => {
  const route = matchRoute("/help");
  assert.equal(route.id, "help");
  assert.equal(route.kind, "site");
  assert.equal(route.path, "/help");
  assert.equal(route.robots, undefined);
  assert.equal(route.canonicalFromPath, undefined, "a fixed path: write-route-pages writes help.html");
  assert.ok(route.description.length >= 50 && route.description.length <= 200);
  assert.equal(ROUTES.help, route);
  assert.equal(matchRoute("/help/wallets").id, "notFound");
  assert.ok(sitemap.includes("<loc>https://kletiaai.xyz/help</loc>"));
});

test("the page covers the four topics end users need, each with a unique anchor", () => {
  const anchors = helpAnchors();
  for (const id of ["connect-wallet", "preview", "step-failed", "test-and-live"]) assert.ok(anchors.includes(id), id);
  assert.equal(new Set(anchors).size, anchors.length);
  for (const id of anchors) assert.match(id, /^[a-z][a-z0-9-]*$/u);
  for (const section of HELP_SECTIONS) {
    assert.ok(section.title && section.lead && section.paragraphs.length > 0, section.id);
    for (const link of section.links ?? []) assert.match(link.to, /^\/[a-z0-9/#-]*$/u, `${section.id}: ${link.to}`);
  }
});

test("network lists come from the registry, so test and live names never drift", () => {
  const testnets = Object.values(CHAINS).filter((chain) => chain.lane === "testnet");
  const live = Object.values(CHAINS).filter((chain) => chain.lane !== "testnet");
  const text = HELP_SECTIONS.find((section) => section.id === "test-and-live").paragraphs.join(" ");
  for (const chain of testnets) assert.ok(text.includes(chain.name), chain.name);
  for (const chain of live) assert.ok(networkNames("production").includes(chain.name), chain.name);
  assert.ok(!networkNames("production").includes("Testnet") && !networkNames("production").includes("Devnet"));
  assert.equal(listNames(["A"]), "A");
  assert.equal(listNames(["A", "B", "C"]), "A, B and C");
});

test("the copy keeps the safety facts: the wallet signs, a preview cannot be signed, a decline sends nothing", () => {
  const all = HELP_SECTIONS.flatMap((section) => [section.lead, ...section.paragraphs, ...(section.steps ?? [])]).join(" ");
  assert.match(all, /never asks for a seed phrase or a private key/u);
  assert.match(all, /demo accounts/u);
  assert.match(all, /nothing was sent/iu);
  assert.match(all, /never sends the same step twice/u);
  assert.doesNotMatch(all, /guarantee/iu, "no promises the product does not make");
});

test("people find /help from the site footer and from the console's site menu", () => {
  const footer = readFileSync(new URL("../../../site/SiteFooter.tsx", import.meta.url), "utf8");
  const deskMenu = readFileSync(new URL("../../../console/shell/DeskSiteMenu.tsx", import.meta.url), "utf8");
  assert.match(footer, /\{ label: "Help", to: "\/help" \}/u);
  assert.match(deskMenu, /\{ to: "\/help", label: copy\.help \}/u);
});
