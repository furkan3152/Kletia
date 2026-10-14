// The errors page's group headings (docs/errorsModel.ts): "Request, 27 codes", with the count
// computed from the catalog, never "Request27". Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/errorsHeading.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ERROR_CATEGORIES, errorCatalogRows } from "@kletia/core";

import { categoryLabel, codeCount, groupErrors, groupHeading } from "../docs/errorsModel.ts";

const rows = errorCatalogRows();

test("each group heading names the category and its computed count", () => {
  const groups = groupErrors(rows);
  const request = groups.find((group) => group.category === "request");
  const expected = rows.filter((row) => row.category === "request").length;
  assert.ok(expected > 1);
  assert.equal(request.heading, `Request, ${expected} codes`);
  assert.equal(groupHeading("not_found", 1), "Not found, 1 code");
  assert.equal(codeCount(0), "0 codes");
  assert.equal(groups.reduce((total, group) => total + group.rows.length, 0), rows.length);
  for (const group of groups) assert.match(group.heading, /^[A-Z][a-z ]+, \d+ codes?$/u, group.heading);
});

test("groups follow the catalog's category order, unknown categories last, empty ones dropped", () => {
  const groups = groupErrors(rows).map((group) => group.category);
  const known = ERROR_CATEGORIES.filter((category) => groups.includes(category));
  assert.deepEqual(groups, known);
  const odd = groupErrors([{ category: "zebra" }, { category: "request" }]);
  assert.deepEqual(odd.map((group) => group.category), ["request", "zebra"]);
  assert.equal(categoryLabel("zebra"), "zebra");
  assert.deepEqual(groupErrors([]), []);
});

test("the heading separates label and count for screen readers", () => {
  const source = readFileSync(new URL("../ErrorsReference.tsx", import.meta.url), "utf8");
  assert.match(source, /\{group\.label\}\s*<span className="sr-only">, <\/span>/u);
  assert.match(source, /codeCount\(group\.rows\.length\)/u);
});
