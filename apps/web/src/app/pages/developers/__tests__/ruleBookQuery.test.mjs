// The Rule Book page's address: ?key=&view= parsed and written back, invalid
// values ignored. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRuleBookQuery,
  ruleBookHref,
  RULE_BOOK_VIEW_LABELS,
  selectedRuleBookKey,
  serializeRuleBookQuery,
} from "../rulebook/ruleBookQuery.ts";

const KEY = `key_${"a1".repeat(12)}`;
const OTHER = `key_${"b2".repeat(12)}`;

test("key and view parse from the query; invalid values are ignored", () => {
  assert.deepEqual(parseRuleBookQuery(`?key=${KEY}&view=simulate`), { key: KEY, view: "simulate" });
  assert.deepEqual(parseRuleBookQuery(new URLSearchParams("key=project&view=decisions")), { key: "project", view: "decisions" });
  assert.deepEqual(parseRuleBookQuery(""), { key: null, view: "rules" });
  assert.deepEqual(parseRuleBookQuery("key=../../keys&view=desk"), { key: null, view: "rules" }, "old tab names and odd ids read as defaults");
  assert.deepEqual(parseRuleBookQuery(`key=KEY_${"A1".repeat(12)}&view=Agents`), { key: null, view: "rules" }, "case matters");
  assert.deepEqual(parseRuleBookQuery(`key=nope&key=${KEY}&view=x&view=agents`), { key: KEY, view: "agents" }, "the first valid value wins");
  assert.deepEqual(parseRuleBookQuery(`?key=${KEY}&secret=kl_dev_x`), { key: KEY, view: "rules" }, "anything else is ignored");
});

test("the query is written back with defaults left out, and never with an invalid value", () => {
  assert.equal(serializeRuleBookQuery({ key: KEY, view: "simulate" }), `?key=${KEY}&view=simulate`);
  assert.equal(serializeRuleBookQuery({ key: KEY, view: "rules" }), `?key=${KEY}`);
  assert.equal(serializeRuleBookQuery({ key: null, view: "rules" }), "");
  assert.equal(serializeRuleBookQuery({ key: "<script>", view: "nope" }), "");
  assert.equal(ruleBookHref({ key: "project", view: "agents" }), "/developers/rule-book?key=project&view=agents");
  assert.equal(ruleBookHref(), "/developers/rule-book");
  // Round trip.
  for (const query of [{ key: KEY, view: "decisions" }, { key: "project", view: "rules" }, { key: null, view: "agents" }]) {
    assert.deepEqual(parseRuleBookQuery(serializeRuleBookQuery(query)), query);
  }
});

test("the shown key: the query's when it is in the list, else the loaded key", () => {
  const keys = [{ id: OTHER, current: false }, { id: KEY, current: true }];
  assert.equal(selectedRuleBookKey(OTHER, keys), OTHER);
  assert.equal(selectedRuleBookKey(`key_${"c3".repeat(12)}`, keys), KEY, "a key the reader cannot see falls back to the loaded key");
  assert.equal(selectedRuleBookKey(null, keys), KEY);
  assert.equal(selectedRuleBookKey("project", keys), "project");
  assert.equal(selectedRuleBookKey(null, []), "project");
});

test("tabs carry plain labels", () => {
  assert.deepEqual(Object.values(RULE_BOOK_VIEW_LABELS), ["Rules", "Simulate", "Decision log", "Agent keys"]);
});
