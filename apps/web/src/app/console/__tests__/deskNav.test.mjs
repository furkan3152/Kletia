// The desk's nav model: nine views in six sections, every old URL
// and desk command still opening its view, now inside a section. Run with
//   node --test apps/web/src/app/console/__tests__/deskNav.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DESK_COPY } from "../content/copy.ts";
import { DESK_VIEW_PATHS, deskLocationOf } from "../hooks/deskUrl.ts";
import { DESK_COMMANDS } from "../state/deskModel.ts";
import { DESK_SECTION_VIEWS, PHONE_SECTIONS, rememberView, sectionOf, sectionTarget, siblingViews, WIDE_SECTIONS } from "../state/deskNav.ts";

const ALL_VIEWS = ["desk", ...Object.keys(DESK_VIEW_PATHS)];

test("every view belongs to exactly one section", () => {
  const listed = Object.values(DESK_SECTION_VIEWS).flat();
  assert.deepEqual([...listed].sort(), [...ALL_VIEWS].sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(PHONE_SECTIONS, ["desk", "tasks", "portfolio", "trade", "automate", "more"]);
  assert.deepEqual(WIDE_SECTIONS, ["desk", "portfolio", "trade", "automate", "more"]);
});

test("the old view URLs open their view inside the right section", () => {
  const expected = {
    "/app": ["desk", "desk"],
    "/app/tasks": ["tasks", "tasks"],
    "/app/dashboard": ["dashboard", "portfolio"],
    "/app/holdings": ["holdings", "portfolio"],
    "/app/perps": ["perps", "trade"],
    "/app/orders": ["orders", "trade"],
    "/app/automations": ["automations", "automate"],
    "/app/tools": ["tools", "more"],
    "/app/tools/x402": ["tools", "more"],
    "/app/activity": ["activity", "more"],
  };
  for (const [path, [view, section]] of Object.entries(expected)) {
    const location = deskLocationOf(path);
    assert.equal(location.view, view, path);
    assert.equal(sectionOf(location.view), section, path);
  }
});

test("desk commands still open their view; its section shows sub-tabs when it has siblings", () => {
  assert.equal(DESK_COMMANDS["show my holdings"], "holdings");
  assert.equal(DESK_COMMANDS["show my dashboard"], "dashboard");
  assert.equal(DESK_COMMANDS["show my orders"], "orders");
  assert.equal(DESK_COMMANDS["show my automations"], "automations");
  assert.equal(DESK_COMMANDS["show my activity"], "activity");
  for (const view of Object.values(DESK_COMMANDS)) assert.ok(siblingViews(view).includes(view), view);
  assert.deepEqual(siblingViews("orders"), ["perps", "orders"]);
  assert.deepEqual(siblingViews("holdings"), ["dashboard", "holdings"]);
  assert.deepEqual(siblingViews("automations"), ["automations"]);
});

test("a section tab stays on the current view, else reopens the remembered one, else its first", () => {
  assert.equal(sectionTarget("trade", "desk"), "perps");
  assert.equal(sectionTarget("trade", "orders"), "orders");
  assert.equal(sectionTarget("portfolio", "desk"), "dashboard");
  assert.equal(sectionTarget("more", "desk"), "tools");
  let memory = {};
  memory = rememberView(memory, "orders");
  memory = rememberView(memory, "activity");
  assert.equal(sectionTarget("trade", "desk", memory), "orders");
  assert.equal(sectionTarget("more", "dashboard", memory), "activity");
  assert.equal(rememberView(memory, "orders"), memory);
  assert.equal(sectionTarget("trade", "desk", { trade: "tools" }), "perps");
});

test("every section and view has a label, and the phone bar fits six short ones", () => {
  for (const section of PHONE_SECTIONS) assert.ok(DESK_COPY.header.sections[section], section);
  for (const view of ALL_VIEWS) assert.ok(DESK_COPY.header.views[view], view);
  for (const section of PHONE_SECTIONS) assert.ok(DESK_COPY.header.sections[section].length <= 9, section);
  assert.equal(DESK_COPY.header.subNavLabel("Trade"), "Trade views");
});

test("the header and the phone bar both read the section model, not a view list of their own", () => {
  const header = readFileSync(new URL("../shell/DeskHeader.tsx", import.meta.url), "utf8");
  const bar = readFileSync(new URL("../shell/DeskViewNav.tsx", import.meta.url), "utf8");
  assert.match(header, /WIDE_SECTIONS\.map/u);
  assert.match(bar, /PHONE_SECTIONS\.map/u);
  for (const source of [header, bar]) assert.doesNotMatch(source, /text-\[1[01]px\]/u);
});
