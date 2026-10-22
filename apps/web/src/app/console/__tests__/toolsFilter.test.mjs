// The Tools view's network filter: a network no tool is built for gets an
// honest note instead of a bare "no match", and the tools for every network
// stay listed under it.
import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_KEYS } from "@kletia/core";

import { DESK_COPY } from "../content/copy.ts";
import { TOOLS } from "../tools/catalogue.ts";
import { filterTools, networkToolNote } from "../tools/toolsFilter.ts";

const all = { network: "all", kind: "all", query: "" };

test("Ethereum, OP Mainnet and Polygon get the note and keep the every-network tools", () => {
  for (const network of ["ethereum", "optimism", "polygon"]) {
    if (!NETWORK_KEYS.includes(network)) continue;
    const filter = { ...all, network };
    const visible = filterTools(TOOLS, filter);
    assert.ok(visible.every((tool) => tool.networks.length === 0), `${network}: only every-network tools`);
    assert.equal(networkToolNote(visible, filter), visible.length > 0 ? "general" : "none");
  }
});

test("a network with its own tools gets no note", () => {
  for (const network of ["base", "arbitrum", "solana", "arc"]) {
    const filter = { ...all, network };
    assert.equal(networkToolNote(filterTools(TOOLS, filter), filter), null, network);
  }
  assert.equal(networkToolNote(filterTools(TOOLS, all), all), null);
});

test("kind and search filters keep the plain no-match message", () => {
  const byKind = { network: "polygon", kind: "prompt", query: "" };
  assert.equal(networkToolNote(filterTools(TOOLS, byKind), byKind), null);
  const bySearch = { network: "polygon", kind: "all", query: "zzz" };
  assert.deepEqual(filterTools(TOOLS, bySearch), []);
  assert.equal(networkToolNote([], bySearch), null);
});

test("the note says the network works from the composer", () => {
  assert.match(DESK_COPY.tools.networkGeneralOnly("Polygon"), /Polygon work from the composer/u);
  assert.match(DESK_COPY.tools.networkNone("OP Mainnet"), /No tool is built for OP Mainnet yet/u);
});
