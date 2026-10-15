// Protocol counts come from the registry, never typed: the README headline and the site's
// registry headline both equal what @kletia/core PROTOCOLS and capabilityIndex() say. Run with
//   node --test apps/web/src/app/site/__tests__/registryCounts.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { capabilityIndex, CHAINS, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";

import { DESK_COPY } from "../../console/content/copy.ts";
import { countWord, NETWORK_COUNT, PRODUCTION_NETWORK_COUNT, TEST_NETWORK_COUNT } from "../networkCount.ts";
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

test("network counts come from the registry: 9 networks, 6 production and 3 test", () => {
  assert.equal(NETWORK_COUNT, NETWORK_KEYS.length);
  assert.equal(NETWORK_COUNT, Object.keys(CHAINS).length);
  assert.equal(PRODUCTION_NETWORK_COUNT + TEST_NETWORK_COUNT, NETWORK_COUNT);
  assert.equal(TEST_NETWORK_COUNT, Object.values(CHAINS).filter((chain) => chain.lane === "testnet").length);
  assert.ok(DESK_COPY.empty.lead.includes(`${countWord(NETWORK_COUNT)} networks`), "the console lead prints the registry count");
});

test("site copy never calls the production lines alone 'the networks' ('6 NETWORKS' beside 'nine networks')", () => {
  const appRoot = fileURLToPath(new URL("../../", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
    }
  };
  walk(appRoot);
  const words = `(?:${countWord(PRODUCTION_NETWORK_COUNT)}|${PRODUCTION_NETWORK_COUNT})`;
  // "six networks", "6 networks", "six production networks" written out as a total are the contradiction; the
  // production count is printed from PRODUCTION_NETWORK_COUNT / PRODUCTION.length with its "production" qualifier.
  const stale = new RegExp(`\\b${words}\\s+(?:networks|chains)\\b|\\b${words}\\s+production\\b`, "iu");
  const hits = files.filter((path) => stale.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "")));
  assert.deepEqual(hits, [], "typed network counts in site copy");
  const hero = readFileSync(join(appRoot, "pages/home/HeroSection.tsx"), "utf8");
  assert.match(hero, /const networks = NETWORK_COUNT;/u, "the hero kicker and headline share the registry count");
});
