// The web prompt secret screen agrees with the shared vectors that the API's
// screen (apps/api/src/platform/engine/secretScreen.ts) is tested against:
// packages/core/test/fixtures/secret-vectors.json. Run with
//   node --test apps/web/src/shared/security/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { containsSensitivePromptMaterial } from "../promptSecrets.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../../../../packages/core/test/fixtures/secret-vectors.json", import.meta.url), "utf8"));

test("the shared vectors are present", () => {
  assert.ok(vectors.refuse.length >= 10);
  assert.ok(vectors.allow.length >= 10);
});

for (const vector of vectors.refuse) {
  test(`refuses: ${vector.case}`, () => {
    assert.equal(containsSensitivePromptMaterial(vector.text), true);
  });
}

for (const vector of vectors.allow) {
  test(`allows: ${vector.case}`, () => {
    assert.equal(containsSensitivePromptMaterial(vector.text), false);
  });
}
