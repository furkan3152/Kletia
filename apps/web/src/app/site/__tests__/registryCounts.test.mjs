// Protocol counts come from the registry, never typed: the README headline and the site's
// registry headline both equal what @kletia/core PROTOCOLS and capabilityIndex() say. Run with
//   node --test apps/web/src/app/site/__tests__/registryCounts.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { capabilityIndex, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";

import { countProtocols, countRoutes, registryHeadline } from "../protocolCount.ts";

const README = readFileSync(new URL("../../../../../../README.md", import.meta.url), "utf8");

test("the README protocol headline equals the registry and the capability index", () => {
  const match = /The registry lists \*\*(\d+) protocols, (\d+) of them executable through the API\*\*/u.exec(README);
  assert.ok(match, "README headline not found");
  assert.equal(Number(match[1]), countProtocols(PROTOCOLS).protocols, "README protocol count");
  assert.equal(Number(match[2]), countRoutes(capabilityIndex()).protocols, "README executable count");
  assert.ok(README.includes(registryHeadline(PROTOCOLS, capabilityIndex())));
});

test("route counts per network come from the index, every network has at least a transfer", () => {
  const { byNetwork, protocols } = countRoutes(capabilityIndex());
  for (const network of NETWORK_KEYS) assert.ok((byNetwork[network] ?? 0) >= 1, network);
  assert.ok(protocols < countProtocols(PROTOCOLS).protocols, "naming, data and console entries are not routes");
  assert.deepEqual(countRoutes([]), { protocols: 0, byNetwork: {} });
});
