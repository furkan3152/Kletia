// The station directory sets the category filter (portal design S-13), and every example sentence on a sign is one
// of the API grammar's GRAMMAR_EXAMPLES. Run with
//   node --test apps/web/src/app/pages/protocols/__tests__/directoryFilter.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROTOCOLS } from "@kletia/core";

import {
  categoryGroupKey,
  categoryMatches,
  directoryRowFilter,
  directoryRows,
  isRowSelected,
  knownCategoryFilters,
} from "../directoryFilter.ts";
import { protocolExample } from "../protocolExamples.ts";
import { applyFilters, EMPTY_FILTERS, parseFilters, sanitizeFilters, serializeFilters } from "../protocolFilterState.ts";

const REAL = PROTOCOLS.filter((protocol) => protocol.category !== "custom");

test("one directory row per sign word, covering every category it names", () => {
  const rows = directoryRows(REAL);
  const swap = rows.find((row) => row.key === "swap");
  assert.ok(swap);
  assert.deepEqual([...swap.categories].sort(), ["dex", "dex-aggregator"]);
  assert.equal(swap.count, REAL.filter((protocol) => ["dex", "dex-aggregator"].includes(protocol.category)).length);
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), REAL.length);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
  for (let index = 1; index < rows.length; index += 1) assert.ok(rows[index - 1].count >= rows[index].count);
});

test("a directory row sets the category, and the grid shows exactly that group", () => {
  const rows = directoryRows(REAL);
  const swap = rows.find((row) => row.key === "swap");
  const category = directoryRowFilter(swap, EMPTY_FILTERS.category);
  assert.equal(category, "swap");
  assert.equal(isRowSelected(swap, category), true);
  const shown = applyFilters(REAL, { ...EMPTY_FILTERS, category });
  assert.equal(shown.length, swap.count);
  assert.ok(shown.every((protocol) => categoryGroupKey(protocol.category) === "swap"));
  // Pressing the selected row again clears the category; another row takes over.
  assert.equal(directoryRowFilter(swap, category), "all");
  const lending = rows.find((row) => row.key === "lending");
  assert.equal(directoryRowFilter(lending, category), "lending");
  assert.equal(isRowSelected(lending, category), false);
});

test("the category survives the URL, and old links with a registry category still filter", () => {
  const known = { networks: new Set(), categories: knownCategoryFilters(REAL) };
  assert.equal(serializeFilters({ ...EMPTY_FILTERS, category: "swap" }), "?category=swap");
  assert.equal(parseFilters("?category=swap").category, "swap");
  const legacy = sanitizeFilters(parseFilters("?category=dex-aggregator"), known);
  assert.equal(legacy.category, "dex-aggregator");
  assert.ok(applyFilters(REAL, legacy).every((protocol) => protocol.category === "dex-aggregator"));
  assert.equal(sanitizeFilters(parseFilters("?category=teleport"), known).category, "all");
  assert.equal(categoryMatches("dex", "all"), true);
  assert.equal(categoryMatches("dex", "bridge"), false);
});

test("every example sentence on a sign is one of the API's GRAMMAR_EXAMPLES", () => {
  const grammar = readFileSync(new URL("../../../../../../api/src/platform/engine/grammar.ts", import.meta.url), "utf8");
  const block = grammar.slice(grammar.indexOf("export const GRAMMAR_EXAMPLES"), grammar.indexOf("]);", grammar.indexOf("export const GRAMMAR_EXAMPLES")));
  const examples = new Set([...block.matchAll(/^\s*"((?:[^"\\]|\\.)*)",?$/gmu)].map((match) => match[1]));
  assert.ok(examples.size >= 20, `parsed ${examples.size} grammar examples`);
  let checked = 0;
  for (const protocol of PROTOCOLS) {
    const example = protocolExample(protocol.id);
    if (!example) continue;
    checked += 1;
    assert.ok(examples.has(example.prompt), `${protocol.id}: "${example.prompt}" is not in GRAMMAR_EXAMPLES`);
  }
  assert.ok(checked >= 20, `${checked} protocols have an example`);
  for (const id of ["raydium", "orca", "meteora", "lido", "sparklend", "spark-savings", "yearn-v3", "across"]) {
    assert.ok(protocolExample(id), `${id} has an example`);
  }
});
