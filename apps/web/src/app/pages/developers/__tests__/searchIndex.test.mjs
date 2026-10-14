// The portal search palette's index (search/searchIndex.ts, portal design 4.6): every operation id, error code,
// recipe id, event type and MCP tool; the ranking rules; hrefs on portal routes; and no network call. Run with
// Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/searchIndex.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { errorCatalogRows } from "@kletia/core";

// Any network call while the index is built or searched fails the test.
const fetches = [];
globalThis.fetch = (...args) => {
  fetches.push(args);
  throw new Error("search must not fetch");
};

const { MCP_TOOLS, RECIPES } = await import("../../../site/snippets.ts");
const { EVENT_FAMILIES, EVENT_TYPES } = await import("../devContent.ts");
const { operationsFromOpenApi } = await import("../explorer/operations.ts");
const { STATIC_OPERATIONS } = await import("../explorer/staticOperations.ts");
const { matchPortal } = await import("../shell/portalRoutes.ts");
const { buildSearchIndex, flattenGroups, MAX_RESULTS, PER_GROUP, resultCount, searchEntries } = await import("../search/searchIndex.ts");

const spec = JSON.parse(readFileSync(new URL("../../../../../../../docs/platform/openapi.json", import.meta.url), "utf8"));
const LIVE = operationsFromOpenApi(spec);
const index = buildSearchIndex({ operations: LIVE });
const titles = (kind) => new Set(index.filter((entry) => entry.kind === kind).map((entry) => entry.title));

test("the index holds every operation id, error code, recipe id, event type and MCP tool", () => {
  assert.ok(LIVE.length >= 90, `${LIVE.length} operations in the spec`);
  const operationHrefs = new Set(index.filter((entry) => entry.kind === "operation").map((entry) => entry.href));
  for (const operation of LIVE) assert.ok(operationHrefs.has(`/developers/api/${operation.id}`), operation.id);
  const staticIndex = buildSearchIndex({ operations: STATIC_OPERATIONS });
  for (const operation of STATIC_OPERATIONS) assert.ok(staticIndex.some((entry) => entry.href === `/developers/api/${operation.id}`), operation.id);
  const errors = titles("error");
  for (const row of errorCatalogRows()) assert.ok(errors.has(row.code), row.code);
  const recipeHrefs = new Set(index.filter((entry) => entry.kind === "recipe").map((entry) => entry.href));
  for (const recipe of RECIPES) assert.ok(recipeHrefs.has(`/developers/recipes/${recipe.id}`), recipe.id);
  const events = titles("event");
  for (const type of [...EVENT_TYPES.map((event) => event.type), ...EVENT_FAMILIES.flatMap((family) => family.types)]) assert.ok(events.has(type), type);
  const tools = titles("tool");
  for (const tool of MCP_TOOLS) assert.ok(tools.has(tool.name), tool.name);
  assert.ok(titles("page").has("Webhooks"));
});

test("every href is a portal route the shell knows", () => {
  for (const entry of index) {
    const path = entry.href.split("#")[0];
    assert.notEqual(matchPortal(path).page.id, "missing", entry.href);
  }
  const violation = index.find((entry) => entry.title === "POLICY_VIOLATION");
  assert.equal(violation.href, "/developers/errors#error-POLICY_VIOLATION");
});

test('"policy viol" ranks POLICY_VIOLATION first, in the errors group, before the policy.violation event', () => {
  const groups = searchEntries(index, "policy viol");
  const flat = flattenGroups(groups);
  assert.equal(flat[0].title, "POLICY_VIOLATION");
  assert.equal(groups[0].group, "error");
  const event = flat.findIndex((entry) => entry.title === "policy.violation");
  assert.ok(event > 0, "the event is found too");
});

test('"POST /v1/intents" ranks the exact path first; an exact code wins over its family', () => {
  const flat = flattenGroups(searchEntries(index, "POST /v1/intents"));
  assert.equal(flat[0].title, "POST /v1/intents");
  assert.equal(flat[0].href, "/developers/api/createIntent");
  assert.ok(flat.some((entry) => entry.title === "POST /v1/intents/{id}/stop"));
  assert.equal(flattenGroups(searchEntries(index, "INTENT_IN_FLIGHT"))[0].title, "INTENT_IN_FLIGHT");
  assert.equal(flattenGroups(searchEntries(index, "createIntent"))[0].href, "/developers/api/createIntent");
  assert.equal(flattenGroups(searchEntries(index, "get_journey"))[0].title, "get_journey");
  assert.equal(flattenGroups(searchEntries(index, "webhooks"))[0].kind, "page");
});

test("limits, empty queries, misses and the announced count", () => {
  assert.deepEqual(searchEntries(index, ""), []);
  assert.deepEqual(searchEntries(index, "   "), []);
  assert.deepEqual(searchEntries(index, "qqqzzz"), []);
  const broad = searchEntries(index, "e");
  assert.ok(flattenGroups(broad).length <= MAX_RESULTS);
  for (const group of broad) assert.ok(group.entries.length <= PER_GROUP, group.group);
  assert.equal(resultCount(0), "No results");
  assert.equal(resultCount(1), "1 result");
  assert.equal(resultCount(5), "5 results");
});

test("venues and already-loaded objects join the index; nothing was fetched", () => {
  const withExtras = buildSearchIndex({
    operations: STATIC_OPERATIONS,
    venues: [{ id: "aave-v3-base-usdc", name: "Aave V3 USDC" }],
    objects: [{ kind: "object", title: "Acme Yield", detail: "Contract", href: "/developers/contracts/ct_1", keywords: "contract" }],
  });
  assert.equal(flattenGroups(searchEntries(withExtras, "aave v3 usdc"))[0].kind, "venue");
  assert.equal(flattenGroups(searchEntries(withExtras, "acme"))[0].kind, "object");
  assert.deepEqual(fetches, []);
});
