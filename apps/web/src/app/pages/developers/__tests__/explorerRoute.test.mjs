// The API explorer reads its operation from the path (explorer/explorerRoute.ts): /developers/api/<operationId>,
// an unknown id falls back to the default with a notice, and the old QuickStart strip is gone. Run with Node 22.18
// or later:
//   node --test apps/web/src/app/pages/developers/__tests__/explorerRoute.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_OPERATION_ID, filterOperations, operationHref, resolveExplorerOperation } from "../explorer/explorerRoute.ts";
import { knownOperations, rememberLiveOperations } from "../explorer/liveSpec.ts";
import { operationsFromOpenApi } from "../explorer/operations.ts";
import { STATIC_OPERATIONS } from "../explorer/staticOperations.ts";
import { matchPortal } from "../shell/portalRoutes.ts";

const spec = JSON.parse(readFileSync(new URL("../../../../../../../docs/platform/openapi.json", import.meta.url), "utf8"));
const LIVE = operationsFromOpenApi(spec);

test("the operation comes from the path", () => {
  for (const operations of [STATIC_OPERATIONS, LIVE]) {
    for (const operation of operations) {
      const match = matchPortal(operationHref(operation.id));
      assert.equal(match.page.id, "api", operation.id);
      assert.equal(match.param, operation.id);
      const route = resolveExplorerOperation(operations, match.param);
      assert.equal(route.operation.id, operation.id);
      assert.equal(route.notice, null);
    }
  }
});

test("no id shows the default operation without a notice; an unknown id shows it with one", () => {
  const plain = resolveExplorerOperation(STATIC_OPERATIONS, null);
  assert.equal(plain.operation.id, DEFAULT_OPERATION_ID);
  assert.equal(plain.notice, null);
  const unknown = resolveExplorerOperation(STATIC_OPERATIONS, "doesNotExist");
  assert.equal(unknown.operation.id, DEFAULT_OPERATION_ID);
  assert.match(unknown.notice, /doesNotExist/u);
  assert.match(unknown.notice, /POST \/v1\/intents/u);
  // A document without createIntent still opens on something.
  const only = STATIC_OPERATIONS.filter((operation) => operation.id === "getHealth");
  assert.equal(resolveExplorerOperation(only, "createIntent").operation.id, "getHealth");
});

test("the bundled reference lists the journey operations", () => {
  for (const id of ["getIntentJourney", "stopIntent"]) {
    const bundled = STATIC_OPERATIONS.find((operation) => operation.id === id);
    const live = LIVE.find((operation) => operation.id === id);
    assert.ok(bundled && live, id);
    assert.equal(bundled.method, live.method);
    assert.equal(bundled.path, live.path);
  }
});

test("the tree filter matches every word in method, path, id, summary or tag", () => {
  assert.equal(filterOperations(LIVE, "").length, LIVE.length);
  const journey = filterOperations(LIVE, "get journey").map((operation) => operation.id);
  assert.deepEqual(journey, ["getIntentJourney"]);
  assert.ok(filterOperations(LIVE, "POST intents").every((operation) => operation.method === "POST"));
  assert.deepEqual(filterOperations(LIVE, "qqqzzz"), []);
});

test("search reads what the explorer loaded, else the bundled reference", () => {
  assert.equal(knownOperations(), STATIC_OPERATIONS);
  rememberLiveOperations([]);
  assert.equal(knownOperations(), STATIC_OPERATIONS);
  rememberLiveOperations(LIVE);
  assert.equal(knownOperations(), LIVE);
});

test("QuickStart is removed, the explorer has no hash state or key field, and the editor wraps", () => {
  assert.equal(existsSync(new URL("../explorer/QuickStart.tsx", import.meta.url)), false);
  const explorer = readFileSync(new URL("../explorer/ApiExplorer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(explorer, /location\.hash|#op-|ApiKeyField|QuickStart\b/u);
  const page = readFileSync(new URL("../views/ExplorerPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /AnchorScope/u);
  const editor = readFileSync(new URL("../explorer/RequestEditor.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(editor, /wrap="off"/u);
  assert.match(editor, /wrap="soft"/u);
});
