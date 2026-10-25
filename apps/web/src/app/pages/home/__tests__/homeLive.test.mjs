// Home live readouts: the tape, the cartridge bay and the hero's "answering now" read GET /v1/health
// only; without a report they say so and never print a number. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/home/__tests__/homeLive.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { answering, cartridgeReadout, groupDigits, heightLabel, latencyLabel, tapeItems, uptimeLabel, utcClock } from "../homeLive.ts";

const REPORT = {
  status: "ok",
  version: "1.4.0",
  time: "2026-10-25T12:04:00.000Z",
  uptimeSeconds: 3 * 86400 + 4 * 3600 + 60,
  networks: [
    { network: "base", ok: true, latencyMs: 211.6, height: "23481207" },
    { network: "solana", ok: true, latencyMs: 1420, height: "312000111" },
    { network: "arbitrum", ok: false, latencyMs: 5000 },
  ],
};
const ORDER = [
  { key: "base", name: "Base" },
  { key: "solana", name: "Solana" },
  { key: "arbitrum", name: "Arbitrum" },
  { key: "polygon", name: "Polygon" },
];

test("formatters", () => {
  assert.equal(groupDigits("23481207"), "23,481,207");
  assert.equal(groupDigits("0x12"), "0x12");
  assert.equal(heightLabel("base", "23481207"), "block 23,481,207");
  assert.equal(heightLabel("solana-devnet", "12"), "slot 12");
  assert.equal(heightLabel("base", undefined), null);
  assert.equal(latencyLabel(211.6), "212 ms");
  assert.equal(latencyLabel(1420), "1.4 s");
  assert.equal(latencyLabel(undefined), null);
  assert.equal(uptimeLabel(3 * 86400 + 4 * 3600), "3 d 4 h");
  assert.equal(uptimeLabel(5 * 3600 + 12 * 60), "5 h 12 m");
  assert.equal(utcClock("2026-10-25T12:04:00.000Z"), "12:04 UTC");
  assert.equal(utcClock("nope"), null);
});

test("the tape reads the report, network by network, then the API", () => {
  const items = tapeItems(REPORT, "live", ORDER);
  assert.deepEqual(items.map((item) => [item.label, item.value, item.lamp]), [
    ["Base", "RPC 212 ms · block 23,481,207", "on"],
    ["Solana", "RPC 1.4 s · slot 312,000,111", "on"],
    ["Arbitrum", "did not answer", "bad"],
    ["Polygon", "no reading", "off"],
    ["Kletia API", "ok · v1.4.0 · up 3 d 4 h", "on"],
  ]);
});

test("without a report nothing numeric is shown", () => {
  for (const state of ["loading", "unavailable"]) {
    const items = tapeItems(null, state, ORDER);
    assert.equal(items.length, 1);
    assert.doesNotMatch(items[0].value.replace("/v1/", ""), /\d/u);
    const readout = cartridgeReadout("base", undefined, state);
    assert.equal(readout.lamp, "off");
    assert.doesNotMatch(readout.lines.join(" "), /\d/u);
  }
  assert.match(tapeItems(null, "unavailable", ORDER)[0].value, /status unavailable/u);
  assert.equal(answering(null, ["base"]), null);
});

test("answering counts only networks that answered", () => {
  assert.deepEqual(answering(REPORT, ["base", "solana", "arbitrum", "polygon"]), { ok: 2, total: 4 });
  assert.deepEqual(cartridgeReadout("arbitrum", REPORT.networks[2], "live").lamp, "bad");
  assert.deepEqual(cartridgeReadout("base", REPORT.networks[0], "live").lines, ["RPC 212 ms", "block 23,481,207"]);
});
