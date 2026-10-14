// Honest protocol counts: N real protocols and M executable through the
// API are computed from GET /v1/protocols; your own contracts are listed apart and never counted. Run with
//   node --test apps/web/src/app/pages/protocols/__tests__/protocolCount.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOLS } from "@kletia/core";

import { countProtocols, isExecutableThroughApi, protocolCountLabel, protocolHeadline, surfaceOf } from "../../../site/protocolCount.ts";
import { protocolBadge, routedViaLabel } from "../protocolBadge.ts";

/** GET /v1/protocols as the API serves it: the registry plus `executable`, `surface` and `routedVia`. */
function liveView(executableIds) {
  return PROTOCOLS.map((protocol) => ({
    ...protocol,
    executable: executableIds.has(protocol.id),
    surface: protocol.execution ?? "platform",
    routedVia: protocol.routedVia ?? [],
  }));
}

const REAL = PROTOCOLS.filter((protocol) => protocol.category !== "custom");

test("N counts real protocols only; the custom doors are your own contracts", () => {
  assert.ok(REAL.length > 0 && REAL.length < PROTOCOLS.length);
  const count = countProtocols(PROTOCOLS);
  assert.equal(count.protocols, REAL.length);
  assert.equal(count.ownContracts, true);
  // The registry cannot know which adapters a deployment runs: M is unknown, never guessed.
  assert.equal(count.executable, null);
  assert.equal(protocolHeadline(PROTOCOLS), `${REAL.length} protocols + your own contracts`);
  assert.equal(protocolCountLabel(PROTOCOLS), `${REAL.length} protocols + your own contracts`);
});

test("M counts live adapters on the platform surface; console, service and custom entries never count", () => {
  // Every id executable, as a deployment with all adapters would report.
  const all = liveView(new Set(PROTOCOLS.map((protocol) => protocol.id)));
  const platform = REAL.filter((protocol) => (protocol.execution ?? "platform") === "platform").length;
  const count = countProtocols(all);
  assert.equal(count.executable, platform);
  assert.ok(platform < REAL.length, "console and service venues exist and are excluded");
  assert.equal(protocolHeadline(all), `${REAL.length} protocols, ${platform} executable through the API, + your own contracts`);
  for (const id of ["kletia-router-v2", "basenames", "x402", "custom-call", "solana-actions"]) {
    const entry = all.find((protocol) => protocol.id === id);
    if (entry) assert.equal(isExecutableThroughApi(entry), false, id);
  }
});

test("an entry the deployment has no adapter for is listed, not executable", () => {
  const view = liveView(new Set(["jupiter", "relay"]));
  assert.equal(countProtocols(view).executable, 2);
  assert.equal(protocolHeadline(view), `${REAL.length} protocols, 2 executable through the API, + your own contracts`);
  assert.equal(protocolBadge(view.find((entry) => entry.id === "kamino")).label, "Listed");
});

test("an unknown surface from a newer API is never read as platform", () => {
  assert.equal(surfaceOf({ surface: "satellite" }), "unknown");
  assert.equal(isExecutableThroughApi({ category: "dex", executable: true, surface: "satellite" }), false);
  assert.equal(surfaceOf({ execution: "console" }), "console");
  assert.equal(surfaceOf({}), "platform");
});

test("badges: Executable, Executable named with a via tag, Data feed, Console only", () => {
  const view = liveView(new Set(PROTOCOLS.map((protocol) => protocol.id)));
  const byId = (id) => view.find((entry) => entry.id === id);
  const nameOf = (id) => PROTOCOLS.find((protocol) => protocol.id === id)?.name;
  assert.equal(protocolBadge(byId("uniswap-v3")).label, "Executable");
  assert.equal(protocolBadge(byId("raydium")).label, "Executable · named");
  assert.equal(routedViaLabel(byId("raydium"), nameOf), "via Jupiter");
  assert.equal(routedViaLabel(byId("uniswap-v3"), nameOf), null);
  assert.equal(protocolBadge(byId("chainlink")).label, "Data feed");
  assert.equal(protocolBadge(byId("kletia-router-v2")).label, "Console only");
  assert.equal(protocolBadge(byId("custom-call")), null, "your own contracts carry no protocol badge");
  // The registry view prints no execution badge for platform venues.
  assert.equal(protocolBadge(PROTOCOLS.find((protocol) => protocol.id === "uniswap-v3")), null);
  assert.equal(protocolBadge(PROTOCOLS.find((protocol) => protocol.id === "kletia-router-v2")).label, "Console only");
});
